// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: the theme's always-running animations must stop under
// `prefers-reduced-motion: reduce` (#656).
//
// `theme/assets/css/main.css` runs an infinite background color cycle, a
// pulsing full-viewport glow (`body::before`, which also scales) and a text /
// border color shimmer on headings and links. Users who ask the OS to reduce
// motion must get none of it. The stylesheet is PARSED with postcss — a
// regex cannot tell a rule inside `@media` from one outside it.

const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const { test, expect } = require("./base");

const MAIN_CSS = path.join(__dirname, "..", "theme", "assets", "css", "main.css");
const root = postcss.parse(fs.readFileSync(MAIN_CSS, "utf8"));

function isReducedMotionAtRule(node) {
  return (
    node.type === "atrule" &&
    node.name === "media" &&
    /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i.test(node.params)
  );
}

const reducedBlocks = [];
root.walkAtRules((node) => {
  if (isReducedMotionAtRule(node)) reducedBlocks.push(node);
});

function reducedRules() {
  const rules = [];
  for (const block of reducedBlocks) {
    block.walkRules((rule) => rules.push(rule));
  }
  return rules;
}

function selectorsOf(rule) {
  return rule.selectors.map((s) => s.replace(/\s+/g, ""));
}

test("main.css still has infinite animations (sanity)", () => {
  let infinite = 0;
  root.walkDecls(/^animation(-iteration-count)?$/, (decl) => {
    if (/\binfinite\b/.test(decl.value)) infinite += 1;
  });
  expect(infinite).toBeGreaterThan(0);
});

test("a prefers-reduced-motion: reduce block exists", () => {
  expect(reducedBlocks.length).toBeGreaterThan(0);
});

test("reduced motion disables animation on every element and pseudo-element", () => {
  const covered = new Set();
  for (const rule of reducedRules()) {
    const stops = rule.nodes.some(
      (d) =>
        d.type === "decl" &&
        d.prop === "animation" &&
        d.value === "none" &&
        d.important,
    );
    if (stops) for (const sel of selectorsOf(rule)) covered.add(sel);
  }
  expect([...covered].sort()).toEqual(["*", "*::after", "*::before"].sort());
});

test("reduced motion parks the body glow at a static opacity", () => {
  const glow = reducedRules().find((r) => selectorsOf(r).includes("body::before"));
  expect(glow, "body::before rule inside the reduced-motion block").toBeTruthy();
  const opacity = glow.nodes.find((d) => d.type === "decl" && d.prop === "opacity");
  expect(opacity, "static opacity declaration").toBeTruthy();
  expect(Number(opacity.value)).toBeLessThan(1);
});
