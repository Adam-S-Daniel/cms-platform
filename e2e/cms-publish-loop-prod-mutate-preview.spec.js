// @lane: real — drives the real Decap CMS in a PR preview env against real GitHub
// @select-skip-when-head-ref-prefix: cms/
//
// allowed: literal slug used for known fixture
// (`/blog/e2e-mutation-canary/` is the rendered URL of the fixture
// `_posts/2099-01-01-e2e-mutation-canary.md`; this spec references it
// deliberately as the test target. File-scope pragma per
// `e2e/blog-slug-literal-lint.test.js`.)
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — PR_NUMBER / PR_HEAD_REF / CMS_E2E_PAT aren't wired into the
// standard PR matrix — so selecting + bringing it up just to no-op is
// pure waste. The dedicated cms-preview-loops workflow exercises this
// path.

/*
 * Preview-env counterpart of cms-publish-loop-prod-mutate.spec.js
 * (issue #999, "preview-parity for the 3 remaining prod-only loops").
 *
 * The prod spec mutates a REAL `_posts/` entry on `main`, validating
 * the path *into main* (main ruleset → auto-merge-when-ready →
 * deploy-production → adamdaniel.ai). This spec runs the SAME Decap
 * mutation through a PR preview environment, validating the path
 * *into the PR head branch* (preview admin's `backend.branch = <head
 * ref>` → cms/<col>/<slug> PR against the feature branch →
 * label-driven auto-merge → deploy-preview → preview-pr<N>
 * .adamdaniel.ai). Per the issue's "inherent non-goal": parity here
 * means *which CMS operation is validated on each deployed surface*,
 * not an identical pipeline — the two regimes are deliberately
 * different.
 *
 * Zero prod blast radius: every write goes to the PR head branch via
 * the Contents API (or through a cms/<col>/<slug> PR Decap opens
 * against that branch). When the parent PR merges or closes the head
 * branch is deleted and any stray canary state dies with it — nothing
 * touches `main`, so this spec is *not* gated behind
 * PROD_PLAYGROUND_MODE the way the prod variant is.
 *
 * NOTE on runCmsLoop: issue #999's proposal references "the
 * generalized `runCmsLoop` helper". That spine is PR #971's *other*
 * tracked follow-up (#1004, `runCmsLoop` + cms-delete-published-
 * preview) and does not exist yet. Per #971's deliberate split (#999
 * vs #1004 are independent), this spec mirrors
 * `cms-publish-loop-preview.spec.js` directly — the structure #1004
 * will later refactor onto the shared spine. No behaviour changes
 * when that lands; only the plumbing moves.
 *
 * Editorial pattern: forward/cleanup legs Save then apply `cms/ready`
 * via the API (mirrors cms-publish-loop-preview.spec.js, which
 * documents why it doesn't re-exercise the Status:Ready→Publish-Now
 * dropdown: Decap has the same dropdown in preview-mode admin, but
 * the editorial-workflow chain is identical from the cms/ready label
 * onward — a separate UI exercise there buys no extra coverage).
 *
 * Hard guards (mirroring the prod spec, but read from the PR head
 * branch via the Contents API instead of disk — the workflow checks
 * out the default branch, which may not equal the PR head):
 *   1. The fixture must exist on the PR head branch. Missing →
 *      test.fixme() with a restore hint.
 *   2. The fixture date `2099-01-01` must still be in the future.
 *
 * Flow:
 *   0. Close any stale Decap PR on the post's fixed cms/posts/<slug>
 *      branch, then reset the fixture to a clean baseline
 *      (`published: false`, marker-free body) on the PR head branch.
 *   1. Confirm the preview URL 4xxs (published:false drops the file).
 *   2. Drive the preview admin with a PAT-seeded session.
 *   3. Append a run marker, toggle Published → ON, Save.
 *   4. Wait for the cms/<col>/<slug> PR Decap opens against the head.
 *   5. Label it cms/ready; wait for the marker to be live on preview.
 *   6. Cleanup via UI: toggle Published → OFF, restore body, Save,
 *      label cms/ready; wait for the preview URL to 4xx again.
 *
 * Gating:
 *   - CMS_E2E_PAT must be set.
 *   - PR_NUMBER + PR_HEAD_REF must be set (the workflow exposes them
 *     from the resolved parent PR).
 *   - chromium-desktop-3k only.
 */
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { closeStaleDecapPrOnBranch } = require("./cms-fixture-pr");
const { addLabel, gh, waitForCmsPullRequest } = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const { previewTarget } = require("./cms-host");
const { readPublishedFlag, sanitizeToBaseline } = require("./fixture-baseline");
const { setPublished, saveEntry } = require("./cms-editor-ui");

