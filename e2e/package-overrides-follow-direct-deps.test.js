// @lane: local — pure-fs lint of e2e/package.json (parsed with JSON.parse).
//
// THE INVARIANT
// -------------
// An `overrides` entry that pins a package this manifest also depends on
// directly must reference the direct dependency (`"$name"`), never repeat a
// literal version. A literal copy goes stale the moment Dependabot bumps the
// direct dependency: npm then sees two different versions of the same package
// and `npm ci` fails with ERESOLVE (PR #1082, immutable 5.1.9 -> 5.2.1, which
// turned every harness-install job red).
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const direct = new Set([
  ...Object.keys(manifest.dependencies || {}),
  ...Object.keys(manifest.devDependencies || {}),
]);

// Walks nested override objects; an entry is a [name, spec] pair.
function literalOverridesOfDirectDeps(node, trail = []) {
  const found = [];
  for (const [name, spec] of Object.entries(node || {})) {
    if (spec && typeof spec === "object") {
      found.push(...literalOverridesOfDirectDeps(spec, [...trail, name]));
    } else if (direct.has(name) && typeof spec === "string" && !spec.startsWith("$")) {
      found.push([...trail, name].join(" > ") + " = " + spec);
    }
  }
  return found;
}

test.describe("e2e/package.json overrides follow the direct dependency", () => {
  test("no override repeats a literal version of a direct dependency", () => {
    expect(literalOverridesOfDirectDeps(manifest.overrides)).toEqual([]);
  });

  test("the walk flags a literal and accepts a $ reference", () => {
    expect(
      literalOverridesOfDirectDeps({ x: { immutable: "1.0.0" }, y: { immutable: "$immutable" } }),
    ).toEqual(["x > immutable = 1.0.0"]);
  });
});
