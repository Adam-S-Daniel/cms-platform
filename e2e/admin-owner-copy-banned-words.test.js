// @lane: local — pure-fs AST lint over owner-facing admin strings (#649)
/*
 * The admin's owner is a non-technical writer who has never used GitHub. The
 * strings she reads (tooltips, link labels, field hints, confirm text) must not
 * use developer vocabulary — PR, branch, Decap, E2E, specs, plugin, CI —
 * except inside the "Advanced" disclosure, which is where GitHub, diff and
 * build-log links live on purpose.
 *
 * Covered here:
 *   - posts-list-enhance.js: the strings of the functions that build the
 *     posts-list rows and bar, minus anything passed to `advancedHTML(...)` or
 *     `advancedLinks.push(...)` (the Advanced affordance);
 *   - confirm-wrap-local-backup.js: the rewritten confirm texts (the REWRITES
 *     function bodies; the keys are Decap's own English strings, which are
 *     exact-match data, not copy);
 *   - config.base.yml: every field `hint`;
 *   - index.html: the Reviews link's title.
 *
 * Parsed with acorn / yaml, never a regex over the source, so a comment that
 * explains the old wording is not a string and does not trip it.
 */
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const read = (f) => fs.readFileSync(path.join(ADMIN, f), "utf8");

// Case-sensitive for the acronyms ("pr" is part of "preview-pr<N>" URLs and
// ordinary words), case-insensitive for the rest.
const BANNED = [
  /\bPRs?\b/,
  /\bpull requests?\b/i,
  /\bbranch(es)?\b/i,
  /\bDecap\b/i,
  /\bE2E\b/,
  /\bspecs?\b/i,
  /\bplugins?\b/i,
  /\bCI\b/,
];

function parse(src) {
  return acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true });
}

function isAdvancedCall(n) {
  if (n.type !== "CallExpression") return false;
  const c = n.callee;
  if (c.type === "Identifier") return c.name === "advancedHTML";
  return (
    c.type === "MemberExpression" &&
    c.object.type === "Identifier" &&
    c.object.name === "advancedLinks" &&
    c.property.name === "push"
  );
}

// Every string in `root`, skipping the arguments of Advanced-affordance calls.
function stringsOutsideAdvanced(root) {
  const out = [];
  (function visit(n) {
    if (!n || typeof n.type !== "string") return;
    if (isAdvancedCall(n)) return;
    if (n.type === "Literal" && typeof n.value === "string") out.push({ v: n.value, line: n.loc.start.line });
    if (n.type === "TemplateElement") out.push({ v: n.value.cooked, line: n.loc.start.line });
    for (const k of Object.keys(n)) {
      const c = n[k];
      if (Array.isArray(c)) c.forEach(visit);
      else if (c && typeof c.type === "string") visit(c);
    }
  })(root);
  return out;
}

function functionsNamed(ast, names) {
  const found = [];
  walk.simple(ast, {
    FunctionDeclaration: (n) => {
      if (names.includes(n.id.name)) found.push(n);
    },
  });
  return found;
}

function offenders(strings) {
  const out = [];
  for (const s of strings) for (const re of BANNED) if (re.test(s.v)) out.push(`line ${s.line ?? "?"} ${re}: ${s.v.slice(0, 80)}`);
  return out;
}

const PLE_FUNCS = ["publishingBarCopy", "publishingStateWord", "publishingSummaryHTML", "ensureBar", "decorate"];

test.describe("owner-facing admin copy avoids developer vocabulary outside Advanced (#649)", () => {
  test("posts-list-enhance.js row and bar strings", () => {
    const fns = functionsNamed(parse(read("posts-list-enhance.js")), PLE_FUNCS);
    expect(fns.map((f) => f.id.name).sort()).toEqual([...PLE_FUNCS].sort());
    const strings = fns.flatMap(stringsOutsideAdvanced);
    expect(strings.length).toBeGreaterThan(20);
    expect(offenders(strings)).toEqual([]);
  });

  test("posts-list-enhance.js keeps the Advanced affordance and its test id", () => {
    const src = read("posts-list-enhance.js");
    expect(src).toContain('data-testid="cms-ple-advanced"');
    expect(src).toContain("<summary>Advanced</summary>");
  });

  test("confirm-wrap-local-backup.js rewritten confirm texts", () => {
    const ast = parse(read("confirm-wrap-local-backup.js"));
    const strings = [];
    walk.simple(ast, {
      VariableDeclarator: (d) => {
        if (d.id.name !== "REWRITES") return;
        for (const p of d.init.properties) strings.push(...stringsOutsideAdvanced(p.value));
      },
    });
    expect(strings.length).toBeGreaterThan(3);
    expect(offenders(strings)).toEqual([]);
  });

  test("config.base.yml field hints", () => {
    const hints = [];
    (function visit(n) {
      if (Array.isArray(n)) return n.forEach(visit);
      if (n && typeof n === "object") {
        if (typeof n.hint === "string") hints.push({ v: n.hint });
        Object.values(n).forEach(visit);
      }
    })(YAML.parse(read("config.base.yml")));
    expect(hints.length).toBeGreaterThan(5);
    expect(offenders(hints)).toEqual([]);
  });

  test("the Reviews link title in index.html", () => {
    const m = read("index.html").match(/<a id="reviews-link"[^>]*\btitle="([^"]*)"/);
    expect(m, "#reviews-link must carry a title").not.toBeNull();
    expect(offenders([{ v: m[1] }])).toEqual([]);
  });

  test("the detector skips Advanced calls and flags banned words", () => {
    const ast = parse('function f(){ var a = "see PR #4"; advancedLinks.push("GitHub PR diff"); advancedHTML("branch"); }');
    const s = stringsOutsideAdvanced(ast).map((x) => x.v);
    expect(s).toEqual(["see PR #4"]);
    expect(offenders([{ v: "uses the auto_tag_pages plugin" }, { v: "Decap backup" }])).toHaveLength(2);
    expect(offenders([{ v: "preview-pr12.example.com" }])).toEqual([]);
  });
});
