// @lane: local — needs decap-server file IO + jekyll build to verify HTML embed renders
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// HTML Embed end-to-end render test.
//
// Locks the contributor capability documented in AGENTS.md ("Embedding
// HTML / Widgets"): a post body containing the sentinel-wrapped block
// emitted by the "HTML Embed" Decap editor component renders as actual
// HTML on the live site, with surrounding markdown still rendered as
// markdown.
//
//   1. Drive admin/index-local.html to create a post (Title, Slug, Body
//      filler) and Save through Decap. Local backend writes the file
//      under _posts/.
//   2. Patch the saved file to include the sentinel-wrapped
//      <div class="post-embed"> block plus markdown prose before/after.
//      Same file-patch approach as cms-inline-image.spec.js — bypasses
//      Decap's WYSIWYG mode-toggle which, per that spec's header note,
//      "isn't a stable contract across Decap minor versions." The
//      contract under test is the kramdown render pipeline, not the
//      toolbar selectors.
//   3. Rebuild Jekyll and fetch /blog/<slug>/.
//   4. Assert the rendered post contains <div class="post-embed"> with
//      the inner author HTML, and that markdown prose flanking the embed
//      still rendered (so markdown + HTML coexist in one body).
//
// The editor-component wiring itself (admin/editor-component-html-embed.js
// loaded after decap-cms.js) is exercised every time a CMS spec opens the
// admin — a script-tag regression in admin/index*.html surfaces as a
// pageerror on those existing specs.

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");

const SMOKE_TITLE = "E2E HTML Embed";
const SMOKE_SLUG = "e2e-html-embed";

const EMBED_INNER_ID = "html-embed-spec-marker";
const EMBED_INNER_TEXT = "interactive widget content";

const EMBED_BLOCK = [
  "<!-- html-embed:start -->",
  '<div class="post-embed">',
  `<p id="${EMBED_INNER_ID}">${EMBED_INNER_TEXT}</p>`,
  "</div>",
  "<!-- html-embed:end -->",
].join("\n");

function findSmokePostFile() {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const match = fs.readdirSync(POSTS_DIR).find((f) => f.endsWith(`-${SMOKE_SLUG}.md`));
  return match ? path.join(POSTS_DIR, match) : null;
}

function cleanup() {
  const f = findSmokePostFile();
  if (f) fs.unlinkSync(f);
  const site = path.join(REPO_ROOT, "_site", "blog", SMOKE_SLUG);
  if (fs.existsSync(site)) fs.rmSync(site, { recursive: true, force: true });
}

test.describe("HTML Embed renders as HTML on the live post", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  test.beforeAll(() => cleanup());
  test.afterAll(() => cleanup());

  test.beforeEach(({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop-1080",
      "Single project — local backend mutates the working tree.",
    );
    page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
  });

  test("post body with html-embed sentinel block → wrapper div renders, surrounding markdown still renders", async ({
    page,
  }) => {
    // ── Drive the admin: open New Post, fill Title / Slug / Body ─────
    await page.goto("/admin/index-local.html");
    await page.getByRole("button", { name: /login/i }).click();
    await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
    await page.goto("/admin/index-local.html#/collections/posts/new");

    const titleField = page.getByLabel(/^Title$/);
    await expect(titleField).toBeVisible({ timeout: 60_000 });
    await titleField.fill(SMOKE_TITLE);

    const slugField = page.getByLabel(/^URL Slug/);
    await slugField.fill(SMOKE_SLUG);

    const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
    await bodyEditor.waitFor({ timeout: 30_000 });
    await bodyEditor.click();
    await bodyEditor.pressSequentially("Body filler before the embed.\n");

    // Flip Published on so Jekyll picks the post up on the rebuild.
    await page
      .getByLabel(/^Published$/)
      .first()
      .click();

    // Save via the split publish menu (same pattern as cms-inline-image).
    await page
      .getByRole("button", { name: /^publish$/i })
      .first()
      .click();
    await page
      .getByRole("menuitem", { name: /publish now/i })
      .first()
      .click();

    // ── On-disk asserts: patch the body with the sentinel block ──────
    await expect.poll(() => findSmokePostFile() !== null, { timeout: 60_000 }).toBe(true);
    const postPath = findSmokePostFile();

    // Surround the embed with markdown prose so the assertions below
    // can verify markdown + HTML coexist in one body. The blank lines
    // before/after each block satisfy kramdown's block-HTML rule.
    const original = fs.readFileSync(postPath, "utf8");
    const patched =
      original.replace(/\s*$/, "") +
      "\n\n" +
      "Markdown prose **before** the embed.\n\n" +
      EMBED_BLOCK +
      "\n\n" +
      "Markdown prose *after* the embed.\n";
    fs.writeFileSync(postPath, patched);

    const written = fs.readFileSync(postPath, "utf8");
    expect(written).toContain(`title: ${SMOKE_TITLE}`);
    expect(written).toContain("<!-- html-embed:start -->");
    expect(written).toContain('<div class="post-embed">');
    expect(written).toContain(EMBED_INNER_TEXT);
    expect(written).toContain("<!-- html-embed:end -->");

    // ── Rendered post asserts ────────────────────────────────────────
    execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    const liveURL = `/blog/${SMOKE_SLUG}/`;
    const resp = await page.goto(liveURL);
    expect(resp.status(), `${liveURL} should be 200`).toBe(200);

    // The wrapper <div> rendered as HTML, not escaped. kramdown's default
    // (`parse_block_html: false`) keeps block HTML verbatim, so the inner
    // markup lands inside `.post-content` as-is.
    const embed = page.locator(".post-content .post-embed");
    await expect(embed).toBeVisible({ timeout: 10_000 });
    const inner = page.locator(`.post-content .post-embed #${EMBED_INNER_ID}`);
    await expect(inner).toBeVisible();
    await expect(inner).toHaveText(EMBED_INNER_TEXT);

    // Surrounding markdown still rendered as markdown — bold + italic
    // produced the expected tags around the embed. Confirms the
    // markdown + HTML mix documented in AGENTS.md.
    const content = page.locator(".post-content");
    await expect(content.locator("strong", { hasText: "before" })).toBeVisible();
    await expect(content.locator("em", { hasText: "after" })).toBeVisible();
  });
});
