// @lane: real — drives the real Decap CMS Posts collection on prod
// @select-skip-when-head-ref-prefix: cms/
//
// Self-skips when CMS_E2E_PAT or RUN_HOST_REPO_PUBLISH_LOOP is unset, so
// the spec only fires from the dedicated cms-publish-loop-host workflow.
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — RUN_HOST_REPO_PUBLISH_LOOP is unset on the standard PR
// matrix.
//
// allowed: literal slug used for known fixture
// (`/blog/e2e-unpublish-canary/` is the rendered URL of the dedicated
// fixture `_posts/2024-01-02-e2e-unpublish-canary.md`; this spec
// references it deliberately as the test target. File-scope pragma
// per `e2e/blog-slug-literal-lint.test.js`.)

/*
 * UI test for Decap CMS's "unpublish" + "re-publish" flow on a real
 * `_posts/` entry. This is DISTINCT from delete: unpublishing keeps
 * the file in the repo (frontmatter `published: true` flipped to
 * `false`) and removes the public URL; re-publishing flips the flag
 * back and the URL serves again. Delete removes the file entirely.
 *
 * Why a dedicated spec rather than extending cms-publish-loop-prod-
 * mutate.spec.js: prod-mutate's purpose is "edit body + flip
 * published flag" (the mutation playground). This spec's purpose is
 * the toggle-only flow — no body edit, no marker insertion. A
 * regression in either flow should fail one spec without obscuring
 * the other.
 *
 * Fixture: `_posts/2024-01-02-e2e-unpublish-canary.md` is shipped
 * with `published: false` so the URL is hidden in the steady state.
 * The date is intentionally in the past — Jekyll's default `future:
 * false` setting skips future-dated posts during build even when
 * `published: true`, which would make the re-publish leg's URL wait
 * time out forever (the post never appears in the deploy). Use a
 * past date so `published: true/false` is the only knob that
 * controls public visibility.
 * The spec:
 *   1. Drives Decap UI to open the entry, asserts the Published
 *      toggle reads the baseline state (off).
 *   2. Asserts /blog/e2e-unpublish-canary/ 4xxs (URL hidden).
 *   3. Drives Decap UI: toggle Published → ON, Save → Status:Ready
 *      → Publish Now. Waits for the URL to flip to 200 (deploy
 *      reflected). This is the "re-publish" leg.
 *   4. Drives Decap UI: toggle Published → OFF, Save → Status:Ready
 *      → Publish Now. Waits for the URL to flip back to 4xx. This
 *      is the "unpublish" leg.
 *
 * The order intentionally is publish-first-then-unpublish (rather
 * than unpublish-first-then-republish): the baseline is OFF, so we
 * have to flip ON to assert the publish path renders, then flip OFF
 * to assert the unpublish path hides. End state matches baseline,
 * so subsequent runs start clean.
 *
 * No back doors per AGENTS.md: every state change is a Decap UI
 * click; every wait is the URL-driven helper from deploy-pill.js.
 */
const path = require("node:path");
const fs = require("node:fs");
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { gh, makeDeployQueueExtender } = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const { prodTarget } = require("./cms-host");
const { guard } = require("./base-collections-guards");

// #33/#21 — resolved like the other registered specs so the drift lint matches it.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");
const { readPublishedFlag, forcePublishedFalse } = require("./fixture-baseline");
const { setPublished, expectPublished, saveEntry, publishViaUi } = require("./cms-editor-ui");
const { seedFixtureViaPr } = require("./cms-fixture-pr");

// Prod host triplet resolved through the shared cms-host SSOT (byte-identical
// to the old hardcoded literals) so prod/preview surfaces can't drift.
const { host: PROD_HOST, adminUrl: PROD_ADMIN, pillId: PILL_PROD } = prodTarget();
const FIXTURE_PATH = "_posts/2024-01-02-e2e-unpublish-canary.md";
const FIXTURE_SLUG = "e2e-unpublish-canary";
const PUBLIC_URL = `${PROD_HOST}/blog/${FIXTURE_SLUG}/`;
// Hash-route to the canary entry editor — the SSOT both the initial
// navigation and the unpublish-leg re-open use (so the path cannot drift).
const ENTRY_EDIT_URL = `${PROD_ADMIN}#/collections/posts/entries/2024-01-02-${FIXTURE_SLUG}`;
const PROD_CANARY = process.env.PROD_CANARY === "1";

