// @lane: real — creates + deletes a real, ephemeral prod _posts/ entry through Decap → GitHub
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — CMS_E2E_PAT and PROD_PLAYGROUND_MODE aren't wired into the
// standard PR matrix — so selecting + bringing it up just to no-op is
// pure waste. The dedicated cms-publish-loop-prod workflow runs it.

/*
 * Real-browser, real-HTTP, real-GitHub end-to-end test for the full
 * Decap CMS publish loop on prod against a REAL `_posts/` entry — now an
 * EPHEMERAL, born-published, hard-deleted per-run post (#1771 step 4).
 *
 * Why ephemeral (the #1771 redesign):
 *   The loop used to mutate a single PERSISTENT committed fixture
 *   (`_posts/2099-01-01-e2e-mutation-canary.md`) in place — toggle
 *   `published`, append a body marker, then revert. A transient failure
 *   on the revert leg (a GitHub 500 on the afterAll Contents-API restore,
 *   run 26511130712) left that one shared cell corrupted on `main`; and
 *   because the next run re-derived its baseline from the same on-disk
 *   body, the corruption was self-perpetuating — wedging the loop until a
 *   human hand-edited the file. Step 4 removes the CLASS of bug: each run
 *   CREATES a uniquely-pathed post, publishes it, asserts it serves, then
 *   DELETES it. Resting state is ABSENCE (404), and absence has no corrupt
 *   variant. A killed run leaks at most ONE inert, uniquely-named orphan
 *   (`_posts/2099-12-31-e2e-prod-mutate-<runId>.md`), swept by
 *   sweep-stale-cms-prs.yml — never a shared corrupt baseline. No loop
 *   ever reads a path it also writes (the #1771 invariant).
 *
 * Fidelity: the real chain (Decap UI create → cms PR → auto-merge →
 * deploy-production → CloudFront → serve → delete → 404) is preserved
 * end-to-end and exercised MORE faithfully — it now covers a real
 * contributor's #1 action (write a new post + publish), then delete,
 * rather than re-editing one persistent file. The "re-edit an
 * already-published post" signal is kept by the persistent `_e2e/` canary
 * in cms-publish-loop.spec.js (#1771 step 5).
 *
 * Born-published + future-dated: the post ships `published: true`, date
 * `2099-12-31` (serves the same way the old `2099-01-01` canary did, via
 * `_config.yml`'s `future: true`), `robots: noindex,nofollow` +
 * `sitemap: false` (a born-published post that briefly serves never leaks
 * to search), and `test_fixture: true` (hidden from the Posts list).
 *
 * The CREATE leg publishes through Decap's editor (Status → Ready →
 * Publish → "Publish now"), exactly like the proven
 * cms-delete-published.spec.js. The merge lands via
 * cms-editorial-workflow `auto-merge-when-ready`: Status:Ready applies
 * `decap-cms/pending_publish` (engages auto-merge), and Publish Now's
 * synchronous merge attempt is 422'd by branch protection while required
 * checks are pending — admin/publish-via-auto-merge.js catches that 422
 * and adds the `cms/ready` label, re-engaging the SAME auto-merge job. The
 * PR then lands once checks pass (commit prefix `publish:` preserved). This
 * is the proven prod path; cms-delete-published.spec.js's green host-loop
 * runs land their merge exactly this way.
 *
 * The DELETE leg is the #1771 iteration-3 fix (run 26529125192). Publish
 * Now alone is NOT enough to make the UI delete remove the file from main:
 * the shim hands Decap a SYNTHETIC `merged:true` while the create PR
 * auto-merges for real only ~5–15 min later, so the `cms/posts/<slug>`
 * editorial branch lingers. If the delete leg re-opens the entry during
 * that window, Decap's loadUnpublishedEntry re-loads it as an OPEN editorial
 * draft (isNewEntry=true, hasUnpublishedChanges=true) → the editor shows
 * "Delete unpublished entry" → the click calls onDeleteUnpublishedChanges,
 * which drops only the draft branch, never main, so the URL never 404s
 * (iterations 1–3 all failed on this). The fix: the delete leg first waits
 * for the create PR to MERGE for real, then reopenForPublishedDelete()
 * poll-reloads the editor until Decap drops the (now-merged) editorial
 * entry and re-loads the published file ("Delete published entry", no
 * Status chip), and only THEN clicks delete — so the click hits onDelete
 * (delete from main → a delete PR). See e2e/cms-editor-ui.js's
 * reopenForPublishedDelete for the full analysis.
 *
 * The explicit `cms/ready` labelling of the create PR (and the delete PR)
 * is kept as belt-and-braces so auto-merge is engaged even if the shim's
 * 422→label recovery is delayed; it is idempotent with the labels Decap
 * already applies. The editor UI is fully driven (fill form, toggle
 * Published, Publish Now, Delete).
 *
 * Flow:
 *   1. Create a born-published ephemeral post via the Decap "+ New Post"
 *      UI (Title + URL Slug + Date 2099-12-31 + Body + Published ON),
 *      Save → Status:Ready → Publish Now → cms/posts/<dated-slug> PR.
 *   2. Label cms/ready (belt-and-braces) → auto-merge → deploy-production.
 *   3. Assert /blog/<slug>/ serves 200 with this run's marker.
 *   4. Wait for the create PR to MERGE, re-open the entry in PUBLISHED
 *      state, Delete via the Decap "Delete published entry" UI → cms PR →
 *      cms/ready → auto-merge → deploy-production.
 *   5. Assert /blog/<slug>/ 404s.
 *   afterAll: existence-only delete (if the post is STILL on main, open a
 *   labelled removal PR via removeFixtureViaPr). No content-restore — the
 *   resting state is absence.
 *
 * Gating:
 *   - `CMS_E2E_PAT` must be set.
 *   - `RUN_PROD_MUTATE_PLAYGROUND=1` (set only in cms-publish-loop-prod.yml).
 *   - `chromium-desktop-3k` only.
 *
 * IMPORTANT: do NOT run this spec locally against prod. It mutates the
 * real production tree. The workflow runs it on a schedule/post-merge.
 */
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { closeStaleDecapPrOnBranch, removeFixtureViaPr } = require("./cms-fixture-pr");
const {
  addLabel,
  gh,
  waitForCmsPullRequest,
  waitForMerge,
  makeDeployQueueExtender,
} = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const {
  setPublished,
  saveEntry,
  publishViaUi,
  clickEditorDelete,
  reopenForPublishedDelete,
} = require("./cms-editor-ui");
const { prodTarget } = require("./cms-host");
const { loudBail } = require("./fixture-baseline");
const { EPHEMERAL_DATE, buildProdMutatePost } = require("./prod-mutate-fixture");

