// @lane: real — exercises the real Decap → GitHub → Actions publish loop end to end
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — RUN_HOST_REPO_PUBLISH_LOOP is unset on the standard PR
// matrix — so selecting + bringing it up just to no-op is pure waste.
// The dedicated cms-publish-loop-host workflow runs it nightly.

/*
 * Real-browser, real-HTTP, real-GitHub end-to-end test for the full Decap
 * CMS publish loop on the host repo.
 *
 * Why: cms-smoke / cms-publish-flow drive `local_backend: true` (decap-server),
 * which forces simple mode regardless of `publish_mode`. cms-editorial-workflow
 * drives the in-browser `test-repo` backend. Neither crosses the boundary into
 * the GitHub backend, the cms-editorial-workflow.yml workflow, or the
 * deploy-production.yml deploy. Issue #79 captures the failure mode that bit
 * us on PR #76→#78: Decap labels its PRs with the namespaced
 * `decap-cms/ready`, but the workflow listened for the bare `cms/ready` —
 * label mismatch, publish loop silently stalled. This spec catches it.
 *
 * Flow:
 *
 *   0. (Setup) If the canary baseline isn't already on main from the
 *      previous cleanup, open a `cms/e2e-fixture/seed-…` PR that
 *      writes it back, label it `cms/ready`, and wait for auto-merge.
 *      Direct Contents-API writes to main are blocked by the branch
 *      ruleset (`pull_request` rule), so even setup has to flow
 *      through the same auto-merge path the test exercises.
 *
 *   1. Drive the production admin URL with a pre-seeded PAT session.
 *   2. Open the e2e collection → canary entry.
 *   3. Edit body to include a unique marker; click Save.
 *   4. Decap opens a `cms/...` PR. Find it via the GitHub API.
 *   5. Wait for cms-editorial-workflow.yml validate-content to pass.
 *   6. Drive the editor's Status dropdown from Draft → Ready.
 *   7. Assert that auto-merge was enabled on the PR.
 *   8. Assert the PR merges into main.
 *   9. Assert deploy-production.yml runs on main and completes successfully.
 *  10. Assert the public adamdaniel.ai canary URL contains the marker.
 *  11. (Cleanup) Open a second `cms/e2e-fixture/cleanup-…` PR that
 *      resets the canary baseline. Same auto-merge path as step 0;
 *      we await the merge so the next run starts clean.
 *
 * Gating:
 *   - CMS_E2E_PAT must be set (host-repo only — fork PRs / Dependabot skip).
 *   - Runs once on chromium-desktop-3k. Other projects skip — exercising 8
 *     browser variants serially of a 7-minute pipeline is wasted minutes.
 *   - CI workflow only schedules this spec when CMS-affecting paths change
 *     (admin/**, _config.yml, _layouts/{post,page,project,canary}.html,
 *     scripts/patch-preview-config.sh, .github/workflows/cms-*,
 *     .github/workflows/deploy-*, e2e/cms-*, _plugins/**).
 */
const { test, expect } = require("./base");
const { captureStep } = require("./manual-capture");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { CANARIES, findCanary, makeMarker } = require("./canary-content");
const {
  fetchPublicUrl,
  gh,
  waitForCmsPullRequest,
  makeDeployQueueExtender,
} = require("./github-actions-poll");
const { seedFixtureViaPr, closeStaleDecapPrOnBranch } = require("./cms-fixture-pr");
const { waitForChangeReflected } = require("./deploy-pill");
const { prodTarget } = require("./cms-host");

const CANARY = findCanary("post");
// Host triplet now resolves through the shared cms-host resolver so the
// prod and preview test surfaces can't drift. This is the fixed-prod
// loop; the values are byte-identical to the old literals.
const { host: PROD_HOST, adminUrl: PROD_ADMIN, pillId: PILL_PROD } = prodTarget();
const PUBLIC_URL = `${PROD_HOST}${CANARY.publicPath}`;

