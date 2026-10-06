// @lane: local — pure-Node sandbox unit tests for theme/admin/mobile-preview-toggle.js
/*
 * cms-platform#645: below 768px admin-mobile.css hides react-split-pane's
 * `.Pane2`, so Decap's eye ("Toggle preview") toggled a pane that could never
 * show. mobile-preview-toggle.js turns the eye into a switch between the form
 * and a full-width preview (the `cms-mobile-preview` class on <html>), and
 * admin-mobile.css rule 13 keys off that class.
 *
 * The shim runs in a vm sandbox against a minimal fake DOM whose lookups are
 * keyed by the shim's own selector constants; the CSS is read with postcss, a
 * real parser. The browser behavior is locked in cms-mobile-layout.spec.js on
 * the webkit-iphone16 project.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const postcss = require("postcss");
const { test, expect } = require("./base");
const { fixedPositionEvidence, removeChildReceivers } = require("./admin-shim-rules");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SRC = fs.readFileSync(path.join(ADMIN, "mobile-preview-toggle.js"), "utf8");
const CSS = fs.readFileSync(path.join(ADMIN, "admin-mobile.css"), "utf8");

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
  };
}

function makeElement(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    id: "",
    type: "",
    textContent: "",
    children: [],
    parentNode: null,
    get firstChild() {
      return this.children[0] || null;
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(child);
      else el.children.splice(i, 0, child);
      return child;
    },
    querySelector(sel) {
      const id = sel.startsWith("#") ? sel.slice(1) : null;
      const walk = (n) => {
        for (const c of n.children) {
          if (id && c.id === id) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type) {
      for (const fn of listeners[type] || []) fn({ target: el });
    },
  };
  return el;
}

// Boots the shim with:
//   mobile        — whether matchMedia("(max-width: 768px)") matches
//   paneMounted   — whether Decap's preview pane is in the DOM at start
function boot({ mobile = true, paneMounted = true } = {}) {
  const state = { mobile, pane: null, pane2: null };
  const docListeners = {};
  const winListeners = {};
  let observerCallback = null;

  function mountPane() {
    state.pane2 = makeElement("div");
    state.pane = makeElement("div");
    state.pane2.appendChild(state.pane);
  }
  function unmountPane() {
    state.pane = null;
    state.pane2 = null;
  }
  if (paneMounted) mountPane();

  const documentElement = { classList: makeClassList() };
  const document = {
    documentElement,
    createElement: makeElement,
    addEventListener(type, fn, capture) {
      (docListeners[type] = docListeners[type] || []).push({ fn, capture });
    },
    querySelector(sel) {
      if (sel === api().PREVIEW_PANE_SELECTOR) return state.pane;
      return null;
    },
  };
  const window = {
    matchMedia: (q) => ({ matches: q === "(max-width: 768px)" && state.mobile }),
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
  };
  function MutationObserver(cb) {
    observerCallback = cb;
    return { observe() {} };
  }
  const sandbox = { window, document, MutationObserver };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  function api() {
    return window.__cmsMobilePreviewToggle;
  }

  const eye = { id: "eye" };
  const other = { id: "other" };
  // Dispatches a click whose target resolves (via closest) to `hit`, through
  // every capture listener, and reports whether the shim swallowed it.
  function click(hit) {
    const target = {
      closest: (sel) => (sel === api().TOGGLE_SELECTOR && hit === eye ? eye : null),
    };
    const ev = {
      target,
      stopped: false,
      prevented: false,
      stopPropagation() {
        this.stopped = true;
      },
      preventDefault() {
        this.prevented = true;
      },
    };
    for (const { fn, capture } of docListeners.click || []) {
      expect(capture, "the eye listener must run in the capture phase").toBe(true);
      fn(ev);
    }
    return ev;
  }

  return {
    state,
    api,
    eye,
    other,
    click,
    mountPane,
    unmountPane,
    mutate: () => observerCallback && observerCallback([]),
    hashchange: () => (winListeners.hashchange || []).forEach((fn) => fn({})),
    showing: () => documentElement.classList.contains(api().MODE_CLASS),
    bar: () => (state.pane2 ? state.pane2.querySelector("#" + api().BAR_ID) : null),
  };
}

test.describe("mobile-preview-toggle.js — shim behavior", () => {
  test("decide(): every state maps to one action", () => {
    const { decide } = boot().api();
    expect(decide({ mobile: false, showing: false, paneMounted: true })).toBe("pass");
    expect(decide({ mobile: false, showing: true, paneMounted: true })).toBe("pass");
    expect(decide({ mobile: true, showing: true, paneMounted: true })).toBe("exit");
    expect(decide({ mobile: true, showing: false, paneMounted: true })).toBe("enter");
    expect(decide({ mobile: true, showing: false, paneMounted: false })).toBe("enter-later");
  });

  test("Decap preview on (the default): the eye shows the preview, and the eye or Back returns", () => {
    const b = boot({ mobile: true, paneMounted: true });
    expect(b.showing()).toBe(false);

    const first = b.click(b.eye);
    expect(first.stopped, "the tap is taken so Decap keeps its preview mounted").toBe(true);
    expect(b.showing()).toBe(true);
    const bar = b.bar();
    expect(bar, "a back bar is added to the preview pane").not.toBeNull();
    expect(b.state.pane2.firstChild, "the bar sits above the preview").toBe(bar);
    const button = bar.children[0];
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("Back to editing");

    const second = b.click(b.eye);
    expect(second.stopped).toBe(true);
    expect(b.showing(), "a second eye tap returns to the form").toBe(false);

    b.click(b.eye);
    expect(b.showing()).toBe(true);
    expect(b.state.pane2.children.filter((c) => c.id === b.api().BAR_ID)).toHaveLength(1);
    button.fire("click");
    expect(b.showing(), "Back to editing returns to the form").toBe(false);
  });

  test("Decap preview off (stored false): the tap mounts the pane, then the preview shows", () => {
    const b = boot({ mobile: true, paneMounted: false });
    const ev = b.click(b.eye);
    expect(ev.stopped, "the tap must reach Decap so it mounts the pane").toBe(false);
    expect(b.showing(), "nothing to show until the pane exists").toBe(false);

    b.mutate();
    expect(b.showing()).toBe(false);

    b.mountPane();
    b.mutate();
    expect(b.showing()).toBe(true);
    expect(b.bar()).not.toBeNull();

    // Back in the form, the pane stays mounted, so the next tap is direct.
    b.click(b.eye);
    expect(b.showing()).toBe(false);
    const again = b.click(b.eye);
    expect(again.stopped).toBe(true);
    expect(b.showing()).toBe(true);
  });

  test("desktop widths leave the eye to Decap", () => {
    const b = boot({ mobile: false, paneMounted: true });
    const ev = b.click(b.eye);
    expect(ev.stopped).toBe(false);
    expect(ev.prevented).toBe(false);
    expect(b.showing()).toBe(false);
    expect(b.bar()).toBeNull();
  });

  test("other clicks are ignored", () => {
    const b = boot({ mobile: true, paneMounted: true });
    const ev = b.click(b.other);
    expect(ev.stopped).toBe(false);
    expect(b.showing()).toBe(false);
  });

  test("the preview view never outlives its pane, or the route", () => {
    const b = boot({ mobile: true, paneMounted: true });
    b.click(b.eye);
    expect(b.showing()).toBe(true);
    b.unmountPane();
    b.mutate();
    expect(b.showing(), "pane gone (another toggle, an unmount): back to the form").toBe(false);

    b.mountPane();
    b.click(b.eye);
    expect(b.showing()).toBe(true);
    b.hashchange();
    expect(b.showing(), "a route change resets to the form").toBe(false);
  });

  test("the shim adds no fixed overlay and removes nothing Decap owns (AST)", () => {
    expect(fixedPositionEvidence(SRC)).toEqual([]);
    expect(removeChildReceivers(SRC)).toEqual([]);
  });

  test("every admin shell loads it after decap-cms.js", () => {
    for (const f of ["index.html", "index-local.html", "index-test.html"]) {
      const html = fs.readFileSync(path.join(ADMIN, f), "utf8");
      const decap = html.indexOf("decap-cms");
      const mine = html.indexOf('<script src="mobile-preview-toggle.js" defer></script>');
      expect(mine, `${f} loads mobile-preview-toggle.js`).toBeGreaterThan(-1);
      expect(mine, `${f} loads it after decap-cms.js`).toBeGreaterThan(decap);
    }
  });
});

test.describe("admin-mobile.css — the preview view rules (postcss)", () => {
  const root = postcss.parse(CSS);
  const phone = [];
  const outside = [];
  root.walkRules((rule) => {
    const inPhone =
      rule.parent &&
      rule.parent.type === "atrule" &&
      rule.parent.name === "media" &&
      rule.parent.params.replace(/\s+/g, " ").trim() === "(max-width: 768px)";
    (inPhone ? phone : outside).push(rule);
  });
  const decl = (rule, prop) => {
    const all = rule.nodes.filter((n) => n.type === "decl" && n.prop === prop);
    return all[all.length - 1];
  };
  const ruleFor = (rules, selector) =>
    rules.find((r) => r.selectors.map((s) => s.replace(/\s+/g, " ")).includes(selector));

  // The selector strings are built from the shim's own constants, so a rename
  // on either side breaks this test rather than the phone.
  const { MODE_CLASS, BAR_ID } = boot().api();
  const ON = `html.${MODE_CLASS}`;

  test("preview view: the form pane steps aside", () => {
    const r = ruleFor(phone, `${ON} .SplitPane > .Pane1`);
    expect(r, "rule hiding .Pane1 in the preview view").toBeTruthy();
    expect(decl(r, "display").value).toBe("none");
    expect(decl(r, "display").important).toBe(true);
  });

  test("preview view: the preview pane shows at full width with a definite height", () => {
    const r = ruleFor(phone, `${ON} .SplitPane > .Pane2`);
    expect(r, "rule showing .Pane2 in the preview view").toBeTruthy();
    expect(decl(r, "display").value).not.toBe("none");
    expect(decl(r, "display").important).toBe(true);
    expect(decl(r, "width").value).toBe("100%");
    expect(decl(r, "width").important).toBe(true);
    expect(decl(r, "height").value).toMatch(/^100s?vh$/);
  });

  test("preview view: the back bar shows", () => {
    const r = ruleFor(phone, `${ON} #${BAR_ID}`);
    expect(r).toBeTruthy();
    expect(decl(r, "display").value).not.toBe("none");
    expect(decl(r, "display").important).toBe(true);
  });

  test("preview off: the phone layout keeps today's single-column form", () => {
    const r = ruleFor(phone, ".SplitPane .Pane2");
    expect(r, "rule 4 still hides the preview pane by default").toBeTruthy();
    expect(r.selectors).toContain(".Resizer");
    expect(decl(r, "display").value).toBe("none");
    expect(decl(r, "display").important).toBe(true);
    for (const rule of phone) {
      if (rule.selectors.some((s) => s.includes(".Pane1") && !s.includes(MODE_CLASS))) {
        const d = decl(rule, "display");
        expect(d && d.value, `${rule.selector} must not hide the form`).not.toBe("none");
      }
    }
  });

  test("desktop: no preview-view rule outside the phone breakpoint, and the bar is hidden", () => {
    const leaks = outside.filter((r) => r.selector.includes(`.${MODE_CLASS}`));
    expect(leaks.map((r) => r.selector)).toEqual([]);
    const bar = outside.find(
      (r) => r.selectors.includes(`#${BAR_ID}`) && r.parent.type === "root",
    );
    expect(bar, "a top-level rule hides the bar").toBeTruthy();
    expect(decl(bar, "display").value).toBe("none");
  });
});
