// @lane: real — exercises the real Decap → GitHub → Actions chain for the Tags collection in a PR preview env
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — PR_NUMBER / PR_HEAD_REF / CMS_E2E_PAT aren't wired into the
// standard PR matrix. The dedicated cms-preview-loops workflow runs it.

/*
 * Preview-env counterpart of cms-tags-lifecycle.spec.js
 * (issue #999, "preview-parity for the 3 remaining prod-only loops").
 *
 * The prod spec drives the Tags-collection create→publish→delete
 * lifecycle on `main`, validating the path *into main* (auto_tag_pages
 * plugin emits /tags/<slug>/ after deploy-production). This spec runs
 * the SAME lifecycle through a PR preview environment, validating the
 * path *into the PR head branch*: preview admin `backend.branch =
 * <head ref>` → cms/tags/<slug> PR against the feature branch →
 * label-driven auto-merge → deploy-preview → auto_tag_pages →
 * preview-pr<N>.adamdaniel.ai/tags/<slug>/.
 *
 * Zero prod blast radius: the tag entry is created on (and deleted
 * from) the PR head branch only. The slug is run-unique
 * (`e2e-tags-canary-preview-<runId>`) so concurrent runs don't race,
 * and the head branch — with any stray tag file — dies when the
 * parent PR merges/closes. Nothing touches `main`, so this spec is
 * *not* gated behind RUN_HOST_REPO_PUBLISH_LOOP the way the prod
 * variant is.
 *
 * NOTE on runCmsLoop: see the header of
 * cms-publish-loop-prod-mutate-preview.spec.js — #1004 owns the
 * `runCmsLoop` spine; #999 (this spec) mirrors
 * cms-publish-loop-preview.spec.js directly until that lands.
 *
 * Editorial patterns:
 *   - CREATE leg: Save then apply `cms/ready` via the API (the model
 *     cms-publish-loop-preview.spec.js pattern — it documents why it
 *     doesn't re-exercise the Status:Ready→Publish-Now dropdown).
 *   - DELETE leg: click "Delete published entry" and wait for the
 *     preview URL to 4xx. Decap's delete path goes through the admin
 *     `publish-via-auto-merge.js` shim that commits the deletion past
 *     the branch ruleset directly (same path cms-delete-published.spec
 *     .js and cms-tags-lifecycle.spec.js exercise on prod — neither
 *     labels a delete PR). The admin bundle is byte-identical
 *     prod↔preview (enforced by admin-bundle-parity.spec.js), so the
 *     shim behaves identically against the head-branch backend; if it
 *     does NOT, this parity spec SHOULD surface that divergence rather
 *     than paper over it with speculative label logic.
 *
 * Flow:
 *   0. Close any stale Decap PR on cms/tags/<slug> (slug is run-
 *      unique, so this is a cheap belt — matches the prod spec).
 *   1. Create the Tags entry (Name only — Description is skipped for
 *      the same Decap-version-flaky reason the prod spec documents),
 *      Save, cms PR → cms/ready, wait for /tags/<slug>/ to serve 200.
 *   2. Delete the entry via the Decap UI, wait for /tags/<slug>/ 404.
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
const { addLabel, gh, waitForCmsPullRequest } = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const { previewTarget } = require("./cms-host");

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

// Run-unique slug + name avoid races with concurrent runs and stale
// /tags/<slug>/ pages from prior crashed runs. Distinct prefix from
// the prod spec's `e2e-tags-canary-<runId>` so the two can't read
// each other's state if their windows overlap.
const RUN_ID = Date.now();
const TAG_SLUG = `e2e-tags-canary-preview-${RUN_ID}`;
const TAG_NAME = `E2E Tags Canary Preview ${RUN_ID}`;
const TAG_FILE_PATH = `_tags/${TAG_SLUG}.md`;
const ARCHIVE_PUBLIC_URL = `${PREVIEW_HOST}/tags/${TAG_SLUG}/`;

// 40 min covers two chain cycles (create + delete) at a 15-min URL
// wait each plus admin login, UI clicks, and the afterAll safety-net.
// Matches the prod spec's budget. Retries disabled — real-state
// mutation.
const TEST_TIMEOUT_MS = 40 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

// Persistent dialog handler — Decap uses native window.confirm() on
// delete. Without this listener Playwright auto-dismisses and Decap
// reads it as "user cancelled".
test.beforeEach(({ page }) => {
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
});

// Fire-and-forget safety-net cleanup. If the UI-driven delete fails
// (Decap regression, mid-run cancellation), the tag file would sit on
// the PR head branch and pollute that PR's preview /tags/ page until
// the parent PR closes. Unlike the prod spec — which must route the
// deletion through a `cms/e2e-fixture/cleanup-…` PR because the main
// ruleset blocks direct writes — the PR head branch has no such
// ruleset, so a single Contents-API DELETE restores it directly
// (mirrors how cms-publish-loop-preview.spec.js writes baseline back
// to the head branch in its afterAll). Gated on PR_NUMBER so it never
// fires on the standard PR matrix (where the body itself skips).
test.afterAll(async () => {
  if (!getPat()) return;
  if (!PR_NUMBER || !PR_HEAD_REF) return;
  test.setTimeout(2 * 60 * 1000);

  let existing;
  try {
    existing = await gh(
      `/repos/${HOST_REPO}/contents/${TAG_FILE_PATH}?ref=${encodeURIComponent(PR_HEAD_REF)}`,
    );
  } catch (_e) {
    // 404 expected on success (UI delete removed it) — nothing to do.
    console.log(
      `[cleanup-safety-net] ${TAG_FILE_PATH} not on ${PR_HEAD_REF} — UI delete succeeded, no cleanup needed`,
    );
    return;
  }

  console.warn(
    `[cleanup-safety-net] ${TAG_FILE_PATH} still on ${PR_HEAD_REF} after UI delete; removing via Contents API`,
  );
  try {
    await gh(`/repos/${HOST_REPO}/contents/${TAG_FILE_PATH}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `test(preview-tags): safety-net cleanup of ${TAG_FILE_PATH} (UI delete left mutation)`,
        sha: existing.sha,
        branch: PR_HEAD_REF,
      }),
    });
  } catch (e) {
    console.warn(
      `[cleanup-safety-net] failed to delete ${TAG_FILE_PATH} on ${PR_HEAD_REF}: ${e && e.message}`,
    );
  }
});

test(
  "CMS — tags lifecycle, preview env (target PR head branch)",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(!getPat(), "CMS_E2E_PAT not set — preview tags-lifecycle disabled.");
    // #33/#21 — a base_collections:[] bio renders none of the base collections; skip green there.
    test.skip(...guard(SITE_ROOT, "cms-tags-lifecycle-preview.spec.js"));
    test.skip(
      !PR_NUMBER || !PR_HEAD_REF,
      "PR_NUMBER / PR_HEAD_REF not set — this spec only runs in the cms-preview-loops workflow.",
    );

    // ── 0. Close any stale Decap PR on this run's branch ────────────
    // Slug is run-unique, so collisions are impossible — cheap guard,
    // matches the prod spec's pattern.
    await test.step("Close any stale Decap PR on the cms/tags/<slug> branch", async () => {
      await closeStaleDecapPrOnBranch({ branch: `cms/tags/${TAG_SLUG}` });
    });

    // ── 1. Pre-seed Decap auth and open the preview admin ───────────
    await seedDecapAuth(page);
    await test.step("Load preview admin", async () => {
      await page.goto(PREVIEW_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 2. CYCLE 1: create the Tags entry via Decap UI ──────────────
    await test.step("Navigate to new Tags entry editor", async () => {
      await page.goto(`${PREVIEW_ADMIN}#/collections/tags/new`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Name$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Fill Name and Save", async () => {
      await page.getByRole("textbox", { name: /^Name$/i }).fill(TAG_NAME);

      // INTENTIONALLY skipping the Description field. Decap's
      // label-to-textarea wiring for the `text` widget varies across
      // Decap versions enough to be a flake source — see the prod
      // cms-tags-lifecycle.spec.js step for the full incident note.
      // An entry with just Name is enough to drive the chain;
      // Description RENDERING is covered by
      // `_plugins_test/auto_tag_pages_test.rb` + `tags.spec.js`.

      await page.getByRole("button", { name: /^Save$/i }).click();
      await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Wait for the cms/tags/<slug> PR → label cms/ready", async () => {
      // New-file diff is all `+` lines including `+name: <TAG_NAME>`;
      // TAG_NAME carries the run-unique RUN_ID so it can't match any
      // other open cms PR's patch.
      const pr = await waitForCmsPullRequest({
        base: PR_HEAD_REF,
        filePath: TAG_FILE_PATH,
        canaryMarker: TAG_NAME,
        timeoutMs: 5 * 60 * 1000,
      });
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });

    // ── 3. Wait for the chain to publish /tags/<slug>/ on preview ───
    await test.step("Wait for /tags/<slug>/ to be served on preview (status 200)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PREVIEW,
        urlCheck: async () => {
          // Tags-collection entries with no posts tagging them still
          // get an archive page from auto_tag_pages (see the prod
          // spec / tags.spec.js empty-state assertion), so a fresh
          // `_tags/<slug>.md` with just Name gets a 200 page after
          // the chain runs.
          const res = await page.request.get(ARCHIVE_PUBLIC_URL, {
            failOnStatusCode: false,
          });
          return res.status() === 200;
        },
        urlTimeoutMs: 15 * 60 * 1000,
      });
    });

    // ── 4. CYCLE 2: delete the Tags entry via Decap UI ──────────────
    // Reset Decap's editorial state before the delete. The create
    // leg's cms/tags/<slug> PR merged into PR_HEAD_REF and its (fixed,
    // per-entry) branch is consumed; the in-memory editorial store
    // still believes that now-merged branch is its working ref, and a
    // bare in-SPA hash nav never reloads — so the delete could act on
    // a stale view (the failure-mode class run #26006678919 surfaced
    // in the model spec). Close any stale branch/PR server-side, then
    // force a full document reload so Decap re-reads the entry's
    // (now-published) editorial status from GitHub before the delete.
    await test.step("Reset Decap editorial state, then re-open the Tags entry", async () => {
      await closeStaleDecapPrOnBranch({ branch: `cms/tags/${TAG_SLUG}` });
      await page.goto(`${PREVIEW_ADMIN}#/collections/tags/entries/${TAG_SLUG}`, {
        waitUntil: "domcontentloaded",
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("textbox", { name: /^Name$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Click Delete published entry — confirms via dialog handler", async () => {
      // Editorial-workflow mode, but the Delete button is still
      // exposed directly on a published entry; the admin shim commits
      // the deletion past the ruleset (same path the prod spec uses —
      // no explicit cms/ready label needed for the delete leg).
      await page
        .getByRole("button", { name: /^delete (entry|published entry)$/i })
        .first()
        .click({ timeout: 30_000 });
    });

    // ── 5. Wait for the chain to remove /tags/<slug>/ on preview ────
    await test.step("Wait for /tags/<slug>/ to 404 on preview (chain complete)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PREVIEW,
        urlCheck: async () => {
          const res = await page.request.get(ARCHIVE_PUBLIC_URL, {
            failOnStatusCode: false,
          });
          // After the Tags entry is deleted AND no post tags this
          // run-unique slug (none does), auto_tag_pages skips the
          // page entirely and CloudFront serves 404 — the chain-
          // complete signal.
          return res.status() === 404;
        },
        urlTimeoutMs: 15 * 60 * 1000,
      });
    });
  },
);
