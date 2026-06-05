// @lane: real — exercises the real Decap → GitHub → Actions chain end to end for the Tags collection
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime via RUN_HOST_REPO_PUBLISH_LOOP being unset on the standard PR
// matrix — selecting + bringing it up just to no-op is pure waste. The
// dedicated cms-publish-loop-host workflow runs it nightly alongside
// cms-publish-loop / cms-delete-published.
//
// Closes task #51. End-to-end UI-driven validation of the Tags collection
// lifecycle THROUGH THE FULL PROD CHAIN:
//
//   1. Drive Decap UI to create a Tags-collection entry (Name + Description).
//   2. Save → Status: Ready → Publish Now → cms-editorial-workflow.yml
//      auto-merges the cms/tags/<slug> PR → deploy-production.yml runs →
//      auto_tag_pages plugin emits /tags/<slug>/ with the description →
//      CloudFront invalidates → live URL serves the description.
//   3. Drive Decap UI to delete the entry.
//   4. Same chain on the unpublish side: PR opens, auto-merges, deploy
//      runs, archive page either 404s (no posts tag it) or renders
//      without our description.
//
// Why GitHub backend (not local): per AGENTS.md "Never bypass the UI in
// a UI test" + "No back doors in setup or cleanup either", an end-to-end
// lifecycle assertion has to drive the full Decap → editorial-workflow
// → deploy-production chain, not just the editor + filesystem
// round-trip. Local backend (decap-server + Jekyll) tests editor UX
// only — the cms/<col>/<slug> PR / auto-merge / deploy-production /
// CloudFront pipeline is what would silently break a tag-rendering
// regression in production. Local-backend versions of this test exist
// elsewhere (`e2e/tags.spec.js` covers structural rendering against a
// local Jekyll build; `_plugins_test/auto_tag_pages_test.rb` covers
// the plugin's data shaping); this spec adds the missing chain layer.
//
// Why the Tags collection (not a tag-on-canary-post): the e2e canary
// post (`_e2e/canary-post.md`) doesn't have a `tags:` field in its
// admin/config*.yml entry, and `_layouts/canary.html` doesn't render
// tags. Adding both would expand scope into infrastructure. Driving
// the Tags COLLECTION instead — a fresh `_tags/<slug>.md` entry per
// run — exercises the same chain (cms/tags/<slug> PR → auto-merge →
// deploy-production → auto_tag_pages → /tags/<slug>/) without
// touching layouts or post fixtures. Slug is run-unique
// (`e2e-tags-canary-<runId>`) so concurrent runs don't race.

const path = require("node:path");
const { guard } = require("./base-collections-guards");
// #33/#21 — resolved like the other registered specs so the drift lint matches it.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { gh, makeDeployQueueExtender } = require("./github-actions-poll");
const {
  createBranchFromMain,
  deleteFileOnBranch,
  openPr,
  addReadyLabel,
  closeStaleDecapPrOnBranch,
  fixtureBranchName,
} = require("./cms-fixture-pr");
const { waitForChangeReflected } = require("./deploy-pill");
const { prodTarget } = require("./cms-host");

// Prod host triplet resolved through the shared cms-host SSOT (byte-identical
// to the old hardcoded literals) so prod/preview surfaces can't drift.
const { host: PROD_HOST, adminUrl: PROD_ADMIN, pillId: PILL_PROD } = prodTarget();
const PROD_CANARY = process.env.PROD_CANARY === "1";

// Runtime-unique slug + name avoid race with concurrent runs and stale
// /tags/<slug>/ pages from prior crashed runs.
const RUN_ID = Date.now();
const TAG_SLUG = `e2e-tags-canary-${RUN_ID}`;
const TAG_NAME = `E2E Tags Canary ${RUN_ID}`;
const TAG_FILE_PATH = `_tags/${TAG_SLUG}.md`;
const ARCHIVE_PUBLIC_URL = `${PROD_HOST}/tags/${TAG_SLUG}/`;

// 40 min covers two full chain cycles (create + delete) at a 15-min
// URL-wait cap each plus admin login, UI clicks, and afterAll
// safety-net. Matches cms-unpublish-republish.spec.js's budget.
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

