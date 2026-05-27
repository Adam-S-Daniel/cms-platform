// @lane: local — reads the locally-built _site/sitemap.xml; @parity-eligible via TARGET=
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

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
  const base = path.basename(filename, ".md");
  return base.replace(FILENAME_DATE_PREFIX_RE, "");
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
  const xml = fs.readFileSync(SITEMAP_PATH, "utf8");
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const raw = match[1].trim();
    try {
      const u = new URL(raw);
      locs.push(u.pathname);
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
      // Posts with `sitemap: false` (e.g. test-fixture canaries that
      // get briefly flipped to `published: true` mid-run by
      // cms-publish-loop-prod-mutate.spec.js) are deliberately
      // excluded from the sitemap by jekyll-sitemap. Don't assert on
      // them — they're a fixture, not a published post the public
      // sees.
      if (fm.sitemap === "false" || fm.sitemap === false) continue;
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
