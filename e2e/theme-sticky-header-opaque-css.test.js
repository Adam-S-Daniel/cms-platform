// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: the sticky site header in main.css is OPAQUE.
//
// The header was `rgb(4 6 15 / 85%)` over a backdrop blur. Scrolled post text
// (the date line, the title) ghosted through the brand and nav, clearly in
// WebKit at 390px and faintly in Chromium at 1280px, because the blur does not
// hold up on every engine. A sticky bar over scrolling content needs a solid
// fill; the browser spec in public-a11y-polish.spec.js checks the computed
// alpha, this lint holds the stylesheet source.
//
// The stylesheet is PARSED with postcss (a regex cannot tell which rule a
// declaration sits in, or follow a `var()` to its token).

const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const { test, expect } = require("./base");

const MAIN_CSS = path.join(__dirname, "..", "theme", "assets", "css", "main.css");
const root = postcss.parse(fs.readFileSync(MAIN_CSS, "utf8"));

function topLevelRules() {
  const rules = [];
  root.each((n) => {
    if (n.type === "rule") rules.push(n);
  });
  return rules;
}

function ruleFor(selector) {
  return topLevelRules().find((r) => r.selectors.map((s) => s.trim()).includes(selector));
}

function declValue(rule, prop) {
  const d = rule && rule.nodes.find((n) => n.type === "decl" && n.prop === prop);
  return d ? d.value.trim() : null;
}

// Alpha of a literal color: #rgb/#rrggbb are opaque, #rgba/#rrggbbaa read the
// last digit(s), rgb()/rgba() read the fourth channel in either syntax.
function alphaOf(value) {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]+)$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 6) return 1;
    if (h.length === 4) return parseInt(h[3] + h[3], 16) / 255;
    if (h.length === 8) return parseInt(h.slice(6), 16) / 255;
    return NaN;
  }
  const fn = /^rgba?\((.*)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const a = parts[3];
    return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
  }
  return NaN;
}

// A declared background, followed through one `var(--token)` hop to :root.
function resolvedBackground(rule) {
  const value = declValue(rule, "background") ?? declValue(rule, "background-color");
  const token = value && /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (!token) return value;
  return declValue(ruleFor(":root"), token[1]);
}

test("the sticky site header is positioned sticky (the premise)", () => {
  expect(declValue(ruleFor(".site-header"), "position")).toBe("sticky");
});

test("the sticky site header background is fully opaque", () => {
  const bg = resolvedBackground(ruleFor(".site-header"));
  expect(bg, ".site-header declares a background").toBeTruthy();
  expect(alphaOf(bg), `alpha of ${bg}`).toBe(1);
});

test("the sticky site header does not lean on a backdrop blur to stay readable", () => {
  const rule = ruleFor(".site-header");
  expect(declValue(rule, "backdrop-filter")).toBeNull();
  expect(declValue(rule, "-webkit-backdrop-filter")).toBeNull();
});

test("alphaOf reads the literal shapes the lint must reject or accept", () => {
  expect(alphaOf("rgb(4 6 15 / 85%)")).toBeCloseTo(0.85);
  expect(alphaOf("rgba(4, 6, 15, 0.85)")).toBeCloseTo(0.85);
  expect(alphaOf("#04060fd9")).toBeLessThan(1);
  expect(alphaOf("rgb(4 6 15)")).toBe(1);
  expect(alphaOf("#04060f")).toBe(1);
});
