// @lane: local — unit test for the AST fact extractor (e2e/spec-ast.js).
//
// The guard-registry lint depends on these facts being exact; this pins the
// helper API directly (template-literal reconstruction, goto/getByRole/require
// extraction, Program-level test() detection, scope-local call search) so a
// refactor of spec-ast can't silently change what the detectors see.
const { test, expect } = require("./base");
const { analyzeSpec, stringValue, calleeName, subtreeHasCall, parse } = require("./spec-ast");

const SAMPLE = `
const { guard } = require("./base-collections-guards");
const SITE_ROOT = process.env.SITE_ROOT || "x";
const slug = "posts";
test("alpha drives a collection", { tag: ["@admin-write"] }, async ({ page }) => {
  test.skip(...guard(SITE_ROOT, "sample.spec.js"));
  await page.goto(\`\${ADMIN}#/collections/\${slug}/entries/x\`);
  await page.getByRole("link", { name: /^Posts$/i });
});
test.skip("beta is unguarded", async ({ page }) => {
  await page.goto("/admin/reviews/health.html");
});
test.describe("nested", () => {
  test("gamma is NOT program-level", () => {});
});
`;

test.describe("spec-ast — fact extraction", () => {
  const f = analyzeSpec(SAMPLE);

  test("stringValue reconstructs a template literal with ${…} placeholders", () => {
    const ast = parse('const x = `a${b}c${d}`;');
    const tl = ast.body[0].declarations[0].init;
    expect(stringValue(tl)).toBe("a${…}c${…}");
  });

  test("calleeName resolves dotted callees", () => {
    const ast = parse("a.b.c(); foo(); test.skip();");
    const names = ast.body.map((s) => calleeName(s.expression.callee));
    expect(names).toEqual(["a.b.c", "foo", "test.skip"]);
  });

  test("goto args capture the reconstructed (interpolated) target", () => {
    expect(f.gotoArgs).toContain("${…}#/collections/${…}/entries/x");
    expect(f.gotoArgs).toContain("/admin/reviews/health.html");
  });

  test("getByRole link-name regex source is captured", () => {
    expect(f.getByRoleLinkNames).toContain("^Posts$");
  });

  test("require specifiers are captured", () => {
    expect(f.requires.has("./base-collections-guards")).toBe(true);
  });

  test("only PROGRAM-LEVEL test() blocks are collected (describe-nested excluded)", () => {
    const titles = f.topLevelTests.map((t) => t.title);
    expect(titles).toEqual(["alpha drives a collection", "beta is unguarded"]);
    expect(titles).not.toContain("gamma is NOT program-level");
  });

  test("tags are read from the options object", () => {
    const alpha = f.topLevelTests.find((t) => t.title.startsWith("alpha"));
    expect(alpha.tags).toContain("@admin-write");
  });

  test("subtreeHasCall finds a guard ONLY inside the test that has it", () => {
    const has = (t) =>
      subtreeHasCall(
        t.node,
        (c) =>
          c.tail === "guard" &&
          c.args[0] &&
          c.args[0].type === "Identifier" &&
          c.args[0].name === "SITE_ROOT" &&
          c.args[1] &&
          c.args[1].type === "Literal" &&
          c.args[1].value === "sample.spec.js",
      );
    const alpha = f.topLevelTests.find((t) => t.title.startsWith("alpha"));
    const beta = f.topLevelTests.find((t) => t.title.startsWith("beta"));
    expect(has(alpha)).toBe(true);
    expect(has(beta)).toBe(false); // scope-local: the guard is in alpha, not beta
  });

  test("a string concat folds static halves and placeholders the rest", () => {
    const ast = parse('const x = "/admin/" + col + "/new";');
    expect(stringValue(ast.body[0].declarations[0].init)).toBe("/admin/${…}/new");
  });
});