// Fixed-prod loop, resolved through the shared cms-host resolver
// (byte-identical to the old literals) so prod/preview can't drift.
const { host: PROD_HOST, adminUrl: PROD_ADMIN, pillId: PILL_PROD } = prodTarget();

// Read-only daily probe gate — set in canary-prod.yml. The afterAll
// safety net consults this so the probe never tries to write to main.
const PROD_CANARY = process.env.PROD_CANARY === "1";

// Two editorial-workflow auto-merge cycles (create + delete), each
// roughly validate-content + auto-merge + deploy-production + CloudFront
// (~12-15 min when runners are warm), plus the in-browser drive of both
// chains and two URL waits at 15 min each. 40 min envelope. Retries
// disabled — this mutates real prod; a retry re-runs the same broken
// chain after another 40 min.
const TEST_TIMEOUT_MS = 40 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

// Module-scoped handle so the afterAll safety-net can see the
// runId/slug/filePath the test generated. The forward DELETE leg IS the
// cleanup; if it succeeds the file is gone from main and the harness
// no-ops. If the test threw mid-flow, the harness opens a removal PR so
// the next run starts clean (and the sweeper reaps anything older).
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

test(
  "CMS publish loop — prod mutation playground (ephemeral born-published _posts/ entry)",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    // Only the dedicated cms-publish-loop-prod.yml workflow opts in via
    // RUN_PROD_MUTATE_PLAYGROUND=1. Without this gate the spec also runs
    // inside e2e-tests.yml shard 1. Legitimate "not my workflow" skip —
    // plain green test.skip, FIRST so a shard-1 PR run exits here before
    // the loud guards below.
    test.skip(
      process.env.RUN_PROD_MUTATE_PLAYGROUND !== "1",
      "RUN_PROD_MUTATE_PLAYGROUND not set — only the cms-publish-loop-prod workflow runs this spec.",
    );

    // Decap's "Delete published entry" flow uses a native window.confirm.
    // Register the handler BEFORE any interaction so it's never too late.
    page.on("dialog", (d) => d.accept());

    // ── Hard guard ─────────────────────────────────────────────────
    // Past the gate above the spec is SUPPOSED to run. `loudBail` makes
    // an unmet precondition a red failure on a schedule/dispatch run (and
    // a green test.fixme on local/PR), so a non-running scheduled loop
    // never masquerades as green (#1053). The ephemeral design has no
    // committed fixture / `published:` precondition to check (the post is
    // born fresh each run) — only the PAT is required.
    if (!getPat()) {
      loudBail(test, "CMS_E2E_PAT not set — prod-mutation playground cannot run.");
      return;
    }

    const runId = Date.now();
    const built = buildProdMutatePost({ runId });
    const { slug, filePath, marker, title, body } = built;
    const publicUrl = `${PROD_HOST}${built.publicPath}`;
    // Decap's posts `slug:` template is `{{year}}-{{month}}-{{day}}-{{slug}}`,
    // so the on-disk file slug (and the entry deeplink segment / Decap
    // branch) is the dated slug.
    const fileSlug = `${EPHEMERAL_DATE}-${slug}`;
    const decapBranch = `cms/posts/${fileSlug}`;
    pendingFixture = { runId, slug, filePath };

    test.info().annotations.push({ type: "fixture-path", description: filePath });

    // ── 0. Close any stale Decap PR on the (unique) post branch ──────
    // The branch is per-run-unique (the slug carries the runId), so a
    // stale-label carryover is structurally impossible — but a retry of
    // the SAME runId could leave a half-open PR. Best-effort reset.
    await test.step("Close any stale Decap PR on the post branch", async () => {
      await closeStaleDecapPrOnBranch({ branch: decapBranch });
    });

    // ── 1. Confirm the URL 404s before creating (unique per-run name) ─
    await test.step("Confirm /blog/<slug>/ 404s before driving admin (unique per-run path)", async () => {
      const res = await fetch(publicUrl, { cache: "no-store" });
      expect(
        res.status,
        `${publicUrl} must not exist yet (unique per-run name) — got ${res.status}`,
      ).toBe(404);
    });

    // ── 2. Pre-seed Decap auth and load prod admin ──────────────────
    await seedDecapAuth(page);
    await test.step("Load production admin", async () => {
      await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 3. Create the born-published ephemeral post via the New Post UI
    await test.step("Open + New Post form (collections/posts/new)", async () => {
      // Direct URL nav to the posts collection's new-entry form is more
      // deterministic than clicking "+ New Post" from the list (no
      // listing-render race; the same route the button navigates to).
      await page.goto(`${PROD_ADMIN}#/collections/posts/new`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Fill Title, URL Slug, Date (2099-12-31), Body", async () => {
      await page.getByRole("textbox", { name: /^Title$/i }).fill(title);

      // Explicit slug so the on-disk file slug (and thus the cms branch +
      // public URL) is deterministic and carries the runId. Decap's
      // `{{year}}-{{month}}-{{day}}-{{slug}}` template prepends the date.
      await page.getByLabel(/^URL Slug/).fill(slug);

      // Future date so the post serves only because `_config.yml` sets
      // `future: true` (the same mechanism the retired 2099 canaries
      // used). The datetime widget renders an <input type="datetime-local">
      // accepting YYYY-MM-DDTHH:mm (precedent: cms-scheduled-post.spec.js).
      await page.getByLabel(/^Date/).fill(`${EPHEMERAL_DATE}T00:00`);

      // The body widget is a markdown (Slate) editor. A Slate round-trip
      // can mangle the body, but this post is ephemeral and deleted, so it
      // doesn't matter — the run marker also lives in the SLUG (structural)
      // and that is what the URL assertion keys on.
      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.click();
      await bodyEditor.pressSequentially(body.trim());
    });

    await test.step("Toggle Published → ON (born live)", async () => {
      // The Published widget is a switch (role="switch"), toggled via
      // aria-checked — see e2e/cms-editor-ui.js (shared so the selector
      // can't drift, #1723).
      await setPublished(page, true, { visibleTimeout: 15_000 });
    });

    await test.step("Save (opens cms/... PR)", async () => {
      // saveEntry clicks Save + waits for the "Changes saved" toast — the
      // canonical "cms PR was opened" signal in editorial_workflow mode.
      await saveEntry(page);
    });

    await test.step("Status:Ready → Publish Now (transitions Decap to PUBLISHED, engages auto-merge)", async () => {
      // publishViaUi (shared, #1723) drives Status:Draft → Ready then
      // Publish → "Publish now" — the exact create-leg flow the proven
      // cms-delete-published.spec.js uses. This is what puts Decap's editor
      // into the PUBLISHED state so the later delete leg surfaces "Delete
      // published entry" (a delete-from-main PR), not "Delete unpublished
      // entry" (which would only drop the draft branch and never 404 the
      // URL). The merge lands via auto-merge-when-ready: Status:Ready
      // applies decap-cms/pending_publish, and Publish Now's synchronous
      // merge is 422'd by branch protection → admin/publish-via-auto-merge.js
      // adds cms/ready, re-engaging the same auto-merge job. We also label
      // cms/ready explicitly below as belt-and-braces.
      await publishViaUi(page);
    });

    // ── 4. Find the cms/... PR Decap opened, label cms/ready ─────────
    // Belt-and-braces: also set cms/ready directly on the cms PR. The
    // Publish-Now shim already adds cms/ready on its 422 recovery and
    // Status:Ready applies decap-cms/pending_publish, both of which engage
    // cms-editorial-workflow.yml's auto-merge-when-ready; this explicit
    // label guarantees auto-merge is enabled even if the shim's recovery is
    // delayed. addLabel is idempotent, so a duplicate is a no-op.
    let createPrNumber = null;
    await test.step("Wait for Decap to open the create cms/... PR, label cms/ready", async () => {
      const pr = await waitForCmsPullRequest({
        base: "main",
        filePath,
        canaryMarker: slug, // the dated slug appears in the file path / added lines
        timeoutMs: 5 * 60 * 1000,
      });
      expect(pr.number, "Decap create PR number").toBeGreaterThan(0);
      createPrNumber = pr.number;
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });

    // ── 5. Wait for the URL to serve the marker (pill terminal-hidden) ─
    // STAY on the entry editor view — the deploy-status pill is injected
    // there. Poll the public URL until it serves this run's marker; watch
    // the pill for failure transitions and assert it lands terminal-hidden.
    await test.step("Wait for /blog/<slug>/ to serve 200 + run marker (pill terminal-hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, { failOnStatusCode: false });
          if (res.status() !== 200) return false;
          return (await res.text()).includes(marker);
        },
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // ── 6. Delete the post via the Decap UI ──────────────────────────
    //
    // CRITICAL ORDERING (#1771 follow-up, iteration-3 root cause —
    // run 26529125192): the delete leg MUST NOT fire until the create
    // PR has truly MERGED and its `cms/posts/<slug>` editorial branch is
    // gone. In editorial_workflow mode Decap overrides
    // loadEntry → loadUnpublishedEntry (withWorkflow.js); while the
    // create branch still exists (between the publish-via-auto-merge
    // shim's synthetic `merged:true` and the REAL auto-merge ~5–15 min
    // later), re-navigating to the entry re-loads it as an OPEN editorial
    // draft. The editor then shows "Status: Draft" + "Delete unpublished
    // entry", and a Delete click calls onDeleteUnpublishedChanges —
    // dropping only the draft branch, never main. The post keeps serving,
    // no delete-from-main PR opens, and the 404-wait times out (exactly
    // the observed failure: post live, delete leg idle, NO delete PR).
    //
    // Gate on the create PR's real merge first; then re-open the editor
    // and poll-reload until Decap loads the now-published entry (no
    // editorial branch ⇒ no Status chip ⇒ "Delete published entry").
    await test.step("Wait for the create PR to actually merge (not just the synthetic Publish-Now ack)", async () => {
      // The Publish-Now shim returns a synthetic merged:true to Decap, but
      // the PR lands for real only once required checks pass + auto-merge
      // fires. The URL already served above (deploy runs only post-merge),
      // so the merge is usually done; this confirms it deterministically
      // and is what lets the delete leg open a delete-FROM-MAIN change.
      expect(createPrNumber, "create PR number captured for merge wait").toBeTruthy();
      await waitForMerge({ prNumber: createPrNumber, timeoutMs: 5 * 60 * 1000 });
    });

    await test.step("Re-open the post in PUBLISHED state for the delete leg", async () => {
      // Poll-reloads the editor until the editorial Status chip is gone
      // and "Delete published entry" is present — i.e. Decap has dropped
      // the (now-merged) editorial entry and re-loaded the published file.
      // Only in that state does the Delete click remove the file from main.
      await reopenForPublishedDelete(page, `${PROD_ADMIN}#/collections/posts/entries/${fileSlug}`);
    });

    await test.step("Click the editor's Delete button → opens delete-from-main cms/... PR", async () => {
      await clickEditorDelete(page);
      // The persistent page.on("dialog") accepts the native confirm. If
      // Decap uses an in-page modal instead, click its confirm button.
      await page
        .getByRole("button", { name: /^(delete|confirm|yes|ok)$/i })
        .first()
        .click({ timeout: 5_000 })
        .catch((e) => {
          // The in-page confirm button is optional: when Decap uses a
          // native confirm(), the persistent page.on("dialog") listener
          // already accepted it, so the button never appears. Log the
          // skip rather than swallowing it silently (silent-catch-lint).
          console.debug(`[cleanup] optional delete-confirm click skipped: ${e.message}`);
        });
    });

    // ── 7. Label the delete PR cms/ready (if Decap opened one) ───────
    // Decap's GitHub backend may commit the delete directly to main via
    // the git data API OR open a cms/* PR (version-dependent). Mirror
    // cms-media-roundtrip's delete handling: if a cms/* PR appears whose
    // diff removes this file, label it cms/ready so auto-merge fires;
    // otherwise the direct commit already triggered deploy-production.
    // Either way the ground truth is the URL going 404.
    await test.step("Label the delete cms/... PR cms/ready if Decap opened one", async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        let prs = [];
        try {
          prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=50`);
        } catch (_) {
          /* transient — retry */
        }
        const cmsPrs = (prs || []).filter(
          (pr) => pr.head && typeof pr.head.ref === "string" && pr.head.ref.startsWith("cms/"),
        );
        let labelled = false;
        for (const pr of cmsPrs) {
          let files;
          try {
            files = await gh(`/repos/${HOST_REPO}/pulls/${pr.number}/files?per_page=100`);
          } catch (_) {
            continue;
          }
          const removesPost = files.some((f) => f.filename === filePath && f.status === "removed");
          if (removesPost) {
            try {
              await addLabel({ prNumber: pr.number, label: "cms/ready" });
            } catch (e) {
              console.warn(
                `[prod-mutate-delete] could not label PR #${pr.number}: ${e && e.message}`,
              );
            }
            labelled = true;
            break;
          }
        }
        if (labelled) break;
        await new Promise((r) => setTimeout(r, 6000));
      }
      // Not finding a PR is fine — Decap committed the delete straight to main.
    });

    // ── 8. Wait for the URL to 404 (pill terminal-hidden) ────────────
    await test.step("Wait for /blog/<slug>/ to 404 (post deleted, pill terminal-hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, { failOnStatusCode: false });
          const s = res.status();
          return s >= 400 && s < 500;
        },
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // Defensive: clearer error if something raced past the urlCheck gate.
    await test.step("Confirm the post's public URL 404s (final)", async () => {
      const res = await fetch(publicUrl, { cache: "no-store" });
      expect(
        res.status,
        `${publicUrl} must 4xx after the UI delete + deploy`,
      ).toBeGreaterThanOrEqual(400);
      expect(res.status, `${publicUrl} must 4xx (not 5xx) after delete`).toBeLessThan(500);
    });
  },
);

