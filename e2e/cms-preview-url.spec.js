// @lane: local — fs reads of admin/config*.yml; pure-Node permalink invariants
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");

// The CMS computes the "View on Live Site" URL from this template. Both admin
// configs must keep it in sync with Jekyll's `permalink: /blog/:slug/` — if it
// drifts (e.g. includes the date prefix), the button 404s.
//
// This spec reproduces Decap's slug derivation in JavaScript so every post is
// reachable at its computed URL.
const POSTS_PREVIEW_PATH = `preview_path: "/blog/{{slug}}/"`;

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFrontMatter(filepath) {
  const src = fs.readFileSync(filepath, "utf8");
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    value = value.replace(/^["'](.*)["']$/, "$1");
    fm[kv[1]] = value;
  }
  return fm;
}

// The bare platform ships no `_posts/` (a consuming SITE provides them),
// so guard the module-scope directory read: if `_posts/` is absent,
// iterate over nothing. This keeps the spec collectable in the platform
// repo without an ENOENT aborting Playwright's WHOLE collection, while a
// consuming site with real posts still exercises every per-post
// round-trip assertion unchanged. (Upstream adamdaniel.ai always ships
// `_posts/`, so it reads the dir directly; the platform needs the guard.)
const postFiles = fs.existsSync(POSTS_DIR) ? fs.readdirSync(POSTS_DIR) : [];

const publishedPosts = postFiles
  .filter((f) => f.endsWith(".md"))
  .map((file) => ({ file, fm: parseFrontMatter(path.join(POSTS_DIR, file)) }))
  .filter(({ fm }) => fm && fm.published === "true")
  // Skip internal fixtures: they carry `sitemap: false` (and usually
  // `robots: noindex,nofollow`) to mark them as not part of the public
  // site. The prod-mutation + media loops create EPHEMERAL born-
  // published posts (`_posts/2099-12-31-e2e-*-<runId>.md`) that briefly
  // serve mid-run and are then hard-deleted (#1771 step 4); they carry
  // `sitemap: false`, and Jekyll's `future: true` only renders them at
  // their permalink while they transiently exist. Either way, this test
  // verifying the public preview-URL contract shouldn't iterate over
  // them.
  .filter(({ fm }) => fm.sitemap !== "false")
  // Skip future-dated posts: Jekyll's default config drops them from
  // the build, so the URL legitimately 404s. Defence-in-depth in case
  // a real post slips past with a future date.
  .filter(({ fm }) => {
    const d = new Date(fm.date);
    return Number.isFinite(d.getTime()) && d.getTime() <= Date.now();
  });

test.describe("CMS preview URL round-trip", () => {
  test("admin/config.yml and admin/config-local.yml share the Posts preview_path", () => {
    const remote = fs.readFileSync(path.join(REPO_ROOT, "admin/config.yml"), "utf8");
    const local = fs.readFileSync(path.join(REPO_ROOT, "admin/config-local.yml"), "utf8");
    expect(remote).toContain(POSTS_PREVIEW_PATH);
    expect(local).toContain(POSTS_PREVIEW_PATH);
  });

  for (const { file, fm } of publishedPosts) {
    const previewSlug = slugify(fm.slug || fm.title);
    test(`${file} is served at the preview URL /blog/${previewSlug}/`, async ({ page }) => {
      const response = await page.goto(`/blog/${previewSlug}/`);
      expect(response.status()).toBe(200);
      await expect(page.locator(".post-header h1")).toHaveText(fm.title);
    });
  }
});