const FIXTURE_PATH = "_posts/2099-01-01-e2e-mutation-canary.md";
const FIXTURE_SLUG = "e2e-mutation-canary";
const FIXTURE_TITLE = "E2E Mutation Canary";
const FIXTURE_DATE = "2099-01-01";
const PUBLIC_PATH = `/blog/${FIXTURE_SLUG}/`;

// Host triplet resolves through the shared cms-host resolver. `host`
// is "" when no PR number is resolvable — preserving the historical
// `PR_NUMBER ? … : ""` self-skip guard (the spec test.skip's on
// !PR_NUMBER before any PREVIEW_* value is used).
const {
  host: PREVIEW_HOST,
  adminUrl: PREVIEW_ADMIN,
  pillId: PILL_PREVIEW,
  prNumber: PR_NUMBER,
} = previewTarget();
// No GITHUB_HEAD_REF fallback — see cms-delete-published-preview.spec.js
// for the loop it caused. PR_HEAD_REF is set only by the dedicated
// preview workflow; falling back to the auto-populated GITHUB_HEAD_REF
// let this @admin-write spec run (and mutate the PR head branch) inside
// e2e-tests.yml's e2e-admin lane on every pull_request event.
const PR_HEAD_REF = process.env.PR_HEAD_REF || "";
const PREVIEW_PUBLIC_URL = `${PREVIEW_HOST}${PUBLIC_PATH}`;

// A stable sentinel embedded in the clean baseline body. Used as the
// `waitForCmsPullRequest` marker for the cleanup leg: it only appears
// as an added (`+`) line when the body is restored, so it can't
// accidentally match the forward (publish) PR's diff.
const BASELINE_SENTINEL = "preview-prod-mutate baseline — no test currently in progress";
const BASELINE_BODY = [
  "Adam Daniel — E2E mutation canary post (do not edit by hand).",
  "",
  "This file is the target of the preview-env prod-mutation parity",
  "spec (`e2e/cms-publish-loop-prod-mutate-preview.spec.js`, run by",
  "`.github/workflows/cms-preview-loops.yml`). The spec drives the",
  "full Decap → cms PR → label-driven auto-merge → deploy-preview",
  "loop against the PR's `preview-pr<N>.adamdaniel.ai` surface,",
  "targeting the PR head branch — zero production blast radius.",
  "",
  "Between runs the body is reset to this baseline and `published`",
  "is forced back to `false`, so the public URL renders nothing.",
  "",
  BASELINE_SENTINEL,
  "",
].join("\n");

// Same envelope as cms-publish-loop-prod-mutate.spec.js — the
// validate-content + auto-merge + deploy-preview + CloudFront chain
// caps out around 12–15 min when runners are warm. Two URL waits
// (forward + cleanup) at 15 min each + setup ≈ 40 min worst case;
// typical happy-path completes in ~10–12 min. Retries disabled —
// a Playwright retry just re-walks the same broken chain.
const TEST_TIMEOUT_MS = 40 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

function makePreviewMarker(runId) {
  return `e2e-preview-prod-mutate:${FIXTURE_SLUG}:${runId}`;
}

function toContentBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

async function fetchFixtureFromBranch(branch) {
  return gh(`/repos/${HOST_REPO}/contents/${FIXTURE_PATH}?ref=${encodeURIComponent(branch)}`);
}

// `readPublishedFlag` and `sanitizeToBaseline` are shared from
// ./fixture-baseline (#1053 DRY'd the per-spec copies into one
// implementation so the trust-the-file bug can't be reintroduced by
// copy-paste drift). `sanitizeToBaseline(text, FIXTURE_PATH,
// BASELINE_BODY)` keeps this spec's behaviour byte-identical: front
// matter verbatim but `published: false`, body swapped for the
// canonical marker-free BASELINE_BODY.

