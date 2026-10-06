// @lane: local — PURE-FS code-shape lint (NO Jekyll build, NO browser).
//
// Every check in public-a11y-polish.spec.js that measures `.site-header` (focus
// clearance under it, its opacity) is about a header that STAYS in view while
// content scrolls under it. `.site-header` is only a class name: jodidaniel.com's
// site-owned 404 layout carries one that is `position: static` with a
// transparent background, where nothing scrolls under it. v0.1.154's opacity
// check failed there on all four width/scheme legs and its two focus checks
// passed only vacuously (jodidaniel.com#388).
//
// The behavior is held by the spec's `skipUnlessStickyHeader(header)`, which
// skips unless the header's COMPUTED position is sticky or fixed. This lint
// holds the SHAPE of that guard from the spec's AST (a regex cannot tell a call
// from the same words in a comment): every test() that locates `.site-header`
// calls it, and the helper itself reads computed position and skips on
// anything but sticky/fixed (the condition's operators and operands are
// checked, so an inverted guard cannot pass). The browser behavior (static
// transparent skips, sticky transparent fails, sticky opaque passes) was proven
// against real pages when the guard was added; the PR that added it records
// the runs.
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { test, expect } = require("./base");
const { parse, analyzeNode, calleeName, subtreeHasCall, subtreeStrings } = require("./spec-ast");

const SPEC = path.join(__dirname, "public-a11y-polish.spec.js");
const HELPER = "skipUnlessStickyHeader";

// Every test(...) call (nested in describe blocks too) with its callback, as
// { title, fn }. Only the shape `test("title", [opts,] async (...) => {...})`.
function testBlocks(src) {
  const out = [];
  walk.full(parse(src), (n) => {
    if (n.type !== "CallExpression" || calleeName(n.callee) !== "test") return;
    const fn = n.arguments.find((a) => a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression");
    const title = n.arguments[0] && n.arguments[0].type === "Literal" ? n.arguments[0].value : "(unnamed)";
    if (fn) out.push({ title, fn });
  });
  return out;
}

// Tests that locate the header but never call the guard.
function unguarded(src) {
  return testBlocks(src)
    .filter(({ fn }) => subtreeStrings(fn).includes(".site-header"))
    .filter(({ fn }) => !subtreeHasCall(fn, (c) => c.name === HELPER))
    .map((t) => t.title);
}

function headerTestCount(src) {
  return testBlocks(src).filter(({ fn }) => subtreeStrings(fn).includes(".site-header")).length;
}

// The helper declaration, found by name.
function helperNode(src) {
  let found = null;
  walk.full(parse(src), (n) => {
    if (n.type === "FunctionDeclaration" && n.id && n.id.name === HELPER) found = n;
  });
  return found;
}

const src = fs.readFileSync(SPEC, "utf8");

test("every test that measures .site-header calls the sticky-or-fixed guard", () => {
  expect(headerTestCount(src), "the spec has header tests to guard").toBe(3);
  expect(unguarded(src)).toEqual([]);
});

// Problems with the helper's SHAPE, as readable strings (empty = sound). The
// skip condition must be exactly `position !== "sticky" && position !== "fixed"`
// over `const position = await <header>.evaluate((el) => getComputedStyle(el).position)`.
// Locking only that the words appear would pass an inverted condition
// (`=== "sticky" || === "fixed"`), which skips the real sticky header and turns
// every CI leg vacuous, so the operators and the operands are checked.
function guardProblems(source) {
  const fn = helperNode(source);
  if (!fn) return [`${HELPER} is not declared`];
  const problems = [];

  // 1. `position` comes from computed style, measured in the page.
  let measured = false;
  walk.full(fn, (n) => {
    if (n.type !== "VariableDeclarator" || !n.id || n.id.name !== "position") return;
    const call = n.init && n.init.type === "AwaitExpression" ? n.init.argument : null;
    const cb = call && call.type === "CallExpression" && calleeName(call.callee) !== null
      && calleeName(call.callee).endsWith(".evaluate") ? call.arguments[0] : null;
    const body = cb && cb.type === "ArrowFunctionExpression" ? cb.body : null;
    measured =
      !!body &&
      body.type === "MemberExpression" &&
      !body.computed &&
      body.property.name === "position" &&
      body.object.type === "CallExpression" &&
      calleeName(body.object.callee) === "getComputedStyle";
  });
  if (!measured) {
    problems.push("`position` is not `await x.evaluate((el) => getComputedStyle(el).position)`");
  }

  // 2. Exactly one test.skip, whose condition is the negated-both shape.
  const skips = analyzeNode(fn).calls.filter((c) => c.name === "test.skip");
  if (skips.length !== 1) return problems.concat(`expected one test.skip, found ${skips.length}`);
  const cond = skips[0].args[0];
  const operands =
    cond && cond.type === "LogicalExpression" && cond.operator === "&&" ? [cond.left, cond.right] : null;
  if (!operands) return problems.concat("the skip condition is not `a && b`");
  const compared = operands.map((o) => {
    const ok =
      o.type === "BinaryExpression" &&
      o.operator === "!==" &&
      o.left.type === "Identifier" &&
      o.left.name === "position" &&
      o.right.type === "Literal" &&
      typeof o.right.value === "string";
    return ok ? o.right.value : null;
  });
  if (compared.some((v) => v === null) || [...compared].sort().join() !== "fixed,sticky") {
    problems.push('the skip condition is not `position !== "sticky" && position !== "fixed"`');
  }
  return problems;
}

test("the guard skips on computed position unless it is sticky or fixed", () => {
  expect(guardProblems(src)).toEqual([]);
});

// Mutations of the real spec source: each must be reported. The inverted one is
// the failure that matters: it leaves every header test skipped on the theme's
// sticky header and CI green.
test("the guard lint rejects a flipped, partial or widened skip condition", () => {
  const good = 'position !== "sticky" && position !== "fixed"';
  expect(src).toContain(good);
  const mutate = (replacement) => src.replace(good, replacement);
  const mutants = {
    inverted: 'position === "sticky" || position === "fixed"',
    "or instead of and": 'position !== "sticky" || position !== "fixed"',
    "sticky only": 'position !== "sticky"',
    "fixed only": 'position !== "fixed"',
    "wrong literal": 'position !== "sticky" && position !== "absolute"',
    "other variable": 'pos !== "sticky" && pos !== "fixed"',
    "always false": "false",
  };
  for (const [name, replacement] of Object.entries(mutants)) {
    expect(guardProblems(mutate(replacement)), `mutant: ${name}`).not.toEqual([]);
  }
  expect(guardProblems(mutate('position !== "fixed" && position !== "sticky"'))).toEqual([]);
  const unmeasured = src.replace("getComputedStyle(el).position", "getComputedStyle(el).display");
  expect(guardProblems(unmeasured)).not.toEqual([]);
});

test("the detector flags a header test with no guard and ignores a mention in a comment", () => {
  const bad = `test("a", async ({ page }) => { const h = page.locator(".site-header"); });`;
  const good = `test("a", async ({ page }) => { const h = page.locator(".site-header"); await ${HELPER}(h); });`;
  const commentOnly = `test("a", async ({ page }) => { /* ${HELPER}(h) */ const h = page.locator(".site-header"); });`;
  expect(unguarded(bad)).toEqual(["a"]);
  expect(unguarded(good)).toEqual([]);
  expect(unguarded(commentOnly)).toEqual(["a"]);
});
