// @lane: local — fs reads of the rendered _site/admin/config.yml; pure-Node permalink invariants
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const cap = require("./site-capabilities");

// SITE_ROOT-aware resolution. The Posts preview_path is read from the
// RENDERED Decap config the gem's render hook emits to
// `<site>/_site/admin/config.yml` during the local-lane build (the source
// `admin/config.yml` doesn't exist — only the `config.base.yml` template).
// config-local.yml is platform-only test scaffolding, so the
// config.yml-vs-config-local.yml parity assertion is dropped; the permalink
// invariant is kept against the rendered config. `_posts` stays the
// consuming site's own.
const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || REPO_ROOT;
const POSTS_DIR = path.join(SITE_ROOT, "_posts");
const RENDERED_CONFIG = path.join(SITE_ROOT, "_site", "admin", "config.yml");

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
  test("rendered admin/config.yml declares the Posts preview_path", () => {
    // The cross-config "config.yml and config-local.yml share preview_path"
    // parity assertion was dropped: config-local.yml is platform-only test
    // scaffolding (the local-backend decap-server variant), so a consumer
    // has only the rendered prod config. Skip (rather than ENOENT-fail) when
    // `_site` isn't built — mirrors the sitemap.spec self-skip.
    test.skip(
      !fs.existsSync(RENDERED_CONFIG),
      `${RENDERED_CONFIG} not built (run the local Jekyll build + render-decap-config.rb) — rendered-config preview_path check only runs in the local lane`,
    );
    // #33 — a single-page consumer that opts out of the "posts" collection via
    // cms.base_collections (v0.1.7) has the posts block STRIPPED from the
    // rendered config (the gem's decap_config_hook applies the keep-list
    // deletion). The posts block is the sole carrier of POSTS_PREVIEW_PATH, so
    // `toContain` would FAIL on a built single-page consumer. Guard PRECISELY on
    // the rendered admin config (the ground truth the assertion reads) — never
    // weakened on a full consumer, where posts is present and the assertion runs
    // unchanged. Mirrors cms-config.spec.js's hasAdminCollection pattern.
    test.skip(
      !cap.hasAdminCollection(SITE_ROOT, "posts"),
      'consumer opts out of the "posts" collection via cms.base_collections — the posts block (sole carrier of the Posts preview_path) is stripped from the rendered config (#33)',
    );
    const rendered = fs.readFileSync(RENDERED_CONFIG, "utf8");
    expect(rendered).toContain(POSTS_PREVIEW_PATH);
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
