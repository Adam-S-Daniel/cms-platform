// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: a long unbroken string must wrap, not widen the page (#753).
//
// A bare URL or identifier has no break opportunity, so without `overflow-wrap`
// it pushes the document past the viewport (about 1330px on a 390px phone in
// the UX audit). Post text, listing excerpts and inline code must break such a
// string, with `break-word`, NOT `anywhere`: `anywhere` also lowers min-content
// size, which makes a table's auto layout break cells mid-word ("Langua|ge")
// even when the table fits, in a classed table (.bws-table) and in inline code
// inside a bare table alike. `break-word` leaves layout alone until a string
// actually overflows. Parsed with postcss.

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

function lastValue(selector, prop) {
  const values = rulesFor(selector).map((r) => decl(r, prop)).filter(Boolean);
  return values.length ? values[values.length - 1] : null;
}

for (const selector of [".post-content", ".post-excerpt", ":not(pre) > code"]) {
  test(`${selector} breaks an unbroken string with break-word`, () => {
    expect(lastValue(selector, "overflow-wrap")).toBe("break-word");
  });
}

test("nothing lowers min-content size, so table layout is computed as before", () => {
  // `overflow-wrap: anywhere` (and `word-break: break-all` / `break-word`) are
  // inherited into a classed table and into inline code inside a bare table,
  // where they break cells mid-word although the table fits. Any selector.
  const offenders = [];
  root.walkDecls((d) => {
    if (d.prop === "overflow-wrap" && d.value.trim() === "anywhere") offenders.push(`${d.parent.selector} overflow-wrap`);
    if (d.prop === "word-break" && /break-all|break-word/.test(d.value)) offenders.push(`${d.parent.selector} word-break`);
    if (d.prop === "line-break" && d.value.trim() === "anywhere") offenders.push(`${d.parent.selector} line-break`);
  });
  expect(offenders).toEqual([]);
});

test("the wrap reaches inline code only, and a code block keeps its horizontal scroll", () => {
  const pre = rulesFor("pre").map((r) => decl(r, "overflow-x")).filter(Boolean).pop();
  expect(pre).toBe("auto");
  // break-word cannot act on a pre as long as it never soft-wraps.
  root.walkRules((r) => {
    if (!r.selectors.some((s) => /(^|[\s>+~])pre($|[\s.:[>+~])/.test(s.trim()) && !/^:not\(pre\)/.test(s.trim()))) return;
    expect(decl(r, "white-space") || "pre", `${r.selector} white-space`).not.toMatch(/wrap|normal|break-spaces/);
  });
  expect(rulesFor(":not(pre) > code")).toHaveLength(1);
});

test("the bare table keeps its own scroll box", () => {
  expect(lastValue("table:not([class])", "overflow-x")).toBe("auto");
});
