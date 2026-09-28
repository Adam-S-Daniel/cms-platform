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
const acorn = require("acorn");
const walk = require("acorn-walk");
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

// The expected outputs are NOT written by hand. They come from the real
// Jekyll::Utils.slugify (default mode) via scripts/generate-slugify-golden.rb,
// and e2e/jekyll-slugify-oracle.test.js re-checks the file against each
// consuming site's own Jekyll. The hand-written table this replaced pinned
// "Café (2026) edition." -> "caf-2026-edition", which is not what Jekyll does
// ("café-2026-edition"): a test locking a divergence in rather than out.
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "jekyll-slugify-golden.json"), "utf8"));

test.describe("every JS slugify is Jekyll's, case for case (golden from the real Jekyll)", () => {
  test("the golden file is a real Jekyll run, with the edge cases that matter", () => {
    expect(GOLDEN.generated_by).toBe("scripts/generate-slugify-golden.rb");
    expect(GOLDEN.mode).toBe("default");
    const inputs = GOLDEN.cases.map(([i]) => i);
    // Non-ASCII letters, Greek final sigma, non-decimal numerals — each
    // caught a real divergence in a hand-rolled port.
    for (const must of ["Café Notes", "ΟΔΟΣ", "Ⅻ roman numeral", "İstanbul", "日本語のタイトル"]) {
      expect(inputs, `golden corpus must cover ${must}`).toContain(must);
    }
  });

  test("Node (public-content.js) and browser (live-url-derive.js) match Jekyll on every golden case", () => {
    const browserSlugify = loadBrowserSlugify();
    for (const [input, expected] of GOLDEN.cases) {
      expect(nodeSlugify(input), `public-content.js slugify(${JSON.stringify(input)})`).toBe(expected);
      expect(browserSlugify(input), `live-url-derive.js slugify(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  test("cms-preview-url.spec.js keeps no private slugify — it uses public-content.js's", () => {
    const src = fs.readFileSync(path.join(__dirname, "cms-preview-url.spec.js"), "utf8");
    const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
    let ownCopy = false;
    walk.simple(ast, {
      FunctionDeclaration(n) {
        if (n.id && n.id.name === "slugify") ownCopy = true;
      },
      VariableDeclarator(n) {
        if (
          n.id.type === "Identifier" &&
          n.id.name === "slugify" &&
          n.init &&
          /Function/.test(n.init.type)
        ) {
          ownCopy = true;
        }
      },
    });
    expect(ownCopy, "cms-preview-url.spec.js must import slugify from ./public-content").toBe(false);
    expect(src).toMatch(/require\(["']\.\/public-content["']\)/);
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
