// @lane: real — drives Decap delete UI end-to-end against prod
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — RUN_HOST_REPO_PUBLISH_LOOP is unset on the standard PR
// matrix — so selecting + bringing it up just to no-op is pure waste.
// The dedicated cms-publish-loop-host workflow runs it nightly.

/*
 * UI-driven coverage for the "Delete published entry" path. Decap's
 * delete UI uses the GitHub git data API directly (POST /git/trees →
 * POST /git/commits → PATCH /git/refs/heads/main); auto-merge engages
 * on the resulting `cms/<col>/<slug>` PR exactly like Save does, and
 * cms-editorial-workflow.yml's `auto-merge-when-ready` job lands the
 * delete once required checks pass.
 *
 * (Historical note: Decap was previously assumed to call
 * DELETE /repos/.../contents/{path}, hit the main-branch ruleset's
 * 422 "rule violations", and bounce off a shim → delete-via-pr.yml
 * recovery path. That recovery never fired because Decap's actual
 * code uses the git data API. The shim's DELETE intercept and the
 * workflow were removed once the spec confirmed the user-facing
 * contract — URL 404s — held without them.)
 *
 * Gating: identical to cms-publish-loop.spec.js's host loop —
 * RUN_HOST_REPO_PUBLISH_LOOP=1 plus a CMS_E2E_PAT must be set.
 * Runs against the same prod admin (https://adamdaniel.ai/admin/) so
 * a single dedicated workflow can drive both this and the publish
 * loop nightly.
 *
 * Fixture model: this spec creates and then deletes its own throw-
 * away `_e2e/canary-delete-<runId>.md` file. A crash mid-flow leaves
 * a recognisable, dated stub on main rather than damaging a checked-
 * in fixture. Both the seed and the delete go through the Decap UI:
 *
 *   - Seed: click "+ New E2E Canary" in the e2e collection list,
 *     fill Title + Body, Save → cms/e2e/<slug> PR opens, drive
 *     Status:Draft → Ready and Publish → Publish Now to engage
 *     auto-merge. Lands on main; deploy-production publishes the
 *     URL.
 *   - Delete: navigate to the just-created entry, click "Delete
 *     published entry", confirm via native confirm() (persistent
 *     dialog handler), wait for the URL to 404.
 *
 * No back doors — both halves are UI-driven per AGENTS.md "Never
 * bypass the UI in a UI test." On test failure, the afterAll
 * harness consults `fileExistsOnMain` and opens a parallel
 * `cms/e2e-fixture/remove-…` PR if the throw-away fixture is still
 * on main.
 */
const path = require("node:path");
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { gh, makeDeployQueueExtender } = require("./github-actions-poll");
const { removeFixtureViaPr } = require("./cms-fixture-pr");
const { waitForChangeReflected } = require("./deploy-pill");
const { prodTarget } = require("./cms-host");
const { guard } = require("./base-collections-guards");

// #33/#21 — resolved the same way the registered specs do so the guard reads
// identically and the drift lint can match it.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

// Fixed-prod loop, resolved through the shared cms-host resolver
// (byte-identical to the old literals) so prod/preview can't drift.
const { host: PROD_HOST, adminUrl: PROD_ADMIN, pillId: PILL_PROD } = prodTarget();

// The delete spec runs two editorial-workflow auto-merge cycles end
// to end:
//   1. The cms/e2e/<slug> PR Decap opens when Save is clicked on the
//      "+ New E2E Canary" form (replaces the earlier seedFixtureViaPr
//      back door).
//   2. The cms/<col>/<slug> PR Decap opens when "Delete published
//      entry" is clicked — Decap PATCHes the git ref directly via
//      the data API; auto-merge engages once required checks pass.
//      This is the real subject of the test.
// Each is roughly the same shape (validate-content + auto-merge +
// deploy-production + CloudFront propagation), capping out around
// 12-15 min. Plus the in-browser drive of two full publish chains.
// 40 min envelope accommodates concurrent CI on busy days where the
// required-check matrix queues up.
//
// Retries stay disabled — this test mutates real state, so a retry
// just re-runs the same broken chain after wasting another 30 min.
// Failures here are almost never transient.
const TEST_TIMEOUT_MS = 40 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

// Module-scoped handle so the afterAll safety-net harness can see the
// runId/slug/filePath generated inside the test. The forward leg is the
// delete itself; if it succeeds the file is gone from main and the
// harness no-ops. If it fails (test threw mid-flow), the harness opens
// a fixture-cleanup PR so the next run starts clean.
let pendingFixture = null;