async function fetchFixtureFromMain() {
  return gh(`/repos/${HOST_REPO}/contents/${FIXTURE_PATH}?ref=main`);
}

// `readPublishedFlag` is shared from ./fixture-baseline (#1053 DRY'd
// the five per-spec copies). The shared regex also tolerates quoted
// values — a strict superset of this spec's old `(true|false)`-only
// copy; the fixture and the afterAll harness only ever write unquoted
// values, so behaviour for this spec's inputs is unchanged.

// Two full publish chains run serially:
//   - chain 1: publish (URL 4xx → 200)
//   - chain 2: unpublish (URL 200 → 4xx)
// Each is roughly the same shape as cms-publish-loop's mutation
// (validate-content + auto-merge + deploy-production). With each
// URL-wait capped at 15 min (matching the prod-mutate spec's
// budget after commit 880a34d) plus admin login + UI clicks +
// cleanup, ~40 min total covers worst-case runner contention.
// Retries disabled — real-state mutation.
const TEST_TIMEOUT_MS = 40 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

async function urlServesPost(page) {
  const res = await page.request.get(PUBLIC_URL, { failOnStatusCode: false });
  return res.status() === 200;
}

async function url404s(page) {
  const res = await page.request.get(PUBLIC_URL, { failOnStatusCode: false });
  const s = res.status();
  return s >= 400 && s < 500;
}

