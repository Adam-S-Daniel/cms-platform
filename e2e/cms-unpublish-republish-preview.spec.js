// @lane: real — drives the real Decap CMS Posts collection in a PR preview env
// @select-skip-when-head-ref-prefix: cms/
//
// allowed: literal slug used for known fixture
// (`/blog/e2e-unpublish-canary/` is the rendered URL of the fixture
// `_posts/2024-01-02-e2e-unpublish-canary.md`; this spec references it
// deliberately as the test target. File-scope pragma per
// `e2e/blog-slug-literal-lint.test.js`.)
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — PR_NUMBER / PR_HEAD_REF / CMS_E2E_PAT aren't wired into the
// standard PR matrix. The dedicated cms-preview-loops workflow runs it.

/*
 * Preview-env counterpart of cms-unpublish-republish.spec.js
 * (issue #999, "preview-parity for the 3 remaining prod-only loops").
 *
 * The prod spec flips the `published` flag of a real `_posts/` entry
 * on `main` and asserts the public URL toggles 4xx ↔ 200, validating
 * the path *into main*. This spec runs the SAME unpublish/re-publish
 * flow through a PR preview environment, validating the path *into
 * the PR head branch* (preview admin `backend.branch = <head ref>` →
 * cms/<col>/<slug> PR against the feature branch → label-driven
 * auto-merge → deploy-preview → preview-pr<N>.adamdaniel.ai).
 *
 * Like the prod spec this is DISTINCT from delete: unpublishing keeps
 * the file in the repo (frontmatter `published: true` → `false`) and
 * removes the public URL; re-publishing flips it back. Toggle-only —
 * no body edit, no marker insertion — so a regression in this flow
 * fails this spec without obscuring the prod-mutate (body-edit) one.
 *
 * Zero prod blast radius: every write goes to the PR head branch (via
 * the Contents API in setup/cleanup, or a cms/<col>/<slug> PR Decap
 * opens against that branch). The head branch — and any stray canary
 * state — dies when the parent PR merges/closes; nothing touches
 * `main`, so this spec is *not* gated behind RUN_HOST_REPO_PUBLISH_-
 * LOOP the way the prod variant is.
 *
 * Fixture: `_posts/2024-01-02-e2e-unpublish-canary.md` ships
 * `published: false` (URL hidden in steady state). The date is
 * intentionally in the PAST — Jekyll's default `future: false` skips
 * future-dated posts even when `published: true`, which would make
 * the re-publish leg's URL wait time out forever. With a past date
 * `published: true/false` is the only knob controlling visibility.
 *
 * NOTE on runCmsLoop: see the header of
 * cms-publish-loop-prod-mutate-preview.spec.js — #1004 owns the
 * `runCmsLoop` spine; #999 (this spec) mirrors
 * cms-publish-loop-preview.spec.js directly until that lands.
 *
 * Editorial pattern: each leg Saves then applies `cms/ready` via the
 * API, mirroring cms-publish-loop-preview.spec.js (it documents why
 * it does not re-exercise the Status:Ready→Publish-Now dropdown — the
 * editorial chain is identical from the cms/ready label onward).
 *
 * Flow (publish-first-then-unpublish so the end state matches the
 * `published: false` baseline and the next run starts clean):
 *   0. Close any stale Decap PR on cms/posts/<slug>, reset the
 *      fixture to `published: false` on the PR head branch.
 *   1. Confirm the preview URL 4xxs; verify the editor reads the
 *      Published toggle OFF.
 *   2. Re-publish leg: toggle ON, Save, cms PR → cms/ready → wait
 *      for the preview URL to serve (200).
 *   3. Unpublish leg: toggle OFF, Save, cms PR → cms/ready → wait
 *      for the preview URL to 4xx.
 *
 * Gating: CMS_E2E_PAT + PR_NUMBER + PR_HEAD_REF; chromium-desktop-3k only.
 */
const path = require("node:path");
const { guard } = require("./base-collections-guards");
// #33/#21 — resolved like the other registered specs so the drift lint matches it.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { closeStaleDecapPrOnBranch } = require("./cms-fixture-pr");
const {
  addLabel,
  gh,
  makePreviewCanaryRecoverer,
  waitForCmsPullRequest,
} = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const { previewTarget } = require("./cms-host");
const { readPublishedFlag, forcePublishedFalse } = require("./fixture-baseline");
const { setPublished, expectPublished, saveEntry } = require("./cms-editor-ui");

const FIXTURE_PATH = "_posts/2024-01-02-e2e-unpublish-canary.md";
const FIXTURE_SLUG = "e2e-unpublish-canary";
const FIXTURE_FILE_SLUG = "2024-01-02-e2e-unpublish-canary";

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
const PUBLIC_URL = `${PREVIEW_HOST}/blog/${FIXTURE_SLUG}/`;

// Two full publish chains run serially (re-publish, then unpublish),
// each roughly the shape of one cms-publish-loop mutation. Each URL
// wait capped at 15 min + admin login + UI clicks + cleanup ≈ 40 min
// worst case. Retries disabled — real-state mutation.
const TEST_TIMEOUT_MS = 40 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

function toContentBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

async function fetchFixtureFromBranch(branch) {
  return gh(`/repos/${HOST_REPO}/contents/${FIXTURE_PATH}?ref=${encodeURIComponent(branch)}`);
}

// `readPublishedFlag` and `forcePublishedFalse` are shared from
// ./fixture-baseline (#1053 DRY'd the per-spec copies into one
// implementation). `forcePublishedFalse(text, FIXTURE_PATH)` is
// byte-identical to the old local copy: front matter + body verbatim,
// only `published:` forced false (toggle-only spec — the body is
// never the thing under test, so it is preserved).

// Contents-API PUT to the PR head branch with optimistic-concurrency
// retry (same rationale as `cms-unpublish-republish.spec.js`'s
// writeFixtureOnMain — the branch can advance under us via a concurrent
// Decap force-push or a push from the parent PR author).
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

async function urlServesPost(page) {
  const res = await page.request.get(PUBLIC_URL, { failOnStatusCode: false });
  return res.status() === 200;
}

async function url4xxs(page) {
  const res = await page.request.get(PUBLIC_URL, { failOnStatusCode: false });
  const s = res.status();
  return s >= 400 && s < 500;
}

test(
  "CMS unpublish + re-publish — preview env, target PR head branch",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(!getPat(), "CMS_E2E_PAT not set — preview unpublish/re-publish disabled.");
    // #33/#21 — a base_collections:[] bio renders none of the base collections; skip green there.
    test.skip(...guard(SITE_ROOT, "cms-unpublish-republish-preview.spec.js"));
    test.skip(
      !PR_NUMBER || !PR_HEAD_REF,
      "PR_NUMBER / PR_HEAD_REF not set — this spec only runs in the cms-preview-loops workflow.",
    );

    // Persistent dialog handler — Decap uses native window.confirm()
    // for some publish-now confirmations; without this listener
    // Playwright auto-dismisses and Decap reads it as "cancelled".
    page.on("dialog", (d) => d.accept());

    // FIX 1 (#82): hoisted to the test body so each leg's
    // waitForChangeReflected recoverer reads the most-recently-matched
    // canary PR. The re-publish leg assigns it first, the unpublish leg
    // reassigns it — both run serially, so `pr` is always the current leg's.
    let pr;

    // ── 0a. Close any stale Decap PR on the post's fixed branch ─────
    await test.step("Close any stale Decap PR on the cms/posts/<slug> branch", async () => {
      await closeStaleDecapPrOnBranch({
        branch: `cms/posts/${FIXTURE_FILE_SLUG}`,
      });
    });

    // ── 0b. Reset the fixture to baseline on the PR head branch ─────
    let baselineFileText;
    await test.step("Reset fixture to baseline (published: false) on the PR head branch", async () => {
      let current;
      try {
        current = await fetchFixtureFromBranch(PR_HEAD_REF);
      } catch (e) {
        throw new Error(
          `Fixture ${FIXTURE_PATH} is missing on ${PR_HEAD_REF} (${e && e.message}). It ships on main; restore it or re-cut the PR branch.`,
          { cause: e },
        );
      }
      const remoteBody = Buffer.from(current.content, "base64").toString("utf8");
      baselineFileText = forcePublishedFalse(remoteBody, FIXTURE_PATH);
      if (remoteBody !== baselineFileText) {
        await writeFixtureOnBranch({
          branch: PR_HEAD_REF,
          fileText: baselineFileText,
          message: "test(preview-unpublish): reset fixture baseline (published: false) before run",
        });
      }
    });

    // ── 1. Confirm the preview URL 4xxs before driving admin ────────
    // The baseline write pushes the head branch → deploy-preview
    // re-runs. published:false drops the file → 4xx.
    await test.step("Confirm the preview URL 4xxs at baseline", async () => {
      const deadline = Date.now() + 12 * 60 * 1000;
      let lastStatus = "unknown";
      while (Date.now() < deadline) {
        const res = await page.request.get(PUBLIC_URL, {
          failOnStatusCode: false,
        });
        lastStatus = `${res.status()}`;
        if (res.status() >= 400 && res.status() < 500) break;
        await page.waitForTimeout(8000);
      }
      expect(lastStatus, `${PUBLIC_URL} should 4xx at baseline (published: false)`).toMatch(
        /^4\d\d$/,
      );
    });

    // ── 2. Open admin, navigate to the unpublish-canary entry ───────
    await seedDecapAuth(page);
    await test.step("Load preview admin", async () => {
      await page.goto(PREVIEW_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Navigate to the unpublish-canary post entry", async () => {
      // Direct URL nav is deterministic. Decap's hash-route entry
      // mount can be slow on a cold preview CDN; two-attempt retry:
      // navigate → wait 60s for Title → on timeout reload + retry.
      const titleLocator = page.getByRole("textbox", { name: /^Title$/i });
      const targetUrl = `${PREVIEW_ADMIN}#/collections/posts/entries/${FIXTURE_FILE_SLUG}`;
      let lastErr;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt === 1) {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          } else {
            console.warn(
              "[preview-unpublish-republish] Title field didn't appear within 60s on attempt 1; reloading and retrying",
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
      // editor on a freshly-loaded preview surface, where the switch can take
      // a moment to hydrate (preserves the pre-refactor visibility tolerance).
      await expectPublished(page, false, { timeout: 30_000 });
    });

    // ── 3. Re-publish leg: toggle ON → Save → cms PR → URL 200 ──────
    await test.step("Toggle Published → ON via UI", async () => {
      await setPublished(page, true);
    });

    await test.step("Save → wait for cms PR → label cms/ready (re-publish)", async () => {
      await saveEntry(page);
      // The diff for this leg flips `-published: false` /
      // `+published: true`. The previous leg's PR (none yet — this is
      // the first) can't collide; waitForCmsPullRequest only
      // considers state=open cms/* PRs, so the marker just has to
      // appear in this PR's patch.
      pr = await waitForCmsPullRequest({
        base: PR_HEAD_REF,
        filePath: FIXTURE_PATH,
        canaryMarker: "published: true",
        timeoutMs: 5 * 60 * 1000,
      });
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });

    await test.step("Wait for the preview URL to serve (200)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PREVIEW,
        urlCheck: async () => urlServesPost(page),
        urlTimeoutMs: 15 * 60 * 1000,
        // FIX 1 (#82): recover the green-but-stuck-BLOCKED re-publish canary PR.
        onBudgetExhausted: makePreviewCanaryRecoverer({
          base: PR_HEAD_REF,
          getPrNumber: () => pr && pr.number,
        }),
      });
    });

    // ── 4. Unpublish leg: toggle OFF → Save → cms PR → URL 4xx ──────
    // Reset Decap's editorial state before the SECOND Save. The
    // re-publish leg's cms/posts/<slug> PR merged into PR_HEAD_REF and
    // its (fixed, per-entry) branch is consumed; the in-memory
    // editorial store still believes that now-merged branch is its
    // working ref, and a bare in-SPA toggle+Save would not open a
    // fresh cms PR (the failure mode run #26006678919 surfaced in the
    // model spec). Close any stale branch/PR server-side, then force a
    // full document reload so Decap re-reads editorial status from
    // GitHub and the unpublish Save opens a new PR.
    await test.step("Reset Decap editorial state for the unpublish leg", async () => {
      await closeStaleDecapPrOnBranch({
        branch: `cms/posts/${FIXTURE_FILE_SLUG}`,
      });
      await page.goto(`${PREVIEW_ADMIN}#/collections/posts/entries/${FIXTURE_FILE_SLUG}`, {
        waitUntil: "domcontentloaded",
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 60_000,
      });
      // After the re-publish chain landed, the editor should now read
      // the toggle as ON; assert it so the OFF flip below is a real
      // state transition (not a no-op on a stale view).
      await expectPublished(page, true, { timeout: 30_000 });
    });

    await test.step("Toggle Published → OFF via UI", async () => {
      await setPublished(page, false);
    });

    await test.step("Save → wait for cms PR → label cms/ready (unpublish)", async () => {
      await saveEntry(page);
      // The re-publish leg's PR is merged (the URL-200 wait only
      // resolves once it landed on the head branch and deploy-preview
      // ran), so waitForCmsPullRequest's state=open filter excludes
      // it. This leg's diff adds `+published: false`.
      pr = await waitForCmsPullRequest({
        base: PR_HEAD_REF,
        filePath: FIXTURE_PATH,
        canaryMarker: "published: false",
        timeoutMs: 5 * 60 * 1000,
      });
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });

    await test.step("Wait for the preview URL to 4xx (URL hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PREVIEW,
        urlCheck: async () => url4xxs(page),
        urlTimeoutMs: 15 * 60 * 1000,
        // FIX 1 (#82): recover the green-but-stuck-BLOCKED unpublish canary PR.
        onBudgetExhausted: makePreviewCanaryRecoverer({
          base: PR_HEAD_REF,
          getPrNumber: () => pr && pr.number,
        }),
      });
    });
  },
);

// Safety-net harness: the spec's last leg flips Published OFF and
// waits for the URL to 4xx, so a passing run already lands at
// baseline. This hook only acts when the UI cleanup didn't complete
// (test failed between the publish and unpublish legs, leaving the
// fixture `published: true` on the head branch). Gated on PR_NUMBER
// so it never fires on the standard PR matrix (where the body skips).
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
  if (readPublishedFlag(decoded) !== true) {
    console.log(
      "[cleanup-harness] preview unpublish-canary at baseline (published: false); UI cleanup succeeded — no safety net needed",
    );
    return;
  }
  console.warn(
    `[cleanup-harness] unpublish-canary on ${PR_HEAD_REF} is still published: true after UI cleanup; restoring baseline via Contents API`,
  );
  await writeFixtureOnBranch({
    branch: PR_HEAD_REF,
    fileText: forcePublishedFalse(decoded, FIXTURE_PATH),
    message:
      "test(preview-unpublish): harness safety-net reset to published: false (UI cleanup left mutation)",
  });
});
