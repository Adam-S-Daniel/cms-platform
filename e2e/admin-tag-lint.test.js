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
const acorn = require("acorn");
const walk = require("acorn-walk");
const { analyzeSpec } = require("./spec-ast");
const config = require("./playwright.config.js");

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

// ── A hand-rolled project gate must be SATISFIABLE by the spec's tag ──────
//
// A spec can pin itself to one project with
// `test.skip(testInfo.project.name !== "X", …)`. That predates tag routing and
// still works — but a tag routes the spec to a DIFFERENT set of projects, and if
// the two disagree the file skips EVERYWHERE and its coverage vanishes silently.
// That is exactly what tagging cms-html-embed @admin-write did: the tag sent it
// to chromium-desktop-3k while its beforeEach demanded chromium-desktop-1080, so
// the kramdown render contract stopped being tested at all and nothing went red.
// A skipped test is invisible in a green run, so this has to be a lint.

// Which projects would run a spec carrying `tags`? Answers from the config's own
// grep/grepInvert, so the routing rule lives in exactly one place.
function projectsForTags(tags) {
  const text = tags.join(" ");
  return (config.projects || [])
    .filter((p) => {
      const grep = p.grep ? [].concat(p.grep) : null;
      const invert = p.grepInvert ? [].concat(p.grepInvert) : null;
      if (grep && !grep.some((re) => re.test(text))) return false;
      if (invert && invert.some((re) => re.test(text))) return false;
      return true;
    })
    .map((p) => p.name);
}

// `<something>.project.name !== "X"` — the shape of a hand-rolled pin.
function projectGates(src) {
  const gates = [];
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
  walk.simple(ast, {
    BinaryExpression(node) {
      if (node.operator !== "!==" && node.operator !== "!=") return;
      const { left, right } = node;
      if (right.type !== "Literal" || typeof right.value !== "string") return;
      if (
        left.type === "MemberExpression" &&
        left.property.name === "name" &&
        left.object.type === "MemberExpression" &&
        left.object.property.name === "project"
      ) {
        gates.push(right.value);
      }
    },
  });
  return gates;
}

const GATED = [];
for (const file of specFiles()) {
  const src = fs.readFileSync(path.join(__dirname, file), "utf8");
  let gates;
  try {
    gates = projectGates(src);
  } catch (e) {
    continue;
  }
  if (!gates.length) continue;
  const strings = (analyzeSpec(src).strings || []).map(String);
  const tags = [...new Set(strings.filter((t) => /^@/.test(t)))];
  GATED.push({ file, gates, tags, routed: projectsForTags(tags) });
}

test("the lint sees the hand-rolled project gates it polices", () => {
  expect(
    GATED.length,
    "no spec pins itself with `project.name !== \"…\"` — did the shape change?",
  ).toBeGreaterThan(0);
});

for (const { file, gates, tags, routed } of GATED) {
  test(`${file} — its project gate is reachable under its own tags`, () => {
    for (const gate of gates) {
      expect(
        routed,
        `${file} skips unless project === "${gate}", but its tags [${tags.join(", ") || "none"}] ` +
          `route it to [${routed.join(", ")}] — the two cannot both hold, so the whole file ` +
          `skips and its coverage disappears from a GREEN run. Drop the hand-rolled gate (the ` +
          `tag already does the routing) or fix the tag.`,
      ).toContain(gate);
    }
  });
}