async function fileExistsOnMain(filePath) {
  try {
    await gh(`/repos/${HOST_REPO}/contents/${filePath}?ref=main`);
    return true;
  } catch (e) {
    if (/\b404\b/.test(String(e.message))) return false;
    throw e;
  }
}

async function tryHardDelete(filePath, slug, runId, message) {
  // Best-effort cleanup. The Decap UI's delete normally removes the
  // fixture via the cms/<col>/<slug> auto-merge path during the test
  // flow; this fallback runs only on test failure when the file is
  // still on main. Direct DELETE /contents/{path} on main is blocked
  // by the ruleset, so we open a labelled fixture-removal PR and let
  // auto-merge land it (same path the success case uses, just
  // initiated from cleanup).
  try {
    await removeFixtureViaPr({
      slug,
      runId,
      filePath,
      message,
      prTitle: message,
      prBody:
        `Cleanup PR opened by \`cms-delete-published.spec.js\` after a test ` +
        `failure left the throw-away fixture on main. Auto-merges via ` +
        `\`cms/ready\`.`,
    });
    console.warn(`[cleanup] removed ${filePath} via fixture-cleanup PR`);
  } catch (e) {
    console.warn(`[cleanup] could not remove ${filePath}: ${e.message}`);
  }
}

test(
  "Delete published entry — UI click → public URL 404s",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(!getPat(), "CMS_E2E_PAT not set — host-repo delete-published spec disabled.");
    // Same opt-in as cms-publish-loop.spec.js so this also only fires
    // inside the dedicated cms-publish-loop-host workflow.
    test.skip(
      process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1",
      "RUN_HOST_REPO_PUBLISH_LOOP not set — delete-published spec is opt-in.",
    );
    // #33/#21 — a base_collections:[] consumer (single-page bio) renders no Posts
    // sidebar link / e2e canary collection, so "Load production admin" would wait
    // 60s for a /^Posts$/ link that never appears. Skip green on such a consumer;
    // run in full where the e2e+posts collections are kept.
    test.skip(...guard(SITE_ROOT, "cms-delete-published.spec.js"));

    // Title shape is chosen so Decap's title→slug derivation matches the
    // slug we predict client-side. Lowercase + spaces only — Decap's
    // default slugify lowercases and replaces non-alphanumerics with `-`,
    // so `Canary delete 1234567890` → `canary-delete-1234567890`. Keep
    // the title to plain ASCII letters/digits/spaces; otherwise the
    // derived slug may not match the predicted one and downstream URL
    // assertions break.
    const runId = Date.now();
    const slug = `canary-delete-${runId}`;
    const filePath = `_e2e/${slug}.md`;
    const title = `Canary delete ${runId}`;
    const publicUrl = `${PROD_HOST}/e2e/${slug}/`;
    pendingFixture = { runId, slug, filePath };

    test.info().annotations.push({
      type: "fixture-path",
      description: filePath,
    });

    // ── Set up persistent dialog + network trace listeners up-front ────
    //
    // PERSISTENT dialog handler — Decap's "Delete published entry" path
    // uses a native confirm() dialog. Playwright's default behavior is
    // to AUTO-DISMISS dialogs that have no listener, which Decap
    // interprets as "user cancelled" and aborts the delete chain. The
    // earlier `page.once("dialog", ...)` was set AFTER the trigger
    // click, so any dialog that appeared during the click was already
    // auto-dismissed by the time the listener registered. Set the
    // persistent listener BEFORE any user interaction so every dialog
    // any flow (create, publish, delete) raises gets accepted.
    page.on("dialog", (d) => d.accept());

    // Broad network trace: log every GitHub API request + response
    // during the spec, plus any console / page error. This is the
    // diagnostic surface a future failure points at — narrower filters
    // previously hid the fact that Decap wasn't calling DELETE /contents
    // at all because the confirm() was being auto-rejected.
    page.on("request", (req) => {
      const method = req.method();
      const url = req.url();
      if (/api\.github\.com\/repos\/Adam-S-Daniel\/adamdaniel\.ai\//.test(url)) {
        console.info(`[trace] ${method} → ${url}`);
      }
    });
    page.on("response", (res) => {
      const url = res.url();
      if (/api\.github\.com\/repos\/Adam-S-Daniel\/adamdaniel\.ai\//.test(url)) {
        console.info(`[trace] ${res.status()} ${res.request().method()} ← ${url}`);
      }
    });
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.info(`[trace] console.${t}: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.warn(`[trace] pageerror: ${err && err.message}`);
    });

    await seedDecapAuth(page);

    // ── 0. Open admin ──────────────────────────────────────────────
    await test.step("Load production admin", async () => {
      await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 1. Create the throw-away canary via UI ─────────────────────
    //
    // Direct URL nav to the e2e collection's "new entry" form is more
    // deterministic than clicking "+ New E2E Canary" from the
    // collection list (no listing-render race). The route is the same
    // one the button would navigate to. Editorial workflow is on, so
    // Save creates a cms/e2e/<slug> PR — auto-merge engages once
    // Status:Ready is set. The slug Decap derives MUST match the slug
    // we predicted from the title (see comment above).
    await test.step("Open + New E2E Canary form (collections/e2e/new)", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/e2e/new`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Fill Title and Body", async () => {
      await page.getByRole("textbox", { name: /^Title$/i }).fill(title);
      // The e2e collection's body is `widget: text` (plain textarea),
      // NOT `widget: markdown`. The switch happened in commit 0346acc
      // ("fix(cms): canary e2e body uses widget: text to defeat Slate
      // newline-doubling") — see PR #882 for the case study and
      // `e2e/canary-content.test.js` for the lock-down lint. The old
      // contenteditable selector left here pointed at the Slate
      // markdown editor; on a `widget: text` form it matches nothing
      // and `body.click()` times out at 30s.
      //
      // The `:visible` filter is required on the NEW-entry form (this
      // spec navigates to `#/collections/e2e/new`) — that form renders
      // an extra `<textarea tabindex="-1" aria-hidden="true">` clipboard
      // shadow input, and an unqualified `textarea.last()` picks that
      // hidden textarea up instead of the visible body field. Sibling
      // specs (cms-publish-loop, cms-publish-loop-preview) navigate to
      // an EXISTING entry edit page (`/collections/e2e/entries/<slug>`)
      // which doesn't render that hidden textarea, so a plain
      // `textarea.last()` works there. The `:visible` pseudo-class is
      // a Playwright built-in (precedent: cms-smoke.spec.js:250).
      const body = page.locator("textarea:visible").last();
      await body.click();
      await body.pressSequentially(
        `Throw-away fixture from run ${runId}. Used by cms-delete-published.spec.js to exercise the editorial-workflow delete path.`,
      );
    });

    await test.step("Save → opens cms/e2e/<slug> PR via editorial workflow", async () => {
      await page.getByRole("button", { name: /^Save$/i }).click();
      // editorial_workflow Save: stays disabled after, toolbar swaps to
      // a Status:<state> button. Wait for the "Changes saved" toast as
      // the canonical signal the cms PR was opened.
      await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Status:Draft → Ready (label flip → cms/ready)", async () => {
      await page.getByRole("button", { name: /^Status:\s*Draft$/i }).click({ timeout: 30_000 });
      await page.getByRole("menuitem", { name: /^Ready$/i }).click({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: /^Status:\s*Ready$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Publish → Publish Now (engages auto-merge)", async () => {
      await page.getByRole("button", { name: /^Publish$/i }).click({ timeout: 30_000 });
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click({ timeout: 30_000 });
    });

    // ── 2. Wait for the canary URL to land on the public site ──────
    //
    // The cms/e2e/<slug> PR auto-merges, deploy-production runs, and
    // the URL becomes 200 with the title rendered. waitForChangeReflected
    // also pins the prod pill in its terminal-hidden state so we don't
    // confuse "deploy in progress" with "deploy never ran." The runtime
    // budget covers the full chain (validate-content + auto-merge +
    // deploy-production + CDN propagation).
    await test.step("Wait for /e2e/<slug>/ to publish (and pill terminal-hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, {
            maxRedirects: 0,
            failOnStatusCode: false,
          });
          if (res.status() !== 200) return false;
          return (await res.text()).includes(title);
        },
        // Cms PR cycle (validate-content + auto-merge + deploy-production
        // + CDN propagation), generous margin for queued runners.
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // ── 3. Re-open the canary entry editor for the delete leg ──────
    //
    // After Publish-Now, Decap may unmount the editor or land us on
    // the cms PR's view; navigate explicitly to the entry's editor URL
    // so the delete menu is on a known DOM. The slug-bearing URL is
    // deterministic since the slug template at the collection level
    // (`slug: "{{slug}}"`) derives from the title we set.
    await test.step("Navigate to the throw-away canary entry", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/e2e/entries/${slug}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    // ── 4. Click "Delete published entry" (hits the shim) ──────────
    await test.step("Click Delete published entry → shim dispatches workflow", async () => {
      // Decap renders this as a button in the entry-status menu (or a
      // top-level "Delete" depending on entry state). Try the menu
      // path first; fall back to a direct button match. Either click
      // ultimately lands on the same fetch that the shim catches.
      //
      // The status-button label DEPENDS on the entry's editorial
      // workflow state. Run #25473784039 hung for 40 min on the
      // fallback path because the seeded canary is published already
      // — the toolbar shows a single button labelled `Published`,
      // NOT `Status: …`. Without an explicit click timeout the
      // missing-element wait pegged the runner until the
      // outer test timeout fired. Match either label and pin a
      // timeout on every action so a UI shape change next time fails
      // in 30 s instead of 40 min.
      const trigger = page.getByRole("button", { name: /delete (published )?entry/i }).first();
      if (await trigger.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await trigger.click({ timeout: 30_000 });
      } else {
        await page
          .getByRole("button", {
            name: /^(Status:|Published$|In Review$|Ready$|Draft$)/i,
          })
          .first()
          .click({ timeout: 30_000 });
        await page
          .getByRole("menuitem", { name: /delete (published )?entry/i })
          .first()
          .click({ timeout: 30_000 });
      }
      // The persistent `page.on("dialog", ...)` set up at the top of
      // the test will accept any native confirm() dialog the delete
      // flow raises. If Decap uses an in-page modal instead, look for
      // its confirm button (Yes / OK / Delete / Confirm) and click it
      // within a generous window. page.locator is loose-match by
      // default; narrow with role="button" + an anchored regex.
      const confirmInPageModal = page.getByRole("button", {
        name: /^(delete|confirm|yes|ok)$/i,
      });
      await confirmInPageModal
        .first()
        .click({ timeout: 5_000 })
        .catch((err) => {
          console.debug(
            "[cms-delete-published] no in-page confirm button (Decap likely used native confirm() — handled by persistent dialog listener):",
            err && err.message,
          );
        });
    });

    // ── 5. Wait for the URL to 404 (and pill terminal-hidden) ──────
    //
    // After the delete click, Decap may unmount the deleted entry's
    // editor and navigate to the collection list. The pill is only
    // injected into an entry editor's toolbar, so navigate to a SIBLING
    // entry (canary-page is stable and unmutated) for a stable pill
    // mount point. Then poll the public URL until it 404s, watching
    // the pill for failure transitions and finally asserting it lands
    // in its terminal hidden state.
    await test.step("Wait for the URL to 404 (and pill terminal-hidden)", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/e2e/entries/canary-page`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 60_000,
      });
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, {
            maxRedirects: 0,
            failOnStatusCode: false,
          });
          const status = res.status();
          return status >= 400 && status < 500;
        },
        // 12 min covers the long delete chain (dispatch + PR open +
        // validate-content + auto-merge + deploy-production + CDN
        // propagation) with margin, in case runners are saturated.
        urlTimeoutMs: 12 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // Defensive: throw if the delete didn't actually land. The
    // urlCheck above is the gate; this is just a clearer error if
    // something raced past it.
    await test.step("Confirm the canary's public URL 404s", async () => {
      const res = await page.request.get(publicUrl, {
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      const status = res.status();
      if (status < 400 || status >= 500) {
        throw new Error(`${publicUrl} returned ${status} — expected 4xx after delete + deploy.`);
      }
    });
  },
);

// Safety-net harness: the spec's forward leg IS the cleanup (UI delete
// removes the file from main). If the test body completes successfully,
// the file is gone and `fileExistsOnMain` returns false — harness
// no-ops. If the test failed mid-flow (workflow stuck, shim 422 not
// caught, etc.), the throw-away fixture is still on main and the
// harness opens a fixture-cleanup PR so the next run starts clean.
// Direct DELETE /contents on main is blocked by the ruleset; the
// fixture-PR path mirrors the success case.
test.afterAll(async () => {
  if (!pendingFixture) return; // test never ran (skipped)
  if (!getPat()) return; // PAT-less runs can't write anyway
  const { filePath, slug, runId } = pendingFixture;
  const stillThere = await fileExistsOnMain(filePath).catch(() => false);
  if (!stillThere) {
    console.log(
      `[cleanup-harness] ${filePath} gone from main; UI delete succeeded — no safety net needed`,
    );
    return;
  }
  console.warn(
    `[cleanup-harness] ${filePath} still on main after the test; opening fixture-cleanup PR to remove it`,
  );
  await tryHardDelete(
    filePath,
    slug,
    runId,
    `test(canary): cleanup throw-away delete fixture run ${runId}`,
  );
});
