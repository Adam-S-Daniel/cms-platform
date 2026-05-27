// @lane: local — needs decap-server file IO + git execs; drives local Decap publish leg
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");
const { captureStep } = require("./manual-capture");
const { pruneSitemapUrls } = require("./sitemap-prune");

// True end-to-end content loop: drive the live Decap admin to create a new
// post, rebuild the site, then GET /blog/<slug>/ and assert the post is
// actually published. cms-smoke.spec.js covers the CMS → disk half; this
// one closes the loop disk → Jekyll → CloudFront-shaped URL → rendered HTML.
//
// What this catches that the other specs don't:
//   - YAML front-matter format drift (Decap writes a shape Jekyll can't parse)
//   - Permalink template drift (file lands at the wrong URL)
//   - Layout breakage that only manifests with Decap-shaped front matter
//   - The publish_mode / local_backend interaction making Save look like
//     it worked but never producing a deployable file
//
// Implementation notes:
//   - Local backend forces simple mode regardless of `publish_mode:
//     editorial_workflow`, so Save → file lands directly in _posts/ with
//     no PR. That's exactly what we need for a synchronous test.
//   - We rebuild Jekyll in-process after save. The playwright.config.js
//     webServer pre-builds once at startup; without an explicit rebuild
//     here the new file isn't on disk in `_site/`.
//   - The serve package re-stats files per request, so a post-startup
//     rebuild is picked up without restarting the webServer.
//   - The post is cleaned up in afterAll regardless of pass/fail —
//     leaving cruft in `_posts/` would pollute the live site.
//
// FUTURE CONTENT TYPES — pattern to copy:
//   When a new collection is added to admin/config*.yml AND its public
//   pages are enabled in Jekyll's routing (i.e. the collection's
//   `published`/`enabled` route exists), add a sibling test that:
//     1. Drives the admin to create an entry in that collection
//     2. Asserts the file lands at the expected on-disk path
//     3. Runs a Jekyll build
//     4. GETs the public URL the new entry should produce and asserts
//        layout-expected DOM (e.g. h1, body container) renders the
//        typed content
//     5. Cleans up both the source file in the collection's folder
//        AND the rendered output under `_site/<route>/`
//   The Pages collection is currently disabled/hidden in the public
//   site routing, so it doesn't have a sibling test here. Re-enable
//   that test when the Pages collection's public route ships.

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");

const SMOKE_TITLE = "E2E Publish Flow Smoke";
const SMOKE_SLUG = "e2e-publish-flow-smoke";
const SMOKE_BODY = "This post was created by the cms-publish-flow e2e spec. Safe to delete.";
// Tag chosen so auto_tag_pages has to manufacture the archive (no curated
// _tags/<slug>.md exists). Slug is what Jekyll's slugify will produce.
const SMOKE_TAG_LABEL = "e2e-smoke-flow-tag";
const SMOKE_TAG_SLUG = "e2e-smoke-flow-tag";

function findSmokePostFile() {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const match = fs.readdirSync(POSTS_DIR).find((f) => f.endsWith(`-${SMOKE_SLUG}.md`));
  return match ? path.join(POSTS_DIR, match) : null;
}

