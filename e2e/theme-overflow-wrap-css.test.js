// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: a long unbroken string must wrap, not widen the page (#753).
//
// A bare URL or identifier has no break opportunity, so without `overflow-wrap`
// it pushes the document past the viewport (about 1330px wide on a 390px phone
// in the UX audit). Post text, listing excerpts and inline code must break
// such a string; a `pre` block and the bare table keep their own horizontal
// scroll box instead, so the wrap is reset there. Parsed with postcss.

const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const { test, expect } = require("./base");

const MAIN_CSS = path.join(__dirname, "..", "theme", "assets", "css", "main.css");
const root = postcss.parse(fs.readFileSync(MAIN_CSS, "utf8"));

function rulesFor(selector) {
  const out = [];
  root.walkRules((r) => {
    if (r.selectors.map((s) => s.trim()).includes(selector)) out.push(r);
  });
  return out;
}

// The last declaration wins within equal specificity, so read it that way.
function decl(rule, prop) {
  const ds = rule.nodes.filter((n) => n.type === "decl" && n.prop === prop);
  return ds.length ? ds[ds.length - 1].value.trim() : null;
}

function wrapValues(selector) {
  return rulesFor(selector).map((r) => decl(r, "overflow-wrap")).filter(Boolean);
}

const BREAKS = /^(anywhere|break-word)$/;

for (const selector of [".post-content", ".post-excerpt", ":not(pre) > code"]) {
  test(`${selector} breaks an unbroken string`, () => {
    const values = wrapValues(selector);
    expect(values, `an overflow-wrap declaration on ${selector}`).not.toHaveLength(0);
    expect(values[values.length - 1]).toMatch(BREAKS);
  });
}

for (const selector of [".post-content pre", ".post-content table:not([class])"]) {
  test(`${selector} opts back out so it keeps its horizontal scroll`, () => {
    expect(wrapValues(selector).pop()).toBe("normal");
  });
}

test("the code block and bare table keep their scroll boxes", () => {
  const scrolls = (sel) => rulesFor(sel).map((r) => decl(r, "overflow-x")).filter(Boolean).pop();
  expect(scrolls("pre")).toBe("auto");
  expect(scrolls("table:not([class])")).toBe("auto");
});

test("no blanket word-break that would split ordinary words", () => {
  root.walkDecls("word-break", (d) => {
    expect(d.value, `${d.parent.selector} word-break`).not.toMatch(/break-all/);
  });
});
