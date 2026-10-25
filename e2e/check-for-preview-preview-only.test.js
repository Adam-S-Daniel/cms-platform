// @lane: local — pure-Node behavioral test for native-preview-href.js (vm sandbox, fake DOM)
/*
 * #642: Decap's "Check for Preview" button waits for the `deploy/preview`
 * commit status deploy-preview.yml sets — and that workflow builds only PRs
 * into the default branch. A draft saved on a preview admin opens a PR into
 * the preview's own branch (`cms/preview-only`), so the button spun on every
 * click forever. When the poller reports the entry's PR as previewOnly, the
 * button is CSS-hidden and a pointer to Live Preview stands in for it; any
 * other entry gets the button back.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/native-preview-href.js"), "utf8");
const ENTRY = { collection: "posts", slug: "2026-09-28-hello" };

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.attrs = {};
    this.props = {};
    this.id = "";
    this.parentNode = null;
    this.children = [];
    const self = this;
    this.style = {
      display: "",
      setProperty(name, value) {
        self.props[name] = value;
        if (name === "display") this.display = value;
      },
      removeProperty(name) {
        delete self.props[name];
        if (name === "display") this.display = "";
      },
      getPropertyValue: (name) => self.props[name] || "",
    };
  }
  getAttribute(n) {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
  }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
  }
  removeAttribute(n) {
    delete this.attrs[n];
  }
  get previousSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  get nextSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    const i = sibs.indexOf(this);
    return i >= 0 && i < sibs.length - 1 ? sibs[i + 1] : null;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(node);
    else this.children.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    this.children.splice(this.children.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
}

function load({ facts, snapEntry = ENTRY, routeEntry = ENTRY, liveLinkDisplay = "" } = {}) {
  const container = new FakeEl("div");
  const button = new FakeEl("button");
  container.insertBefore(button, null);
  const liveLink = new FakeEl("a");
  liveLink.id = "live-preview-link";
  liveLink.setAttribute("href", "/preview/?collection=posts");
  liveLink.style.display = liveLinkDisplay;
  const byId = () => [liveLink, ...container.children].reduce((m, el) => ((m[el.id] = el), m), {});
  const snapshot = { ready: true, entry: snapEntry, facts, prNumber: 4076 };
  const window = {
    CMSPublishProgress: {
      get: () => snapshot,
      subscribe() {},
      currentEntry: () => routeEntry,
    },
    addEventListener() {},
  };
  const sandbox = {
    window,
    document: {
      body: {},
      hidden: false,
      // The shim listens for visibilitychange (#644).
      addEventListener() {},
      getElementById: (id) => byId()[id] || null,
      createElement: (tag) => new FakeEl(tag),
      querySelectorAll: (sel) => (sel === '[class*="RefreshPreviewButton"]' && button.parentNode ? [button] : []),
    },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    console: { info() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const hook = window.__nativePreviewHref;
  expect(hook && typeof hook.syncCheckForPreview, "native-preview-href.js must expose syncCheckForPreview").toBe(
    "function",
  );
  return { hook, button, container, snapshot };
}

const pointerIn = (container) => container.children.find((el) => el.id === "cms-live-preview-pointer");

test.describe('native-preview-href.js: "Check for Preview" on a preview-only draft (#642)', () => {
  test("preview-only PR → the button is CSS-hidden and Live Preview is offered in its place", () => {
    const { hook, button, container } = load({ facts: { hasOpenPr: true, previewOnly: true } });
    hook.syncCheckForPreview();
    expect(button.props.display).toBe("none");
    expect(button.getAttribute("aria-hidden")).toBe("true");
    expect(button.parentNode, "never removed — React owns it").toBe(container);
    const pointer = pointerIn(container);
    expect(pointer, "a pointer to Live Preview stands in for the button").toBeTruthy();
    expect(pointer.getAttribute("href")).toBe("/preview/?collection=posts");
    expect(pointer.textContent).toContain("Live Preview");
    expect(pointer.previousSibling).toBe(button);
  });

  test("a PR into the default branch keeps Decap's button", () => {
    const { hook, button, container } = load({ facts: { hasOpenPr: true, previewOnly: false } });
    hook.syncCheckForPreview();
    expect(button.props.display).toBeUndefined();
    expect(pointerIn(container)).toBeUndefined();
  });

  test("the poller's answer for a different entry decides nothing", () => {
    const { hook, button } = load({
      facts: { hasOpenPr: true, previewOnly: true },
      snapEntry: { collection: "posts", slug: "2026-01-01-other" },
    });
    hook.syncCheckForPreview();
    expect(button.props.display).toBeUndefined();
  });

  test("moving to an entry whose PR gets a preview restores the button and drops the pointer", () => {
    const { hook, button, container, snapshot } = load({ facts: { hasOpenPr: true, previewOnly: true } });
    hook.syncCheckForPreview();
    snapshot.facts = { hasOpenPr: true, previewOnly: false };
    hook.syncCheckForPreview();
    expect(button.props.display).toBeUndefined();
    expect(button.getAttribute("aria-hidden")).toBe(null);
    expect(pointerIn(container)).toBeUndefined();
  });

  test("with Live Preview not offered for this entry, the button is still hidden but no pointer is added", () => {
    const { hook, button, container } = load({
      facts: { hasOpenPr: true, previewOnly: true },
      liveLinkDisplay: "none",
    });
    hook.syncCheckForPreview();
    expect(button.props.display).toBe("none");
    expect(pointerIn(container)).toBeUndefined();
  });

  test("a repeated pass writes nothing new (no observer feedback loop)", () => {
    const { hook, container } = load({ facts: { hasOpenPr: true, previewOnly: true } });
    hook.syncCheckForPreview();
    const before = container.children.slice();
    hook.syncCheckForPreview();
    expect(container.children).toEqual(before);
  });
});
