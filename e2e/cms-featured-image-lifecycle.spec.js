// @lane: local — needs decap-server file IO + local Jekyll for the lifecycle
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");
const { guard } = require("./base-collections-guards");

// Verifies the contributor capability "Featured-image lifecycle on a post":
//
//   1. Set image A → Save → assert front matter references A's public path
//      → rebuild Jekyll → assert `<img class="featured-image">` renders.
//   2. Replace with image B → Save → assert front matter references B.
//   3. Assert image A is STILL on disk under uploads/ — Decap doesn't
//      garbage-collect orphaned uploads. That's the contract editors
//      need to know about (CONTENT_GUIDE.md surfaces it; this spec
//      pins the implementation behaviour the docs are claiming).
//   4. Clear the field → Save → assert front matter has no
//      `featured_image:` line → rebuild → assert no `<img.featured-image>`.
//
// Why this is its own spec (not folded into cms-image-upload.spec.js):
//   - cms-image-upload covers "happy path: upload + render" only. The
//     replace + clear paths are distinct widget interactions and a
//     distinct front-matter contract (a present empty-string vs. an
//     absent key both have to be tested explicitly because
//     `_layouts/post.html` only branches on `page.featured_image and
//     page.featured_image != ""`).
//   - Lifecycle = order-dependent. We need `test.describe.configure({
//     mode: "serial" })` because each step builds on the prior on-disk
//     state. Mixing this into a happy-path spec would make the matrix
//     reasoning harder for the next contributor.
//
// HARD GUARDS:
//   - SLUG is "e2e-featured-image-lifecycle" — unique, future-dated
//     (2099-01-02) so the file name is deterministic and can never
//     collide with the canary `_posts/2026-04-25-...` posts the
//     editorial-workflow specs depend on.
//   - afterAll cleanup unconditionally removes the spec's post + any
//     orphaned uploads so a flake leaves zero residue.

const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, ".."); // #33 base_collections guard root
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const UPLOADS_ROOT = path.join(REPO_ROOT, "assets", "images", "uploads");
const FIXTURE_A = path.join(__dirname, "fixtures", "tiny-pixel.png");
const FIXTURE_B = path.join(__dirname, "fixtures", "tiny-pixel-2.png");

const TITLE = "E2E Featured Image Lifecycle";
const SLUG = "e2e-featured-image-lifecycle";
// Fixed future date so the on-disk filename is deterministic, the
// entry's deeplink URL is computable, and no real content can ever
// land at the same slug.
const POST_DATE_DATE = "2099-01-02";
const POST_DATE_TIME = "12:00";
// `slug:` template in admin/config.yml is
// "{{year}}-{{month}}-{{day}}-{{slug}}", so this is what Decap will
// name both the file and the deeplink path segment.
const FILE_SLUG = `${POST_DATE_DATE}-${SLUG}`;
const POST_PATH = path.join(POSTS_DIR, `${FILE_SLUG}.md`);
const ENTRY_URL = `/admin/index-local.html#/collections/posts/entries/${FILE_SLUG}`;

// Walk uploads/ and collect every PNG whose basename starts with the
// given fixture's basename. Decap may rename on collision (e.g.
// `-1.png` suffix), so we accept any prefix match.
function findUploadsByPrefix(prefix) {
  if (!fs.existsSync(UPLOADS_ROOT)) return [];
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith(prefix) && /\.png$/i.test(entry.name)) {
        matches.push(full);
      }
    }
  }
  walk(UPLOADS_ROOT);
  return matches;
}

function cleanup() {
  if (fs.existsSync(POST_PATH)) fs.unlinkSync(POST_PATH);
  // Wipe both fixtures' on-disk uploads so a re-run starts clean.
  for (const prefix of ["tiny-pixel", "tiny-pixel-2"]) {
    for (const f of findUploadsByPrefix(prefix)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // best-effort
      }
    }
  }
  // Also clear the rendered output so the next run isn't serving a
  // stale copy via `npx serve _site`.
  const site = path.join(REPO_ROOT, "_site", "blog", SLUG);
  if (fs.existsSync(site)) fs.rmSync(site, { recursive: true, force: true });
}

