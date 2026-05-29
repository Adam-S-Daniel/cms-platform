// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — RUN_HOST_REPO_PUBLISH_LOOP / CMS_E2E_PAT aren't wired into
// the standard PR matrix — so selecting + bringing it up just to no-op
// is pure waste. The dedicated cms-publish-loop-host workflow runs the
// existing publish-loop spec; this harness will eventually graduate to
// its own workflow when the per-slug preview model lands.
//
// @lane: real
//
// "real lane" = exercises live GitHub, real Decap, real preview infra,
// not a local mock. Currently inert in the standard PR matrix; gated to
// CMS_E2E_PAT + RUN_HOST_REPO_PUBLISH_LOOP and runs once on
// chromium-desktop-1080. The `@lane: real` tag exists so a future workflow
// (or `--grep @lane:real`) can opt the spike's harness in/out as a unit.

/*
 * Spike harness — exercises today's `cms/<slug>` flow end-to-end so we
 * have a real validation harness for the preview-pr-mimicry change
 * described in docs/preview-pr-ruleset-spike.md. Skeleton + TODOs in
 * places where the future-state assertions go; the existing flow IS
 * exercised so the harness has a green bar to defend before the
 * preview-pr model lands.
 *
 * Why a separate spec instead of extending cms-publish-loop.spec.js:
 *   - cms-publish-loop targets `main` and asserts public adamdaniel.ai
 *     content. It's the gold-standard end-to-end check today.
 *   - This spec's job is to assert the LIFECYCLE of a `cms/<slug>`
 *     branch as its own isolated unit — open, redeploy preview, label
 *     flip, merge — without coupling to "did it ship to prod?". Once
 *     the per-slug preview env exists, the future-state assertions
 *     plug in here without touching the prod path.
 *
 * Today's flow (what the skeleton drives):
 *   0. Reset canary baseline (via labelled PR — main ruleset blocks
 *      direct Contents-API writes; reuses cms-fixture-pr.seedFixtureViaPr).
 *   1. Pre-seed Decap auth, load the production admin.
 *   2. Open the canary entry, edit the body with a unique marker, Save.
 *   3. Wait for Decap to open the cms/<col>/<slug> PR.
 *   4. Wait for cms-editorial-workflow.yml validate-content to pass.
 *   5. Drive Status: Ready via the UI dropdown (the same path
 *      cms-publish-loop.spec.js exercises — covers the
 *      decap-cms/ready ↔ cms/ready synonym contract).
 *   6. Wait for auto-merge, wait for merge.
 *   7. Cleanup: reset baseline.
 *
 * Future-state TODOs (filed against the preview-pr-mimicry rollout):
 *   [TODO step 3a] After the cms/<slug> PR opens, assert a per-slug
 *     preview env at `https://preview-cms-<slug>.adamdaniel.ai/` (or
 *     whichever subdomain pattern the rollout settles on) is reachable
 *     and serves the in-progress edit.
 *   [TODO step 4a] Assert the cms-content-branches ruleset (id TBD —
 *     written but not applied yet, see .github/rulesets/cms-content-
 *     branches.json) blocks `gh api -X DELETE refs/heads/cms/<slug>`
 *     while the PR is open. Mirrors how main.json's `deletion` rule
 *     works, scoped to refs/heads/cms/**.
 *   [TODO step 5a] Assert that on Save → label flip the per-slug
 *     preview env redeploys (track deploy-preview.yml run on the
 *     cms/<slug> head ref, not the parent PR number).
 *   [TODO step 7a] After the PR merges, assert the per-slug preview
 *     env is torn down by a sibling teardown job — same shape as
 *     deploy-preview.yml's `teardown-preview` job for code PRs today.
 *
 * Gating (matches cms-publish-loop.spec.js):
 *   - CMS_E2E_PAT must be set (host-repo only — fork PRs / Dependabot skip).
 *   - RUN_HOST_REPO_PUBLISH_LOOP=1 opt-in to avoid PR-time recursion.
 *   - Runs once on chromium-desktop-1080. Other projects skip — this is a
 *     real-network real-GitHub spec, not a per-browser invariant.
 *   - PROD_CANARY=1 (read-only daily probe) skips this — no mutation.
 */
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { findCanary, makeMarker } = require("./canary-content");
const {
  fetchPublicUrl,
  gh,
  waitForAutoMergeEnabled,
  waitForCmsPullRequest,
  waitForMerge,
  waitForWorkflowRun,
} = require("./github-actions-poll");
const { seedFixtureViaPr } = require("./cms-fixture-pr");

const CANARY = findCanary("post");
const PROD_HOST = "https://adamdaniel.ai";
const PROD_ADMIN = `${PROD_HOST}/admin/`;
const PUBLIC_URL = `${PROD_HOST}${CANARY.publicPath}`;
const PROD_CANARY = process.env.PROD_CANARY === "1";

