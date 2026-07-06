// @lane: real — drives the real Decap CMS in a PR preview env against real GitHub
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — PR_NUMBER / PR_HEAD_REF / CMS_E2E_PAT aren't wired into the
// standard PR matrix — so selecting + bringing it up just to no-op is
// pure waste. The dedicated preview workflow exercises this path.

/*
 * Real-browser end-to-end test for the CMS publish loop driven through a
 * PR-preview environment (preview-pr<N>.adamdaniel.ai/admin/), targeting
 * the PR's head branch.
 *
 * Why a preview-env variant: the host-repo spec (cms-publish-loop.spec.js)
 * tests the loop into `main`, but every other contributor flow happens on
 * a feature branch's preview. The preview admin's `admin/config.yml` is
 * patched at deploy time to use `backend.branch = <head ref>`, so saves
 * open `cms/...` PRs against the feature branch — a different code path
 * (and a different branch-protection regime) from the main flow. This
 * spec validates that loop end-to-end on a real subdomain.
 *
 * Gating:
 *   - PR_NUMBER must be set (the workflow exposes it from
 *     `github.event.pull_request.number`).
 *   - PR_HEAD_REF must be set (the workflow exposes it from
 *     `github.event.pull_request.head.ref`).
 *   - CMS_E2E_PAT must be set.
 *   - Runs once on chromium-desktop-3k only.
 *
 * Cleanup: writes the canary baseline back to the PR head branch via the
 * Contents API. Because the head branch belongs to a feature PR, a stale
 * canary state has zero blast radius — when the parent PR merges (or
 * closes), the branch is deleted and the canary edit dies with it.
 */
const path = require("node:path");
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { findCanary, makeMarker } = require("./canary-content");
const { closeStaleDecapPrOnBranch } = require("./cms-fixture-pr");
const {
  addLabel,
  fetchPublicUrl,
  gh,
  makePreviewCanaryRecoverer,
  waitForCmsPullRequest,
  waitForMerge,
} = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const { previewTarget } = require("./cms-host");
const { guard } = require("./base-collections-guards");

// SITE_ROOT — the consuming site's repo root; the #21 guard-registry meta-proof
// overrides it to point at a fixture.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

const CANARY = findCanary("page");
// No GITHUB_HEAD_REF fallback — see cms-delete-published-preview.spec.js
// for the loop it caused. PR_HEAD_REF is set only by the dedicated
// preview workflow; falling back to the auto-populated GITHUB_HEAD_REF
// let this @admin-write spec run (and mutate the PR head branch) inside
// e2e-tests.yml's e2e-admin lane on every pull_request event.
const PR_HEAD_REF = process.env.PR_HEAD_REF || "";

// Host triplet now resolves through the shared cms-host resolver. The
// `host` is "" when no PR number is resolvable — preserving the old
// `PR_NUMBER ? … : ""` self-skip guard exactly (the spec test.skip's on
// `!PR_NUMBER` before any PREVIEW_* value is used).
const {
  host: PREVIEW_HOST,
  adminUrl: PREVIEW_ADMIN,
  pillId: PILL_PREVIEW,
  prNumber: PR_NUMBER,
} = previewTarget();
const PREVIEW_PUBLIC_URL = `${PREVIEW_HOST}${CANARY.publicPath}`;

// #1723 Cat 1 (preview-loop port, 2026-07): the old 12-min (720,000ms)
// budget was structurally too small for the REAL chain this spec drives —
// Decap save -> cms/<col>/<slug> PR -> auto-merge nudge (5-min cron) ->
// merge -> deploy-preview (~2 min) -> CloudFront. Two real adamdaniel.ai
// dispatches (runs 28755547169 and 28757192011) both died with the exact
// "Test timeout of 720000ms exceeded" message at the marker-live wait,
// even though the chain itself was healthy: PR #2457 opened 21:32:00,
// merged 21:42:10 (~10m), deploy-preview success 21:43:55 (~2m later) —
// 13m55s total — while this test's own budget was only 12m. PR #2459
// showed the same shape (merged 22:45:24, deploy success 22:45:30, test
// died 22:47:03). Sized like the prod-mutate/delete-preview siblings:
// baseline confirm (8m) + PR-open wait (5m) + the NEW merge wait (25m,
// below) + URL-reflect wait (10m) per leg, TWO legs (forward + cleanup)
// ~= 88m worst-case sum; 90m leaves a little slack for the in-browser UI
// steps without inflating past what the workflow's timeout-minutes
// (bumped alongside this) can hold.
const TEST_TIMEOUT_MS = 90 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  // Real-state mutation; a Playwright retry just re-walks the same
  // broken chain after wasting another ~90 min — and on the
  // cms-publish-loop-preview workflow's (now enlarged) timeout-minutes,
  // a retry would still risk running out of GHA budget and getting
  // cancelled mid-attempt (run #25468569663 hit exactly this shape on
  // 2026-05-07, at the old smaller budget).
  retries: 0,
});

function toContentBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

async function fetchCanaryFromBranch(branch) {
  return gh(`/repos/${HOST_REPO}/contents/${CANARY.path}?ref=${encodeURIComponent(branch)}`);
}

async function writeCanaryOnBranch({ branch, bodyText, message }) {
  const current = await fetchCanaryFromBranch(branch);
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  const fmEnd = decoded.indexOf("\n---\n", 4);
  if (fmEnd < 0) throw new Error("Canary file is missing closing front-matter delimiter.");
  const frontMatter = decoded.slice(0, fmEnd + 5);
  const newFile = `${frontMatter}\n${bodyText}\n`;
  return gh(`/repos/${HOST_REPO}/contents/${CANARY.path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: toContentBase64(newFile),
      sha: current.sha,
      branch,
    }),
  });
}

test(
  "CMS publish loop — preview env, target PR head branch",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(!getPat(), "CMS_E2E_PAT not set — preview publish-loop disabled.");
    test.skip(
      !PR_NUMBER || !PR_HEAD_REF,
      "PR_NUMBER / PR_HEAD_REF not set — this spec only runs in PR CI.",
    );
    // #21 — a single-page consumer ships no `_e2e/canary-*.md` to drive the
    // preview-env publish loop against. Guarded via the shared registry on the
    // build-INDEPENDENT hasE2ECanaries signal. Full consumer → RUNS.
    test.skip(...guard(SITE_ROOT, "cms-publish-loop-preview.spec.js"));

    const runId = Date.now();
    const marker = makeMarker(`preview-${CANARY.id}`, runId);
    const baselineBody = CANARY.baseline;

    // ── 0. Reset canary on the PR head branch ───────────────────────
    await test.step("Reset canary baseline on PR head branch via Contents API", async () => {
      await writeCanaryOnBranch({
        branch: PR_HEAD_REF,
        bodyText: `${baselineBody}\n\nThis URL exists so the automated end-to-end publish-loop tests have a stable\ntarget to assert against on both preview-pr<N>.adamdaniel.ai and\nadamdaniel.ai. The body is replaced during a test run and reset to this\nbaseline in cleanup, so the public URL always renders innocuous content\nbetween runs.\n\nIf this is the only thing you can see, no test is currently in progress.`,
        message: `test(canary): reset page baseline before preview publish-loop run ${runId}`,
      });
    });

    await test.step("Confirm baseline is live on preview before driving admin", async () => {
      await fetchPublicUrl(PREVIEW_PUBLIC_URL, {
        expectContent: baselineBody,
        timeoutMs: 8 * 60 * 1000,
      });
    });

    await seedDecapAuth(page);
    await test.step("Load preview admin", async () => {
      await page.goto(PREVIEW_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Navigate to canary entry", async () => {
      // Mirror the host-loop spec's navigate-by-slug pattern: go
      // straight to the entry instead of clicking the first /Canary/i
      // link in the collection list. The e2e collection has multiple
      // canaries (page/post/project) plus any leftover throw-away
      // `canary-delete-<runId>` fixtures from failed delete-spec runs,
      // and the sidebar's display order can't be relied on to land on
      // the configured one (CANARY.id). Run #25470995760 hit exactly
      // this — `.getByRole("link", { name: /Canary/i }).first()`
      // landed on a stale `canary-delete-1778008012598` entry, the
      // marker insert went into the wrong file, and Decap opened a
      // cms PR for a `_e2e/canary-delete-*` change that
      // `waitForCmsPullRequest({ filePath: "_e2e/canary-page.md" })`
      // never matched.
      await page.goto(
        `${PREVIEW_ADMIN}#/collections/${CANARY.cmsCollection}/entries/${CANARY.slug}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Insert run marker into body and Save", async () => {
      // The e2e collection's body is `widget: text` (plain textarea) per
      // admin/config.yml — it used to be `widget: markdown` (Slate
      // WYSIWYG) but the Slate serializer doubled every soft line wrap
      // on save (PR #882). The textarea preserves typed text verbatim.
      // Title is a single-line `<input>`; date/technology/hidden fields
      // are not textareas — `textarea` is unambiguous on this view.
      // `:visible` filter — Decap appends a hidden clipboard textarea
      // (tabindex=-1 aria-hidden=true) whose append timing races with
      // `.last()` resolution. See cms-publish-loop.spec.js step 3 for
      // the full incident note. Mirroring the filter keeps the preview
      // and prod publish-loop specs aligned.
      const body = page.locator("textarea:visible").last();
      await body.click();
      await body.press("End");
      await body.pressSequentially(`\n\n${marker}\n`);
      await page.getByRole("button", { name: /^Save$/i }).click();
      // In editorial_workflow mode (preview admin), Save stays
      // disabled after the save completes — the toolbar swaps in
      // status pills + a "Publish" button. Wait for the "Changes
      // saved" status text instead of the (incorrect) toBeEnabled
      // signal that the host-loop spec also walked away from.
      await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
        timeout: 60_000,
      });
    });

    let pr;
    await test.step("Wait for Decap to open the cms/... PR against the PR head", async () => {
      pr = await waitForCmsPullRequest({
        base: PR_HEAD_REF,
        filePath: CANARY.path,
        canaryMarker: marker,
        timeoutMs: 5 * 60 * 1000,
      });
    });

    // Apply cms/ready directly (mirrors the prod spec's "Set Status:
    // Ready" UI click — Decap has the same dropdown in preview-mode
    // admin, but we'd need a separate UI exercise to validate it
    // there, and the editorial-workflow chain is identical from this
    // label onward). Once cms/ready lands,
    // cms-editorial-workflow.yml's auto-merge-when-ready job
    // enables auto-merge; validate-content + the PR's required
    // checks then land the PR into PR_HEAD_REF and trigger
    // deploy-preview.
    //
    // NB: when this Save landed in an ALREADY-OPEN, already-cms/ready
    // PR (Decap force-pushes the same cms/* branch on re-saves),
    // addLabel's default refireIfPresent removes + re-adds the label so
    // a FRESH `labeled` event fires for the NEW head — without it the
    // POST is a silent no-op event-wise and auto-merge-when-ready
    // (labeled-only trigger) never evaluates the new head. Empirical:
    // adamdaniel PR #2484 — cms/ready labeled 04:29:39, re-save
    // head_ref_force_pushed 05:16:08 with NO subsequent labeled event,
    // waitForMerge timed out 05:42.
    await test.step("Label PR cms/ready", async () => {
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });

    // ── #1723 Cat 1 port: explicit merge-aware wait ──────────────────
    // Ports the prod-mutate / delete-preview pattern (they wait on
    // waitForMerge BEFORE polling the public URL) instead of relying
    // solely on a post-hoc budget-exhaustion probe. This makes a real
    // auto-merge/editorial-workflow miss fail HERE, with a clear "PR
    // never merged" message, rather than surfacing 900s later as an
    // ambiguous "URL never reflected the change." `pr` is whichever open
    // cms/... PR waitForCmsPullRequest matched — its "opened OR updated"
    // contract (see its docstring) already covers a Save landing in an
    // ALREADY-OPEN PR for this entry (Decap force-pushes the same
    // cms/<collection>/<slug> branch on every Save), so no separate
    // lookup-by-branch is needed here. 25-min budget mirrors
    // cms-delete-published-preview.spec.js's seed-leg waitForMerge (same
    // preview auto-merge chain, same observed latency profile).
    await test.step("Wait for the create PR to actually merge before polling the preview URL", async () => {
      await waitForMerge({ prNumber: pr.number, timeoutMs: 25 * 60 * 1000 });
    });

    // ── Wait for the preview deploy-status pill spinner→settled ──
    //
    // The pill is the editor-facing signal for "your change is live
    // on the PR's preview environment." Anchoring the wait on the
    // pill DOM (instead of polling the GitHub API for PR-merge state
    // and deploy-preview-run state) is the contract this test
    // asserts. If the pill misses the in-progress window, stays
    // spinning past success, or flips to failure, that IS the
    // regression — the previous API-based version of these steps
    // would have hidden a real pill bug.
    //
    // Navigate to /admin/ on the PR's preview subdomain so the pill
    // scripts have a stable shell while the auto-merge → deploy
    // chain runs in the background.
    // STAY on the entry editor view (the canary-page entry) — that's
    // where deploy-status-pill.js injects the pill. Poll the preview
    // URL until it serves the marker; along the way watch the pill
    // for failure (fast-fail) and assert it lands in the terminal
    // hidden state. We don't gate on the pill's in_progress spinner —
    // deploy-preview can complete in 15–30 s, less than the pill's
    // 30-s polling interval, so the spinner state can pass entirely
    // between two polls without rendering.
    await test.step("Wait for the marker to be live on the preview subdomain (and pill terminal-hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PREVIEW,
        urlCheck: async () => {
          const res = await page.request.get(PREVIEW_PUBLIC_URL, {
            failOnStatusCode: false,
          });
          if (res.status() !== 200) return false;
          return (await res.text()).includes(marker);
        },
        urlTimeoutMs: 10 * 60 * 1000,
        // FIX 1 (#82): recover the green-but-stuck-BLOCKED forward canary PR.
        // Kept over the generic makeDeployQueueExtender: this recoverer
        // already grants queue/backlog-aware extensions (merged-awaiting-
        // deploy / checks-not-green => perDeployMs) AND can actively force
        // a stuck-BLOCKED PR's merge — strictly more capable for OUR OWN
        // labelled cms/* canary than a plain deploy-lane-activity probe,
        // and (unlike makeDeployQueueExtender's `deploy-production.yml`
        // default) it never needs a preview-vs-prod lane parameter at
        // all, since it reasons about the PR/branch-protection state
        // directly rather than GHA workflow-run activity. The NEW
        // explicit waitForMerge above already confirms the merge landed
        // before this wait even starts, so this recoverer is now mostly
        // defense-in-depth for the deploy-preview + CDN leg.
        onBudgetExhausted: makePreviewCanaryRecoverer({
          base: PR_HEAD_REF,
          getPrNumber: () => pr.number,
        }),
      });
    });

    // ── Cleanup via Decap UI (the user-facing path) ────────────────
    // Drive Decap to remove the marker, restoring the canary body to
    // baseline. Symmetrical with the forward leg — Save → cms PR
    // (against PR_HEAD_REF) → cms/ready → auto-merge → deploy-preview
    // re-renders → URL serves baseline. Per AGENTS.md "no back doors
    // in setup or cleanup either".
    await test.step("Cleanup via UI: replace body with baseline, Save, label cms/ready", async () => {
      // Reset Decap's editorial state before the second Save. The
      // forward leg's cms/<col>/<slug> PR has merged into PR_HEAD_REF
      // and its branch is consumed; Decap reuses a FIXED branch per
      // entry, and the in-memory editorial store from the forward leg
      // still believes that (now-merged) branch is its working ref. A
      // bare `page.goto(...#/...entries/...)` is a same-document hash
      // change — the SPA never reloads, so the stale store persists and
      // the cleanup Save does NOT open a fresh cms PR (run
      // #26006678919 hit exactly this: only the forward PR #1021 ever
      // existed; the cleanup `waitForCmsPullRequest` then timed out
      // with nothing to find). Close any stale branch/PR server-side,
      // then force a full document reload so Decap re-reads the entry's
      // editorial status from GitHub — seeing no open PR, the next Save
      // starts a fresh draft and opens a new PR.
      await closeStaleDecapPrOnBranch({
        branch: `cms/${CANARY.cmsCollection}/${CANARY.slug}`,
      });
      await page.goto(
        `${PREVIEW_ADMIN}#/collections/${CANARY.cmsCollection}/entries/${CANARY.slug}`,
        { waitUntil: "domcontentloaded" },
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });

      // `widget: text` plain textarea — see the marker-insert step above
      // for the rationale.
      // `:visible` filter — Decap appends a hidden clipboard textarea
      // (tabindex=-1 aria-hidden=true) whose append timing races with
      // `.last()` resolution. See cms-publish-loop.spec.js step 3 for
      // the full incident note. Mirroring the filter keeps the preview
      // and prod publish-loop specs aligned.
      const body = page.locator("textarea:visible").last();
      await body.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await body.pressSequentially(`${CANARY.baselineBody}\n`);

      await page.getByRole("button", { name: /^Save$/i }).click();
      await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
        timeout: 60_000,
      });

      // Find the cms PR Decap just opened for this Save and label it
      // cms/ready so editorial-workflow auto-merges it. (Mirrors the
      // forward leg's labelling step.)
      // Match on the forward run's unique marker, NOT the baseline body
      // sentence. The cleanup commit REMOVES the marker, so it appears
      // as a `-` line in this PR's `_e2e/canary-page.md` patch —
      // guaranteed present. The old `canaryMarker: baselineBody` (the
      // title sentence) sat at the TOP of the body, far from the
      // end-of-body marker deletion, so it fell outside the unified-diff
      // context window and never matched even when Decap DID open the PR.
      const cleanupPr = await waitForCmsPullRequest({
        base: PR_HEAD_REF,
        filePath: CANARY.path,
        canaryMarker: marker,
        timeoutMs: 5 * 60 * 1000,
      });
      await addLabel({ prNumber: cleanupPr.number, label: "cms/ready" });

      // #1723 Cat 1 port (same rationale as the forward leg above): wait
      // for the cleanup PR to actually merge before polling the public
      // URL, so a real auto-merge miss fails here with an unambiguous
      // message instead of showing up as "URL never reverted to
      // baseline" minutes later. waitForCmsPullRequest already resolved
      // whichever open cms/... PR carries this leg's marker (new-or-
      // updated), so cleanupPr.number is the right target.
      await test.step("Wait for the cleanup PR to actually merge before polling the preview URL", async () => {
        await waitForMerge({ prNumber: cleanupPr.number, timeoutMs: 25 * 60 * 1000 });
      });

      // Wait for the URL to revert to baseline (no marker).
      await waitForChangeReflected({
        page,
        pillId: PILL_PREVIEW,
        urlCheck: async () => {
          const res = await page.request.get(PREVIEW_PUBLIC_URL, {
            failOnStatusCode: false,
          });
          if (res.status() !== 200) return false;
          const text = await res.text();
          return !text.includes(marker) && text.includes(baselineBody);
        },
        urlTimeoutMs: 10 * 60 * 1000,
        // FIX 1 (#82): recover the green-but-stuck-BLOCKED cleanup canary
        // PR. Kept over makeDeployQueueExtender for the same reason as the
        // forward leg above (PR/branch-protection-state recovery, no
        // deploy-workflow lane parameter needed); the explicit waitForMerge
        // above already confirms the merge before this wait starts.
        onBudgetExhausted: makePreviewCanaryRecoverer({
          base: PR_HEAD_REF,
          getPrNumber: () => cleanupPr.number,
        }),
      });
    });
  },
);

