// @lane: local — reads the locally-built _site/sitemap.xml; @parity-eligible via TARGET=
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { isTestFixturePost, slugify } = require("./public-content");

// Plan unit B3 — sitemap structural contract.
//
// The published sitemap is the canonical "what URLs exist" list for crawlers,
// and several other parity probes (B2 image-alt-text, B6 draft-isolation) plan
// to fan out from it. Three things must hold:
//
//   1. Every published `_posts/*.md` (front matter `published` not explicitly
//      `false`) appears as a `<loc>` entry under `/blog/<slug>/`.
//   2. No `_e2e/` canary entries appear — `_config.yml`'s defaults block sets
//      `sitemap: false` for that collection, and this spec is the regression
//      lock that catches anyone who ever flips it.
//   3. No drafts (`published: false`) appear, regardless of where they live.
//
// Pure-Node spec: reads `_site/sitemap.xml` directly via `fs.readFileSync`,
// no browser navigation needed. Tagged `@parity` — once G3's `TARGET=` switch
// lands, this spec stays read-only and runs identically against local,
// preview, and prod.

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const E2E_DIR = path.join(REPO_ROOT, "_e2e");
const SITEMAP_PATH = path.join(REPO_ROOT, "_site", "sitemap.xml");

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---/;
// Strip Jekyll's `_posts/YYYY-MM-DD-` filename prefix (e.g. `2026-04-25-foo` →
// `foo`). Mirrors the slug-from-filename derivation the `permalink: /blog/:slug/`
// template expects when no explicit `slug:` overrides it.
const FILENAME_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

function parseFrontMatter(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const match = text.match(FRONT_MATTER_RE);
  if (!match) return {};
  const fields = {};
  // Split by newlines + take simple `key: value` pairs. Sufficient for the
  // two keys we care about (`published`, `slug`) — both ship as scalars in
  // every fixture in this repo. We deliberately ignore nested/multiline
  // values like the `featured_image:` data-URI in `_posts/2026-04-28-here-
  // is-a-3rd-post-😁.md` — those keys aren't in our allowlist.
  for (const rawLine of match[1].split(/\r?\n/)) {
    const m = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip surrounding quotes — `slug: ''` is the common shape.
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    fields[m[1]] = value;
  }
  return fields;
}

function deriveSlugFromFilename(filename) {
  // `_posts/2026-04-25-replacement-test-post-1.md` → `replacement-test-post-1`.
  // The date-stripped remainder is then run through the SHARED `slugify`
  // (e2e/public-content.js) — Jekyll's `permalink: /blog/:slug/` passes the
  // effective slug through `Jekyll::Utils.slugify` (lowercase, collapse runs
  // of non-`[a-z0-9]` into single `-`, trim dashes). Without slugifying here,
  // a filename like `2026-05-28-quoting-anthropic-opus-4-8-safety-"somewhat-
  // less-robust".md` (real human content; #1815 push-media run 26598524027)
  // mapped to a literal `…safety-"somewhat-less-robust"` URL that doesn't
  // exist in the jekyll-generated sitemap — the live URL is the curly-quote-
  // stripped `…safety-somewhat-less-robust`. Reusing the shared helper keeps
  // this spec, admin/live-url-derive.js, and public-content.js's crawl
  // enumeration agreeing on what the live URL is (drift-locked by
  // e2e/slugify-parity.test.js).
  const base = path.basename(filename, ".md");
  const dateStripped = base.replace(FILENAME_DATE_PREFIX_RE, "");
  return slugify(dateStripped);
}

function expectedPostUrl(filename, frontMatter) {
  // Front matter `slug:` overrides the filename-derived slug, but only when
  // it's a non-empty string. The seed posts ship `slug: ''` to keep Decap's
  // file-naming template authoritative — for those we must fall back to the
  // filename. Mirrors `live-url-banner.js`'s `compute()`.
  const explicitSlug = (frontMatter.slug || "").trim();
  const slug = explicitSlug || deriveSlugFromFilename(filename);
  return `/blog/${slug}/`;
}

function expectedE2eUrl(filename, frontMatter) {
  // `_e2e` entries set their own `slug:` and `permalink:` directly — no date
  // prefix to strip. Filename-derived fallback is just the basename minus
  // `.md` (matches `_e2e/canary-post.md` → `canary-post`).
  const explicitSlug = (frontMatter.slug || "").trim();
  const slug = explicitSlug || path.basename(filename, ".md");
  return `/e2e/${slug}/`;
}

function isPublished(frontMatter) {
  // Jekyll treats missing `published:` as `true`. Only an explicit `false`
  // (string match — YAML scalars come through this parser as strings) drops
  // the entry from the build.
  return String(frontMatter.published || "").toLowerCase() !== "false";
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(dir, name));
}

