// @lane: local — uses the in-browser test-repo backend; no real GitHub
const { test, expect } = require("./base");
const {
  SEED_POST_SLUG,
  SEED_POST_TITLE,
  SEED_POST_FILENAME,
  loadTestAdmin,
  readDraftContent,
} = require("./cms-test-backend");

// Audit finding #4: catch the "bundle silently dropped editorial_workflow"
// regression (the Sveltia 0.158 failure mode — every Save committed
// straight to main and got rejected by branch protection).
//
// Drives admin/index-test.html with the test-repo backend and
// editorial_workflow ON, edits a seeded post, hits Save, then asserts:
//   1. window.repoFilesUnpublished gained a draft entry, AND
//   2. window.repoFiles (the published state) was NOT mutated.
//
// If the bundle ever falls back to simple-mode under editorial_workflow,
// the published file changes and no unpublished entry appears — both
// assertions flip and the spec fails loudly.

test.describe(
  "Editorial workflow stays ON — Save creates a draft, never mutates main",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test.beforeEach(async () => {});

    test("Save on an existing post lands as an unpublished draft, not on main", async ({
      page,
    }) => {
      await loadTestAdmin(page);
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });

      const publishedBefore = await page.evaluate(
        (filename) => window.repoFiles?._posts?.[filename]?.content || null,
        SEED_POST_FILENAME,
      );
      expect(publishedBefore).toContain(SEED_POST_TITLE);

      const NEW_TITLE = `${SEED_POST_TITLE} — workflow-mode probe`;
      await titleField.fill(NEW_TITLE);

      // In editorial-workflow mode the primary toolbar action is "Save"
      // (drafts to a workflow branch). Simple mode would render "Publish"
      // with a split menu instead — bug-shape parity with the Sveltia
      // regression.
      await page
        .getByRole("button", { name: /^save$/i })
        .first()
        .click();

      await expect
        .poll(
          () =>
            readDraftContent(page, {
              collection: "posts",
              slug: SEED_POST_SLUG,
            }),
          { timeout: 30_000 },
        )
        .toContain(NEW_TITLE);

      // The CRUCIAL assertion: the published tree must NOT have been
      // mutated. This is what failed under Sveltia 0.158 — Save bypassed
      // the workflow and wrote directly to main, which is exactly what
      // mutating window.repoFiles models in this backend.
      const publishedAfter = await page.evaluate(
        (filename) => window.repoFiles?._posts?.[filename]?.content || null,
        SEED_POST_FILENAME,
      );
      expect(
        publishedAfter,
        "Save under editorial_workflow must NOT mutate window.repoFiles (the published-branch state). If this content shows the new title, the bundle silently fell back to simple mode.",
      ).toBe(publishedBefore);
    });
  },
);
