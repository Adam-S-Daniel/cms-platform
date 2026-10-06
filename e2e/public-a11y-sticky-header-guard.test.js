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
// anything but sticky/fixed. The browser behavior (static transparent skips,
// sticky transparent fails, sticky opaque passes) was proven against real
// pages when the guard was added; the PR that added it records the runs.
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

test("the guard skips on computed position unless it is sticky or fixed", () => {
  const fn = helperNode(src);
  expect(fn, `${HELPER} is declared in the spec`).not.toBeNull();
  const facts = analyzeNode(fn);
  expect(facts.calls.some((c) => c.tail === "evaluate"), "it measures in the page").toBe(true);
  expect(facts.calls.some((c) => c.name === "getComputedStyle"), "it reads computed style").toBe(true);
  expect(facts.memberProps.has("position"), "it reads position").toBe(true);
  expect(facts.calls.some((c) => c.name === "test.skip"), "it skips through test.skip").toBe(true);
  expect(facts.strings).toEqual(expect.arrayContaining(["sticky", "fixed"]));
});

test("the detector flags a header test with no guard and ignores a mention in a comment", () => {
  const bad = `test("a", async ({ page }) => { const h = page.locator(".site-header"); });`;
  const good = `test("a", async ({ page }) => { const h = page.locator(".site-header"); await ${HELPER}(h); });`;
  const commentOnly = `test("a", async ({ page }) => { /* ${HELPER}(h) */ const h = page.locator(".site-header"); });`;
  expect(unguarded(bad)).toEqual(["a"]);
  expect(unguarded(good)).toEqual([]);
  expect(unguarded(commentOnly)).toEqual(["a"]);
});