// E3 — `PROD_CANARY=1` gates a read-only daily canary probe (see
// `.github/workflows/canary-prod.yml`). When the env var is set, the
// mutating publish-loop test self-skips and a sibling read-only test
// runs against the public canary URLs only — no Decap login, no PR open,
// no label flip, no merge. The hard guard below makes that contract
// machine-checked: any code path that tries to mutate state (write to
// the Contents API, drive admin actions) calls assertNotProdCanary()
// and throws immediately if the gate has been breached.
const PROD_CANARY = process.env.PROD_CANARY === "1";

function assertNotProdCanary(action) {
  if (PROD_CANARY) {
    throw new Error(
      `PROD_CANARY=1 is read-only — refusing to ${action}. ` +
        `Daily canary probes must NEVER mutate prod state. If you reached ` +
        `this branch, the spec's read-only gate has been bypassed.`,
    );
  }
}

// The full pipeline runs three labelled-PR auto-merge cycles end to
// end:
//   1. Optional setup PR (only when the previous run's cleanup didn't
//      land — usually a no-op).
//   2. The Decap-driven cms/<col>/<slug> PR (the real subject of the
//      test).
//   3. The cleanup PR that resets the canary baseline.
// Each PR waits on the full required-check suite (validate-content +
// e2e shards + finalize) plus deploy-production on main. Worst-case
// runtime per cycle is ~10 min when runners are warm; the URL-wait
// cap is 15 min per leg (forward + cleanup) so the spec fits in
// ~40 min worst case. Stuck pipelines still fail fast rather than
// holding a runner for a full hour. Retries are explicitly disabled
// for the same reason: the publish-loop is a real-state mutation and
// a retry just re-runs the same broken chain after wasting another
// 40 min — the failure mode is almost never transient.
const TEST_TIMEOUT_MS = 40 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

/** Read the current main-branch SHA + content of the canary file. */
async function fetchCanaryFromMain() {
  return gh(`/repos/${HOST_REPO}/contents/${CANARY.path}?ref=main`);
}

/**
 * Compose a canary file body from the current front matter + a new
 * body string. The front matter is preserved verbatim (it carries the
 * canary_id, layout, permalink, etc. that the spec asserts against);
 * only the body below the second `---` is replaced.
 */
async function composeCanaryFile(bodyText) {
  const current = await fetchCanaryFromMain();
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  const fmEnd = decoded.indexOf("\n---\n", 4);
  if (fmEnd < 0) throw new Error("Canary file is missing closing front-matter delimiter.");
  const frontMatter = decoded.slice(0, fmEnd + 5);
  return `${frontMatter}\n${bodyText}\n`;
}

/**
 * Write a body to the canary file via a labelled PR that auto-merges.
 *
 * Direct writes to main are blocked by the `pull_request` rule on the
 * main-branch ruleset (.github/rulesets/main.json); the API returns
 * 409 "Repository rule violations found". `seedFixtureViaPr` opens a
 * `cms/e2e-fixture/seed-<slug>-<runId>` PR with the `cms/ready` label,
 * which engages cms-editorial-workflow.yml's `auto-merge-when-ready`
 * job — same path prod content edits use — then blocks until the PR
 * merges. Returns the merged-PR descriptor.
 */
async function writeCanaryViaPr({ runId, bodyText, message, prTitle, prBody, skipWaitForMerge }) {
  assertNotProdCanary("write to the canary file via a labelled PR");
  const newFile = await composeCanaryFile(bodyText);
  return seedFixtureViaPr({
    slug: CANARY.slug,
    runId,
    filePath: CANARY.path,
    bodyText: newFile,
    message,
    prTitle,
    skipWaitForMerge,
    prBody,
  });
}

