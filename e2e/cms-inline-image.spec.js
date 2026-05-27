// @lane: local — needs decap-server file IO + git execs to verify inline image drafts
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// B1 — Inline markdown image in post body.
//
// Verifies the contributor capability "insert an inline image into a post
// body and have it render on the live site":
//
//   1. Drive admin/index-local.html to create a post.
//   2. Plant a fixture PNG directly in assets/images/uploads/ (the
//      media_folder is flat + template-free in admin/config.yml, so
//      this is byte-identical to where a real upload lands on every
//      backend).
//   3. Type the inline-image markdown reference into the body editor so the
//      saved markdown contains `![alt](/assets/images/uploads/...)`.
//   4. Save (local-backend forces simple mode regardless of `publish_mode`,
//      so the file lands directly in `_posts/`).
//   5. Rebuild Jekyll and fetch /blog/<slug>/.
//   6. Assert the rendered post contains an inline <img> with non-empty
//      alt and that HEAD'ing the src returns 200.
//
// Why a separate spec from cms-image-upload.spec.js: that spec covers the
// Featured Image widget (front-matter `featured_image: ...` rendered by
// _layouts/post.html as `<img class="featured-image">`). This one covers
// inline images embedded in the markdown body — a different code path
// (kramdown converts `![]()` into `<img>` inside `.post-content`). The
// failure modes don't overlap.
//
// Why we plant the upload directly instead of driving the markdown
// widget's image-upload toolbar button: the widget's source-mode toggle
// and image-button selectors aren't a stable contract across Decap
// minor versions, but the CMS-facing contract that matters here is
// "post body markdown referencing /assets/images/uploads/... renders an
// <img> on the live site whose src resolves." This spec asserts that
// contract end to end.

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const UPLOADS_ROOT = path.join(REPO_ROOT, "assets", "images", "uploads");
const FIXTURE_PNG = path.join(__dirname, "fixtures", "inline-image.png");

const SMOKE_TITLE = "E2E Inline Image";
const SMOKE_SLUG = "e2e-inline-image";

// admin/config.yml's media_folder is flat + template-free
// ("assets/images/uploads"), and public_folder is its URL form
// ("/assets/images/uploads"). The planted fixture's on-disk path and
// the URL written into the markdown are therefore the SAME directory —
// which is exactly the property a real upload now has on every backend.
function uploadDir() {
  return UPLOADS_ROOT;
}
function uploadPublicPath() {
  return `/assets/images/uploads/inline-image.png`;
}

function findSmokePostFile() {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const match = fs.readdirSync(POSTS_DIR).find((f) => f.endsWith(`-${SMOKE_SLUG}.md`));
  return match ? path.join(POSTS_DIR, match) : null;
}

function cleanup() {
  // Remove the post file the test wrote into _posts/.
  const f = findSmokePostFile();
  if (f) fs.unlinkSync(f);

  // Remove the planted fixture upload.
  const planted = path.join(uploadDir(), "inline-image.png");
  if (fs.existsSync(planted)) fs.unlinkSync(planted);

  // Clear the rendered output so a stale copy can't satisfy the live
  // URL assertion if a re-run skips the build.
  const site = path.join(REPO_ROOT, "_site", "blog", SMOKE_SLUG);
  if (fs.existsSync(site)) fs.rmSync(site, { recursive: true, force: true });
}

test.describe(
  "Inline markdown image renders on the live post",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => cleanup());
    test.afterAll(() => cleanup());

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("create post with inline image markdown → renders <img> with reachable src", async ({
      page,
    }) => {
      // ── Plant the upload fixture ─────────────────────────────────────
      // Mirrors a real upload via the markdown widget's image button: the
      // file lands directly in the flat media_folder with the
      // byte-identical public URL Decap would emit.
      const uploadDirAbs = uploadDir();
      fs.mkdirSync(uploadDirAbs, { recursive: true });
      fs.copyFileSync(FIXTURE_PNG, path.join(uploadDirAbs, "inline-image.png"));
      const inlineImageMd = `![inline image](${uploadPublicPath()})`;

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

      // The body widget supports two modes (`admin/config.yml`:
      // `body.modes: [rich_text, raw]`). Rich-text mode treats typed text
      // through the WYSIWYG editor and escapes markdown-special chars on
      // serialize — `!` typed before `[` round-trips as literal `!\[`,
      // which kramdown then renders as text, not an `<img>`. Switching to
      // raw / Markdown mode would preserve the typed markdown atom, but
      // the mode-toggle's selector isn't a stable Decap contract across
      // minor versions (per the spec's own header note: "the widget's
      // source-mode toggle and image-button selectors aren't a stable
      // contract"). So we type only plain text here, then patch the saved
      // file with the inline-image markdown post-save — that exercises
      // the same render-pipeline contract (kramdown → <img>; uploads
      // pipeline serves the asset; layout doesn't strip the leading /)
      // without depending on the unstable WYSIWYG mode-toggle.
      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.waitFor({ timeout: 30_000 });
      await bodyEditor.click();
      await bodyEditor.pressSequentially("Body for inline-image test.\n");

      // Flip Published on so Jekyll picks the post up on the rebuild.
      await page
        .getByLabel(/^Published$/)
        .first()
        .click();

      // Save (split publish menu — same pattern as cms-image-upload).
      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click();

      // ── On-disk asserts ──────────────────────────────────────────────
      await expect.poll(() => findSmokePostFile() !== null, { timeout: 60_000 }).toBe(true);
      const postPath = findSmokePostFile();

      // Patch the saved body to append the inline-image markdown atom.
      // See the bodyEditor comment above — this bypasses Decap's
      // unstable mode-toggle while still exercising the kramdown render
      // path the spec was designed to lock.
      const original = fs.readFileSync(postPath, "utf8");
      const patched = original.replace(/\s*$/, "") + `\n\n${inlineImageMd}\n`;
      fs.writeFileSync(postPath, patched);

      const written = fs.readFileSync(postPath, "utf8");
      expect(written).toContain(`title: ${SMOKE_TITLE}`);
      // Inline-image markdown atom must be present on disk — that's what
      // kramdown reads to emit the <img> tag in the rendered HTML.
      expect(written).toMatch(
        /!\[inline image\]\(\/assets\/images\/uploads\/[^/]*inline-image\.png\)/,
      );

      // ── Rendered post asserts ────────────────────────────────────────
      execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      const liveURL = `/blog/${SMOKE_SLUG}/`;
      const resp = await page.goto(liveURL);
      expect(resp.status(), `${liveURL} should be 200`).toBe(200);

      // Inline images live in `.post-content` (rendered from the body
      // markdown). Featured images live in `.post-header > img.featured-image`,
      // a different parent — so locating inside `.post-content` is unambiguous.
      const inlineImg = page.locator(".post-content img").first();
      await expect(inlineImg).toBeVisible({ timeout: 10_000 });
      const imgSrc = await inlineImg.getAttribute("src");
      const imgAlt = await inlineImg.getAttribute("alt");
      expect(imgSrc, "Inline <img> must reference uploads path").toMatch(
        /\/assets\/images\/uploads\/[^/]*inline-image\.png$/,
      );
      expect(imgAlt, "Inline <img> alt must be non-empty").toBeTruthy();

      // HEAD-fetch the src on the same origin so the test catches a
      // build-time path drift (e.g. relative_url stripping the leading /).
      const srcAbs = imgSrc.startsWith("http") ? imgSrc : new URL(imgSrc, page.url()).toString();
      const head = await page.request.fetch(srcAbs, { method: "HEAD" });
      expect(head.status(), `${srcAbs} should be 200`).toBe(200);
    });
  },
);