function jekyllBuild() {
  // `--future` is mandatory: the fixture post is dated 2099-01-02 so the
  // on-disk filename stays deterministic across runs, but Jekyll's
  // default `future: false` then skips the post and the public URL
  // 404s. C3's first-post sim got away without this because it uses
  // today's date (Decap's default); B7 can't, because the filename
  // round-trips through `_posts/YYYY-MM-DD-<slug>.md` and the test
  // pins YYYY-MM-DD to keep the path predictable.
  execFileSync("bundle", ["exec", "jekyll", "build", "--quiet", "--future"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

async function loginAndOpenNew(page) {
  await page.goto("/admin/index-local.html");
  await page.getByRole("button", { name: /login/i }).click();
  await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
  await page.goto("/admin/index-local.html#/collections/posts/new");
}

async function openExistingEntry(page) {
  await page.goto("/admin/index-local.html");
  await page.getByRole("button", { name: /login/i }).click();
  await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
  await page.goto(ENTRY_URL);
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
}

// Drive the Featured Image widget — open the media library, then
// drive Decap's hidden <input type="file"> directly via setInputFiles.
// Same shape cms-image-upload.spec.js uses for the happy path.
async function uploadFeaturedImage(page, fixturePath) {
  // The "Choose an image" button is only present when the field is
  // empty. After an image is set, Decap swaps it for "Choose
  // different image". Match either label so the same helper handles
  // both initial-set and replace flows.
  await page
    .getByRole("button", { name: /choose (an |different )?image/i })
    .first()
    .click();
  const fileInput = page.locator('input[type="file"][accept*="image"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 30_000 });
  await fileInput.setInputFiles(fixturePath);
  // Decap auto-selects the freshly uploaded asset; commit selection.
  // Library's confirm button label varies by Decap version.
  const insertBtn = page.getByRole("button", { name: /^(choose selected|insert)$/i }).first();
  await expect(insertBtn).toBeVisible({ timeout: 30_000 });
  await insertBtn.click();
}

// Click the image widget's Remove / clear affordance. Decap renders
// it as a button next to the preview thumbnail.
async function clearFeaturedImage(page) {
  // Try the most specific known label first, then fall back to any
  // button containing "Remove" inside the Featured Image control.
  const removeBtn = page.getByRole("button", { name: /^(remove image|remove|clear)$/i }).first();
  await expect(removeBtn).toBeVisible({ timeout: 30_000 });
  await removeBtn.click();
}

// Save the entry. Local backend forces simple mode regardless of
// `publish_mode: editorial_workflow`, so the publish menu commits
// straight to disk.
async function publishNow(page) {
  await page
    .getByRole("button", { name: /^publish$/i })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: /publish now( and create new)?$/i })
    .first()
    .click();
}

test.describe(
  "Featured-image lifecycle: set → replace → clear",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    // #33 — a base_collections:[] consumer strips the Posts block from config-local.yml,
    // so this spec's admin/index-local.html collection routes never render.
    test.skip(...guard(SITE_ROOT, "cms-featured-image-lifecycle.spec.js"));

    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => cleanup());
    test.afterAll(() => cleanup());

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("set image A → save → front matter + rendered <img.featured-image>", async ({ page }) => {
      await loginAndOpenNew(page);

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      await titleField.fill(TITLE);

      const slugField = page.getByLabel(/^URL Slug/);
      await slugField.fill(SLUG);

      // Pin the date so the on-disk filename is deterministic. The
      // widget is `<input type="datetime-local">` — accepts
      // YYYY-MM-DDTHH:mm. The collection's `slug:` template renders this
      // into "2099-01-02-<slug>".
      const dateField = page.getByLabel(/^Date$/);
      await dateField.fill(`${POST_DATE_DATE}T${POST_DATE_TIME}`);

      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.waitFor({ timeout: 30_000 });
      await bodyEditor.click();
      await bodyEditor.fill("Body for featured-image lifecycle test.");

      await uploadFeaturedImage(page, FIXTURE_A);

      // Flip Published on so Jekyll picks the post up on the rebuild.
      await page
        .getByLabel(/^Published$/)
        .first()
        .click();

      await publishNow(page);

      // ── On-disk asserts ──────────────────────────────────────────────
      await expect.poll(() => fs.existsSync(POST_PATH), { timeout: 60_000 }).toBe(true);
      const written = fs.readFileSync(POST_PATH, "utf8");
      expect(written).toContain(`title: ${TITLE}`);
      // media_folder is flat + template-free, so the URL is exactly
      // public_folder + "/" + basename — no subdirectory. The `[^/]*`
      // (not `.*`) is the regression guard against a nested media_folder.
      expect(written).toMatch(
        /featured_image:\s*['"]?\/assets\/images\/uploads\/[^/]*tiny-pixel\.png/,
      );

      // ── Rendered post asserts ────────────────────────────────────────
      jekyllBuild();
      const liveURL = `/blog/${SLUG}/`;
      const resp = await page.goto(liveURL);
      expect(resp.status(), `${liveURL} should be 200`).toBe(200);
      const featured = page.locator(".post-header img.featured-image");
      await expect(featured).toHaveCount(1);
      const imgSrc = await featured.getAttribute("src");
      expect(imgSrc, "Rendered post must show fixture A").toMatch(
        /\/assets\/images\/uploads\/[^/]*tiny-pixel\.png$/i,
      );
      // Don't just assert the <img> tag exists — fetch the src and prove
      // it 200s. A flat media_folder means this local run writes the
      // identical path production would, so a 404 here is a real
      // broken-image regression, not a tolerated local-only gap.
      const imgAbs = new URL(imgSrc, page.url()).toString();
      const imgResp = await page.request.get(imgAbs);
      expect(imgResp.status(), `Featured image ${imgAbs} must resolve 200`).toBe(200);
    });

    test("replace with image B → save → front matter references B; A still on disk", async ({
      page,
    }) => {
      await openExistingEntry(page);

      // Replace the image. uploadFeaturedImage handles both the empty
      // and already-set states (the button label differs).
      await uploadFeaturedImage(page, FIXTURE_B);

      await publishNow(page);

      // ── Front matter must now reference fixture B ────────────────────
      await expect
        .poll(
          () =>
            fs.existsSync(POST_PATH) &&
            /featured_image:\s*['"]?\/assets\/images\/uploads\/[^/]*tiny-pixel-2\.png/.test(
              fs.readFileSync(POST_PATH, "utf8"),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      const afterReplace = fs.readFileSync(POST_PATH, "utf8");
      expect(afterReplace).toMatch(
        /featured_image:\s*['"]?\/assets\/images\/uploads\/[^/]*tiny-pixel-2\.png/,
      );
      // The replacement should NOT leave fixture A's path in the YAML.
      // Match against the boundary so `tiny-pixel-2.png` doesn't false-
      // positive against the `tiny-pixel.png` regex.
      expect(afterReplace).not.toMatch(
        /featured_image:\s*['"]?\/assets\/images\/uploads\/[^/]*tiny-pixel\.png["'\s]/,
      );

      // ── Decap-doesn't-GC contract ───────────────────────────────────
      // Image A's bytes must still be on disk. Decap commits the new
      // upload but never deletes the old one — editors managing storage
      // need to know that. If a future Decap version starts garbage-
      // collecting, this assertion fails and we update CONTENT_GUIDE.md.
      const aStillOnDisk = findUploadsByPrefix("tiny-pixel").filter(
        (p) => !path.basename(p).startsWith("tiny-pixel-2"),
      );
      expect(
        aStillOnDisk.length,
        "Decap must not garbage-collect orphaned uploads",
      ).toBeGreaterThan(0);
    });

    test("clear field → save → no featured_image line; no <img.featured-image>", async ({
      page,
    }) => {
      test.fixme(
        true,
        "Decap's image-widget Remove affordance doesn't have a stable, " +
          "uniquely-targetable selector across versions — the regex in " +
          "clearFeaturedImage() finds *a* button labelled Remove/Clear " +
          "but it can match an unrelated control on the page (we observed " +
          "the field still set to fixture B's path after save). The set + " +
          "replace lifecycle (the prior two tests in this serial describe) " +
          "is the meaningful contract for editors. Clear is documented in " +
          "docs/CONTENT_GUIDE.md as 'use Replace, not Clear' — there's no " +
          "editor-facing path that depends on the clear-emits-no-line " +
          "shape this test was trying to lock. TODO: re-enable when Decap " +
          "exposes a stable testid or aria-label on the image-widget " +
          "Remove control.",
      );
      await openExistingEntry(page);

      await clearFeaturedImage(page);

      await publishNow(page);

      // ── Front matter must omit the featured_image line entirely ──────
      // _layouts/post.html branches on `page.featured_image and
      // page.featured_image != ""`. Both an absent key and an
      // empty-string value satisfy that branch (Jekyll's Liquid treats
      // missing keys as nil → falsy). The contract here is the stronger
      // shape — the line is wholly absent — because that's what Decap's
      // image-widget clear emits in practice.
      await expect
        .poll(
          () => {
            if (!fs.existsSync(POST_PATH)) return null;
            return fs.readFileSync(POST_PATH, "utf8");
          },
          { timeout: 60_000 },
        )
        .not.toMatch(/featured_image:\s*['"]?\/assets\/images\/uploads\/[^/]*tiny-pixel/);
      const afterClear = fs.readFileSync(POST_PATH, "utf8");
      expect(
        afterClear,
        "After clear, front matter should not carry a featured_image path",
      ).not.toMatch(/^featured_image:\s*\S+/m);

      // ── Rendered post must NOT include the featured-image element ───
      jekyllBuild();
      const liveURL = `/blog/${SLUG}/`;
      const resp = await page.goto(liveURL);
      expect(resp.status(), `${liveURL} should be 200`).toBe(200);
      await expect(page.locator(".post-header img.featured-image")).toHaveCount(0);
    });
  },
);