test(
  "CMS unpublish + re-publish — flip published flag toggles URL visibility",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(!getPat(), "CMS_E2E_PAT not set — host-repo unpublish spec disabled.");
    test.skip(
      process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1",
      "RUN_HOST_REPO_PUBLISH_LOOP not set — opt-in via the cms-publish-loop-host workflow.",
    );
    // #33/#21 — a base_collections:[] bio renders no Posts collection, so the
    // unpublish/republish round-trip has nothing to act on; skip green there.
    test.skip(...guard(SITE_ROOT, "cms-unpublish-republish.spec.js"));

    // Persistent dialog handler — Decap uses native window.confirm()
    // for the publish-now confirmation in some flows; without this
    // listener Playwright auto-dismisses the dialog and Decap reads
    // it as "user cancelled," silently aborting the chain. See
    // AGENTS.md "Test-Driven Design" section.
    page.on("dialog", (d) => d.accept());

    // ── 0. Confirm baseline before driving admin ────────────────────
    // Read the source fixture from main and verify it asserts
    // `published: false` — this is the baseline the spec restores in
    // cleanup, and a spec body that started against a different
    // baseline would corrupt the next run. UI-driven assertion below
    // confirms the editor agrees.
    await test.step("Confirm fixture file's baseline is published: false on main", async () => {
      const text = fs.readFileSync(path.join(SITE_ROOT, FIXTURE_PATH), "utf8");
      if (!/^published:\s*false\s*$/m.test(text)) {
        throw new Error(
          `${FIXTURE_PATH} on main is not at baseline (published: false). Reset before running this spec.`,
        );
      }
    });

    await test.step("Confirm public URL 4xxs before driving admin", async () => {
      const ok404 = await url404s(page);
      expect(ok404, `${PUBLIC_URL} should 4xx at baseline`).toBe(true);
    });

    // ── 1. Open admin, navigate to the unpublish-canary entry ──────
    await seedDecapAuth(page);
    await test.step("Load production admin", async () => {
      await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Navigate to the unpublish-canary post entry", async () => {
      // Direct URL nav is deterministic and bypasses any
      // collection-list ordering quirks.
      //
      // Decap's hash-route entry mount is occasionally slow on cold
      // CDN cache (especially right after a deploy-production), and
      // the failure mode is a stuck Title field. Two-attempt retry:
      // navigate → wait up to 60s for Title → on timeout, reload
      // (forcing a fresh asset fetch) and try once more. 60s per
      // leg, so worst-case ~120s before this step fails.
      const titleLocator = page.getByRole("textbox", { name: /^Title$/i });
      const targetUrl = ENTRY_EDIT_URL;
      let lastErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt === 1) {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          } else {
            console.warn(
              `[unpublish-republish] Title field didn't appear within 60s on attempt 1; reloading and retrying`,
            );
            await page.reload({ waitUntil: "domcontentloaded" });
          }
          await expect(titleLocator).toBeVisible({ timeout: 60_000 });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
    });

    await test.step("Verify the editor reads Published toggle as OFF (baseline)", async () => {
      // The Published widget is a switch (role="switch"), state via
      // aria-checked — see e2e/cms-editor-ui.js (shared so the selector
      // can't drift, #1723). 30s window: this is the first view of the
      // editor on a freshly-loaded prod surface, where the switch can take
      // a moment to hydrate (preserves the pre-refactor visibility tolerance).
      await expectPublished(page, false, { timeout: 30_000 });
    });

    // ── 2. Re-publish leg: toggle ON, Save, drive workflow → URL 200 ──
    await test.step("Toggle Published → ON via UI", async () => {
      // Idempotent toggle (only clicks if not already ON) via the shared
      // switch helper — guards against an earlier abort leaving it ON.
      await setPublished(page, true);
    });

    await test.step("Save → Status:Ready → Publish Now (re-publish)", async () => {
      await saveEntry(page);
      await publishViaUi(page);
    });

    await test.step("Wait for /blog/e2e-unpublish-canary/ to serve (URL 200)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => urlServesPost(page),
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // ── 3. Unpublish leg: toggle OFF, Save, drive workflow → URL 404 ──
    // Symmetric to the step-1 "reads OFF (baseline)" gate: after "Publish
    // now" Decap reloads the entry in place, and the Published switch
    // briefly shows its default (OFF) before re-hydrating the now-persisted
    // published: true. The idempotent setPublished(false) below must NOT
    // race into that window — it would read OFF, skip the click, and leave
    // the form un-dirtied, so the Save button stays `disabled` and the save
    // click times out (the host-loop "layer-5" failure, #80; the on-prod
    // failure log showed `<button disabled ...SaveButton...>Save</button>`).
    // Re-open the entry fresh (forcing a re-fetch from main, which is now
    // published: true) and wait for the switch to read ON before toggling.
    await test.step("Re-open entry (FULL reload) and confirm Published reads ON before unpublishing", async () => {
      // A FULL page.reload() -- not just the hash-route goto -- is required.
      // The re-publish leg's "Publish Now" returns the shim's synthetic 422, so
      // Decap reports a publish error and KEEPS the entry in its in-memory
      // editorial draft (UNPUBLISHED_ENTRY_PUBLISH_FAILURE never clears the
      // entity). A hash-only navigation re-reads that stale draft; Decap only
      // re-derives editorial state from the backend on a fresh app boot
      // (CONFIG_SUCCESS). By now the re-publish PR has merged (the URL served
      // 200 above) and delete_branch_on_merge has removed its
      // cms/posts/2024-01-02-e2e-unpublish-canary branch, so the reload makes
      // Decap re-fetch the entry as a PUBLISHED file. The unpublish edit below
      // then opens a FRESH editorial PR. Without the reload the edit auto-saves
      // into the stale draft on the (now-gone) branch, no new PR opens, no
      // deploy fires, and the URL-404 wait times out (#80 layer 11, run
      // 28342322662 -- screenshot showed Status:Ready + "Not yet published").
      await page.goto(ENTRY_EDIT_URL, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 60_000,
      });
      await expectPublished(page, true, { timeout: 30_000 });
    });

    await test.step("Toggle Published → OFF via UI", async () => {
      await setPublished(page, false);
    });

    await test.step("Save → Status:Ready → Publish Now (unpublish)", async () => {
      await saveEntry(page);
      await publishViaUi(page);
    });

    await test.step("Wait for /blog/e2e-unpublish-canary/ to 4xx (URL hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => url404s(page),
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });
  },
);

