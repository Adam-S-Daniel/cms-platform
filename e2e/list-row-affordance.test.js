// @lane: local — pure-Node behavioral test for list-row-affordance.js (vm sandbox, tiny fake DOM)
/*
 * Decap's list rows have three icon-only controls (expand chevron, drag handle,
 * remove "x"), the entry editor's Back link wraps an arrow glyph and a save-status
 * badge, and the Rich Text / Markdown switch and the body textbox have no name at
 * all. A keyboard or screen-reader owner heard the same name on every row, or
 * nothing, and Enter on the unnamed "x" deleted a row. list-row-affordance.js
 * names them. This is the unit half (a fake DOM that answers the few selectors the
 * shim uses); the real Decap 3.15.1 half is cms-control-names.spec.js.
 *
 * The fake follows the shape verified against Decap 3.15.1 in a real browser:
 *   SortableListItem
 *     StyledListItemTopBar > button, div[role=button][aria-roledescription=sortable]
 *                              > span.DragIconContainer, button
 *     NestedObjectLabel (the summary; stays in the DOM when the row is open)
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM = fs.readFileSync(path.resolve(__dirname, "../theme/admin/list-row-affordance.js"), "utf8");

// ── A tiny DOM: elements, attributes, and exactly the selectors the shim uses ──
// Compound selectors of tag, [attr], [attr="v"], [attr*="v"], joined by spaces
// (descendant). Anything else throws, so a new selector in the shim shows up here.
function parseCompound(src) {
  const tag = /^[a-z][a-z0-9]*/i.exec(src);
  const rest = tag ? src.slice(tag[0].length) : src;
  const attrs = [];
  const re = /\[([a-z-]+)(?:(\*?=)"([^"]*)")?\]/gi;
  let m;
  let used = 0;
  while ((m = re.exec(rest))) {
    attrs.push({ name: m[1], op: m[2] || null, value: m[3] });
    used += m[0].length;
  }
  if (used !== rest.length) throw new Error(`fake DOM cannot parse selector part: ${src}`);
  return { tag: tag ? tag[0].toLowerCase() : null, attrs };
}

function parseSelector(sel) {
  return sel
    .split(/\s+(?![^[]*\])/)
    .filter(Boolean)
    .map(parseCompound);
}

