// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: a post or page body cannot reach outside its own box (#1067).
//
// The body is whatever HTML an author's post carries. Measured on a real
// consumer build before these rules: a fixed-width <div> pasted from another
// site, an inline <svg>, a PDF <embed> and a <canvas> each pushed the whole
// page sideways on a phone, and an image floated near the end of a post
// squeezed the share row beside it into a 42px column. Two rules stop that,
// and one property must stay off because it moved every existing post.
// Parsed with postcss.

const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const { test, expect } = require("./base");

const MAIN_CSS = path.join(__dirname, "..", "theme", "assets", "css", "main.css");
const root = postcss.parse(fs.readFileSync(MAIN_CSS, "utf8"));

const BODIES = [".post-content", ".page-content"];
const MEDIA = ["video", "svg", "embed", "object", "canvas"];

// Top-level rules only: a rule inside @media applies to some widths, and
// these must hold at every width.
function topLevelRulesWith(selector) {
  return root.nodes.filter((n) => n.type === "rule" && n.selectors.includes(selector));
}

function decl(rule, prop) {
  const d = rule.nodes.find((n) => n.type === "decl" && n.prop === prop);
  return d ? d.value.trim() : null;
}

for (const body of BODIES) {
  test(`${body} contains its own floats with a clearing ::after`, () => {
    const rules = topLevelRulesWith(`${body}::after`);
    expect(rules, `one top-level ${body}::after rule`).toHaveLength(1);
    expect(decl(rules[0], "clear")).toBe("both");
    expect(decl(rules[0], "display")).toBe("block");
    expect(decl(rules[0], "content")).toBe('""');
  });

  test(`${body} caps its direct children at the column width`, () => {
    const rules = topLevelRulesWith(`${body} > *`);
    expect(rules, `one top-level "${body} > *" rule`).toHaveLength(1);
    expect(decl(rules[0], "max-width")).toBe("100%");
  });

  // flow-root (and any overflow other than visible) would also contain the
  // floats, but it stops the body's first and last margins collapsing through
  // it: every existing post grew by 24px when it was tried.
  test(`${body} is not made a new formatting context`, () => {
    root.walkRules((r) => {
      if (!r.selectors.includes(body)) return;
      expect(decl(r, "display"), `${body} display`).not.toBe("flow-root");
      for (const prop of ["overflow", "overflow-x", "overflow-y"]) {
        const v = decl(r, prop);
        expect(v === null || v === "visible", `${body} ${prop}: ${v}`).toBe(true);
      }
    });
  });
}

// The two deeper rules name both bodies inside `:where()`, which adds no
// specificity. Written plainly they outranked an author's own one-class cap
// inside an embed (`.card { max-width: 400px }`, `.icon { max-width: 1em }`)
// and widened what the author had made narrow.
const BOTH = `:where(${BODIES.join(", ")})`;

// The editor's HTML Embed component wraps pasted HTML in
// <div class="post-embed">, so a pasted fixed-width box is a GRANDCHILD of the
// body: the direct-child rule alone left it 1,624px wide at 390px.
test("the children of an HTML embed are capped, at no more than one class of specificity", () => {
  const selector = `${BOTH} .post-embed > *`;
  const rules = topLevelRulesWith(selector);
  expect(rules, `one top-level "${selector}" rule`).toHaveLength(1);
  expect(decl(rules[0], "max-width")).toBe("100%");
});

test("replaced media at any depth is capped, at zero specificity", () => {
  const selector = `${BOTH} :where(${MEDIA.join(", ")})`;
  const rules = topLevelRulesWith(selector);
  expect(rules, `one top-level "${selector}" rule`).toHaveLength(1);
  expect(decl(rules[0], "max-width")).toBe("100%");
});

test("no containment rule outranks an author's one-class rule", () => {
  root.walkRules((r) => {
    if (decl(r, "max-width") !== "100%") return;
    for (const selector of r.selectors) {
      if (!BODIES.some((b) => selector.includes(b))) continue;
      // Outside :where(), at most one class and no element name.
      const counted = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "");
      const classes = (counted.match(/\./g) || []).length;
      expect(classes, `"${selector}" counts ${classes} classes outside :where()`).toBeLessThanOrEqual(1);
      expect(counted, `"${selector}" names an element outside :where()`).not.toMatch(/(^|[\s>+~])[a-z]/);
    }
  });
});
