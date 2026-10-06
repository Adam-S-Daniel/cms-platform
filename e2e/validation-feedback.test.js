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

function fakeEl(props = {}) {
  const el = {
    attrs: {},
    style: {},
    children: [],
    removed: false,
    scrolled: null,
    ...props,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    remove() {
      this.removed = true;
    },
    scrollIntoView(opts) {
      this.scrolled = opts;
    },
    appendChild(c) {
      this.children.push(c);
    },
  };
  return el;
}

// A click target that answers closest() the way the browser does for a button.
function button(text) {
  const b = fakeEl({ textContent: text });
  b.closest = () => b;
  return b;
}

function load({ phrase = DECAP_DEFAULT, hasGetLocale = true, errors = [], decapToast = false } = {}) {
  const widget = { regexPattern: phrase, required: "%{fieldLabel} is required." };
  const en = { editor: { editorControlPane: { widget } } };
  const frames = [];
  const listeners = {};
  const toasts = [];
  const styles = [];
  const errorEls = errors.map((t) => fakeEl({ textContent: t }));
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
      if (sel.includes("Toastify")) return decapToast ? fakeEl() : null;
      if (sel.includes("data-validation-feedback-toast")) return toasts.filter((t) => !t.removed)[0] || null;
      return null;
    },
    querySelectorAll(sel) {
      return sel.includes("ControlErrorsList") ? errorEls : [];
    },
  };
  const sandbox = {
    window: {
      CMS: hasGetLocale ? { getLocale: (l) => (l === "en" ? en : undefined) } : {},
      requestAnimationFrame: (fn) => frames.push(fn),
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
  const click = (target) => {
    listeners.click.fn({ target });
    flush();
  };
  return { widget, listeners, toasts, styles, errorEls, click };
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
    expect(t.errorEls[0].scrolled).toEqual({ block: "center", behavior: "smooth" });
    expect(t.errorEls[1].scrolled, "only the first error is scrolled to").toBeNull();
    expect(t.toasts).toHaveLength(1);
    expect(t.toasts[0].textContent).toBe(
      "Not saved yet. Permalink: Must start and end with a slash (not just /pages/) (1 more below.)",
    );
    expect(t.toasts[0].attrs.role).toBe("alert");
  });

  test("Publish now gets the same feedback; a single error has no 'more' count", () => {
    const t = load({ errors: ["Article URL: Must be a valid http(s) URL"] });
    t.click(button("Publish now"));
    expect(t.toasts[0].textContent).toBe("Not saved yet. Article URL: Must be a valid http(s) URL");
  });

  test("when Decap raised its own toast there is no second one (the scroll still happens)", () => {
    const t = load({ errors: ["Content is required."], decapToast: true });
    t.click(button("Save"));
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
});