class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.ownText = "";
    this.listeners = {};
    this.clicks = 0;
    this.style = {};
    this.writes = 0;
    for (const k of kids) this.append(k);
  }
  get className() {
    return this.attrs.class || "";
  }
  append(kid) {
    if (typeof kid === "string") {
      this.ownText += kid;
    } else {
      kid.parentElement = this;
      this.children.push(kid);
    }
    return this;
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.ownText = String(v);
    this.children = [];
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  hasAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k);
  }
  setAttribute(k, v) {
    this.writes++;
    this.attrs[k] = String(v);
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  click() {
    this.clicks++;
    if (this.listeners.click) this.listeners.click({ target: this });
  }
  _matchesCompound(c) {
    if (c.tag && this.tagName.toLowerCase() !== c.tag) return false;
    return c.attrs.every((a) => {
      const v = this.getAttribute(a.name);
      if (v === null) return false;
      if (a.op === "=") return v === a.value;
      if (a.op === "*=") return v.includes(a.value);
      return true;
    });
  }
  _matchesChain(chain) {
    if (!this._matchesCompound(chain[chain.length - 1])) return false;
    let need = chain.length - 2;
    for (let n = this.parentElement; n && need >= 0; n = n.parentElement) {
      if (n._matchesCompound(chain[need])) need--;
    }
    return need < 0;
  }
  matches(sel) {
    return this._matchesChain(parseSelector(sel));
  }
  closest(sel) {
    const chain = parseSelector(sel);
    for (let n = this; n; n = n.parentElement) if (n._matchesChain(chain)) return n;
    return null;
  }
  querySelectorAll(sel) {
    const chain = parseSelector(sel);
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c._matchesChain(chain)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  // Every attribute write below this node, for "touched nothing" assertions.
  totalWrites() {
    return this.writes + this.children.reduce((n, c) => n + c.totalWrites(), 0);
  }
}

const el = (tag, cls, attrs, kids) => new El(tag, { ...(cls ? { class: cls } : {}), ...(attrs || {}) }, kids);

// Emotion-style hashed class names, as Decap renders them.
const css = (name) => `css-1abc-${name} e11zrb3c`;

// One list row as Decap 3.15.1 renders it.
function row(summary, extraKids = []) {
  const bar = el("div", css("TopBar-StyledListItemTopBar-StyledListItemTopBar"), null, [
    el("button", css("TopBarButton-button-button")),
    el("div", null, { role: "button", tabindex: "0", "aria-roledescription": "sortable" }, [
      el("span", css("TopBarButtonSpan-TopBarButton-DragIconContainer")),
    ]),
    el("button", css("TopBarButton-button-button")),
  ]);
  const kids = [bar];
  if (summary !== null) kids.push(el("div", css("NestedObjectLabel"), null, [summary]));
  return el("div", css("ListItem-listControlItem-SortableListItem"), null, kids.concat(extraKids));
}

const barOf = (r) => r.children[0];
const namesOf = (r) => barOf(r).children.map((c) => c.getAttribute("aria-label"));

// Run the shim in a sandbox over `body`; returns a handle to re-run a pass.
function load(body) {
  const documentElement = el("html", null, null, [body]);
  const observers = [];
  const document = {
    readyState: "complete",
    documentElement,
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    addEventListener() {},
  };
  class FakeObserver {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(target, opts) {
      this.target = target;
      this.opts = opts;
    }
  }
  const sandbox = { document, MutationObserver: FakeObserver };
  vm.runInNewContext(SHIM, sandbox, { filename: "list-row-affordance.js" });
  return { pass: () => observers.forEach((o) => o.cb([])), observers, documentElement };
}

test.describe("list-row-affordance.js names the unnamed admin controls", () => {
  test("each row's chevron, handle and remove button get a distinct, row-specific name", () => {
    const r1 = row("Alpha");
    const r2 = row("Beta");
    load(el("div", null, null, [r1, r2]));
    expect(namesOf(r1)).toEqual(["Expand or collapse item 1 (Alpha)", "Move item 1 (Alpha)", "Delete item 1 (Alpha)"]);
    expect(namesOf(r2)).toEqual(["Expand or collapse item 2 (Beta)", "Move item 2 (Beta)", "Delete item 2 (Beta)"]);
    expect(new Set([...namesOf(r1), ...namesOf(r2)]).size).toBe(6);
  });

  test("a row with no summary is named by its position alone", () => {
    const r1 = row(null);
    const r2 = row("   ");
    load(el("div", null, null, [r1, r2]));
    expect(namesOf(r1)).toEqual(["Expand or collapse item 1", "Move item 1", "Delete item 1"]);
    expect(namesOf(r2)).toEqual(["Expand or collapse item 2", "Move item 2", "Delete item 2"]);
  });

  test("a long summary is shortened so it is not read out three times in full", () => {
    const long = "word ".repeat(40);
    const r1 = row(long);
    load(el("div", null, null, [r1]));
    const [chev] = namesOf(r1);
    expect(chev.startsWith("Expand or collapse item 1 (word word")).toBe(true);
    expect(chev.endsWith("…)")).toBe(true);
    expect(chev.length).toBeLessThan(100);
  });

  test("a nested list's rows take their own position, and the outer row keeps its own summary", () => {
    const inner1 = row("Inner A");
    const inner2 = row("Inner B");
    const innerList = el("div", null, null, [inner1, inner2]);
    const outer = row("Outer", [innerList]);
    const outer2 = row("Second outer");
    load(el("div", null, null, [outer, outer2]));
    expect(namesOf(outer)[2]).toBe("Delete item 1 (Outer)");
    expect(namesOf(inner1)[2]).toBe("Delete item 1 (Inner A)");
    expect(namesOf(inner2)[2]).toBe("Delete item 2 (Inner B)");
    expect(namesOf(outer2)[2]).toBe("Delete item 2 (Second outer)");
  });

  test("an outer row whose own label is absent does not borrow a nested row's summary", () => {
    const inner = row("Inner");
    const outer = row(null, [el("div", null, null, [inner])]);
    load(el("div", null, null, [outer]));
    expect(namesOf(outer)[2]).toBe("Delete item 1");
  });

  test("idempotent: a second pass over finished rows writes nothing", () => {
    const body = el("div", null, null, [row("Alpha"), row("Beta")]);
    const h = load(body);
    const before = body.totalWrites();
    const names = body.children.map(namesOf);
    h.pass();
    h.pass();
    expect(body.totalWrites()).toBe(before);
    expect(body.children.map(namesOf)).toEqual(names);
  });

  test("names follow a changed summary and renumber when a row goes away", () => {
    const r1 = row("Alpha");
    const r2 = row("Beta");
    const body = el("div", null, null, [r1, r2]);
    const h = load(body);

    r2.children[1].textContent = "Gamma";
    h.pass();
    expect(namesOf(r2)[2]).toBe("Delete item 2 (Gamma)");

    body.children.splice(0, 1); // Decap drops row 1; r2 is now first
    h.pass();
    expect(namesOf(r2)[2]).toBe("Delete item 1 (Gamma)");
  });

  test("a row Decap re-renders as fresh nodes is named again on the next pass", () => {
    const body = el("div", null, null, [row("Alpha")]);
    const h = load(body);
    body.children.length = 0;
    const fresh = row("Alpha");
    body.append(fresh);
    expect(namesOf(fresh)).toEqual([null, null, null]);
    h.pass();
    expect(namesOf(fresh)).toEqual(["Expand or collapse item 1 (Alpha)", "Move item 1 (Alpha)", "Delete item 1 (Alpha)"]);
  });

  test("a name Decap itself puts on a control is never overwritten", () => {
    const r1 = row("Alpha");
    barOf(r1).children[2].attrs["aria-label"] = "Remove";
    load(el("div", null, null, [r1]));
    expect(namesOf(r1)[2]).toBe("Remove");
    expect(namesOf(r1)[1]).toBe("Move item 1 (Alpha)");
  });

  test("a row with no remove button (sorting only) is named without one", () => {
    const r1 = row("Alpha");
    barOf(r1).children.pop();
    load(el("div", null, null, [r1]));
    expect(namesOf(r1)).toEqual(["Expand or collapse item 1 (Alpha)", "Move item 1 (Alpha)"]);
  });

  test("the observer also watches text, because a summary is rewritten in place", () => {
    const h = load(el("div"));
    expect(h.observers).toHaveLength(1);
    expect(h.observers[0].opts).toEqual({ childList: true, characterData: true, subtree: true });
  });

  test("clicking a row's summary still clicks that row's own chevron", () => {
    const r1 = row("Alpha");
    const r2 = row("Beta");
    load(el("div", null, null, [r1, r2]));
    r2.children[1].click();
    expect(barOf(r2).children[0].clicks).toBe(1);
    expect(barOf(r1).children[0].clicks).toBe(0);
  });

  test("without Decap's class names the shim touches nothing and does not throw", () => {
    const body = el("div", null, null, [
      el("div", "plain-row", null, [el("button"), el("div", null, { role: "button" }), el("button")]),
      el("a", "link", { href: "#/x" }, ["Writing in X collection"]),
      el("button", null, { role: "switch" }),
      el("div", null, { role: "textbox" }),
    ]);
    const h = load(body);
    h.pass();
    expect(body.totalWrites()).toBe(0);
  });
});

// The entry editor's top-left link, as Decap 3.15.1 renders it.
function backLink({ status = "Unsaved Changes", withCollection = true } = {}) {
  const kids = [el("div", css("BackArrow"), null, ["←"])];
  const inner = [];
  if (withCollection) inner.push(el("div", css("BackCollection"), null, [" Writing in Pages collection"]));
  if (status) inner.push(el("div", css("BackStatus-BackStatusChanged-badge"), null, [status]));
  kids.push(el("div", null, null, inner));
  return el("a", css("ToolbarSectionBackLink-toolbarSection"), { href: "#/collections/pages" }, kids);
}

test.describe("list-row-affordance.js: the editor Back link", () => {
  test("hides the arrow and the save badge from the name and says it goes back", () => {
    const link = backLink();
    load(el("div", null, null, [link]));
    expect(link.querySelector('[class*="BackArrow"]').getAttribute("aria-hidden")).toBe("true");
    expect(link.querySelector('[class*="BackStatus"]').getAttribute("aria-hidden")).toBe("true");
    expect(link.getAttribute("aria-label")).toBe("Back to Writing in Pages collection");
  });

  test("the name does not change when the save status does", () => {
    const link = backLink({ status: "Changes saved" });
    const h = load(el("div", null, null, [link]));
    expect(link.getAttribute("aria-label")).toBe("Back to Writing in Pages collection");
    link.querySelector('[class*="BackStatus"]').textContent = "Unsaved Changes";
    h.pass();
    expect(link.getAttribute("aria-label")).toBe("Back to Writing in Pages collection");
  });

  test("a link with no collection text is left alone (no name invented)", () => {
    const link = backLink({ withCollection: false });
    load(el("div", null, null, [link]));
    expect(link.getAttribute("aria-label")).toBeNull();
  });

  test("a name Decap itself puts on the link is never overwritten", () => {
    const link = backLink();
    link.attrs["aria-label"] = "Back to all pages";
    load(el("div", null, null, [link]));
    expect(link.getAttribute("aria-label")).toBe("Back to all pages");
  });
});

// A markdown field's control: label on top, then the editor with its mode switch.
function bodyField(label) {
  const sw = el("button", css("ToggleContainer-StyledToggle-ToolbarToggle"), { role: "switch", "aria-checked": "false" });
  const box = el("div", null, { role: "textbox", "aria-multiline": "true", "data-slate-editor": "true" });
  const field = el("div", css("ControlContainer"), null, [
    el("div", css("ControlTopbar"), null, [el("label", css("FieldLabel-fieldLabel"), { for: "body-field-4" }, [label])]),
    el("div", "cms-editor-visual", null, [el("div", css("ToolbarToggle"), null, [sw]), box]),
  ]);
  return { field, sw, box };
}

test.describe("list-row-affordance.js: the Rich Text / Markdown switch and the body textbox", () => {
  test("both take their name from the field's label", () => {
    const { field, sw, box } = bodyField("Content");
    load(el("div", null, null, [field]));
    expect(sw.getAttribute("aria-label")).toBe("Edit Content as Markdown");
    expect(box.getAttribute("aria-label")).toBe("Content");
  });

  test("two body fields each get their own label", () => {
    const a = bodyField("Intro");
    const b = bodyField("Details");
    load(el("div", null, null, [a.field, b.field]));
    expect(a.box.getAttribute("aria-label")).toBe("Intro");
    expect(b.box.getAttribute("aria-label")).toBe("Details");
    expect(b.sw.getAttribute("aria-label")).toBe("Edit Details as Markdown");
  });

  test("a textbox Decap already labels by reference is left alone", () => {
    const { field, box } = bodyField("Content");
    box.attrs["aria-labelledby"] = "x";
    load(el("div", null, null, [field]));
    expect(box.getAttribute("aria-label")).toBeNull();
  });

  test("a field with no label text is left unnamed rather than named wrongly", () => {
    const { field, sw, box } = bodyField("");
    load(el("div", null, null, [field]));
    expect(sw.getAttribute("aria-label")).toBeNull();
    expect(box.getAttribute("aria-label")).toBeNull();
  });

  test("idempotent: a second pass writes nothing", () => {
    const { field } = bodyField("Content");
    const body = el("div", null, null, [field]);
    const h = load(body);
    const before = body.totalWrites();
    h.pass();
    expect(body.totalWrites()).toBe(before);
  });
});
