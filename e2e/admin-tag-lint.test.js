// @lane: local — pure-fs AST lint; no browser, no build, no network.
//
// Lint: a spec that drives the Decap admin must carry an `@admin-*` tag.
//
// WHY THIS EXISTS
// playwright.config.js routes specs by tag: `@admin-write` → chromium-desktop-3k
// only ("writes are heavy and serial"), `@admin-read` → that plus
// webkit-iphone16, `@admin-screenshots` → chromium-desktop-3k for determinism.
// An UNTAGGED test matches every public-lane project's `grepInvert`, so forgetting
// the tag does not fail — it silently runs the admin UI on all EIGHT public
// projects. `cms-html-embed.spec.js` was in exactly that state: it drove
// /admin/index-local.html, created a post through Decap and rebuilt Jekyll, on
// firefox and webkit too, multiplying the concurrent decap-server writers and
// builds for a contract (the kramdown render pipeline) that is server-side and
// engine-independent.
//
// AST, not regex, per AGENTS.md: the signal is a code-shape fact (which string
// literals the spec actually navigates to, and which tag strings it declares),
// and a regex would match the same words inside a comment.
//
// Platform-internal: reads the harness's own spec sources.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { analyzeSpec } = require("./spec-ast");

// The dev-backend admin shell. A spec that navigates it is driving the CMS, not
// a public page. (`index-test.html`'s in-browser test backend is the read-only
// contract lane and is tagged too, but it is not what this lint keys on.)
const ADMIN_SHELL = "/admin/index-local.html";
const ADMIN_TAG = /^@admin-/;

function specFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".spec.js"))
    .sort();
}

const OFFENDERS = [];
const COVERED = [];

for (const file of specFiles()) {
  let facts;
  try {
    facts = analyzeSpec(fs.readFileSync(path.join(__dirname, file), "utf8"));
  } catch (e) {
    // A spec that cannot be parsed is spec-load-smoke.test.js's problem.
    continue;
  }
  const strings = (facts.strings || []).map(String);
  if (!strings.some((s) => s.includes(ADMIN_SHELL))) continue;
  const tags = strings.filter((s) => ADMIN_TAG.test(s));
  (tags.length ? COVERED : OFFENDERS).push({ file, tags });
}

test("the lint still finds the admin-driving specs it polices", () => {
  // If the admin shell path or the AST helper changes, this must not quietly
  // become a no-op.
  expect(
    COVERED.length + OFFENDERS.length,
    `no spec appears to navigate ${ADMIN_SHELL} — did the shell path change?`,
  ).toBeGreaterThan(10);
});

test("every spec that drives the admin declares an @admin-* tag", () => {
  expect(
    OFFENDERS.map((o) => o.file),
    `these specs navigate ${ADMIN_SHELL} with no @admin-* tag, so they run on ALL ` +
      `EIGHT public-lane projects instead of the admin projects. Add ` +
      `{ tag: ["@admin-write"] } (writes) or ["@admin-read"] (read-only) to the ` +
      `describe — see playwright.config.js's tag routing contract.`,
  ).toEqual([]);
});

test("each declared admin tag is one playwright.config.js actually routes", () => {
  const KNOWN = ["@admin-write", "@admin-read", "@admin-screenshots"];
  for (const { file, tags } of COVERED) {
    for (const tag of tags) {
      expect(KNOWN, `${file} declares an unrouted admin tag ${tag}`).toContain(tag);
    }
  }
});
