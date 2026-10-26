// @lane: local — pure-Node behavioral test for route-focus.js (vm sandbox, no timers)
/*
 * UX round 3 (ad-kbd K8, jd-kbd F5): Decap unmounts the focused element on a
 * route change, a Save or a Delete, so focus drops to <body>. route-focus.js
 * puts it back on the new view (list heading, first field of a new entry, the
 * Back link of an existing one) ONLY while focus is on <body>, and adds a
 * "Skip to content" link as the first child of <body>.
 *
 * The animation frames are stubbed and run by hand, so nothing here reads a
 * clock. The Decap selectors the shim keys on (Decap 3.15.1) are listed below
 * and proven against the real bundle by cms-route-focus.spec.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM = fs.readFileSync(path.resolve(__dirname, "../theme/admin/route-focus.js"), "utf8");

const EDITOR = '[class*="EditorContainer"]';
const CONTROL = '[class*="ControlContainer"]';
const BACK_LINK = 'a[class*="ToolbarSectionBackLink"]';
const APP_MAIN = '[class*="AppMainContainer"]';

function fakeEl(tagName, props = {}) {
  const el = {
    tagName,
    attrs: {},
    style: {},
    children: [],
    listeners: {},
    isConnected: true,
    offsetParent: {},
    disabled: false,
    focused: null,
    textContent: "",
    ...props,
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] === undefined ? null : this.attrs[k];
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    appendChild(c) {
      this.children.push(c);
    },
    // The three selectors the shim hands to closest().
    closest(sel) {
      if (sel === CONTROL) return this.inControl ? this : null;
      if (sel === '[role="menuitem"]') return this.attrs.role === "menuitem" ? this : null;
      if (sel === 'button, [role="menuitem"]') return this.tagName === "BUTTON" || this.attrs.role === "menuitem" ? this : null;
      return null;
    },
    focus(opts) {
      this.focused = opts || {};
      this.ownerDoc.activeElement = this;
    },
  };
  return el;
}

function load({ hash = "#/collections/posts", readyState = "complete" } = {}) {
  const frames = [];
  const windowListeners = {};
  const docListeners = {};
  const styles = [];
  const body = fakeEl("BODY");
  body.insertBefore = (el, ref) => {
    body.children.splice(ref ? body.children.indexOf(ref) : body.children.length, 0, el);
    el.parent = body;
  };
  Object.defineProperty(body, "firstChild", { get: () => body.children[0] || null });
  const head = fakeEl("HEAD");
  head.appendChild = (c) => styles.push(c);
  const editor = fakeEl("DIV", { fields: [] });
  editor.querySelectorAll = () => editor.fields;
  // The page's Decap DOM: tests assign these.
  const dom = { h1: null, main: null, backLink: null, editor: null, appMain: null };
  const document = {
    body,
    head,
    readyState,
    activeElement: body,
    documentElement: fakeEl("HTML"),
    createElement: (tag) => fakeEl(String(tag).toUpperCase(), { ownerDoc: document }),
    getElementById(id) {
      if (id === "cms-route-focus-style") return styles[0] || null;
      return body.children.find((c) => c.id === id) || null;
    },
    querySelector(sel) {
      if (sel === "main h1") return dom.h1;
      if (sel === "main") return dom.main;
      if (sel === BACK_LINK) return dom.backLink;
      if (sel === EDITOR) return dom.editor;
      if (sel === APP_MAIN) return dom.appMain;
      return null;
    },
    addEventListener(type, fn) {
      docListeners[type] = fn;
    },
  };
  body.ownerDoc = document;
  head.ownerDoc = document;
  const sandbox = {
    window: {
      requestAnimationFrame: (fn) => frames.push(fn),
      addEventListener(type, fn) {
        windowListeners[type] = fn;
      },
    },
    document,
    location: { hash },
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM, sandbox);
  // A fake element in this document.
  const make = (tag, props) => {
    const e = fakeEl(tag, { ownerDoc: document, ...props });
    return e;
  };
  // Run the queued frames: `n` rounds, or until the queue drains.
  const flush = (n = 1000) => {
    let rounds = 0;
    while (frames.length && rounds++ < n) {
      const batch = frames.splice(0, frames.length);
      batch.forEach((f) => f());
    }
  };
  const go = (next) => {
    sandbox.location.hash = next;
    windowListeners.hashchange();
  };
  const click = (target, trusted = true) => docListeners.click({ target, isTrusted: trusted });
  const keydown = (target, key, trusted = true) => docListeners.keydown({ target, key, isTrusted: trusted });
  const pointerdown = () => docListeners.pointerdown({});
  // A realistic editor: a Back link, and fields (the first hidden, the second
  // outside a control, the third the real first field).
  const withEditor = () => {
    dom.editor = editor;
    dom.backLink = make("A");
    const hidden = make("INPUT", { offsetParent: null, inControl: true });
    const stray = make("INPUT", { inControl: false });
    const title = make("INPUT", { inControl: true });
    const second = make("TEXTAREA", { inControl: true });
    editor.fields = [hidden, stray, title, second];
    return { back: dom.backLink, title, hidden, stray, second };
  };
  return { sandbox, document, body, dom, styles, frames, flush, go, click, keydown, pointerdown, make, withEditor, windowListeners, docListeners };
}

test.describe("route-focus.js", () => {
  test("adds a visible-on-focus Skip to content link as the first child of body, once", () => {
    const { body, styles, sandbox } = load();
    expect(body.children).toHaveLength(1);
    const link = body.children[0];
    expect(link.id).toBe("cms-skip-link");
    expect(link.textContent).toBe("Skip to content");
    expect(link.tagName).toBe("A");
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain("#cms-skip-link:focus{top:8px}");
    // A second load (the shell included twice) installs nothing more.
    vm.runInContext(SHIM, sandbox);
    expect(body.children).toHaveLength(1);
  });

  test("installs after DOMContentLoaded when the shell is still parsing", () => {
    const { body, docListeners } = load({ readyState: "loading" });
    expect(body.children).toHaveLength(0);
    docListeners.DOMContentLoaded();
    expect(body.children[0].id).toBe("cms-skip-link");
  });

  test("does not move focus on the initial page load", () => {
    const { document, body, frames, dom, make } = load();
    dom.h1 = make("H1");
    expect(frames).toHaveLength(0);
    expect(document.activeElement).toBe(body);
  });

  test("a route change that dropped focus on body puts it on the list heading, with a tabindex", () => {
    const t = load();
    t.dom.main = t.make("MAIN");
    t.dom.h1 = t.make("H1");
    t.go("#/collections/posts");
    t.flush();
    expect(t.document.activeElement).toBe(t.dom.h1);
    expect(t.dom.h1.getAttribute("tabindex")).toBe("-1");
    expect(t.dom.h1.getAttribute("data-route-focus")).toBe("");
    expect(t.styles[0].textContent).toContain("[data-route-focus]:focus{outline:none}");
  });

  test("a list with no heading falls back to main; with neither it is a silent no-op", () => {
    const a = load();
    a.dom.main = a.make("MAIN");
    a.go("#/collections/posts");
    a.flush();
    expect(a.document.activeElement).toBe(a.dom.main);

    const b = load();
    b.go("#/collections/posts");
    expect(() => b.flush()).not.toThrow();
    expect(b.document.activeElement).toBe(b.body);
    // It gave up: the frame loop is bounded, not endless.
    expect(b.frames).toHaveLength(0);
  });

  test("waits for the new view to render, then moves focus once", () => {
    const t = load();
    t.go("#/collections/posts");
    t.flush(3);
    expect(t.document.activeElement).toBe(t.body);
    t.dom.h1 = t.make("H1");
    t.flush();
    expect(t.document.activeElement).toBe(t.dom.h1);
    expect(t.frames).toHaveLength(0);
  });

  test("a new entry goes to the first visible field inside a control, not a hidden or stray one", () => {
    const t = load({ hash: "#/collections/posts" });
    const { title, back } = t.withEditor();
    t.go("#/collections/posts/new");
    t.flush();
    expect(t.document.activeElement).toBe(title);
    expect(back.focused).toBeNull();
    // A text field already focuses natively: no tabindex or marker is added.
    expect(title.getAttribute("tabindex")).toBeNull();
    expect(title.getAttribute("data-route-focus")).toBeNull();
  });

  test("a new entry with no usable field falls back to the Back link", () => {
    const t = load();
    const { back } = t.withEditor();
    t.document.querySelector(EDITOR).fields = [];
    t.go("#/collections/posts/new");
    t.flush();
    expect(t.document.activeElement).toBe(back);
  });

  test("an existing entry goes to the toolbar Back link", () => {
    const t = load();
    const { back, title } = t.withEditor();
    t.go("#/collections/posts/entries/2026-01-01-hello");
    t.flush();
    expect(t.document.activeElement).toBe(back);
    expect(title.focused).toBeNull();
    // A link is natively focusable: not given a tabindex.
    expect(back.getAttribute("tabindex")).toBeNull();
  });

  test("focus already inside an input is never stolen, not even later in the poll", () => {
    const t = load();
    t.dom.h1 = t.make("H1");
    const input = t.make("INPUT");
    input.focus();
    t.go("#/collections/posts");
    t.flush();
    expect(t.document.activeElement).toBe(input);
    expect(t.dom.h1.focused).toBeNull();
  });

  test("when focus is lost partway through the poll it is restored; if another shim got there first it is left", () => {
    // Lost on frame 3: moved.
    const a = load();
    a.dom.h1 = a.make("H1");
    const input = a.make("INPUT");
    input.focus();
    a.go("#/collections/posts");
    a.flush(2);
    expect(a.document.activeElement).toBe(input);
    a.document.activeElement = a.body;
    a.flush();
    expect(a.document.activeElement).toBe(a.dom.h1);

    // Another shim focused a field between the hashchange and the first frame.
    const b = load();
    b.dom.h1 = b.make("H1");
    b.go("#/collections/posts");
    const field = b.make("INPUT");
    field.focus();
    b.flush();
    expect(b.document.activeElement).toBe(field);
    expect(b.dom.h1.focused).toBeNull();
  });

  test("a search route is left alone, and cancels a pending move", () => {
    const t = load();
    t.dom.h1 = t.make("H1");
    t.go("#/collections/posts");
    t.go("#/search/zebra?q=1");
    t.flush();
    expect(t.document.activeElement).toBe(t.body);
    expect(t.dom.h1.focused).toBeNull();
  });

  test("a Save click that disables the button restores focus to the Back link, after the validation-feedback settle", () => {
    const t = load({ hash: "#/collections/posts/entries/hello" });
    const { back } = t.withEditor();
    const save = t.make("BUTTON", { textContent: "Save" });
    save.focus();
    t.click(save);
    // Decap disables the focused Save button after the save: focus drops to body.
    save.disabled = true;
    t.document.activeElement = t.body;
    t.flush(6);
    expect(t.document.activeElement, "waits six frames before its first move").toBe(t.body);
    t.flush();
    expect(t.document.activeElement).toBe(back);
    expect(back.focused, "page is not scrolled back to the top").toEqual({ preventScroll: true });
  });

  test("it does not override the first invalid field validation-feedback.js focuses after a failed Save", () => {
    const t = load({ hash: "#/collections/posts/entries/hello" });
    const { back } = t.withEditor();
    const item = t.make("DIV", { attrs: { role: "menuitem" } });
    item.focus();
    t.keydown(item, "Enter");
    // The menu closed (item removed, focus on body); three frames later
    // validation-feedback focuses the bad field.
    item.isConnected = false;
    t.document.activeElement = t.body;
    const bad = t.make("INPUT");
    t.flush(3);
    bad.focus({ preventScroll: true });
    t.flush();
    expect(t.document.activeElement).toBe(bad);
    expect(back.focused).toBeNull();
  });

  test("a click on a control that is still there and enabled does not move focus", () => {
    const t = load({ hash: "#/collections/posts/entries/hello" });
    const { back } = t.withEditor();
    const save = t.make("BUTTON");
    t.click(save);
    t.flush();
    expect(t.document.activeElement).toBe(t.body);
    expect(back.focused).toBeNull();
  });

  test("a click from script is ignored, a trusted one on a removed control counts", () => {
    const t = load({ hash: "#/collections/posts/entries/hello" });
    const { back } = t.withEditor();
    const save = t.make("BUTTON", { isConnected: false });
    t.click(save, false);
    t.flush();
    expect(back.focused).toBeNull();
    t.click(save, true);
    t.flush();
    expect(t.document.activeElement).toBe(back);
  });

  test("Enter or Space on a menu item counts; a <button> is left to its own click", () => {
    const item = (t) => t.make("DIV", { attrs: { role: "menuitem" }, isConnected: false });
    const a = load({ hash: "#/collections/posts/entries/hello" });
    const { back } = a.withEditor();
    a.keydown(item(a), " ");
    a.flush();
    expect(a.document.activeElement).toBe(back);

    const b = load({ hash: "#/collections/posts/entries/hello" });
    const bb = b.withEditor();
    b.keydown(b.make("BUTTON", { isConnected: false }), "Enter");
    b.flush();
    expect(bb.back.focused, "the button's own click, which follows the keydown, is what counts").toBeNull();

    const c = load({ hash: "#/collections/posts/entries/hello" });
    const cc = c.withEditor();
    c.keydown(item(c), "a");
    c.flush();
    expect(cc.back.focused).toBeNull();
  });

  test("a key or pointer press after the click means the person took over: nothing moves", () => {
    const a = load({ hash: "#/collections/posts/entries/hello" });
    const ea = a.withEditor();
    a.click(a.make("BUTTON", { isConnected: false }));
    a.flush(2);
    a.keydown(a.make("INPUT"), "Tab");
    a.flush();
    expect(ea.back.focused).toBeNull();

    const b = load({ hash: "#/collections/posts/entries/hello" });
    const eb = b.withEditor();
    b.click(b.make("BUTTON", { isConnected: false }));
    b.flush(2);
    b.pointerdown();
    b.flush();
    expect(eb.back.focused).toBeNull();
  });

  test("the skip link never navigates (the hash is Decap's route) and focuses the content target", () => {
    const list = load({ hash: "#/collections/posts" });
    list.dom.h1 = list.make("H1");
    let prevented = 0;
    list.body.children[0].listeners.click({ preventDefault: () => prevented++ });
    expect(prevented).toBe(1);
    expect(list.document.activeElement).toBe(list.dom.h1);
    expect(list.sandbox.location.hash).toBe("#/collections/posts");

    // In an existing entry "content" is the form, not the Back link.
    const entry = load({ hash: "#/collections/posts/entries/hello" });
    const { title, back } = entry.withEditor();
    entry.body.children[0].listeners.click({ preventDefault() {} });
    expect(entry.document.activeElement).toBe(title);
    expect(back.focused).toBeNull();
  });

  test("the skip link falls back to the app container on a page with no main, and does nothing without one", () => {
    const a = load({ hash: "#/workflow" });
    a.dom.appMain = a.make("DIV");
    a.body.children[0].listeners.click({ preventDefault() {} });
    expect(a.document.activeElement).toBe(a.dom.appMain);

    const b = load({ hash: "#/workflow" });
    expect(() => b.body.children[0].listeners.click({ preventDefault() {} })).not.toThrow();
    expect(b.document.activeElement).toBe(b.body);
  });

  test("viewOf names the four views", () => {
    const { sandbox } = load();
    const v = sandbox.window.__routeFocus.viewOf;
    expect(v("#/collections/posts/new")).toBe("new");
    expect(v("#/collections/posts/entries/a-b")).toBe("entry");
    expect(v("#/collections/posts")).toBe("page");
    expect(v("#/collections/posts/filter/draft")).toBe("page");
    expect(v("#/search/zebra")).toBe("search");
    expect(v("")).toBe("page");
  });
});
