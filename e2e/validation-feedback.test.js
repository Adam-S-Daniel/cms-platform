// @lane: local — pure-Node behavioral test for validation-feedback.js (vm sandbox)
/*
 * cms-platform#730: a field `pattern` failure blocks Save and Publish, but
 * Decap raises its toast only for a missing value, and its `regexPattern`
 * phrase wraps the site's own message as "<LABEL> DIDN'T MATCH THE PATTERN:
 * <message>." (upper-cased by Decap's styling, with a doubled period).
 * validation-feedback.js (1) replaces that phrase so the site's message shows
 * alone, (2) turns the upper-casing off, (3) scrolls to the first error and
 * toasts when a Save/Publish click leaves a field error and Decap raised no
 * toast of its own.
 *
 * The Decap phrase string asserted below is Decap's own English default,
 * verified in the decap-cms 3.15.1 bundle.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM = fs.readFileSync(path.resolve(__dirname, "../theme/admin/validation-feedback.js"), "utf8");
const DECAP_DEFAULT = "%{fieldLabel} didn't match the pattern: %{pattern}.";

// The toast's message: its first child, ahead of the close button.
const messageOf = (toast) => toast.children[0].textContent;

function fakeEl(props = {}) {
  const el = {
    attrs: {},
    style: {},
    children: [],
    className: "",
    removed: false,
    scrolled: null,
    clicked: 0,
    listeners: {},
    ...props,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    remove() {
      this.removed = true;
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    // A button's own click(): runs its listener, as the DOM does.
    click() {
      this.clicked++;
      if (this.listeners.click) this.listeners.click({ target: this });
    },
    querySelector(sel) {
      return (this.found || {})[sel] || null;
    },
    matches(sel) {
      return sel === this.isRow;
    },
    closest(sel) {
      return (this.ancestors || {})[sel] || null;
    },
    scrollIntoView(opts) {
      this.scrolled = opts;
    },
    appendChild(c) {
      this.children.push(c);
    },
    getAttribute(k) {
      return this.attrs[k] === undefined ? null : this.attrs[k];
    },
    querySelectorAll(sel) {
      return sel === "li" ? this.items || [] : [];
    },
  };
  return el;
}

// A click target that answers closest() the way the browser does for a button.
function button(text, attrs = {}) {
  const b = fakeEl({ textContent: text });
  Object.assign(b.attrs, attrs);
  b.closest = () => b;
  return b;
}

const ROW = '[class*="SortableListItem"]';
const ROW_LABEL = '[class*="NestedObjectLabel"]';
const ROW_TOGGLE = '[class*="StyledListItemTopBar"] button';
const CONTROL = '[class*="ControlContainer"]';

// A Decap toast as react-toastify marks it; `error` is the red variant.
const MISSING_EN = "Oops, you've missed a required field. Please complete before saving.";
const MISSING_DE = "Oops, einige zwingend erforderliche Felder sind nicht ausgef\u00fcllt.";
const decapToastEl = (textContent = MISSING_EN) =>
  fakeEl({ className: "Toastify__toast Toastify__toast--error", textContent });

function load({
  phrase = DECAP_DEFAULT,
  hasGetLocale = true,
  errors = [],
  staleDecapToast = false,
  staleText,
  coarsePointer = false,
  innerHeight,
} = {}) {
  const widget = { regexPattern: phrase, required: "%{fieldLabel} is required." };
  const en = { editor: { editorControlPane: { widget } }, ui: { toast: { missingRequiredField: MISSING_EN } } };
  const de = { ui: { toast: { missingRequiredField: MISSING_DE } } };
  const frames = [];
  const listeners = {};
  const toasts = [];
  const styles = [];
  // An entry is one error list: a string, or an array of <li> texts (which
  // the real DOM's textContent runs together with no separator).
  const errorEls = errors.map((t) =>
    Array.isArray(t)
      ? fakeEl({ textContent: t.join(""), items: t.map((x) => fakeEl({ textContent: x })) })
      : fakeEl({ textContent: t }),
  );
  // Decap's toasts on screen. One left over from an earlier click is here
  // before the click; one the click raised is pushed during it.
  const decapToasts = staleDecapToast ? [decapToastEl(staleText)] : [];
  const stale = decapToasts[0];
  if (stale) {
    stale.found = { '[class*="Toastify__close-button"]': fakeEl() };
  }
  const body = fakeEl();
  body.appendChild = (c) => {
    toasts.push(c);
  };
  const head = fakeEl();
  head.appendChild = (c) => styles.push(c);
  const document = {
    head,
    body,
    createElement: () => fakeEl(),
    addEventListener(type, fn, capture) {
      listeners[type] = { fn, capture };
    },
    querySelector(sel) {
      if (sel.includes("Toastify")) return decapToasts[0] || null;
      if (sel.includes("data-validation-feedback-toast")) return toasts.filter((t) => !t.removed)[0] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes("Toastify")) return decapToasts;
      return sel.includes("ControlErrorsList") ? errorEls : [];
    },
  };
  const sandbox = {
    window: {
      CMS: hasGetLocale ? { getLocale: (l) => ({ en, de })[l] } : {},
      requestAnimationFrame: (fn) => frames.push(fn),
      matchMedia: (q) => ({ matches: coarsePointer && /pointer:\s*coarse/.test(q) }),
      innerHeight,
    },
    document,
    setTimeout: () => 1,
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM, sandbox);
  // Run the queued animation frames to completion (deterministic: no clock).
  const flush = () => {
    let guard = 20;
    while (frames.length && guard--) frames.shift()();
  };
  // `during` runs after the shim saw the click and before Decap's re-render
  // settles: where a toast the click raised would appear.
  const click = (target, during) => {
    listeners.click.fn({ target });
    if (during) during();
    flush();
  };
  const raiseDecapToast = () => decapToasts.push(decapToastEl());
  const addDecapToast = (text, extra = {}) => {
    const el = decapToastEl(text);
    Object.assign(el, extra);
    el.found = { '[class*="Toastify__close-button"]': fakeEl() };
    decapToasts.push(el);
    return el;
  };
  // The state Decap's re-render leaves behind: what a later click will see.
  const setErrors = (next) => {
    errorEls.length = 0;
    next.forEach((t) => errorEls.push(fakeEl({ textContent: t })));
  };
  return { widget, listeners, toasts, styles, errorEls, click, setErrors, decapToasts, stale, raiseDecapToast, addDecapToast };
}

test.describe("validation-feedback.js (#730)", () => {
  test("replaces Decap's regexPattern phrase so the site's message shows alone", () => {
    const { widget } = load();
    expect(widget.regexPattern).toBe("%{fieldLabel}: %{pattern}");
    expect(widget.regexPattern).not.toMatch(/match the pattern/i);
    expect(widget.required, "other phrases stay as Decap wrote them").toBe("%{fieldLabel} is required.");
  });

  test("a locale shape it does not recognize is left alone, without throwing", () => {
    expect(() => load({ hasGetLocale: false })).not.toThrow();
    const { widget } = load({ phrase: 42 });
    expect(widget.regexPattern).toBe(42);
  });

  test("turns off the upper-casing on field error lists", () => {
    const { styles } = load();
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toMatch(/ControlErrorsList/);
    expect(styles[0].textContent).toMatch(/text-transform:\s*none/);
  });

  test("listens for clicks in the capture phase", () => {
    expect(load().listeners.click.capture).toBe(true);
  });

  test("Save with a field error scrolls to the first error and toasts its message", () => {
    const t = load({
      errors: ["Permalink: Must start and end with a slash (not just /pages/)", "Slug: Use lowercase letters only."],
    });
    t.click(button("Save"));
    // Instant, so the toast can be placed against where the field ends up.
    expect(t.errorEls[0].scrolled).toEqual({ block: "center", behavior: "auto" });
    expect(t.errorEls[1].scrolled, "only the first error is scrolled to").toBeNull();
    expect(t.toasts).toHaveLength(1);
    expect(messageOf(t.toasts[0])).toBe(
      "Not saved yet. Permalink: Must start and end with a slash (not just /pages/) (1 more below.)",
    );
    expect(t.toasts[0].attrs.role).toBe("alert");
  });

  test("Publish now gets the same feedback; a single error has no 'more' count", () => {
    const t = load({ errors: ["Article URL: Must be a valid http(s) URL"] });
    t.click(button("Publish now"));
    expect(messageOf(t.toasts[0])).toBe("Not saved yet. Article URL: Must be a valid http(s) URL");
  });

  test("when Decap raised its own toast there is no second one (the scroll still happens)", () => {
    const t = load({ errors: ["Content is required."] });
    t.click(button("Save"), t.raiseDecapToast);
    expect(t.toasts).toHaveLength(0);
    expect(t.errorEls[0].scrolled).not.toBeNull();
  });

  test("a successful save (no error lists) does nothing", () => {
    const t = load({ errors: [] });
    t.click(button("Save"));
    expect(t.toasts).toHaveLength(0);
  });

  test("clicks on other controls do nothing", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Delete entry"));
    t.click(button("Saved drafts"));
    expect(t.toasts).toHaveLength(0);
    expect(t.errorEls[0].scrolled).toBeNull();
  });

  test("it waits for Decap to re-render before looking (no answer on the click itself)", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.listeners.click.fn({ target: button("Save") });
    expect(t.toasts, "nothing before the frames run").toHaveLength(0);
  });

  test("a toast from a blocked save is removed when the next save goes through", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Save"));
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0].removed).toBe(false);
    t.setErrors([]); // the editor fixed the field; Decap re-renders without the list
    t.click(button("Save"));
    expect(t.toasts[0].removed, "the stale 'Not saved yet' must be gone").toBe(true);
    expect(t.toasts, "and no new one appears").toHaveLength(1);
  });

  test("opening the toolbar's Publish menu (aria-haspopup) is not a publish attempt", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Publish", { "aria-haspopup": "true", role: "button" }));
    expect(t.toasts).toHaveLength(0);
    expect(t.errorEls[0].scrolled).toBeNull();
    // ... while the menu item inside it still is.
    t.click(button("Publish now", { role: "menuitem" }));
    expect(t.toasts).toHaveLength(1);
  });

  test("several messages on one field are read apart, as separate sentences", () => {
    const t = load({ errors: [["Slug: Use lowercase letters only.", "Slug: Keep it short"]] });
    t.click(button("Save"));
    expect(messageOf(t.toasts[0])).toBe("Not saved yet. Slug: Use lowercase letters only. Slug: Keep it short.");
  });

  // ── cms-platform#750 ────────────────────────────────────────────────────

  // A list row as Decap draws it: its summary (kept in the DOM, shown only
  // while the row is collapsed) and its expand/collapse button.
  function row({ summary, collapsed = false }) {
    const toggle = fakeEl();
    const label = fakeEl({ textContent: summary, offsetParent: collapsed ? {} : null });
    return { el: fakeEl({ isRow: ROW, found: { [ROW_LABEL]: label, [ROW_TOGGLE]: toggle } }), toggle };
  }
  // Rows side by side under one parent, as in the browser; `outer` is the row
  // the parent sits inside, for a list within a list.
  function listOf(rows, outer) {
    const parent = fakeEl({ children: rows.map((r) => r.el), ancestors: outer ? { [ROW]: outer.el } : {} });
    rows.forEach((r) => (r.el.parentElement = parent));
    return parent;
  }

  test("a field inside a list row names the row by position and summary", () => {
    const rows = [row({ summary: "Alpha" }), row({ summary: "Beta" })];
    listOf(rows);
    const t = load({ errors: ["URL: http(s) or mailto URL."] });
    t.errorEls[0].ancestors = { [ROW]: rows[1].el };
    t.click(button("Publish now"));
    expect(messageOf(t.toasts[0])).toBe("Not saved yet. Item 2 (Beta): URL: http(s) or mailto URL.");
  });

  test("a row with no summary is named by its position alone", () => {
    const rows = [row({ summary: "  " }), row({ summary: "" })];
    listOf(rows);
    const t = load({ errors: ["URL: bad."] });
    t.errorEls[0].ancestors = { [ROW]: rows[0].el };
    t.click(button("Save"));
    expect(messageOf(t.toasts[0])).toBe("Not saved yet. Item 1: URL: bad.");
  });

  test("a row inside a row is named outermost first", () => {
    const outer = row({ summary: "Links" });
    listOf([outer]);
    const inner = [row({ summary: "A" }), row({ summary: "B" })];
    listOf(inner, outer);
    const t = load({ errors: ["URL: bad."] });
    t.errorEls[0].ancestors = { [ROW]: inner[1].el };
    t.click(button("Save"));
    expect(messageOf(t.toasts[0])).toBe("Not saved yet. Item 1 (Links) > Item 2 (B): URL: bad.");
  });

  test("a field outside any list row gets no row prefix", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Save"));
    expect(messageOf(t.toasts[0])).toBe("Not saved yet. Permalink: bad");
  });

  test("a collapsed row is opened so the field is on screen; an open row is left alone", () => {
    const rows = [row({ summary: "Alpha", collapsed: true }), row({ summary: "Beta", collapsed: false })];
    listOf(rows);
    const t = load({ errors: ["URL: bad."] });
    t.errorEls[0].ancestors = { [ROW]: rows[0].el };
    t.click(button("Save"));
    expect(rows[0].toggle.clicked, "the collapsed row's own toggle is clicked once").toBe(1);
    expect(rows[1].toggle.clicked).toBe(0);
    // ... and only after it is open is the field scrolled to.
    expect(t.errorEls[0].scrolled).not.toBeNull();
  });

  test("the toast lets clicks through, and only its close button takes one", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Save"));
    const [text, close] = t.toasts[0].children;
    expect(t.toasts[0].style.cssText).toMatch(/pointer-events:none/);
    expect(text.textContent).toContain("Permalink: bad");
    expect(close.attrs["aria-label"]).toBe("Dismiss");
    expect(close.style.cssText).toMatch(/pointer-events:auto/);
    expect(t.toasts[0].removed).toBe(false);
    close.click();
    expect(t.toasts[0].removed, "the close button removes it").toBe(true);
  });

  test("the toast sits on the screen edge the field is not near", () => {
    const at = (top, height) => {
      const t = load({ errors: ["Permalink: bad"], innerHeight: 800 });
      const control = fakeEl({ getBoundingClientRect: () => ({ top, height }) });
      t.errorEls[0].ancestors = { [CONTROL]: control };
      t.click(button("Save"));
      return t.toasts[0].style.cssText;
    };
    expect(at(700, 60), "last field, low on the screen").toMatch(/top:12px/);
    expect(at(700, 60)).not.toMatch(/bottom:/);
    expect(at(370, 60), "centered").toMatch(/bottom:24px/);
    expect(at(40, 60), "first field, high on the screen").toMatch(/bottom:24px/);
  });

  test("with no measurable field the toast keeps the bottom edge", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Save"));
    expect(t.toasts[0].style.cssText).toMatch(/bottom:24px/);
  });

  test("a Decap toast left over from an earlier click does not hide a format error", () => {
    // 'Oops, you missed a required field' from an empty Save lives 8 s; a
    // retry inside that time must still be told about the bad format.
    const t = load({ errors: ["Start date: Use YYYY-MM-DD"], staleDecapToast: true });
    const close = t.stale.found['[class*="Toastify__close-button"]'];
    t.click(button("Publish now"));
    expect(t.toasts).toHaveLength(1);
    expect(messageOf(t.toasts[0])).toBe("Not saved yet. Start date: Use YYYY-MM-DD");
    expect(close.clicked, "and the stale 'missed a required field' toast is closed").toBe(1);
  });

  test("a stale Decap toast stays when this click raised one of its own", () => {
    const t = load({ errors: ["Content is required."], staleDecapToast: true });
    const close = t.stale.found['[class*="Toastify__close-button"]'];
    t.click(button("Publish now"), t.raiseDecapToast);
    expect(t.toasts).toHaveLength(0);
    expect(close.clicked).toBe(0);
  });

  test("a stale Decap toast that is not an error is left open", () => {
    const t = load({ errors: ["Permalink: bad"], staleDecapToast: true });
    t.stale.className = "Toastify__toast Toastify__toast--success";
    const close = t.stale.found['[class*="Toastify__close-button"]'];
    t.click(button("Save"));
    expect(t.toasts).toHaveLength(1);
    expect(close.clicked).toBe(0);
  });

  // ── cms-platform#752 ────────────────────────────────────────────────────

  test("only the stale 'missed a required field' toast is closed; an unrelated error toast stays", () => {
    // 'Logged out' and 'backend unavailable' notices are persistent and may
    // not have been read; a format-error Save must not dismiss them.
    const t = load({ errors: ["Start date: Use YYYY-MM-DD"], staleDecapToast: true });
    const other = t.addDecapToast("You have been logged out. Please log in again.");
    const missingClose = t.stale.found['[class*="Toastify__close-button"]'];
    const otherClose = other.found['[class*="Toastify__close-button"]'];
    t.click(button("Save"));
    expect(t.toasts).toHaveLength(1);
    expect(missingClose.clicked, "the stale missing-field toast is closed").toBe(1);
    expect(otherClose.clicked, "the unrelated error toast is left open").toBe(0);
  });

  test("a stale missing-field toast in the site's configured locale is closed too", () => {
    const t = load({ errors: ["Start date: Use YYYY-MM-DD"], staleDecapToast: true, staleText: MISSING_DE });
    const close = t.stale.found['[class*="Toastify__close-button"]'];
    t.click(button("Save"));
    expect(t.toasts).toHaveLength(1);
    expect(close.clicked).toBe(1);
  });

  test("an error toast in a locale it cannot read is left open", () => {
    const t = load({ errors: ["Start date: Use YYYY-MM-DD"], staleDecapToast: true, staleText: "Unrecognized wording" });
    const close = t.stale.found['[class*="Toastify__close-button"]'];
    t.click(button("Save"));
    expect(t.toasts).toHaveLength(1);
    expect(close.clicked).toBe(0);
  });

  test("with no readable locale API no stale toast is closed (and nothing throws)", () => {
    const t = load({ errors: ["Start date: Use YYYY-MM-DD"], staleDecapToast: true, hasGetLocale: false });
    const close = t.stale.found['[class*="Toastify__close-button"]'];
    t.click(button("Save"));
    expect(t.toasts).toHaveLength(1);
    expect(close.clicked).toBe(0);
  });

  test("the Dismiss button is at least 24 x 24, and 44 x 44 on a touch screen", () => {
    const sizeOf = (coarsePointer) => {
      const t = load({ errors: ["Permalink: bad"], coarsePointer });
      t.click(button("Save"));
      const css = t.toasts[0].children[1].style.cssText;
      return [Number(/min-width:(\d+)px/.exec(css)[1]), Number(/min-height:(\d+)px/.exec(css)[1])];
    };
    expect(sizeOf(false)).toEqual([24, 24]);
    expect(sizeOf(true)).toEqual([44, 44]);
  });

  test("the close glyph is aria-hidden, so the alert reads as its message alone", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Save"));
    const close = t.toasts[0].children[1];
    expect(close.attrs["aria-label"]).toBe("Dismiss");
    expect(close.textContent, "no bare glyph text on the button").toBeUndefined();
    expect(close.children).toHaveLength(1);
    expect(close.children[0].textContent).toBe("\u00d7");
    expect(close.children[0].attrs["aria-hidden"]).toBe("true");
  });

  test("the toast is centered by auto margins, not left:50% (which halved its width on a phone)", () => {
    const t = load({ errors: ["Permalink: bad"] });
    t.click(button("Save"));
    const css = t.toasts[0].style.cssText;
    expect(css).not.toMatch(/left:50%/);
    expect(css).not.toMatch(/translateX/);
    expect(css).toMatch(/left:0;right:0;margin:0 auto;width:fit-content/);
  });
});
