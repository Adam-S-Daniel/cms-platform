// @lane: local — needs decap-server file IO to round-trip uploaded images
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// Verifies the contributor capability "Upload a featured image":
//
//   1. Drive admin/index-local.html, create a post, attach a fixture PNG
//      via the Featured Image widget.
//   2. Assert the file lands DIRECTLY in assets/images/uploads/ (the
//      media_folder is flat + template-free — admin/config.yml).
//   3. Assert the post's front matter references the upload at the
//      byte-identical public URL (public_folder == "/" + media_folder).
//   4. Rebuild Jekyll, fetch /blog/<slug>/, and assert the rendered
//      <img.featured-image> src resolves to a real 200. Because the
//      path is flat, decap-server and the production GitHub backend
//      now write the IDENTICAL path, so this local run is a faithful
//      end-to-end check — there is no template-expansion gap to
//      tolerate.

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const UPLOADS_ROOT = path.join(REPO_ROOT, "assets", "images", "uploads");
const FIXTURE_PNG = path.join(__dirname, "fixtures", "tiny-pixel.png");

const SMOKE_TITLE = "E2E Image Upload Smoke";
const SMOKE_SLUG = "e2e-image-upload-smoke";

function findSmokePostFile() {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const match = fs.readdirSync(POSTS_DIR).find((f) => f.endsWith(`-${SMOKE_SLUG}.md`));
  return match ? path.join(POSTS_DIR, match) : null;
}

// Walk uploads/ and return any file matching the fixture's basename.
// Decap may rename the file (e.g. dedupe suffix) so we accept
// "tiny-pixel*.png".
function findUploadedFixture() {
  if (!fs.existsSync(UPLOADS_ROOT)) return null;
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^tiny-pixel.*\.png$/i.test(entry.name)) matches.push(full);
    }
  }
  walk(UPLOADS_ROOT);
  return matches[0] || null;
}

function cleanup() {
  const f = findSmokePostFile();
  if (f) fs.unlinkSync(f);
  const up = findUploadedFixture();
  if (up) fs.unlinkSync(up);
  // Also clear the rendered output from _site/ so the next run isn't
  // serving a stale copy.
  const site = path.join(REPO_ROOT, "_site", "blog", SMOKE_SLUG);
  if (fs.existsSync(site)) fs.rmSync(site, { recursive: true, force: true });
}

test.describe(
  "Featured Image upload via the CMS",
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

    test("uploaded image lands flat in uploads/, post references it, image resolves 200", async ({
      page,
    }) => {
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
      await bodyEditor.fill("Body for image-upload test.");

      // Featured Image widget — open the media library, then drive
      // Decap's hidden <input type="file"> directly via setInputFiles
      // (Playwright accepts that on inputs even when they're not visible
      // to the user). Decap watches that input's `change` event and runs
      // the same upload + select pipeline as a real picker click.
      await page
        .getByRole("button", { name: /choose (an )?image/i })
        .first()
        .click();
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 30_000 });
      await fileInput.setInputFiles(FIXTURE_PNG);
      // Decap auto-selects the freshly uploaded asset; commit the
      // selection back to the form. Library's confirm button label varies
      // ("Choose selected" in 3.x, "Insert" historically).
      const insertBtn = page.getByRole("button", { name: /^(choose selected|insert)$/i }).first();
      await expect(insertBtn).toBeVisible({ timeout: 30_000 });
      await insertBtn.click();

      // Flip Published on so Jekyll picks the post up on the rebuild.
      await page
        .getByLabel(/^Published$/)
        .first()
        .click();

      // Save (split publish menu — same shape as cms-publish-flow).
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
      await expect.poll(() => findUploadedFixture() !== null, { timeout: 60_000 }).toBe(true);

      const uploaded = findUploadedFixture();
      // The media_folder is flat + template-free, so the file must land
      // DIRECTLY in assets/images/uploads/ — not in any subdirectory.
      // Asserting the exact relative shape (no path separator) is what
      // catches a regression back to a nested/templated media_folder.
      const rel = path.relative(UPLOADS_ROOT, uploaded);
      expect(
        rel,
        "Uploaded file must land directly in assets/images/uploads/ with no subdirectory",
      ).toMatch(/^tiny-pixel.*\.png$/i);

      // Front matter must reference the upload at the byte-identical
      // public URL: public_folder ("/assets/images/uploads") + "/" + the
      // exact on-disk basename. No `.*` wildcard in the middle — the path
      // is fully determined now, so we pin it.
      const uploadedBase = path.basename(uploaded);
      const expectedPublicUrl = `/assets/images/uploads/${uploadedBase}`;
      const written = fs.readFileSync(findSmokePostFile(), "utf8");
      expect(written).toContain(`title: ${SMOKE_TITLE}`);
      expect(written).toMatch(
        new RegExp(
          `featured_image:\\s*['"]?${expectedPublicUrl.replace(/[.]/g, "\\$&")}['"]?\\s*$`,
          "m",
        ),
      );

      // ── Rendered post asserts ────────────────────────────────────────
      // Rebuild Jekyll and verify the rendered <img.featured-image> src
      // resolves to a real 200. The path is flat, so decap-server writes
      // the IDENTICAL path the production GitHub backend would — this
      // local run is a faithful end-to-end check, with no
      // template-expansion gap to tolerate. A 404 here is a real failure.
      execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      const liveURL = `/blog/${SMOKE_SLUG}/`;
      const resp = await page.goto(liveURL);
      expect(resp.status(), `${liveURL} should be 200`).toBe(200);
      const imgSrc = await page.locator(".post-header .featured-image").getAttribute("src");
      expect(imgSrc, "Rendered post must include the featured-image <img>").toBe(expectedPublicUrl);
      // Actually fetch the image URL — the bug this whole change fixes is
      // "the post references an image URL that 404s." Assert it 200s with
      // real image bytes, not just that the <img> tag is present.
      const imgAbs = new URL(imgSrc, page.url()).toString();
      const imgResp = await page.request.get(imgAbs);
      expect(
        imgResp.status(),
        `Featured image ${imgAbs} must resolve 200 (this is the broken-image regression guard)`,
      ).toBe(200);
      expect(
        (await imgResp.body()).length,
        "Featured image response must have non-empty bytes",
      ).toBeGreaterThan(0);
    });
  },
);