function readSitemapLocs() {
  // jekyll-sitemap emits `<loc>https://adamdaniel.ai/path/</loc>`. Pull every
  // <loc>'s body, then strip the host so we can compare against root-relative
  // paths regardless of which `url:` is configured (prod vs. preview).
  //
  // After stripping, percent-decode the path so the comparison against
  // expectedPostUrl / expectedE2eUrl (which return literal unencoded slug
  // text) matches when a post slug contains characters that jekyll-sitemap
  // URL-encodes — curly quotes, em-dashes, etc. Without this, a post like
  // `_posts/2026-05-28-quoting-anthropic-opus-4-8-safety-"somewhat-less-
  // robust".md` is in the sitemap as `…safety-%E2%80%9C…%E2%80%9D/` but the
  // expected URL is `…safety-"…"/`, the strict `locs.includes(url)` returns
  // false, and the test reports the post as missing (#1815 push-media run
  // 26598524027). decodeURI is the correct primitive here — it leaves URL
  // reserved characters (`/`, `?`, `#`, etc.) intact and only decodes the
  // percent-encoded body, which is what we want for slug comparison.
  const xml = fs.readFileSync(SITEMAP_PATH, "utf8");
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const raw = match[1].trim();
    try {
      const u = new URL(raw);
      let path = u.pathname;
      try {
        path = decodeURI(path);
      } catch {
        // Malformed percent-encoding — keep the raw pathname so the
        // failure surface is a real mismatch, not a decode crash.
      }
      locs.push(path);
    } catch {
      // Not a full URL — keep as-is.
      locs.push(raw);
    }
  }
  return locs;
}

test.describe("sitemap structure @parity", () => {
  // When the sitemap hasn't been built yet (e.g. someone runs this single
  // spec without the webServer fixture warming `jekyll build`), surface a
  // clear failure rather than a generic ENOENT stack.
  test.beforeAll(() => {
    if (!fs.existsSync(SITEMAP_PATH)) {
      throw new Error(
        `_site/sitemap.xml not found at ${SITEMAP_PATH}. ` +
          "The Playwright webServer step runs `bundle exec jekyll build` before " +
          "tests; if you're running this spec standalone, build first.",
      );
    }
  });

  test("every published _posts/*.md appears as a <loc> entry @parity", () => {
    const locs = readSitemapLocs();
    const posts = listMarkdownFiles(POSTS_DIR);
    expect(posts.length, "expected at least one post in _posts/").toBeGreaterThan(0);

    const missing = [];
    for (const file of posts) {
      const fm = parseFrontMatter(file);
      if (!isPublished(fm)) continue;
      // E2E test-fixture canaries are NOT public content we assert the
      // sitemap must advertise. The shared isTestFixturePost predicate
      // (e2e/public-content.js) excludes posts flagged `sitemap: false`
      // (jekyll-sitemap drops these anyway — the `_e2e`/unpublish
      // canaries) AND the ephemeral prod-loop posts whose slug carries
      // the `e2e-` canary signature. The latter are born
      // `published: true` through the Decap UI with NO `sitemap:` flag
      // (the posts collection has no widget for it), so they DO land in
      // the sitemap mid-run — but they're a transient fixture, not a
      // published post the public sees, so this "every published post
      // appears" check must not depend on them (#1771 Cat-2 fix).
      if (isTestFixturePost(fm, { filename: path.basename(file) })) continue;
      const url = expectedPostUrl(file, fm);
      if (!locs.includes(url)) {
        missing.push({ file: path.relative(REPO_ROOT, file), url });
      }
    }
    expect(
      missing,
      `published posts missing from sitemap: ${JSON.stringify(missing, null, 2)}`,
    ).toEqual([]);
  });

  test("no draft (published: false) post appears in the sitemap @parity", () => {
    const locs = readSitemapLocs();
    const posts = listMarkdownFiles(POSTS_DIR);
    const leaks = [];
    for (const file of posts) {
      const fm = parseFrontMatter(file);
      if (isPublished(fm)) continue;
      const url = expectedPostUrl(file, fm);
      if (locs.includes(url)) {
        leaks.push({ file: path.relative(REPO_ROOT, file), url });
      }
    }
    expect(leaks, `drafts leaked into sitemap: ${JSON.stringify(leaks, null, 2)}`).toEqual([]);
  });

  test("no _e2e/ canary entry appears in the sitemap @parity", () => {
    // Defaults block in `_config.yml` sets `sitemap: false` for the e2e
    // collection. This spec is the regression lock for that default — if
    // someone deletes or overrides it, we want a fast, named failure.
    const locs = readSitemapLocs();
    const canaries = listMarkdownFiles(E2E_DIR);
    const leaks = [];
    for (const file of canaries) {
      const fm = parseFrontMatter(file);
      const url = expectedE2eUrl(file, fm);
      if (locs.includes(url)) {
        leaks.push({ file: path.relative(REPO_ROOT, file), url });
      }
    }
    expect(
      leaks,
      `_e2e/ canary entries leaked into sitemap: ${JSON.stringify(leaks, null, 2)}`,
    ).toEqual([]);
  });
});
