/*
 * Single source of truth for the PUBLIC-CONTENT post set the @parity
 * content-crawl specs enumerate — and, crucially, the predicate that
 * excludes E2E test-fixture canaries from it.
 *
 * Why this module exists (#1771 follow-up — the Cat-2 regression)
 * --------------------------------------------------------------
 * The @parity content-crawl specs (console-clean, image-alt-text,
 * sitemap) walk every "published" `/blog/<slug>/` post and assert a
 * public-quality invariant (no console.error, every <img> has alt, the
 * sitemap advertises it). Those invariants are for REAL public content
 * the reader sees — NOT for the E2E canary posts the prod-loop specs
 * create.
 *
 * The #1771 step-4 ephemeral prod loops CREATE a born-`published: true`,
 * future-dated `_posts/2099-12-31-e2e-{prod-mutate,media-roundtrip}-<runId>.md`
 * post through the Decap "+ New Post" UI, assert it serves, then DELETE
 * it. While it is briefly live (and for the window an orphaned run leaves
 * it on `main`) it is enumerated by every crawl spec — and a transient
 * 404 of its featured image, or the post itself before it's swept,
 * red-fails console-clean / image-alt-text, which run inside the REQUIRED
 * `e2e-admin` and `parity` checks. That poisons EVERY cms PR's merge gate
 * (including the loop's OWN create PR → the loop can never go green) and
 * threatens real content PRs. This is the exact #1723 Category-2 class:
 * transient `main` state poisoning a shared required check.
 *
 * The robust marker problem
 * -------------------------
 * The design intent (see prod-mutate-fixture.js) is that these canaries
 * carry `test_fixture: true` + `sitemap: false` + `robots: noindex,nofollow`,
 * exactly like the `_e2e/` collection canaries. But the Decap `posts`
 * collection (admin/config*.yml) declares NONE of `sitemap`/`robots`, and
 * its `test_fixture` field is `widget: hidden, default: false` — and a
 * hidden widget can't be toggled through the editor UI. So a post created
 * by the genuinely-UI-driven create leg lands on `main` with
 * `test_fixture: false` and NO `sitemap`/`robots` keys (verified against
 * the real `Create Post` commits). `test_fixture: true` alone is therefore
 * NOT a reliable signal for the ephemeral posts.
 *
 * What IS reliable is the post's STRUCTURAL identity: the slug the spec
 * types into the URL Slug field (`e2e-prod-mutate-<runId>` /
 * `e2e-media-roundtrip-<runId>`) and the dated filename
 * (`YYYY-MM-DD-e2e-…`). That `e2e-` signature is already the
 * codebase-wide fixture detector — `admin/posts-list-enhance.js` keys the
 * Posts-list hide on `/^\d{4}-\d{2}-\d{2}-e2e-/i`, and `cms-recursion-churn.js`
 * keys each loop's self-churn glob on it.
 *
 * So `isTestFixturePost` returns true on ANY of three independent
 * fixture signals (defence in depth, each individually correct):
 *   1. front-matter `test_fixture: true`  — the documented marker; the
 *      `_e2e/` canaries, the persistent unpublish canary, and the
 *      `composePost()` afterAll fallback all set it.
 *   2. front-matter `sitemap: false`      — fixtures opt out of the
 *      sitemap; the `_e2e/` collection default + composePost fallback.
 *   3. the `e2e-` slug / `YYYY-MM-DD-e2e-` filename signature — catches
 *      the UI-created ephemeral posts that carry neither of the above.
 *
 * Pure Node — deliberately NO `require("./base")` — so it stays a plain,
 * unit-testable library (same discipline as `./fixture-baseline` and
 * `./prod-mutate-fixture`). The crawl specs add the Playwright layer.
 */
const fs = require("node:fs");

// Jekyll's default slugify + Decap's slug derivation. Same shape as
// e2e/cms-preview-url.spec.js / the old console-clean copy, kept here so
// every public-content consumer agrees on what the live URL is.
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Parse a `_posts/*.md` (or `pages/*.md`) front-matter block into a flat
// string map. Tolerates CRLF, surrounding quotes, and an inline YAML
// comment ("key: value  # note" — the contributor pages use these). This
// is the union of the parsers the individual crawl specs grew; keeping
// ONE here stops them disagreeing on, say, whether `sitemap: false` is
// seen. Returns null when there's no parseable front matter.
function parseFrontMatter(filepath) {
  const src = fs.readFileSync(filepath, "utf8");
  return parseFrontMatterText(src);
}

function parseFrontMatterText(src) {
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2];
    // Strip an inline YAML comment ("# ..." preceded by whitespace).
    value = value.replace(/\s+#.*$/, "");
    value = value.trim();
    value = value.replace(/^["'](.*)["']$/, "$1");
    fm[kv[1]] = value;
  }
  return fm;
}

// Jekyll's default-published semantics: a post is published unless its
// front matter explicitly says `published: false`. A missing key means
// published (Jekyll builds it).
function isPublished(frontMatter) {
  return String((frontMatter && frontMatter.published) || "").toLowerCase() !== "false";
}

// The structural E2E-canary slug signature. Matches BOTH the URL slug
// (`e2e-prod-mutate-<runId>`) and the dated on-disk file slug
// (`2099-12-31-e2e-prod-mutate-<runId>`). Mirrors the codebase-wide
// fixture detector in admin/posts-list-enhance.js (`/^\d{4}-\d{2}-\d{2}-e2e-/i`)
// generalised to also accept the bare URL slug.
const E2E_DATED_FILE_SLUG_RE = /^\d{4}-\d{2}-\d{2}-e2e-/i;
const E2E_URL_SLUG_RE = /^e2e-/i;

function hasE2eSlugSignature({ filename, urlSlug } = {}) {
  if (filename) {
    const base = String(filename).replace(/\.md$/i, "");
    if (E2E_DATED_FILE_SLUG_RE.test(base)) return true;
  }
  if (urlSlug && E2E_URL_SLUG_RE.test(String(urlSlug))) return true;
  return false;
}

// THE predicate: is this post an E2E test-fixture canary that the
// public-content @parity crawls must NOT enumerate? True on any of the
// three independent fixture signals documented in the file header.
//
// `frontMatter` is the parsed map (may be null/empty). `filename` is the
// `_posts/` basename (e.g. `2099-12-31-e2e-media-roundtrip-123.md`) and
// `urlSlug` is the public slug (e.g. `e2e-media-roundtrip-123`); pass
// whichever the caller has (source-tree crawls have the filename;
// sitemap-derived crawls have only the URL slug).
function isTestFixturePost(frontMatter, { filename, urlSlug } = {}) {
  const fm = frontMatter || {};
  if (fm.test_fixture === true || fm.test_fixture === "true") return true;
  if (fm.sitemap === false || fm.sitemap === "false") return true;
  if (hasE2eSlugSignature({ filename, urlSlug })) return true;
  return false;
}

module.exports = {
  slugify,
  parseFrontMatter,
  parseFrontMatterText,
  isPublished,
  isTestFixturePost,
  hasE2eSlugSignature,
  E2E_DATED_FILE_SLUG_RE,
  E2E_URL_SLUG_RE,
};
