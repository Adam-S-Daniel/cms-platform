// @lane: local — cross-runtime slugify drift guard (#1815)
//
// The site derives a post's public `/blog/<slug>/` URL by slugifying the
// title / date-stripped filename the SAME WAY Jekyll's `permalink:
// /blog/:slug/` does (`Jekyll::Utils.slugify`, default mode: lowercase,
// collapse runs of non-[a-z0-9] into a single dash, trim dashes).
//
// That algorithm is implemented TWICE because it runs in two runtimes that
// can't share a module:
//
//   - e2e/public-content.js  `slugify`  — Node (the @parity crawl specs:
//                                          sitemap / console-clean / image-alt
//                                          enumerate `/blog/<slug>/` from the
//                                          source tree).
//   - admin/live-url-derive.js `slugify` — browser (the Decap admin "VIEW
//                                          PAGE ON SITE" banner + the Posts-
//                                          list "published ↗" link via
//                                          posts-list-enhance.js).
//
// If they drift, the admin UI links somewhere the crawl specs don't expect
// (or vice-versa) and a real post silently 404s — exactly the #1815
// regression where a curly-quote post's URL was computed with the quotes
// kept in one place and stripped in another. This test locks the two impls
// to identical behaviour across the punctuation/non-ASCII cases that matter,
// AND pins the canonical output so neither can quietly change the algorithm.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");
const { slugify: nodeSlugify } = require("./public-content");

const REPO_ROOT = path.resolve(__dirname, "..");
const LIVE_URL_DERIVE_PATH = path.join(REPO_ROOT, "theme", "admin/live-url-derive.js");
const POSTS_LIST_ENHANCE_PATH = path.join(REPO_ROOT, "theme", "admin/posts-list-enhance.js");

// Execute the browser IIFE in a sandbox to get the REAL exported slugify
// (not a regex-extracted copy). live-url-derive.js only touches
// window/document inside its functions, so loading it with empty stubs is
// safe — nothing runs at module load except the `window.LiveURL = {...}`
// assignment.
function loadBrowserSlugify() {
  const src = fs.readFileSync(LIVE_URL_DERIVE_PATH, "utf8");
  const sandbox = { window: {}, document: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  expect(
    sandbox.window.LiveURL && typeof sandbox.window.LiveURL.slugify,
    "admin/live-url-derive.js must expose window.LiveURL.slugify",
  ).toBe("function");
  return sandbox.window.LiveURL.slugify;
}

// The battery of inputs that exercise every transformation rule. Each entry
// is [input, canonicalExpectedSlug].
const CASES = [
  ["replacement-test-post-1", "replacement-test-post-1"],
  ["e2e-prod-mutate-1779995015867", "e2e-prod-mutate-1779995015867"],
  ["Already-Has-Capitals", "already-has-capitals"],
  // The exact #1815 regression: curly quotes are stripped, not kept.
  [
    'quoting-anthropic-opus-4-8-safety-"somewhat-less-robust"',
    "quoting-anthropic-opus-4-8-safety-somewhat-less-robust",
  ],
  [
    "quoting-anthropic-opus-4-8-safety-“somewhat-less-robust”",
    "quoting-anthropic-opus-4-8-safety-somewhat-less-robust",
  ],
  // Em-dash, ampersand, parentheses, accents, trailing period, dot-in-title.
  ["Design — Build & Ship", "design-build-ship"],
  ["Café (2026) edition.", "caf-2026-edition"],
  ["my-post-with-dots.in.title", "my-post-with-dots-in-title"],
  ["  leading and trailing  ", "leading-and-trailing"],
  ["multiple---dashes___and   spaces", "multiple-dashes-and-spaces"],
];

test.describe("slugify cross-runtime parity (#1815)", () => {
  test("Node (public-content.js) and browser (live-url-derive.js) slugify agree on every case", () => {
    const browserSlugify = loadBrowserSlugify();
    for (const [input, expected] of CASES) {
      const fromNode = nodeSlugify(input);
      const fromBrowser = browserSlugify(input);
      expect(fromNode, `public-content.js slugify(${JSON.stringify(input)})`).toBe(expected);
      expect(fromBrowser, `live-url-derive.js slugify(${JSON.stringify(input)})`).toBe(expected);
      expect(
        fromBrowser,
        `slugify drift: Node and browser disagree on ${JSON.stringify(input)}`,
      ).toBe(fromNode);
    }
  });

  test("posts-list-enhance.js reuses LiveURL.slugify (no hand-rolled date-strip-only URL)", () => {
    // Locks the #1815 bug fix: urlSlug() must slugify, not just strip the
    // date prefix. If a future edit drops the LiveURL.slugify call and goes
    // back to a bare `.replace(/^\d{4}-\d{2}-\d{2}-/, "")` return, the
    // "published ↗" link silently 404s for any punctuated-filename post.
    const src = fs.readFileSync(POSTS_LIST_ENHANCE_PATH, "utf8");
    expect(src, "posts-list-enhance.js urlSlug must call LiveURL.slugify").toMatch(
      /L\.slugify\(|LiveURL\.slugify\(/,
    );
  });
});