// Write a complete fixture body to the PR head branch. Optimistic-
// concurrency retry mirrors `cms-unpublish-republish.spec.js`'s
// writeFixtureOnMain: the Contents API needs the current blob SHA; if
// the branch advances under us (a concurrent Decap force-push, the
// parent PR author pushing) the PUT 409s. Re-fetch the SHA and retry,
// capped at 4 attempts. The PUT is idempotent (same baseline → same
// end state).
async function writeFixtureOnBranch({ branch, fileText, message }) {
  const MAX_ATTEMPTS = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = await fetchFixtureFromBranch(branch);
    try {
      return await gh(`/repos/${HOST_REPO}/contents/${FIXTURE_PATH}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          content: toContentBase64(fileText),
          sha: current.sha,
          branch,
        }),
      });
    } catch (err) {
      lastErr = err;
      if (err && err.status === 409 && attempt < MAX_ATTEMPTS) {
        console.warn(
          `[writeFixtureOnBranch] 409 conflict on attempt ${attempt}; re-fetching SHA and retrying (${branch} advanced under us)`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Today's date as YYYY-MM-DD (UTC), compared lexicographically
// against the fixture's ISO date — string comparison is correct for
// ISO 8601 dates.
function todayUtcIso() {
  return new Date().toISOString().slice(0, 10);
}

test(
  "CMS publish loop — preview env, prod-mutation parity (real _posts/ entry)",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(!getPat(), "CMS_E2E_PAT not set — preview prod-mutation parity disabled.");
    test.skip(
      !PR_NUMBER || !PR_HEAD_REF,
      "PR_NUMBER / PR_HEAD_REF not set — this spec only runs in the cms-preview-loops workflow.",
    );

    // ── Hard guards (run inside the test so failures show up in the
    // report, not as silent worker bring-up errors) ────────────────
    let initialFileText;
    try {
      const current = await fetchFixtureFromBranch(PR_HEAD_REF);
      initialFileText = Buffer.from(current.content, "base64").toString("utf8");
    } catch (e) {
      test.fixme(
        true,
        `Fixture ${FIXTURE_PATH} is missing on ${PR_HEAD_REF} (${e && e.message}). It ships on main; restore it or re-cut the PR branch.`,
      );
      return;
    }
    if (readPublishedFlag(initialFileText) === null) {
      test.fixme(
        true,
        `Fixture ${FIXTURE_PATH} on ${PR_HEAD_REF} has no parseable 'published:' front-matter line — fix before retrying.`,
      );
      return;
    }
    if (todayUtcIso() >= FIXTURE_DATE) {
      test.fixme(
        true,
        `Be kind in 2099: the date-based fixture ${FIXTURE_PATH} (${FIXTURE_DATE}) is past its expiry. Move the date forward or retire this spec.`,
      );
      return;
    }

    const runId = Date.now();
    const marker = makePreviewMarker(runId);
    const baselineFileText = sanitizeToBaseline(initialFileText, FIXTURE_PATH, BASELINE_BODY);

    // ── 0a. Close any stale Decap editorial-workflow PR on the
    // post's fixed branch ───────────────────────────────────────────
    // Decap reuses cms/posts/<slug> per entry, so a prior preview run
    // that crashed past Save can leave a non-Draft labelled PR;
    // closing it lets Decap open a fresh draft on the next Save.
    await test.step("Close any stale Decap PR on the cms/posts/<slug> branch", async () => {
      const fileSlug = FIXTURE_PATH.replace(/^_posts\//, "").replace(/\.md$/, "");
      await closeStaleDecapPrOnBranch({ branch: `cms/posts/${fileSlug}` });
    });

    // ── 0b. Reset the fixture to a clean baseline on the PR head ────
    await test.step("Reset fixture to baseline (published: false) on the PR head branch", async () => {
      const current = await fetchFixtureFromBranch(PR_HEAD_REF);
      const remoteBody = Buffer.from(current.content, "base64").toString("utf8");
      if (remoteBody !== baselineFileText) {
        await writeFixtureOnBranch({
          branch: PR_HEAD_REF,
          fileText: baselineFileText,
          message: `test(preview-prod-mutate): reset fixture baseline before run ${runId}`,
        });
      }
    });

    // ── 1. Confirm the preview URL 4xxs before driving admin ────────
    // The baseline write pushes the head branch → deploy-preview
    // re-runs (pull_request `synchronize`). Until that lands the
    // preview may still serve a stale state. published:false drops
    // the file from the build → 4xx. Generous budget covers
    // deploy-preview + CloudFront propagation.
    await test.step("Confirm the preview URL 4xxs while published: false", async () => {
      const deadline = Date.now() + 12 * 60 * 1000;
      let lastStatus = "unknown";
      while (Date.now() < deadline) {
        const res = await page.request.get(PREVIEW_PUBLIC_URL, {
          failOnStatusCode: false,
        });
        lastStatus = `${res.status()}`;
        if (res.status() >= 400 && res.status() < 500) return;
        await page.waitForTimeout(8000);
      }
      throw new Error(
        `Expected ${PREVIEW_PUBLIC_URL} to 4xx before driving admin (published: false should drop the file from the build), got ${lastStatus}.`,
      );
    });

    // ── 2. Pre-seed Decap auth and load the preview admin ───────────
    await seedDecapAuth(page);
    await test.step("Load preview admin", async () => {
      await page.goto(PREVIEW_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 3. Open the post, append marker, toggle Published, Save ─────
    await test.step("Navigate to the mutation canary post", async () => {
      // Direct entry URL is deterministic. admin/posts-list-enhance.js
      // hides automated-test fixtures from the Posts list by DEFAULT
      // (#1042); navigate to the canary directly (same pattern as the
      // steps below and cms-unpublish-republish.spec.js).
      const fileSlug = FIXTURE_PATH.replace(/^_posts\//, "").replace(/\.md$/, "");
      await page.goto(`${PREVIEW_ADMIN}#/collections/posts/entries/${fileSlug}`, {
        waitUntil: "domcontentloaded",
      });
      const titleBox = page.getByRole("textbox", { name: /^Title$/i });
      await expect(titleBox).toBeVisible({ timeout: 30_000 });
      // Confirm we deep-linked to the right canary.
      await expect(titleBox).toHaveValue(new RegExp(FIXTURE_TITLE, "i"));
    });

    await test.step("Append run marker to body", async () => {
      // `_posts/` body is a markdown editor. The pinned Decap version
      // no longer exposes "Body" as the textbox's accessible name —
      // mirror the prod spec and grab the last contenteditable
      // textbox on the page.
      const body = page.locator('[role="textbox"][contenteditable="true"]').last();
      await body.click();
      await body.press("End");
      await body.pressSequentially(`\n\n${marker}\n`);
    });

    await test.step("Toggle Published → ON", async () => {
      // The Published widget is a switch (role="switch"), toggled via
      // aria-checked — see e2e/cms-editor-ui.js (shared so the selector
      // can't drift, #1723).
      await setPublished(page, true, { visibleTimeout: 15_000 });
    });

    await test.step("Save (opens cms/... PR against the PR head)", async () => {
      await saveEntry(page);
    });

    // ── 4. Find the cms/... PR Decap opened against the PR head ─────
    let pr;
    await test.step("Wait for Decap to open the cms/... PR against the PR head", async () => {
      pr = await waitForCmsPullRequest({
        base: PR_HEAD_REF,
        filePath: FIXTURE_PATH,
        canaryMarker: marker,
        timeoutMs: 5 * 60 * 1000,
      });
      expect(pr.number, "Decap PR number").toBeGreaterThan(0);
    });

    // ── 5. Label cms/ready and wait for the preview deploy pill ─────
    await test.step("Label PR cms/ready", async () => {
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });

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
        urlTimeoutMs: 15 * 60 * 1000,
      });
    });

    // ── 6. Cleanup via UI (symmetrical with the forward leg) ────────
    // Toggle Published OFF + restore the baseline body, Save → cms PR
    // → cms/ready → deploy-preview re-renders → preview URL 4xxs.
    // Per AGENTS.md "no back doors in cleanup either".
    await test.step("Cleanup via UI: toggle Published → OFF, restore body, Save, label cms/ready", async () => {
      // Reset Decap's editorial state before the second Save. The
      // forward cms/posts/<slug> PR merged into PR_HEAD_REF and its
      // (fixed, per-entry) branch is consumed; the in-memory editorial
      // store from the forward leg still believes that now-merged
      // branch is its working ref, and a bare hash `page.goto(...)` is
      // a same-document change that never reloads the SPA — so the
      // cleanup Save would not open a fresh cms PR (the failure mode
      // run #26006678919 surfaced in the model spec). Close any stale
      // branch/PR server-side, then force a full document reload so
      // Decap re-reads the entry's editorial status from GitHub.
      const fileSlug = FIXTURE_PATH.replace(/^_posts\//, "").replace(/\.md$/, "");
      await closeStaleDecapPrOnBranch({ branch: `cms/posts/${fileSlug}` });
      await page.goto(`${PREVIEW_ADMIN}#/collections/posts/entries/${fileSlug}`, {
        waitUntil: "domcontentloaded",
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });

      await setPublished(page, false);

      const body = page.locator('[role="textbox"][contenteditable="true"]').last();
      await body.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await body.pressSequentially(BASELINE_BODY.trim() + "\n");

      await saveEntry(page);

      // Match on the forward run's unique marker, not BASELINE_SENTINEL.
      // The cleanup commit REMOVES the marker the forward leg appended,
      // so it is guaranteed to appear as a `-` line in this PR's
      // FIXTURE_PATH patch. (BASELINE_SENTINEL only lands as a context
      // line if it happens to fall inside the unified-diff window — the
      // same fragility that broke the model spec's cleanup.)
      const cleanupPr = await waitForCmsPullRequest({
        base: PR_HEAD_REF,
        filePath: FIXTURE_PATH,
        canaryMarker: marker,
        timeoutMs: 5 * 60 * 1000,
      });
      await addLabel({ prNumber: cleanupPr.number, label: "cms/ready" });

      await waitForChangeReflected({
        page,
        pillId: PILL_PREVIEW,
        urlCheck: async () => {
          const res = await page.request.get(PREVIEW_PUBLIC_URL, {
            failOnStatusCode: false,
          });
          const s = res.status();
          return s >= 400 && s < 500;
        },
        urlTimeoutMs: 15 * 60 * 1000,
      });
    });
  },
);

