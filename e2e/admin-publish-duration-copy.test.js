// @lane: local — pure-fs AST lint over theme/admin/*.js editor-facing strings
/*
 * No editor-facing string in the admin may promise "5–15 minutes".
 *
 * That range was a guess from before the publish chain was measured; the
 * real trip from Publish to live is a median 4.6 min (p80 5.5, max 6.3) over
 * the 15 most recent merged cms/* PRs on adamdaniel.ai (2026-09-28, #3857).
 * Telling an editor "up to 15 minutes" for a five-minute wait is the
 * estimate-is-far-off complaint in a second place. The live countdown and the
 * typical figure live in entry-status-model.js (CHECKS/DEPLOY_NOMINAL_MIN,
 * TYPICAL_PHRASE); fixed copy says "about 5 minutes".
 *
 * AST, not regex over the file: comments that EXPLAIN the old range (and
 * there are several, documenting history) are not strings, so they do not
 * trip it.
 */
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const OLD_RANGE = /5\s*[–-]\s*15\s*min/i;

function offendingStrings(src) {
  const out = [];
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true });
  const check = (v, loc) => {
    if (typeof v === "string" && OLD_RANGE.test(v)) out.push(`line ${loc.start.line}: ${v.slice(0, 70)}`);
  };
  walk.simple(ast, {
    Literal: (n) => check(n.value, n.loc),
    TemplateElement: (n) => check(n.value.cooked, n.loc),
  });
  return out;
}

test.describe("admin copy does not promise the unmeasured 5–15 minutes (#3857)", () => {
  for (const f of fs.readdirSync(ADMIN).filter((x) => x.endsWith(".js"))) {
    test(f, () => {
      const hits = offendingStrings(fs.readFileSync(path.join(ADMIN, f), "utf8"));
      expect(hits, `${f}: ${hits.join("; ")}`).toEqual([]);
    });
  }

  test("the detector catches a string and ignores a comment", () => {
    expect(offendingStrings('var a = "takes about 5–15 minutes";')).toHaveLength(1);
    expect(offendingStrings("var a = 'about 5-15 min';")).toHaveLength(1);
    expect(offendingStrings("// about 5–15 minutes\nvar a = 1;")).toEqual([]);
  });
});
