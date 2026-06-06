// @lane: local — AST lint (acorn, never regex per the AST-always rule): a
// CONSUMER-RUNNING (@lane: real) spec must read SITE content (_posts/, _e2e/,
// _tags/, _drafts/, assets/) from SITE_ROOT (the consuming site checkout), NOT
// from `path.join(__dirname, "..", …)` — which resolves to the PLATFORM's
// `.cms-platform/` harness checkout on a consumer and ENOENTs (the host loop's
// cms-unpublish-republish.spec.js read its `_posts/` canary that way and the
// host loop died after the byte-lock create leg, #1815 host leg). Platform
// SOURCE (theme/, infrastructure/, scripts/, screenshots/) is legitimately read
// from the harness checkout and is allowed.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parse, stringValue, calleeName } = require("./spec-ast");

const E2E_DIR = path.resolve(__dirname);
const SITE_PREFIXES = ["_posts/", "_e2e/", "_tags/", "_drafts/", "assets/"];

// Collect top-level `const NAME = "string"` values so a `path.join(__dirname,
// "..", FIXTURE_PATH)` resolves FIXTURE_PATH to its string.
function constStrings(ast) {
  const m = {};
  for (const node of ast.body || []) {
    if (node.type !== "VariableDeclaration") continue;
    for (const d of node.declarations) {
      if (d.id && d.id.type === "Identifier" && d.init) {
        const v = stringValue(d.init);
        if (v != null) m[d.id.name] = v;
      }
    }
  }
  return m;
}

function walk(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn));
    else if (v && typeof v.type === "string") walk(v, fn);
  }
}

// Resolve a path.join arg to a string (literal or known const), else null.
function argString(arg, consts) {
  const s = stringValue(arg);
  if (s != null) return s;
  if (arg && arg.type === "Identifier" && consts[arg.name] != null) return consts[arg.name];
  return null;
}

function isLaneReal(src) {
  return /^\/\/ @lane:\s*real\b/m.test(src);
}

test.describe("@lane:real specs read SITE content from SITE_ROOT, not the platform checkout (#1815)", () => {
  const specs = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.js"));

  test("no @lane:real spec joins __dirname/.. with a SITE-content path", () => {
    const violations = [];
    for (const f of specs) {
      const src = fs.readFileSync(path.join(E2E_DIR, f), "utf8");
      if (!isLaneReal(src)) continue;
      let ast;
      try {
        ast = parse(src);
      } catch (e) {
        violations.push(`${f}: unparseable (${e.message})`);
        continue;
      }
      const consts = constStrings(ast);
      walk(ast, (n) => {
        if (n.type !== "CallExpression") return;
        if (calleeName(n.callee) !== "path.join") return;
        const a = n.arguments || [];
        if (!(a[0] && a[0].type === "Identifier" && a[0].name === "__dirname")) return;
        if (stringValue(a[1]) !== "..") return;
        // any remaining arg that resolves to a site-content prefix is a bug
        for (const arg of a.slice(2)) {
          const s = argString(arg, consts);
          if (s != null && SITE_PREFIXES.some((p) => s.startsWith(p))) {
            violations.push(`${f}: path.join(__dirname, "..", "${s}") reads SITE content from the platform checkout — use path.join(SITE_ROOT, …)`);
          }
        }
      });
    }
    expect(violations, `SITE_ROOT read violations:\n${violations.join("\n")}`).toEqual([]);
  });
});