// ── Test-harness cleanup safety net ───────────────────────────────
// Mirrors cms-publish-loop-preview.spec.js's afterAll. If the in-spec
// UI cleanup left the fixture mutated on the PR head branch (test
// aborted, Decap regression mid-cleanup, etc.), restore the baseline
// via the Contents API. Gated additionally on PR_NUMBER so it never
// fires on the standard PR matrix (where the test body itself skips):
// without PR_NUMBER the body never mutated anything, so there is
// nothing — and a spurious read against the head branch is wasteful.
test.afterAll(async () => {
  if (!getPat()) return;
  if (!PR_NUMBER || !PR_HEAD_REF) return;
  let current;
  try {
    current = await fetchFixtureFromBranch(PR_HEAD_REF);
  } catch (e) {
    console.warn(
      `[cleanup-harness] couldn't read ${FIXTURE_PATH} from ${PR_HEAD_REF}; skipping safety net: ${e && e.message}`,
    );
    return;
  }
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  const stillPublished = readPublishedFlag(decoded) === true;
  const hasMarker = /e2e-preview-prod-mutate:[a-z-]+:\d+/.test(decoded);
  if (!stillPublished && !hasMarker) {
    console.log(
      "[cleanup-harness] preview prod-mutate fixture at baseline; UI cleanup succeeded — no safety net needed",
    );
    return;
  }
  console.warn(
    `[cleanup-harness] fixture on ${PR_HEAD_REF} is mutated (published=${stillPublished}, marker=${hasMarker}); restoring via Contents API`,
  );
  await writeFixtureOnBranch({
    branch: PR_HEAD_REF,
    fileText: sanitizeToBaseline(decoded, FIXTURE_PATH, BASELINE_BODY),
    message:
      "test(preview-prod-mutate): harness safety-net reset of fixture (UI cleanup left mutation)",
  });
});
