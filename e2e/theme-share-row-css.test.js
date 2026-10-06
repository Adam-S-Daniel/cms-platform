// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: the share row's stylesheet rules (#727).
//
// 1. The idle "Copy link" button showed the link glyph AND the check mark
//    because `.share-link svg { display: block }` (0,1,1) outranked
//    `.share-icon-success { display: none }` (0,1,0). A hiding rule for the
//    success icon must be at least as specific as the rule that shows every
//    share-row svg.
// 2. A phone (coarse pointer or a narrow viewport) must get a 44px touch
//    target (WCAG 2.5.5, Apple HIG), from a real width/height, not a
//    pseudo-element a size audit cannot see.
//
// The stylesheet is PARSED with postcss; a regex cannot tell a rule inside
// `@media` from one outside it. Specificity is computed from the selector's
// own tokens (ids, classes, attributes, pseudo-classes, types), the one place
// a lexical scan is the right tool.

const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const { test, expect } = require("./base");

const MAIN_CSS = path.join(__dirname, "..", "theme", "assets", "css", "main.css");
const root = postcss.parse(fs.readFileSync(MAIN_CSS, "utf8"));

// [ids, classes/attributes/pseudo-classes, types/pseudo-elements]
function specificity(selector) {
  let s = selector.replace(/"[^"]*"|'[^']*'/g, "");
  let a = 0;
  let b = 0;
  let c = 0;
  // :not(X) / :is(X) count as their argument; :where() counts as nothing.
  s = s.replace(/:where\([^)]*\)/g, "");
  s = s.replace(/:(?:not|is)\(([^)]*)\)/g, (_m, inner) => {
    const [ia, ib, ic] = specificity(inner);
    a += ia;
    b += ib;
    c += ic;
    return "";
  });
  s = s.replace(/#[\w-]+/g, () => (a++, ""));
  s = s.replace(/\[[^\]]*\]/g, () => (b++, ""));
  s = s.replace(/::[\w-]+/g, () => (c++, ""));
  s = s.replace(/:[\w-]+(?:\([^)]*\))?/g, () => (b++, ""));
  s = s.replace(/\.[\w-]+/g, () => (b++, ""));
  s = s.replace(/(^|[\s>+~])([a-zA-Z][\w-]*)/g, () => (c++, ""));
  return [a, b, c];
}

function atLeast(x, y) {
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

function topLevelRules() {
  const rules = [];
  root.each((n) => {
    if (n.type === "rule") rules.push(n);
  });
  return rules;
}

function declValue(rule, prop) {
  const d = rule.nodes.find((n) => n.type === "decl" && n.prop === prop);
  return d ? d.value.trim() : null;
}

test("the share-row svg rule that sets display exists (sanity)", () => {
  const rule = topLevelRules().find((r) => r.selectors.includes(".share-link svg"));
  expect(rule, ".share-link svg rule").toBeTruthy();
  expect(declValue(rule, "display")).toBe("block");
});

test("hiding the success icon is at least as specific as `.share-link svg`", () => {
  const shows = topLevelRules().find((r) => r.selectors.includes(".share-link svg"));
  const floor = specificity(".share-link svg");
  const hiding = topLevelRules().filter(
    (r) => declValue(r, "display") === "none" && r.selectors.some((s) => s.includes(".share-icon-success")),
  );
  expect(hiding.length, "a rule hiding .share-icon-success").toBeGreaterThan(0);
  for (const rule of hiding) {
    for (const sel of rule.selectors.filter((s) => s.includes(".share-icon-success"))) {
      expect(
        atLeast(specificity(sel), floor),
        `"${sel}" ${JSON.stringify(specificity(sel))} must be >= ".share-link svg" ${JSON.stringify(floor)}`,
      ).toBe(true);
    }
  }
  expect(shows).toBeTruthy();
});

test("the copied state still outranks the idle hide rule", () => {
  const hide = specificity(".share-link .share-icon-success");
  const copiedShow = topLevelRules().find((r) => r.selectors.includes(".share-copy.share-copied .share-icon-success"));
  expect(copiedShow, "copied-state show rule").toBeTruthy();
  expect(atLeast(specificity(".share-copy.share-copied .share-icon-success"), hide)).toBe(true);
  expect(declValue(copiedShow, "display")).toBe("block");
});

function remToPx(value) {
  const m = /^([\d.]+)(rem|px)$/.exec(value || "");
  if (!m) return NaN;
  return m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
}

test("a coarse pointer or phone width gets 44px share buttons", () => {
  let found = null;
  root.walkAtRules("media", (at) => {
    if (!/\(\s*pointer\s*:\s*coarse\s*\)/.test(at.params)) return;
    at.walkRules((r) => {
      if (r.selectors.includes(".share-link")) found = r;
    });
  });
  expect(found, ".share-link rule inside a (pointer: coarse) media query").toBeTruthy();
  expect(remToPx(declValue(found, "width"))).toBeGreaterThanOrEqual(44);
  expect(remToPx(declValue(found, "height"))).toBeGreaterThanOrEqual(44);
});

test("the desktop share button stays compact", () => {
  const base = topLevelRules().find((r) => r.selectors.includes(".share-link"));
  expect(remToPx(declValue(base, "width"))).toBeLessThan(44);
});
