// @lane: local — uses the in-browser test-repo backend with a seeded fixture
const { test, expect } = require("./base");
const { SEED_POST_SLUG, loadTestAdmin, readDraftContent } = require("./cms-test-backend");

// Audit finding #18: catch the "body text accidentally typed into the
// excerpt field" regression. The Sveltia 0.158 layout shift moved the
// markdown body editor next to the excerpt textarea, and the
// `getByLabel(/Body/)` heuristic some specs use silently latched onto
// the wrong widget. Net effect: every Save shipped with body content
// in the excerpt and a blank body.
//
// Strategy: drive the editorial-workflow editor, type a unique
// sentinel into the BODY widget specifically, click Save, then read
// the saved file content and assert:
//   1. The body block contains the sentinel.
//   2. The `excerpt:` front-matter field is empty.

const SENTINEL = "FIELD_TARGETING_BODY_SENTINEL_4f29a";

// Split a written entry on the second `---` separator so we can look
// at the body and front matter independently.
function splitFrontMatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error(`unexpected entry shape:\n${content}`);
  return { frontMatter: m[1], body: m[2] };
}

test.describe(
  "Body sentinel lands in the body, not the excerpt",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test.beforeEach(async () => {});

    test("typing the sentinel into the Body widget saves it to the body, leaves excerpt empty", async ({
      page,
    }) => {
      await loadTestAdmin(page);
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });

      // Same locator pattern cms-publish-flow.spec.js uses — the markdown
      // widget's editing surface is a contenteditable role=textbox.
      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.waitFor({ timeout: 30_000 });
      await bodyEditor.click();
      await bodyEditor.fill(SENTINEL);

      await page
        .getByRole("button", { name: /^save$/i })
        .first()
        .click();

      let saved = null;
      await expect
        .poll(
          async () => {
            saved = await readDraftContent(page, {
              collection: "posts",
              slug: SEED_POST_SLUG,
            });
            return saved && saved.includes(SENTINEL);
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      const { frontMatter, body } = splitFrontMatter(saved);

      expect(
        body,
        `Body block (after the second ---) should contain the typed sentinel. Saved content was:\n${saved}`,
      ).toContain(SENTINEL);

      const excerptLine = frontMatter.split(/\r?\n/).find((l) => /^excerpt:/.test(l));
      expect(excerptLine, "excerpt front-matter line should exist").toBeDefined();
      // Acceptable shapes for "empty": `excerpt:`, `excerpt: ''`, `excerpt: ""`.
      expect(
        excerptLine.replace(/^excerpt:\s*/, "").trim(),
        `excerpt should remain empty — the body sentinel must not have leaked into the excerpt field. excerpt line was: ${excerptLine}`,
      ).toMatch(/^(''|""|)$/);
    });
  },
);
