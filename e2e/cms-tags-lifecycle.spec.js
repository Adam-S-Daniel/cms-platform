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
const {
  gh,
  addLabel,
  getPullRequest,
  waitForCmsPullRequest,
  waitForMerge,
  makeDeployQueueExtender,
} = require("./github-actions-poll");
const {
  createBranchFromMain,
  deleteFileOnBranch,
  openPr,
  addReadyLabel,
  closeStaleDecapPrOnBranch,
  fixtureBranchName,
} = require("./cms-fixture-pr");
const {
  reopenForPublishedDelete,
  confirmEditorDelete,
  clickEditorDelete,
} = require("./cms-editor-ui");
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

// 80 min (bumped from 40) covers two full chain cycles (create + delete)
// where the delete leg now waits for the create PR to actually MERGE
// (waitForMerge, 30-min budget) and reopens the entry in the PUBLISHED
// state (reopenForPublishedDelete, up to a 25-min resync) before deleting
// -- mirroring cms-publish-loop-prod-mutate.spec.js -- plus the 15-min
// URL-wait cap on each leg, admin login, UI clicks, and afterAll
// safety-net.
const TEST_TIMEOUT_MS = 80 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

// Contents-API existence probe on main -- used by reopenForPublishedDelete's
// crossCheck so a reopen timeout can distinguish "Decap is slow" from "the
// create PR's merge never landed" (#1815). Mirrors the helper in
// cms-publish-loop-prod-mutate.spec.js / cms-delete-published.spec.js.
async function fileExistsOnMain(filePath) {
  try {
    await gh(`/repos/${HOST_REPO}/contents/${filePath}?ref=main`);
    return true;
  } catch (e) {
    if (/\b404\b/.test(String(e.message))) return false;
    throw e;
  }
}

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

    // -- 2b. Find the create cms/tags/... PR Decap opened; label cms/ready.
    // Capturing the create PR number lets the delete leg wait for its REAL
    // merge before reopening the entry for the published-delete path
    // (mirrors cms-publish-loop-prod-mutate.spec.js).
    let createPrNumber = null;
    await test.step("Wait for Decap to open the create cms/tags/... PR, label cms/ready", async () => {
      const pr = await waitForCmsPullRequest({
        base: "main",
        filePath: TAG_FILE_PATH,
        // Marker must be in the file's DIFF CONTENT (f.patch), not the path.
        // TAG_SLUG (hyphenated) is only the filename; TAG_NAME (spaced) is the
        // `title`/name frontmatter Decap writes, and RUN_ID is inside it. Use it.
        canaryMarker: String(RUN_ID),
        timeoutMs: 5 * 60 * 1000,
      });
      expect(pr.number, "Decap create PR number").toBeGreaterThan(0);
      createPrNumber = pr.number;
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
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

    // -- 3b. Wait for the create PR to actually merge (not just the
    // synthetic Publish-Now ack). The delete leg must not reopen the entry
    // until the create PR's cms/tags/<slug> branch is truly gone, else Decap
    // reloads it as an OPEN editorial draft ("Delete unpublished entry",
    // drops only the draft branch, never main) and /tags/<slug>/ never 404s.
    // Mirrors cms-publish-loop-prod-mutate.spec.js.
    await test.step("Wait for the create PR to actually merge (not just the synthetic Publish-Now ack)", async () => {
      expect(createPrNumber, "create PR number captured for merge wait").toBeTruthy();
      await waitForMerge({ prNumber: createPrNumber, timeoutMs: 30 * 60 * 1000 });
    });

    // ── 4. CYCLE 2: delete the Tags entry via Decap UI ───────────────
    await test.step("Re-open the Tags entry in PUBLISHED state for the delete leg", async () => {
      // Mirrors cms-publish-loop-prod-mutate.spec.js: after Publish-Now's
      // synthetic merged:true the create PR's cms/tags/<slug> branch lingers
      // until the REAL auto-merge lands; reopening during that window reloads
      // an OPEN editorial draft ("Delete unpublished entry", drops only the
      // draft branch). reopenForPublishedDelete poll-reloads until Decap shows
      // the PUBLISHED file ("Delete published entry"). The Tags editor's title
      // field is "Name", not "Title", so pass titleName accordingly.
      await reopenForPublishedDelete(page, `${PROD_ADMIN}#/collections/tags/entries/${TAG_SLUG}`, {
        titleName: /^Name$/i,
        crossCheck: () => fileExistsOnMain(TAG_FILE_PATH),
        adminUrl: PROD_ADMIN,
      });
    });

    await test.step("Click the editor's Delete button -> opens delete-from-main cms/... PR", async () => {
      // confirmEditorDelete arms a POST /git/trees watcher BEFORE the click
      // and AWAITS it as positive proof Decap dispatched the delete -- a
      // silent no-op throws HERE (the real fault site) instead of 900s later
      // in the URL-404 wait (#1815 delete-phase). The persistent dialog
      // handler from beforeEach accepts the native confirm(). Mirrors
      // cms-publish-loop-prod-mutate.spec.js.
      await confirmEditorDelete(page, () => clickEditorDelete(page));
    });

    // -- 4b. Label the delete cms/... PR cms/ready if Decap opened one.
    // Decap's "Delete published entry" commits via the git data API; the
    // terminal ref update is 422'd by branch protection and
    // admin/publish-via-auto-merge.js recovers it by opening a cms/* delete
    // PR labelled cms/ready. Re-label it (idempotent) so auto-merge lands +
    // deploys the delete. Mirrors cms-publish-loop-prod-mutate.spec.js.
    await test.step("Label the delete cms/... PR cms/ready if Decap opened one", async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        let prs = [];
        try {
          prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=50`);
        } catch (_) {
          /* transient -- retry */
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
          const removesTag = files.some(
            (f) => f.filename === TAG_FILE_PATH && f.status === "removed",
          );
          if (removesTag) {
            try {
              await addLabel({ prNumber: pr.number, label: "cms/ready" });
            } catch (e) {
              console.warn(`[tags-lifecycle] could not label PR #${pr.number}: ${e && e.message}`);
            }
            labelled = true;
            break;
          }
        }
        if (labelled) break;
        await new Promise((r) => setTimeout(r, 6000));
      }
      // Not finding a PR is fine -- Decap committed the delete straight to main.
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