// ── Test-harness cleanup safety net — existence-only DELETE ───────────
// #1771 step 4 makes this an existence-only delete, NOT a content
// restore: the forward DELETE leg IS the cleanup. If the test body
// completed, the post is gone from main and `fileExistsOnMain` returns
// false → the harness no-ops. If the test threw mid-flow, the
// uniquely-named ephemeral post may still be on main; open a labelled
// removal PR (same auto-merge path the forward leg uses) so the next run
// starts clean. A 500 here leaks ONE inert, uniquely-named orphan the
// daily sweeper reaps — never a corrupt shared baseline. Per AGENTS.md's
// harness-hygiene carve-out, this API path is harness cleanup, not the
// behaviour under test (the primary delete leg is UI-driven).
test.afterAll(async () => {
  if (PROD_CANARY) return;
  if (!getPat()) return;
  // Mirror the test-body skip: this hook recovers from a failed
  // mid-flow run in THIS spec's owning workflow only. Outside it the body
  // never ran, so there's nothing to clean up.
  if (process.env.RUN_PROD_MUTATE_PLAYGROUND !== "1") return;
  if (!pendingFixture) return; // test never ran (skipped)

  // Bump the hook timeout off Playwright's 30s default. This safety net
  // reads main + opens a labelled removal PR via the GitHub API; under
  // runner contention 30s is too tight even with skipWaitForMerge below
  // (the first ephemeral prod-mutate run's afterAll timed out at exactly
  // the 30s limit). 2 min covers the worst case without the hook ever
  // blocking on the 25-min waitForMerge.
  test.setTimeout(2 * 60 * 1000);

  const { filePath, slug, runId } = pendingFixture;
  const stillThere = await fileExistsOnMain(filePath).catch(() => false);
  if (!stillThere) {
    console.log(
      `[cleanup-harness] ${filePath} gone from main; UI delete succeeded — no safety net needed`,
    );
    return;
  }
  console.warn(
    `[cleanup-harness] ${filePath} still on main after the test; opening removal PR (existence-only delete, #1771 step 4)`,
  );
  try {
    await removeFixtureViaPr({
      slug,
      runId,
      filePath,
      message: `test(prod-mutate): cleanup leftover ephemeral post run ${runId}`,
      prTitle: `test(prod-mutate): cleanup leftover ephemeral post run ${runId}`,
      prBody:
        "Existence-only cleanup PR opened by `cms-publish-loop-prod-mutate.spec.js` after a " +
        "test failure left the throw-away ephemeral post on main. Auto-merges via `cms/ready` " +
        "(#1771 step 4 — resting state is absence/404).",
      // Fire-and-forget: open + label the removal PR, then return. The
      // editorial-workflow auto-merges it in the background; the daily
      // sweep reaps any orphan. Without this the 25-min waitForMerge
      // blew the (now 2-min) hook timeout — the failure this fix targets.
      skipWaitForMerge: true,
    });
    console.warn(`[cleanup-harness] removed ${filePath} via removal PR`);
  } catch (e) {
    console.warn(`[cleanup-harness] could not remove ${filePath}: ${e && e.message}`);
  }
});