function removeSmokePost() {
  const f = findSmokePostFile();
  if (f) fs.unlinkSync(f);
  // Also clear the rendered output from `_site/`. The webServer serves
  // `_site/` directly, so leaving an orphan here would make the smoke
  // post reachable at /blog/<slug>/ after the test ran. The next jekyll
  // build would normally wipe it, but the playwright webServer only
  // builds once at startup.
  for (const dir of [
    path.join(REPO_ROOT, "_site", "blog", SMOKE_SLUG),
    path.join(REPO_ROOT, "_site", "tags", SMOKE_TAG_SLUG),
  ]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  // ...and prune those URLs from the prebuilt `_site/sitemap.xml`. The
  // in-test jekyllBuild() baked /blog/<slug>/ (and the manufactured
  // /tags/<tag>/ archive) into the sitemap; deleting the rendered dirs
  // above leaves those <loc>s advertised but 404-ing. image-alt-text.spec.js
  // runs in the SAME e2e-admin job, shares this `_site/`, walks the
  // sitemap, and fails on the orphaned 404 — so keep the sitemap
  // consistent with what's actually on disk.
  const sitemap = path.join(REPO_ROOT, "_site", "sitemap.xml");
  if (fs.existsSync(sitemap)) {
    const xml = fs.readFileSync(sitemap, "utf8");
    const cleaned = pruneSitemapUrls(xml, [`/blog/${SMOKE_SLUG}/`, `/tags/${SMOKE_TAG_SLUG}/`]);
    if (cleaned !== xml) fs.writeFileSync(sitemap, cleaned);
  }
}

function jekyllBuild() {
  // Quiet build into the same `_site/` the playwright webServer is
  // serving from, so the new post becomes reachable at /blog/<slug>/
  // without needing to restart `npx serve`.
  execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

test.describe(
  "CMS publish flow: create → build → browse to live URL",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => {
      removeSmokePost();
    });
    test.afterAll(() => {
      removeSmokePost();
    });

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("create a post in Decap, rebuild, and assert /blog/<slug>/ renders it", async ({
      page,
    }) => {
      // ── Drive the admin: open New Post, fill Title + Body, publish ────
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
      await page.goto("/admin/index-local.html#/collections/posts/new");

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      await titleField.fill(SMOKE_TITLE);

      // The slug field auto-derives from title; explicitly set it so the
      // post lands at a predictable URL even if the slugify algorithm
      // changes between Decap versions.
      const slugField = page.getByLabel(/^URL Slug/);
      await slugField.fill(SMOKE_SLUG);

      // Decap's markdown widget defaults to rich-text mode. The
      // contentEditable surface accepts plain typed text, which is good
      // enough for asserting the post renders end-to-end.
      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.waitFor({ timeout: 30_000 });
      await bodyEditor.click();
      await bodyEditor.fill(SMOKE_BODY);

      // Set an inline tag — exercises the auto_tag_pages plugin's
      // "manufacture an archive page when no curated _tags/<slug>.md
      // exists" branch. Tags is a list-of-strings widget; click into its
      // input, type, press Enter to commit the chip.
      const tagsInput = page.getByLabel(/^Tags/i).first();
      await tagsInput.click();
      await tagsInput.fill(SMOKE_TAG_LABEL);
      await page.keyboard.press("Enter");

      // Flip Published on so this post is part of `site.posts` immediately.
      // (Default in the schema is OFF, which would route the post into the
      // scheduled-publish bucket and skip Jekyll's _posts/ rendering for the
      // immediate build.)
      const publishedToggle = page.getByLabel(/^Published$/).first();
      await publishedToggle.click();
      await captureStep(page, {
        section: "Marking ready and publishing",
        step: "6.1",
        title: "Filled-out post ready to publish",
        body: "Title, slug, body, tags, and the Published toggle are all set. In editorial workflow mode (production), the toolbar shows **Save** and a separate Status dropdown; clicking Save opens a PR in draft. Setting the dropdown to **Ready** is what triggers the auto-merge.",
      });

      // Decap's split publish button: open menu, pick "Publish now".
      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await captureStep(page, {
        section: "Marking ready and publishing",
        step: "6.2",
        title: "Publish menu open",
        body: "Decap's primary button is a split control. Clicking the Publish trigger opens a menu — **Publish now** commits the entry; **Publish and create new** commits then routes you to a fresh blank entry. In editorial-workflow mode this is replaced with a Save → Status flow.",
      });
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click();

      // ── Wait for the file to land in _posts/ ──────────────────────────
      await expect.poll(() => findSmokePostFile() !== null, { timeout: 60_000 }).toBe(true);
      const postPath = findSmokePostFile();
      const written = fs.readFileSync(postPath, "utf8");
      expect(written).toMatch(/^---/);
      expect(written).toContain(`title: ${SMOKE_TITLE}`);
      expect(written).toContain(`slug: ${SMOKE_SLUG}`);
      expect(written).toContain("published: true");

      // ── Rebuild Jekyll so /blog/<slug>/ is in `_site/` ────────────────
      jekyllBuild();

      // ── Browse to the live URL, assert the post renders ──────────────
      const liveURL = `/blog/${SMOKE_SLUG}/`;
      const response = await page.goto(liveURL);
      expect(response.status(), `${liveURL} should be 200`).toBe(200);

      await expect(page.locator(".post-header h1")).toHaveText(SMOKE_TITLE);
      await expect(page.locator(".post-content")).toContainText(SMOKE_BODY);
      await captureStep(page, {
        section: "Marking ready and publishing",
        step: "6.3",
        title: "Published post live",
        body: "After the publish settles, the post is reachable at its public URL — here `/blog/<slug>/`. In production the same URL pattern is served by CloudFront once `deploy-production.yml` finishes its `aws s3 sync` and invalidation, typically within ~2 minutes of the merge.",
      });

      // ── Inline tag → auto-generated archive page ─────────────────────
      // The auto_tag_pages plugin should manufacture /tags/<slug>/ for
      // any tag a post uses, even if no curated _tags/<slug>.md exists.
      // This catches plugin regressions that break the post → tag-archive
      // handoff (issue #27 territory).
      const tagURL = `/tags/${SMOKE_TAG_SLUG}/`;
      const tagResp = await page.goto(tagURL);
      expect(tagResp.status(), `${tagURL} should be 200`).toBe(200);
      await expect(
        page.getByRole("link", { name: SMOKE_TITLE }).first(),
        "auto-generated tag archive should list the new post",
      ).toBeVisible();
    });
  },
);