test("CMS publish loop — host repo, target main", { tag: ["@admin-write"] }, async ({ page }) => {
  test.skip(
    PROD_CANARY,
    "PROD_CANARY=1 — daily canary probe runs the read-only @canary-readonly test instead.",
  );
  test.skip(
    !getPat(),
    "CMS_E2E_PAT not set — host-repo publish-loop disabled. (Forks and Dependabot are expected to land here.)",
  );
  // Opt-in marker mirroring RUN_PROD_MUTATE_PLAYGROUND. Without it, the
  // spec also runs inside e2e-tests.yml shard 1 on regular PRs — and
  // the cms/ PR it opens against main triggers another e2e-tests run
  // (whose shard 1 picks this same spec back up), force-pushing
  // concurrent commits to cms/<col>/<slug> and cancelling each other's
  // validate-content + auto-merge-when-ready labeled events. Until a
  // dedicated workflow opts in (mirroring cms-publish-loop-prod.yml),
  // self-skip on PRs and rely on the cms-publish-loop-prod-mutate
  // playground + read-only @canary-readonly probe for coverage.
  test.skip(
    process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1",
    "RUN_HOST_REPO_PUBLISH_LOOP not set — host-repo publish-loop spec is opt-in (avoids cms/* PR self-recursion in PR-time CI).",
  );

  const runId = Date.now();
  const marker = makeMarker(CANARY.id, runId);
  const baselineBody = CANARY.baseline;
  // Full canonical body (title sentence + explanatory paragraphs +
  // footer) — the single source of truth for both the API-path resets
  // (setup + safety-net) and the UI-path cleanup. See
  // `e2e/canary-content.js`. Keeping it in one place eliminates the
  // drift risk between the three sites that write the baseline back.
  const baselineFullBody = CANARY.baselineBody;

  // ── 0a. Close any stale Decap editorial-workflow PR on the
  // canary's fixed branch ────────────────────────────────────────
  // Decap reuses cms/<col>/<slug> per entry, so a prior run that
  // crashed at any stage past Save can leave a PR with a non-Draft
  // editorial-workflow label (decap-cms/pending_publish,
  // decap-cms/pending_review, decap-cms/ready). On the next run the
  // Save pushes onto the same branch — the labels persist — Decap's
  // toolbar shows "Status: Ready" instead of "Status: Draft" — the
  // step-6 button-wait below times out at 20 min. Pre-emptively
  // closing any open PR for this entry's branch resets to a clean
  // slate; Decap will open a fresh decap-cms/draft PR on the next
  // Save below.
  await test.step("Close any stale Decap editorial-workflow PR on the canary branch", async () => {
    await closeStaleDecapPrOnBranch({
      branch: `cms/${CANARY.cmsCollection}/${CANARY.slug}`,
    });
  });

  // ── 0. Reset canary to baseline before the run ──────────────────
  // The previous run may have crashed mid-flow; force a clean start.
  // The reset goes through a `cms/ready`-labelled PR + auto-merge
  // because the main-branch ruleset blocks direct Contents-API writes.
  await test.step("Reset canary to baseline via labelled PR (auto-merge)", async () => {
    const current = await fetchCanaryFromMain();
    const currentBody = Buffer.from(current.content, "base64").toString("utf8");
    if (!currentBody.includes(baselineBody)) {
      await writeCanaryViaPr({
        runId: `setup-${runId}`,
        bodyText: baselineFullBody,
        message: "test(canary): reset post baseline before publish-loop run",
      });
    }
  });

  await test.step("Confirm baseline is live before driving admin", async () => {
    await fetchPublicUrl(PUBLIC_URL, {
      expectContent: baselineBody,
      timeoutMs: 6 * 60 * 1000,
    });
  });

  // ── 1. Pre-seed Decap auth and open the prod admin ──────────────
  await seedDecapAuth(page);
  await test.step("Load production admin", async () => {
    await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
    // Decap renders the login button until it sees the auth in localStorage,
    // then mounts the editor. Wait for the collections sidebar.
    await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
      timeout: 60_000,
    });
  });

  // ── 2. Open the canary entry ────────────────────────────────────
  await test.step("Navigate to canary entry", async () => {
    // Go straight to the entry by slug instead of clicking the first
    // /Canary/i link in the collection list — the e2e collection has
    // page/post/project canaries and the sidebar's display order
    // can't be relied on to land on the configured one (CANARY.id).
    await page.goto(`${PROD_ADMIN}#/collections/${CANARY.cmsCollection}/entries/${CANARY.slug}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({ timeout: 30_000 });
  });

  // ── 3. Edit body and save as draft ──────────────────────────────
  await test.step("Insert run marker into body and Save", async () => {
    // The body is a `widget: text` plain textarea (admin/config.yml on
    // the e2e collection). It used to be `widget: markdown` (Slate
    // WYSIWYG) but Slate's serializer doubled every soft line wrap on
    // save, so the cleanup leg produced a body that disagreed with the
    // baseline and left a perpetually-open conflicting cms/e2e/* PR
    // (see PR #882). The textarea preserves typed text verbatim.
    //
    // The `:visible` filter is required: Decap renders an extra
    // `<textarea tabindex="-1" aria-hidden="true">` (clipboard shadow
    // input) that an unqualified `textarea.last()` may pick up,
    // depending on when it's appended to the DOM relative to the
    // visible body textarea. The race is timing-sensitive — schedule
    // runs historically won it, PR runs reliably lose it. Filter to
    // visible textareas to be deterministic. Precedent for the
    // `:visible` Playwright pseudo-class: cms-smoke.spec.js:250.
    const body = page.locator("textarea:visible").last();
    await body.click();
    // Move to the end of the existing body; appending the marker keeps
    // the canonical baseline body intact, so the diff is purely
    // additive and the safety-net's marker-regex check still trips.
    await body.press("End");
    await body.pressSequentially(`\n\n${marker}\n`);

    // Save (writes the draft entry to a new cms/<...> branch + opens a PR).
    await page.getByRole("button", { name: /^Save$/i }).click();
    // In editorial_workflow mode (prod admin), Save stays disabled
    // after the save completes — the toolbar swaps to "Status: Draft"
    // + a separate "Publish" button. Wait for the "Changes saved"
    // status text instead of the (incorrect) toBeEnabled signal.
    await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  // ── 4. Find the cms/... PR Decap opened ──────────────────────────
  let pr;
  await test.step("Wait for Decap to open the cms/... PR", async () => {
    pr = await waitForCmsPullRequest({
      base: "main",
      filePath: CANARY.path,
      canaryMarker: marker,
      timeoutMs: 5 * 60 * 1000,
    });
    expect(pr.number, "Decap PR number").toBeGreaterThan(0);
  });

  // ── 6. Drive Status: Ready via the UI dropdown ──────────────────
  // Editorial workflow: click the "Status: Draft" button, pick
  // "Ready" from the menu. Decap applies the `decap-cms/ready` label,
  // which cms-editorial-workflow.yml's auto-merge-when-ready job
  // accepts as a synonym for cms/ready and uses to enable auto-merge.
  // This replaces an earlier `addLabel({ label: "cms/ready" })` API
  // shortcut — the shortcut never exercised the dropdown handler that
  // a real operator triggers, which is exactly the surface area the
  // shim has to interoperate with.
  await test.step("Set Status: Ready via UI dropdown", async () => {
    await page.getByRole("button", { name: /^Status:\s*Draft$/i }).click();
    await page.getByRole("menuitem", { name: /^Ready$/i }).click();
    // The toolbar reflects the new status — the button text flips.
    await expect(page.getByRole("button", { name: /^Status:\s*Ready$/i })).toBeVisible({
      timeout: 30_000,
    });
  });

  // ── 6b. Drive Publish → Publish Now via the UI ──────────────────
  //
  // Click Publish → Publish Now. The chain that follows
  // (decap-cms/pending_publish label → cms-editorial-workflow.yml
  // maps to cms/ready → auto-merge fires → PR merges → deploy-
  // production runs → pill spins → pill hides) takes ~1–3 min
  // typically. We observe the chain SOLELY via the deploy-status
  // pill in the next step — no GitHub API peeks, no waiting on
  // Decap's local status-button transition (which lags the merge
  // by however long the entire chain takes; an earlier 60-s wait
  // on the "Published" flip flaked because the chain takes longer
  // than that under any meaningful load). If the click doesn't
  // trigger a deploy at all, the pill spinTimeoutMs in the next
  // step gives a clean, localised failure.
  await test.step("Click Publish → Publish Now via UI", async () => {
    await page.getByRole("button", { name: /^Publish$/i }).click();
    await page
      .getByRole("menuitem", { name: /publish now/i })
      .first()
      .click();
    // Don't wait for any UI transition here. The pill is the
    // ground truth for the chain's outcome. Decap closes the
    // Publish menu synchronously; a follow-up pill spin proves
    // the click reached the GitHub API.
  });

  // ── 7. Pill is the editor-facing wait signal for "deploy complete" ──
  //
  // After Publish Now, the chain that runs in the background is:
  //   Decap → cms-editorial-workflow.yml (validate-content + auto-
  //   merge-when-ready) → PR squash-merge → deploy-production.yml →
  //   deploy-status-pill polls and sees in_progress → spinner →
  //   pill polls and sees success → display: none.
  //
  // The pill is what an editor watches; it is the ground-truth user
  // signal for "your change is live." Anchoring the wait on the
  // pill DOM (instead of polling the GitHub API for PR-merge state
  // and deploy-run state) is the contract this test asserts. If the
  // pill misses the in-progress window or stays spinning past
  // success, that IS the regression — the previous API-based
  // version of this step would have hidden a real pill bug.
  //
  // Step 6b's "Click Publish → Publish Now" already drives the
  // chain. Navigate to /admin/ now so the pill scripts have a
  // stable shell to mount on while the chain runs in the
  // background, then wait for the spinner→settled lifecycle.
  // ── 7+8. Wait for the change to land on adamdaniel.ai ──────────
  //
  // STAY on the entry editor view — that's where deploy-status-pill.js
  // injects the pill. Poll the public URL until it serves the marker;
  // along the way, watch the pill for failure transitions (fast-fail)
  // and finally assert it lands in its terminal hidden state. We
  // intentionally do NOT gate on observing the pill's in_progress
  // spinner — production deploys often complete in 15–30 s, less than
  // the pill's 30-s polling interval, so the spinner state can pass
  // entirely between two polls without ever rendering. The URL
  // change is the user-facing ground truth; the pill's terminal
  // state confirms the editor's signal stayed consistent.
  await test.step("Wait for the marker to be live on adamdaniel.ai (and pill terminal-hidden)", async () => {
    await waitForChangeReflected({
      page,
      pillId: PILL_PROD,
      urlCheck: async () => {
        const res = await page.request.get(PUBLIC_URL, {
          failOnStatusCode: false,
        });
        if (res.status() !== 200) return false;
        return (await res.text()).includes(marker);
      },
      // 10 min covers cms-editorial-workflow + auto-merge + required
      // checks + deploy-production + CDN propagation under runner
      // saturation.
      urlTimeoutMs: 15 * 60 * 1000,
      onBudgetExhausted: makeDeployQueueExtender(),
    });
    await page.goto(PUBLIC_URL, { waitUntil: "domcontentloaded" });
    await captureStep(page, {
      section: "Verifying on the public site",
      step: "7.2",
      title: "Marker live on the production canary URL",
      body: "After the PR auto-merges and `deploy-production.yml` finishes, the canary URL on `adamdaniel.ai` reflects the edit. The deploy-status pill in `/admin/` settles to hidden once the deploy succeeds — that's the editor-facing 'change is live' signal.",
    });
  });

  // ── 9a. Cleanup via Decap UI (the user-facing path) ────────────
  //
  // Drive Decap to remove the marker we just appended, restoring the
  // canary body to its baseline. This is the editor's actual
  // "undo my edit" flow — Save → Status:Ready → Publish Now —
  // exercised symmetrically with the forward leg.
  //
  // Per AGENTS.md "no back doors in setup or cleanup either": the
  // forward leg (Save marker → URL serves marker) is symmetrical
  // with the cleanup leg (Save baseline → URL serves baseline);
  // both go through the same UI chain. The fixture-PR safety net
  // remains as 9b in case the UI-driven cleanup itself fails (e.g.
  // a Decap regression mid-run leaves the canary mutated even after
  // the spec attempted to restore baseline).
  await test.step("Cleanup via UI: remove marker, Save → Status:Ready → Publish Now", async () => {
    // Navigate back to the canary entry (we may have left for the
    // pill-watch step on /admin/).
    await page.goto(`${PROD_ADMIN}#/collections/${CANARY.cmsCollection}/entries/${CANARY.slug}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
      timeout: 30_000,
    });

    // Replace the body content with the canonical baseline. The body is
    // a `widget: text` plain textarea (see step 3 for why the e2e
    // collection no longer uses `widget: markdown`). Click, select all,
    // delete, retype. The textarea writes typed bytes verbatim, so the
    // resulting file matches `baselineFullBody` byte-for-byte and the
    // cms/e2e/canary-post PR Decap opens here has no spurious diff
    // against the API-path setup-reset / safety-net writes.
    //
    // `:visible` filter mirrors step 3 — Decap renders a hidden
    // clipboard textarea that an unqualified `.last()` may pick up
    // depending on DOM-append timing.
    const body = page.locator("textarea:visible").last();
    await body.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await body.pressSequentially(`${baselineFullBody}\n`);

    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole("button", { name: /^Status:\s*Draft$/i }).click();
    await page.getByRole("menuitem", { name: /^Ready$/i }).click();
    await expect(page.getByRole("button", { name: /^Status:\s*Ready$/i })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: /^Publish$/i }).click();
    await page
      .getByRole("menuitem", { name: /publish now/i })
      .first()
      .click();

    // Wait for the URL to serve baseline (no marker). Reuse
    // waitForChangeReflected with an inverted urlCheck — URL fetched,
    // body does NOT contain the marker.
    const { waitForChangeReflected, PILL_PROD: P } = require("./deploy-pill");
    await waitForChangeReflected({
      page,
      pillId: P,
      urlCheck: async () => {
        const res = await page.request.get(PUBLIC_URL, {
          failOnStatusCode: false,
        });
        if (res.status() !== 200) return false;
        const text = await res.text();
        return !text.includes(marker) && text.includes(baselineBody);
      },
      urlTimeoutMs: 15 * 60 * 1000,
      onBudgetExhausted: makeDeployQueueExtender(),
    });
  });
});