// ~30 min budget — one labelled-PR cycle (validate-content + label flip
// + merge) plus the optional setup PR if cleanup didn't land last run.
// No deploy-production wait here (that's cms-publish-loop's job); we're
// scoped to the cms/<slug> branch lifecycle.
const TEST_TIMEOUT_MS = 30 * 60 * 1000;

test.describe.configure({ mode: "serial", timeout: TEST_TIMEOUT_MS });

// Module-scoped flag for the afterAll safety-net harness. Set inside
// the test once the marker is inserted into the canary body. The hook
// reads the file from main and only fires the API restore when the
// marker is still there (UI cleanup didn't run / failed).
let pendingMarker = null;

async function fetchCanaryFromMain() {
  return gh(`/repos/${HOST_REPO}/contents/${CANARY.path}?ref=main`);
}

async function composeCanaryFile(bodyText) {
  const current = await fetchCanaryFromMain();
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  const fmEnd = decoded.indexOf("\n---\n", 4);
  if (fmEnd < 0) throw new Error("Canary file is missing closing front-matter delimiter.");
  const frontMatter = decoded.slice(0, fmEnd + 5);
  return `${frontMatter}\n${bodyText}\n`;
}

async function writeCanaryViaPr({ runId, bodyText, message }) {
  const newFile = await composeCanaryFile(bodyText);
  return seedFixtureViaPr({
    slug: CANARY.slug,
    runId,
    filePath: CANARY.path,
    bodyText: newFile,
    message,
  });
}

