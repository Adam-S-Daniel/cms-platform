// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: a bare Markdown table is readable (#729) and stays a scroll box (#540).
//
// kramdown emits a class-less <table>, so the theme styles `table:not([class])`.
// Before #729 that rule carried only the overflow box, and cells ran together
// ("1,450 ms" + "slow & thorough"). The rules must keep the `:not([class])`
// scope (a classed table, adamdaniel.ai's .bws-table, styles its own cells) and
// use the theme's color tokens, not hardcoded colors. Parsed with postcss.

const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");
const { test, expect } = require("./base");

const MAIN_CSS = path.join(__dirname, "..", "theme", "assets", "css", "main.css");
const root = postcss.parse(fs.readFileSync(MAIN_CSS, "utf8"));

function rulesFor(selector) {
  const out = [];
  root.walkRules((r) => {
    if (r.selectors.includes(selector)) out.push(r);
  });
  return out;
}

function decl(rule, prop) {
  const d = rule.nodes.find((n) => n.type === "decl" && n.prop === prop);
  return d ? d.value.trim() : null;
}

const remPx = (v) => (/^([\d.]+)rem$/.test(v || "") ? Number(RegExp.$1) * 16 : NaN);

test("the bare table keeps its horizontal scroll box and gains margin and border-collapse", () => {
  const rules = rulesFor("table:not([class])");
  expect(rules, "a table:not([class]) rule").toHaveLength(1);
  expect(decl(rules[0], "display")).toBe("block");
  expect(decl(rules[0], "overflow-x")).toBe("auto");
  expect(decl(rules[0], "max-width")).toBe("100%");
  expect(decl(rules[0], "border-collapse")).toBe("collapse");
  expect(decl(rules[0], "margin")).toBeTruthy();
});

test("cells get padding and a token-colored border, scoped to bare tables", () => {
  const cells = root.nodes.find(
    (n) =>
      n.type === "rule" &&
      n.selectors.includes("table:not([class]) th") &&
      n.selectors.includes("table:not([class]) td"),
  );
  expect(cells, "a rule for bare-table th and td").toBeTruthy();
  const pad = decl(cells, "padding");
  expect(pad, "padding").toBeTruthy();
  expect(remPx(pad.split(/\s+/)[0])).toBeGreaterThanOrEqual(8);
  expect(decl(cells, "border")).toBe("1px solid var(--border)");
});

test("the header row is heavier and has its own token background", () => {
  const rules = rulesFor("table:not([class]) th");
  const head = rules.find((r) => decl(r, "font-weight"));
  expect(head, "a th rule with font-weight").toBeTruthy();
  expect(Number(decl(head, "font-weight"))).toBeGreaterThanOrEqual(600);
  expect(decl(head, "background")).toMatch(/^var\(--bg-\d\)$/);
});

// Selector scanning without a regex over its shape: split a selector into its
// compounds at combinators (whitespace, >, +, ~) that sit outside [] and (),
// then read each compound's leading type name character by character.
const TABLE_PARTS = new Set(["table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td"]);

function compounds(selector) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const ch of selector.trim()) {
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    const combinator = depth === 0 && (ch === " " || ch === "\t" || ch === "\n" || ch === ">" || ch === "+" || ch === "~");
    if (combinator) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function typeName(compound) {
  let name = "";
  for (const ch of compound) {
    const isNameChar = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-";
    if (!isNameChar) break;
    name += ch;
  }
  return name.toLowerCase();
}

// A selector ends on a table part (so it styles table content) without any
// compound pinning a `table` to `:not([class])` => it restyles classed tables.
function restylesClassedTables(selector) {
  const parts = compounds(selector);
  if (parts.length === 0 || !TABLE_PARTS.has(typeName(parts[parts.length - 1]))) return false;
  const scoped = parts.some((c) => typeName(c) === "table" && c.includes(":not([class])"));
  return !scoped;
}

test("the scope check itself catches bare, descendant and structural selectors", () => {
  for (const bad of ["td", "table", ".page-content td", ".post-content table", "tbody tr:hover td", "main > table th", "table td"]) {
    expect(restylesClassedTables(bad), bad).toBe(true);
  }
  for (const ok of ["table:not([class])", "table:not([class]) td", ".page-content table:not([class]) th", "pre", ".share-link svg"]) {
    expect(restylesClassedTables(ok), ok).toBe(false);
  }
});

test("no rule in main.css restyles classed tables", () => {
  const offenders = [];
  root.walkRules((r) => {
    for (const sel of r.selectors) {
      if (restylesClassedTables(sel)) offenders.push(sel);
    }
  });
  expect(offenders, "scope each with table:not([class])").toEqual([]);
});