// ── Test-harness cleanup safety net ───────────────────────────────
//
// Mirrors cms-publish-loop.spec.js's afterAll harness. If the
// in-spec UI cleanup left the canary mutated on the PR head branch
// (test aborted, Decap regression mid-cleanup, etc.), this hook
// reads canary-page.md from PR_HEAD_REF and writes baseline back
// via the Contents API. SKIPS when the file is already at baseline.
test.afterAll(async () => {
  if (!getPat()) return;
  if (!PR_HEAD_REF) return;
  let current;
  try {
    current = await fetchCanaryFromBranch(PR_HEAD_REF);
  } catch (e) {
    console.warn(
      `[cleanup-harness] couldn't read ${CANARY.path} from ${PR_HEAD_REF}; skipping safety net: ${e && e.message}`,
    );
    return;
  }
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  // Two kinds of "UI cleanup left mutation" — see the host-loop
  // afterAll for the rationale. Body-equality check guards against
  // formatting drift (PR #882) in addition to the marker regex.
  const fmEnd = decoded.indexOf("\n---\n", 4);
  const fileBody =
    fmEnd < 0
      ? decoded
      : decoded
          .slice(fmEnd + 5)
          .replace(/^\n+/, "")
          .replace(/\n+$/, "");
  const expectedBody = CANARY.baselineBody;
  // `[a-z-]+` (not `[a-z]+`): this spec's marker is
  // `e2e-publish-loop:preview-<id>:<runId>` — the hyphen in
  // `preview-page` made the old `[a-z]+:` class fail to match, so the
  // safety net could falsely report "at baseline" and skip restoring
  // a still-mutated head branch.
  const hasMarker = /e2e-publish-loop:[a-z-]+:\d+/.test(decoded);
  const bodyDrift = fileBody !== expectedBody;
  if (!hasMarker && !bodyDrift) {
    console.log(
      "[cleanup-harness] preview canary at baseline; UI-driven cleanup succeeded — no safety net needed",
    );
    return;
  }
  const reason = hasMarker
    ? "marker still present after UI cleanup"
    : "body diverges from canonical baseline (formatting drift)";
  console.warn(`[cleanup-harness] canary on ${PR_HEAD_REF}: ${reason}; restoring via Contents API`);
  await writeCanaryOnBranch({
    branch: PR_HEAD_REF,
    bodyText: expectedBody,
    message: `test(canary): harness safety-net reset of page baseline (${reason})`,
  });
});
