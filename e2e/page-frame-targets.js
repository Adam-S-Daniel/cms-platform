// Which pages e2e/page-frame.spec.js opens (cms-platform#1070).
//
// Pure and filesystem-only, so the selection is unit-tested in the
// node-unit-lints lane (e2e/page-frame-targets.test.js) without a browser.
//
// Inputs, both from the environment the workflows set:
//   PAGE_FRAME_CHANGED  newline- or space-separated repo-relative paths the
//                       publish changed. Unset means "no diff known".
//   PAGE_FRAME_ALL=1    every published post (the daily sweep).
//
// A post a diff changed is checked on its own page, plus every tag archive it
// links to (found on the page, so the spec follows the site's real links rather
// than re-deriving Jekyll's tag slugs). The home page and the blog index are
// always checked when the theme renders them. When a diff changed no post (a
// layout change, or no diff at all), the newest post stands in, so a change to
// the frame itself still opens one post page.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { postPublicPath, isTestFixturePost, hasE2eSlugSignature, isPublished } = require("./public-content");
const cap = require("./site-capabilities");

function readFrontMatter(file) {
  const src = fs.readFileSync(file, "utf8");
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const fm = YAML.parse(match[1]);
    return fm && typeof fm === "object" ? fm : null;
  } catch {
    return null;
  }
}

// A post the frame check should open: published, not an e2e fixture, with an
// address this module can work out. null otherwise.
// Jekyll does not build a post dated in the future unless the site sets
// `future: true`; such a post is scheduled, not broken.
function siteBuildsFuture(siteRoot) {
  try {
    const cfg = YAML.parse(fs.readFileSync(path.join(siteRoot, "_config.yml"), "utf8"));
    return !!(cfg && cfg.future === true);
  } catch {
    return false;
  }
}

function isFutureDated(rel, nowMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-/.exec(path.basename(rel));
  return !!m && Date.UTC(+m[1], +m[2] - 1, +m[3]) > nowMs;
}

function postTarget(siteRoot, rel, { future = false, nowMs = Date.now() } = {}) {
  if (!future && isFutureDated(rel, nowMs)) return null;
  const file = path.join(siteRoot, rel);
  if (!fs.existsSync(file)) return null;
  const fm = readFrontMatter(file);
  if (!fm || !isPublished(fm)) return null;
  const base = path.basename(rel, path.extname(rel));
  if (isTestFixturePost(fm, { filename: path.basename(rel) })) return null;
  const urlPath = postPublicPath(base, fm);
  if (!urlPath) return null;
  return { path: urlPath, source: rel };
}

function isPostSource(rel) {
  return /^_posts\/[^/]+\.(md|markdown|html)$/.test(rel);
}

function parseChanged(value) {
  if (value == null) return null;
  // One path per line, as `git diff --name-only` prints them: a post's
  // file name may contain a space.
  return String(value)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function listPostSources(siteRoot) {
  const dir = path.join(siteRoot, "_posts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(md|markdown|html)$/.test(f))
    .sort()
    .map((f) => `_posts/${f}`);
}

// { listings: [path], posts: [{ path, source }], removedPosts: n }
//   listings      `/` (when the theme layout renders it) and `/blog/` (when the
//                 site keeps the posts collection)
//   posts         post pages to open
//   removedPosts  posts the diff deleted, unpublished or scheduled
function pageFrameTargets({ siteRoot, changedFiles = null, all = false, nowMs = Date.now() } = {}) {
  const opts = { future: siteBuildsFuture(siteRoot), nowMs };
  const listings = [];
  if (cap.homeUsesThemeLayout(siteRoot)) listings.push("/");
  const keepsPosts = cap.keepsBaseCollection(siteRoot, "posts");
  if (keepsPosts) listings.push("/blog/");

  const posts = [];
  let removedPosts = 0;
  if (keepsPosts) {
    const sources = listPostSources(siteRoot);
    if (all) {
      for (const rel of sources) {
        const t = postTarget(siteRoot, rel, opts);
        if (t) posts.push(t);
      }
    } else {
      for (const rel of (changedFiles || []).filter(isPostSource)) {
        if (hasE2eSlugSignature({ filename: path.basename(rel) })) continue;
        const t = postTarget(siteRoot, rel, opts);
        if (t) posts.push(t);
        else removedPosts += 1;
      }
      if (posts.length === 0) {
        for (const rel of sources.slice().reverse()) {
          const t = postTarget(siteRoot, rel, opts);
          if (t) {
            posts.push(t);
            break;
          }
        }
      }
    }
  }
  const seen = new Set();
  const unique = posts.filter((p) => !seen.has(p.path) && seen.add(p.path));
  return { listings, posts: unique, removedPosts };
}

function targetsFromEnv(env = process.env, siteRoot = cap.defaultSiteRoot()) {
  return pageFrameTargets({
    siteRoot,
    changedFiles: parseChanged(env.PAGE_FRAME_CHANGED),
    all: env.PAGE_FRAME_ALL === "1" || env.PAGE_FRAME_ALL === "true",
  });
}

module.exports = { pageFrameTargets, isFutureDated, targetsFromEnv, parseChanged };