// Safety-net harness: the spec body's last leg flips Published OFF and
// waits for the URL to 404, so a passing run already lands at baseline.
// This hook only acts when the UI cleanup didn't complete (test failed
// somewhere between the publish and unpublish legs, leaving the fixture
// at `published: true` on main). Reading the file once and short-
// circuiting on the clean case keeps the hook silent in the happy path.
test.afterAll(async () => {
  if (PROD_CANARY) return; // daily canary probe doesn't mutate
  if (!getPat()) return; // PAT-less runs can't write anyway
  // Mirror the test-body skip: this hook recovers from a failed
  // mid-mutation in THIS run. Outside the host-loop workflow the
  // body never runs, so there's nothing to clean up — and reading +
  // writing the canary from e.g. e2e-real while host-loop is
  // mid-flight on a parallel run races the Contents API SHA and
  // returns 409. Only cleanup in the same context that owns the
  // mutation.
  if (process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1") return;
  let current;
  try {
    current = await fetchFixtureFromMain();
  } catch (e) {
    console.warn(
      `[cleanup-harness] couldn't read ${FIXTURE_PATH} from main; skipping safety net: ${e && e.message}`,
    );
    return;
  }
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  const stillPublished = readPublishedFlag(decoded) === true;
  if (!stillPublished) {
    console.log(
      "[cleanup-harness] unpublish-canary at baseline (published: false); UI cleanup succeeded — no safety net needed",
    );
    return;
  }
  console.warn(
    "[cleanup-harness] unpublish-canary on main is still published: true after the UI cleanup; restoring baseline via Contents API",
  );
  // Derive the baseline from the checked-in fixture itself, forcing
  // ONLY `published: false` and leaving every other byte alone
  // (forcePublishedFalse from ./fixture-baseline — the shared on-disk-
  // derive helper; #1053. The prod-mutate / media loops that once shared
  // this restore pattern went ephemeral in #1771 step 4, so this spec is
  // its lone remaining caller.)
  //
  // The previous implementation hard-coded the entire front matter +
  // body as a literal array — a drift trap: any field added to the
  // committed fixture but not to the literal silently disappeared on
  // every safety-net commit. Exactly what happened to `test_fixture:
  // true` (added in PR #1043 / 7243e08, never mirrored here, dropped
  // by this hook in 5fcd9be) — main lost the flag, the
  // `cms-posts-list-enhance.spec.js:162` required check then red-
  // failed every PR until restored (PR #1177 → run 26114231574). The
  // forcePublishedFalse approach makes future fixture-frontmatter
  // edits flow through automatically.
  const baselineFileText = forcePublishedFalse(
    fs.readFileSync(path.join(SITE_ROOT, FIXTURE_PATH), "utf8"),
    FIXTURE_PATH,
  );
  // Fire-and-forget: open a `cms/ready`-labelled PR (auto-merges in the
  // background) instead of a direct PUT to main. adamdaniel's main ruleset has
  // bypass_actors:[] so a direct PUT 409s ("Changes must be made through a pull
  // request"), which silently left the canary mutated + served PUBLICLY at
  // /blog/e2e-unpublish-canary/ (#1815 host leg). Mirrors cms-publish-loop's
  // afterAll safety-net; the daily sweep cleans up any orphan PR.
  await seedFixtureViaPr({
    slug: FIXTURE_SLUG,
    runId: `harness-cleanup-${Date.now()}`,
    filePath: FIXTURE_PATH,
    bodyText: baselineFileText,
    message:
      "test(unpublish): harness safety-net reset to published: false (UI cleanup left mutation)",
    skipWaitForMerge: true,
  });
});