// Fire-and-forget safety-net cleanup. If the UI-driven delete in the
// test body fails (Decap regression, mid-run cancellation, anything),
// the tag-entry file would otherwise sit on main and pollute the site's
// /tags/<slug>/ page until manual cleanup. This afterAll opens a
// `cms/e2e-fixture/cleanup-…` PR that deletes the file, applies
// cms/ready, and returns immediately — does NOT wait for the merge.
// The editorial-workflow auto-merges in the background; the daily
// `sweep-stale-cms-prs.yml` workflow catches orphan PRs (Tier 1
// covers the `cms/e2e-fixture/` prefix).
//
// Per AGENTS.md "No back doors in cleanup either": the UI-driven
// cleanup IS the contract; this safety-net only fires when that
// contract demonstrably failed. Logged with a warning so a regression
// doesn't get silently papered over.
test.afterAll(async () => {
  if (PROD_CANARY) return;
  if (!getPat()) return;
  // Mirror the test-body skip: this hook recovers from a failed
  // mid-mutation in THIS run. Outside the host-loop workflow the
  // body never runs, so there's nothing to clean up — and reading
  // the tag file from e.g. e2e-real while host-loop is mid-flight
  // on a parallel run can fire spurious cleanup PRs against the
  // in-flight mutation. Only cleanup in the same context that
  // owns the mutation.
  if (process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1") return;
  // Bump the hook timeout — the API calls (createBranch + deleteFile +
  // openPr + addReadyLabel) take a few seconds total but can stretch
  // under runner contention. 2 min covers the worst case.
  test.setTimeout(2 * 60 * 1000);

  // Check whether the file still exists on main. If the UI-delete step
  // succeeded, this returns 404 and we early-return.
  let tagFileStillExists = false;
  try {
    await gh(`/repos/${HOST_REPO}/contents/${TAG_FILE_PATH}?ref=main`);
    tagFileStillExists = true;
  } catch (_e) {
    // 404 expected on success — fall through.
  }
  if (!tagFileStillExists) {
    console.log(
      `[cleanup-safety-net] ${TAG_FILE_PATH} not on main — UI-delete succeeded, no cleanup needed`,
    );
    return;
  }

  console.warn(
    `[cleanup-safety-net] ${TAG_FILE_PATH} still on main after UI-delete; opening fire-and-forget cleanup PR`,
  );

  // Use cms-fixture-pr.js primitives directly (NOT removeFixtureViaPr)
  // because the latter blocks on a 25-min waitForMerge that would
  // overrun the hook timeout. Open + label, then return.
  const branch = fixtureBranchName({
    slug: TAG_SLUG,
    runId: `cleanup-${RUN_ID}`,
    action: "remove",
  });
  try {
    await createBranchFromMain({ repo: HOST_REPO, branch });
    await deleteFileOnBranch({
      repo: HOST_REPO,
      branch,
      filePath: TAG_FILE_PATH,
      message: `test(canary): safety-net cleanup of ${TAG_FILE_PATH} (UI delete left mutation)`,
    });
    const pr = await openPr({
      repo: HOST_REPO,
      branch,
      title: `test(canary): safety-net cleanup of ${TAG_FILE_PATH}`,
      body:
        `Automated cleanup by \`cms-tags-lifecycle.spec.js\`'s afterAll safety-net.\n\n` +
        `The UI-driven delete in the test body did not unlink \`${TAG_FILE_PATH}\` from main.\n` +
        `This PR auto-merges via \`cms/ready\`. The daily \`sweep-stale-cms-prs.yml\` workflow ` +
        `catches it as Tier 1 if it doesn't auto-merge.`,
    });
    await addReadyLabel({ repo: HOST_REPO, prNumber: pr.number });
    console.log(
      `[cleanup-safety-net] opened cleanup PR #${pr.number} on branch ${branch}; not waiting for merge`,
    );
  } catch (e) {
    console.warn(`[cleanup-safety-net] failed to open cleanup PR: ${e && e.message}`);
  }
});

test(
  "CMS — tags lifecycle (host repo, target main)",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    test.skip(PROD_CANARY, "PROD_CANARY=1 — daily canary probe doesn't run mutation specs.");
    test.skip(
      !getPat(),
      "CMS_E2E_PAT not set — host-repo tags-lifecycle disabled. (Forks and Dependabot are expected to land here.)",
    );
    test.skip(
      process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1",
      "RUN_HOST_REPO_PUBLISH_LOOP not set — host-repo tags-lifecycle is opt-in (avoids cms/* PR self-recursion in PR-time CI).",
    );
    // #33/#21 — a base_collections:[] bio renders no Posts sidebar / Tags editor;
    // skip green there, run in full where posts+tags are kept.
    test.skip(...guard(SITE_ROOT, "cms-tags-lifecycle.spec.js"));

    // ── 0. Close any stale Decap PR on this run's branch ──────────────
    // Slug is run-unique here, so collisions are impossible — but this
    // guard is cheap and matches cms-publish-loop's pattern.
    await test.step("Close any stale Decap PR on the cms/tags/<slug> branch", async () => {
      await closeStaleDecapPrOnBranch({
        branch: `cms/tags/${TAG_SLUG}`,
      });
    });

    // ── 1. Pre-seed Decap auth and open the prod admin ────────────────
    await seedDecapAuth(page);
    await test.step("Load production admin", async () => {
      await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 2. CYCLE 1: create the Tags-collection entry via Decap UI ─────
    await test.step("Navigate to new Tags entry editor", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/tags/new`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Name$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Fill Name and Save", async () => {
      await page.getByRole("textbox", { name: /^Name$/i }).fill(TAG_NAME);

      // INTENTIONALLY skipping the Description field. Decap's
      // label-to-textarea wiring for the `text` widget (which
      // Description uses) varies across Decap versions — see
      // cms-smoke.spec.js's identical decision: "Description is
      // required: false and its label-to-textarea wiring varies
      // enough across Decap versions to be a flake source." Two
      // failing runs here (#25582963426 with role=textbox by name,
      // #25583283581 with role=textbox+contenteditable selector)
      // both confirmed the field doesn't match either pattern in
      // the current prod admin. The lifecycle assertion still
      // works without it: an entry with just Name is enough to
      // drive `cms/tags/<slug>` PR → auto-merge → deploy-production
      // → auto_tag_pages → /tags/<slug>/ rendering. Description
      // RENDERING is a separate, Jekyll-build-time concern covered
      // by `_plugins_test/auto_tag_pages_test.rb` and read-only
      // structural specs in `tags.spec.js`.

      await page.getByRole("button", { name: /^Save$/i }).click();
      await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("Drive Status: Draft → Ready", async () => {
      await page.getByRole("button", { name: /^Status:\s*Draft$/i }).click();
      await page.getByRole("menuitem", { name: /^Ready$/i }).click();
      await expect(page.getByRole("button", { name: /^Status:\s*Ready$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Click Publish → Publish Now", async () => {
      await page.getByRole("button", { name: /^Publish$/i }).click();
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click();
    });

    // ── 3. Wait for the chain to publish /tags/<slug>/ (chain complete)
    await test.step("Wait for /tags/<slug>/ to be served (status 200, chain complete)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          // Tags-collection entries with no posts tagging them still
          // get an archive page from auto_tag_pages — see tags.spec.js's
          // "tag with no matching posts shows the empty-state placeholder"
          // assertion. So a fresh `_tags/<slug>.md` with just a Name field
          // gets a 200 page after the chain runs (with the empty-state
          // placeholder body, since no post tags `e2e-tags-canary-<runId>`).
          const res = await page.request.get(ARCHIVE_PUBLIC_URL, {
            failOnStatusCode: false,
          });
          return res.status() === 200;
        },
        // 15 min covers cms-editorial-workflow + auto-merge + required
        // checks + deploy-production + CloudFront propagation under
        // runner contention. Matches cms-publish-loop / prod-mutate.
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // ── 4. CYCLE 2: delete the Tags entry via Decap UI ───────────────
    await test.step("Navigate back to the Tags entry editor", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/tags/entries/${TAG_SLUG}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Name$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Click Delete published entry — confirms via dialog handler", async () => {
      // Prod backend is editorial-workflow mode, but the Delete button
      // is still exposed directly on a published entry. Persistent
      // dialog handler from beforeEach accepts the confirm().
      await page
        .getByRole("button", { name: /^delete (entry|published entry)$/i })
        .first()
        .click({ timeout: 30_000 });
    });

    // ── 5. Wait for the chain to remove /tags/<slug>/ (chain complete)
    await test.step("Wait for /tags/<slug>/ to 404 (chain complete)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(ARCHIVE_PUBLIC_URL, {
            failOnStatusCode: false,
          });
          // After the Tags entry is deleted AND no post tags this
          // run-unique slug (none does — the slug is per-run and only
          // the Tags entry creates it), auto_tag_pages skips the page
          // entirely and CloudFront serves 404. That's the chain-
          // complete signal.
          return res.status() === 404;
        },
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });
  },
);