// ── Test-harness cleanup safety net ───────────────────────────────
//
// The test body's step 9a (Cleanup via UI) is the contract being
// validated — it drives the editor's actual "undo my edit" path. If
// it succeeds, the canary on main is at baseline AND the URL serves
// baseline content; this hook becomes a no-op.
//
// If 9a fails or the test aborts before reaching it (Playwright
// timeout, pill-watch failure, the marker leg never reached the
// URL, etc.), the canary file on main may still hold the marker.
// Leaving it that way breaks subsequent runs and pollutes the
// public URL between runs. This hook detects mutation by reading
// the canary file from main via the Contents API; if a marker is
// present, it opens a labelled fixture PR + auto-merges to restore
// baseline. If the file is already at baseline, it skips with a
// notice.
//
// Per AGENTS.md "no back doors in setup or cleanup either," this
// API-driven path is restricted to the harness-cleanup safety net
// — it never replaces the UI-driven cleanup leg, only fires when
// that leg has demonstrably failed to complete.
// eslint-disable-next-line no-empty-pattern -- no Playwright fixtures are needed, but the second positional arg (testInfo) IS used below; the empty destructure is required to skip to it.
test.afterAll(async ({}, testInfo) => {
  if (PROD_CANARY) return; // daily canary probe doesn't mutate
  if (!getPat()) return; // PAT-less local runs can't write anyway
  // Mirror the test-body skip: this hook recovers from a failed
  // mid-mutation in THIS run. Outside the host-loop workflow the
  // body never runs, so there's nothing to clean up — and reading
  // the canary marker from e.g. e2e-real while host-loop is
  // mid-flight on a parallel run can fire spurious cleanup PRs
  // against the in-flight mutation. Only cleanup in the same
  // context that owns the mutation.
  if (process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1") return;
  // Single-worker coordination: only the FIRST worker (workerIndex
  // 0) attempts the safety-net cleanup. Without this gate, all 8
  // browser-project workers in the e2e-tests matrix observe the
  // same stale-marker state on main and each open their OWN
  // cleanup PR — the cms/e2e-fixture/seed-canary-post-harness-
  // cleanup-* fan-out. Each PR auto-merges and triggers
  // deploy-production, which has `concurrency: { group: production,
  // cancel-in-progress: false }` — so deploys queue 8 deep,
  // unrelated specs (e.g. cms-unpublish-republish) sit at the back
  // of the queue, and their 15-min URL-wait cap blows. PR #517's
  // host-loop on commit bdae10a (run #25583629495) hit exactly
  // this. With workerIndex===0 gating, one stale-marker event on
  // main → one cleanup PR → one deploy → queue stays shallow.
  //
  // host-loop's own workflow only spawns one worker
  // (--project=chromium-desktop-3k) so the gate is a no-op there;
  // the e2e-tests matrix is the path that fans out.
  if (testInfo.workerIndex !== 0) return;
  // Bump the hook timeout from Playwright's 30s default. The
  // safety-net path opens a PR + applies a label via the GitHub
  // API; under runner contention 30s is too tight even with
  // skipWaitForMerge below. 2 min covers the worst case.
  test.setTimeout(2 * 60 * 1000);
  const CanaryFile = require("./canary-content").findCanary("post");
  let current;
  try {
    current = await fetchCanaryFromMain();
  } catch (e) {
    console.warn(
      `[cleanup-harness] couldn't read ${CanaryFile.path} from main; skipping safety-net check: ${e && e.message}`,
    );
    return;
  }
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  // Two kinds of "UI cleanup left mutation":
  //
  //   1. Marker still present — forward leg's `e2e-publish-loop:post:
  //      <runId>` survived in the body. UI cleanup didn't run or didn't
  //      remove it.
  //
  //   2. Formatting drift — marker is gone, but the body has been
  //      mangled (e.g., extra blank lines from a `widget: markdown`
  //      Slate round-trip; PR #882 is the case study, fixed by
  //      switching to `widget: text`). The marker-regex below would
  //      have missed this — the next `setup` step at the top of this
  //      spec would have re-opened the same conflicting PR forever.
  //
  // Body-equality is checked against the canonical
  // `buildBaselineBody()` output so any divergence triggers recovery,
  // not just markers.
  const fmEnd = decoded.indexOf("\n---\n", 4);
  const fileBody =
    fmEnd < 0
      ? decoded
      : decoded
          .slice(fmEnd + 5)
          .replace(/^\n+/, "")
          .replace(/\n+$/, "");
  const expectedBody = CanaryFile.baselineBody;
  const hasMarker = /e2e-publish-loop:[a-z]+:\d+/.test(decoded);
  const bodyDrift = fileBody !== expectedBody;
  if (!hasMarker && !bodyDrift) {
    console.log(
      "[cleanup-harness] canary at baseline; UI-driven cleanup succeeded — no API safety net needed",
    );
    return;
  }
  const reason = hasMarker
    ? "canary on main still contains a marker after the UI cleanup"
    : "canary on main body diverges from canonical baseline (formatting drift)";
  console.warn(`[cleanup-harness] ${reason}; opening fixture PR to restore baseline`);
  // Fire-and-forget: open the cleanup PR + apply cms/ready, then
  // return without waiting for auto-merge. The editorial-workflow
  // auto-merges in the background. Without this, the afterAll
  // would block on seedFixtureViaPr's 25-minute waitForMerge while
  // Playwright's 30s hook timeout kills it — the failure mode
  // empirically observed across 8 browser projects on PR #517 run
  // 25580846437. The daily sweep workflow handles any orphan PRs
  // (empty-diff because another worker won the race, or CI
  // failure) so leaking a few cleanup PRs is acceptable here.
  await writeCanaryViaPr({
    runId: `harness-cleanup-${Date.now()}`,
    bodyText: expectedBody,
    message: `test(canary): harness safety-net reset of post baseline (${reason})`,
    skipWaitForMerge: true,
  });
});

// E3 — Daily production canary probe.
//
// Runs once a day under `.github/workflows/canary-prod.yml` against
// TARGET=prod. The full publish-loop above is the gold-standard end-to-
// end check, but it's heavyweight (~7 minutes and a real PR per run) and
// only fires when CMS-affecting paths change. The canary probe is the
// always-on smoke check: every morning, before US/EU work hours, assert
// that the three `_e2e/canary-*` URLs are still serving their baseline
// content. If any of them 404s, drifts, or stops resolving entirely,
// the workflow opens an issue tagged `production-canary`.
//
// Read-only by construction:
//   - No Decap login (no PAT, no admin navigation, no editor drive).
//   - No PR open / label flip / merge.
//   - No Contents-API write.
//   - All three URLs are fetched via `page.request.get(...)` against the
//     prod baseURL set by the TARGET=prod fixture in `e2e/base.js`.
//
// The hard guard at the top of this file (assertNotProdCanary) makes the
// read-only contract machine-checked: if a future edit accidentally
// routes through writeCanaryOnMain() while PROD_CANARY=1, the spec
// throws immediately rather than silently mutating prod.
test("@canary-readonly production canary URLs serve their baselines", async ({ page }) => {
  test.skip(
    !PROD_CANARY,
    "PROD_CANARY=1 not set — canary-readonly probe is gated to the daily workflow.",
  );

  // Hard guard: never expose the test runner to a CMS_E2E_PAT in this
  // mode. The PROD_CANARY workflow does NOT set the secret, but a local
  // shell that ran the publish-loop earlier may have it exported. Strip
  // it from this process so even an accidental seedDecapAuth() call
  // would be a no-op (it self-skips when getPat() returns undefined).
  delete process.env.CMS_E2E_PAT;
  expect(getPat(), "PROD_CANARY mode must run without a PAT").toBeFalsy();

  for (const c of CANARIES) {
    await test.step(`Fetch ${c.publicPath} and assert baseline`, async () => {
      // `page.request.get(c.publicPath)` resolves against the TARGET=prod
      // baseURL fixture (e2e/base.js → https://adamdaniel.ai). No DOM
      // navigation needed — pure HTTP, fast and deterministic.
      const res = await page.request.get(c.publicPath);
      expect(res.status(), `${c.publicPath} should return 200 from prod`).toBe(200);
      const body = await res.text();
      expect(
        body,
        `${c.publicPath} should still surface its baseline ("${c.baseline}"). ` +
          `If this fails, the canary entry has drifted or the deploy pipeline ` +
          `has stalled — check deploy-production.yml on main.`,
      ).toContain(c.baseline);
    });
  }
});