test(
  "@lane:real CMS preview-PR-mimicry harness — cms/<slug> branch lifecycle",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(
      PROD_CANARY,
      "PROD_CANARY=1 — daily canary probe is read-only; this spec mutates state.",
    );
    test.skip(
      !getPat(),
      "CMS_E2E_PAT not set — spike harness disabled. (Forks and Dependabot are expected to land here.)",
    );
    test.skip(
      process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1",
      "RUN_HOST_REPO_PUBLISH_LOOP not set — spike harness is opt-in (avoids cms/* PR self-recursion in PR-time CI).",
    );

    const runId = Date.now();
    const marker = makeMarker(`spike-${CANARY.id}`, runId);
    const baselineBody = CANARY.baseline;

    // ── 0. Reset canary baseline before driving admin ────────────────
    await test.step("Reset canary to baseline via labelled PR", async () => {
      const current = await fetchCanaryFromMain();
      const currentBody = Buffer.from(current.content, "base64").toString("utf8");
      if (!currentBody.includes(baselineBody)) {
        await writeCanaryViaPr({
          runId: `spike-setup-${runId}`,
          bodyText: `${baselineBody}\n\nSpike harness baseline — see e2e/cms-preview-pr-self-contained.spec.js.\n`,
          message: "test(spike): reset canary baseline before spike-harness run",
        });
      }
    });

    await test.step("Confirm baseline is live before driving admin", async () => {
      await fetchPublicUrl(PUBLIC_URL, {
        expectContent: baselineBody,
        timeoutMs: 6 * 60 * 1000,
      });
    });

    // ── 1. Pre-seed Decap auth, load admin ──────────────────────────
    await seedDecapAuth(page);
    await test.step("Load production admin", async () => {
      await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 2. Open canary entry, edit body, Save ───────────────────────
    await test.step("Navigate to canary entry", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/${CANARY.cmsCollection}/entries/${CANARY.slug}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Insert run marker into body and Save", async () => {
      const body = page.locator('[role="textbox"][contenteditable="true"]').last();
      await body.click();
      await body.press("End");
      await body.pressSequentially(`\n\n${marker}\n`);
      pendingMarker = marker;
      await page.getByRole("button", { name: /^Save$/i }).click();
      await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 3. Find the cms/<col>/<slug> PR Decap opened ────────────────
    let pr;
    await test.step("Wait for Decap to open the cms/<col>/<slug> PR", async () => {
      pr = await waitForCmsPullRequest({
        base: "main",
        filePath: CANARY.path,
        canaryMarker: marker,
        timeoutMs: 5 * 60 * 1000,
      });
      expect(pr.number, "Decap PR number").toBeGreaterThan(0);
      expect(pr.head.ref, "Decap branch is cms/<col>/<slug>-shaped").toMatch(/^cms\//);
    });

    // [TODO step 3a — preview-pr-mimicry rollout] Once the per-slug
    // preview env exists, assert a subdomain like
    // `https://preview-cms-<slug>.adamdaniel.ai/<canary publicPath>`
    // is reachable and serves the in-progress edit (the marker). This
    // is the assertion that distinguishes the new model from today's
    // single-PR-preview approach.
    //
    //   const previewSlug = pr.head.ref.replace(/^cms\//, "").replace(/\//g, "-");
    //   const cmsPreviewUrl = `https://preview-cms-${previewSlug}.adamdaniel.ai${CANARY.publicPath}`;
    //   await test.step("Per-slug preview env serves the in-progress edit", async () => {
    //     await fetchPublicUrl(cmsPreviewUrl, { expectContent: marker, timeoutMs: 8 * 60 * 1000 });
    //   });

    // ── 4. validate-content passes ──────────────────────────────────
    await test.step("Wait for validate-content to succeed", async () => {
      await waitForWorkflowRun({
        workflow: "cms-editorial-workflow.yml",
        headSha: pr.head.sha,
        branch: pr.head.ref,
        timeoutMs: 6 * 60 * 1000,
      });
    });

    // [TODO step 4a — preview-pr-mimicry rollout] Assert the
    // cms-content-branches ruleset (drafted at
    // .github/rulesets/cms-content-branches.json) blocks branch
    // deletion while this PR is open. Sketch:
    //
    //   await test.step("cms/<slug> branch is delete-protected", async () => {
    //     const res = await fetch(
    //       `https://api.github.com/repos/${HOST_REPO}/git/refs/heads/${pr.head.ref}`,
    //       { method: "DELETE", headers: { Authorization: `Bearer ${getPat()}` } },
    //     );
    //     expect(res.status).toBe(422); // ruleset rejection
    //   });

    // ── 5. Status → Ready (drives the UI dropdown, exercising the
    // decap-cms/ready ↔ cms/ready synonym contract) ──────────────────
    await test.step("Set Status: Ready via UI dropdown", async () => {
      await page.getByRole("button", { name: /^Status:\s*Draft$/i }).click();
      await page.getByRole("menuitem", { name: /^Ready$/i }).click();
      await expect(page.getByRole("button", { name: /^Status:\s*Ready$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Wait for auto-merge to be enabled", async () => {
      await waitForAutoMergeEnabled({ prNumber: pr.number });
    });

    // [TODO step 5a — preview-pr-mimicry rollout] If the per-slug
    // preview redeploys on the cms/<slug> head's `synchronize` event,
    // assert the redeployed preview surfaces the marker too. Mirrors
    // how cms-publish-loop-preview.spec.js asserts deploy-preview.yml
    // ran on PR_HEAD_REF.

    // ── 6. PR merges ────────────────────────────────────────────────
    await test.step("Wait for PR to merge into main", async () => {
      await waitForMerge({ prNumber: pr.number });
    });

    // [TODO step 7a — preview-pr-mimicry rollout] After merge, assert
    // the per-slug preview env is torn down (subdomain returns
    // 404/CloudFront-error, matching how deploy-preview.yml's
    // teardown-preview job cleans up after code PRs today).

    // ── 7. Cleanup: the cms/<slug> PR's merge IS the cleanup. The
    // spike's mutation is a marker insert; the merge lands the body
    // verbatim back on main with the marker, so the next run's baseline
    // check finds the marker and forces a fresh reset via the spec's
    // step-0 setup. The afterAll harness below is the safety net for the
    // (rare) case where the spike crashed mid-flow before merge.
    pendingMarker = null;
  },
);

// Safety-net harness: when the spec body crashes after marker insert
// but before the cms/<slug> PR merges, the canary on main still
// contains the marker — the next run's step-0 detects this and resets
// via the spec's normal setup PR path. This hook is the belt-and-
// suspenders short-circuit: if the marker is on main when the test
// finishes, open a baseline-reset PR right away rather than relying on
// the next run to notice.
test.afterAll(async () => {
  if (!pendingMarker) return; // spec succeeded or never reached marker insert
  if (PROD_CANARY) return; // daily canary probe doesn't mutate
  if (!getPat()) return;
  let current;
  try {
    current = await fetchCanaryFromMain();
  } catch (e) {
    console.warn(
      `[cleanup-harness] couldn't read ${CANARY.path} from main; skipping safety net: ${e && e.message}`,
    );
    return;
  }
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  if (!decoded.includes(pendingMarker)) {
    console.log(
      "[cleanup-harness] spike canary at baseline (marker not present); merge happened or spec recovered — no safety net needed",
    );
    return;
  }
  console.warn(
    `[cleanup-harness] spike marker still present on main; opening fixture PR to restore canary baseline`,
  );
  const baselineBody = CANARY.baseline;
  await writeCanaryViaPr({
    runId: `spike-harness-cleanup-${Date.now()}`,
    bodyText: `${baselineBody}\n\nSpike harness baseline — see e2e/cms-preview-pr-self-contained.spec.js.\n`,
    message: "test(spike): harness safety-net reset of canary baseline (marker remained on main)",
  });
});
