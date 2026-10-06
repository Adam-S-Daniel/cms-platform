// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: the public-theme polish rules in main.css (#737).
//
// 1. Hero gap. The post hero image was an inline <img> with its own
//    `margin-bottom: 2rem` inside `.post-header` (`margin-bottom: 3rem`): the
//    two stacked, plus a descender strip from the inline baseline, so about
//    90px of empty space sat between the picture and the body.
// 2. Current nav item. `.site-nav a` runs the `text-thermal` animation, and a
//    running animation outranks every normal declaration, so the old
//    `.site-nav a.active { color }` rule never showed. A current-page rule
//    has to switch the animation off.
// 3. Tag names. The pill shows a tag uppercase (`text-transform`); the tag
//    index and the tag page heading showed it as stored.
//
// The stylesheet is PARSED with postcss (a regex cannot tell which rule a
// declaration sits in).

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

function remToPx(value) {
  if (value === "0") return 0;
  const m = /^([\d.]+)(rem|px)$/.exec(value || "");
  if (!m) return NaN;
  return m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
}

test("the hero image is a block, not an inline image on a text baseline", () => {
  expect(declValue(ruleFor(".featured-image"), "display")).toBe("block");
});

test("a hero image in the post header adds no margin of its own under the header's", () => {
  const header = remToPx(declValue(ruleFor(".post-header"), "margin-bottom"));
  const image = remToPx(declValue(ruleFor(".post-header .featured-image"), "margin-bottom"));
  expect(header, ".post-header margin-bottom").toBeGreaterThan(0);
  expect(image, ".post-header .featured-image margin-bottom").toBe(0);
});

test("the Decap preview pane's image, outside a header, keeps its spacing", () => {
  expect(remToPx(declValue(ruleFor(".featured-image"), "margin-bottom"))).toBeGreaterThan(0);
});

test("the current nav item stops the text-thermal animation that would hide its color", () => {
  const base = ruleFor(".site-nav a");
  expect(declValue(base, "animation"), "base nav link animates (the premise)").toMatch(/text-thermal/);
  for (const value of ["page", "true"]) {
    const selector = `.site-nav a[aria-current="${value}"]`;
    const current = topLevelRules().find((r) =>
      r.selectors.some((s) => s.replace(/\s+/g, " ").trim() === selector),
    );
    expect(current, `a rule for ${selector}`).toBeTruthy();
    expect(declValue(current, "animation"), `${selector} animation`).toBe("none");
    expect(declValue(current, "color"), `${selector} color`).toBeTruthy();
    // Not color alone (WCAG 1.4.1): an underline marks it too.
    expect(declValue(current, "text-decoration"), `${selector} text-decoration`).toMatch(/underline/);
  }
});

test("marking the current nav item moves nothing: no border, padding or margin added", () => {
  for (const r of topLevelRules().filter((r) => r.selectors.some((s) => /^\.site-nav a(\.active|\[aria-current)/.test(s.trim())))) {
    for (const prop of ["border", "border-bottom", "padding", "padding-bottom", "margin", "margin-bottom"]) {
      expect(declValue(r, prop), `${r.selector} ${prop}`).toBeNull();
    }
  }
});

test("a tag is displayed uppercase everywhere the pill shows it", () => {
  const pill = declValue(ruleFor(".tag-pill"), "text-transform");
  expect(pill).toBe("uppercase");
  for (const selector of [".tag-list-name", ".tag-title"]) {
    expect(declValue(ruleFor(selector), "text-transform"), `${selector} text-transform`).toBe(pill);
  }
});
