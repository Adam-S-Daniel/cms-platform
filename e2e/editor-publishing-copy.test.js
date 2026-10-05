// @lane: local — runtime copy checks plus parsed Decap config contracts.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ROOT = path.resolve(__dirname, "..");
const ADMIN = path.join(ROOT, "theme", "admin");
const CONFIGS = ["config.base.yml", "config-local.base.yml", "config-test.yml"];

const POST_PUBLISHED_HINT =
  "Turn on to show this post on {{CMS_CURRENT_HOST}} when you select Publish. " +
  "Leave off to keep it as a draft or schedule it with Publish Date below.";
const POST_DATE_HINT =
  "Optional. Choose a future date and time (UTC) to publish this post automatically on {{CMS_CURRENT_HOST}}. " +
  "Only honored when Published is off.";
const PAGE_PUBLISHED_HINT =
  "Turn on to show this page on {{CMS_CURRENT_HOST}} when you select Publish. " +
  "Leave off to keep it as a draft.";
const CONTENT_PUBLISHED_HINT =
  "Turn on to show this content on {{CMS_CURRENT_HOST}} when you select Publish. " +
  "Leave off to keep it as a draft or schedule it with Publish Date below.";
const CONTENT_DATE_HINT =
  "Optional. Choose a future date and time to publish this content automatically on {{CMS_CURRENT_HOST}}. " +
  "Only honored when Published is off.";

class FakeStyle {
  constructor() {
    this.values = new Map();
    this.priorities = new Map();
    this.writeCount = 0;
  }
  set cssText(value) {
    this.values.clear();
    for (const part of String(value).split(";")) {
      const at = part.indexOf(":");
      if (at > 0) this.values.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
  }
  get cssText() {
    return [...this.values].map(([k, v]) => `${k}:${v}`).join(";");
  }
  getPropertyValue(name) {
    return this.values.get(name) || "";
  }
  getPropertyPriority(name) {
    return this.priorities.get(name) || "";
  }
  setProperty(name, value, priority = "") {
    this.writeCount += 1;
    this.values.set(name, String(value));
    this.priorities.set(name, String(priority));
  }
  removeProperty(name) {
    this.writeCount += 1;
    this.priorities.delete(name);
    return this.values.delete(name);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.className = "";
    this.disabled = false;
    this.id = "";
    this._text = "";
  }
  get isConnected() {
    return Boolean(this.parentElement);
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = value == null ? "" : String(value);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, reference) {
    child.parentElement = this;
    const at = reference ? this.children.indexOf(reference) : -1;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentElement = null;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  addEventListener() {}
}

function findById(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function loadEditorCopy({ hash = "#/collections/posts/entries/a", saveDisabled = false, hasOpenPr = true } = {}) {
  const intervals = [];
  const doc = {
    readyState: "complete",
    body: {},
    documentElement: {},
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    addEventListener() {},
  };
  const root = new FakeElement("div", doc);
  const toolbar = new FakeElement("div", doc);
  const save = new FakeElement("button", doc);
  save.disabled = saveDisabled;
  root.appendChild(toolbar);
  // Decap's toolbar status ("Changes saved"), a sibling of the toolbar here.
  const savedStatus = new FakeElement("div", doc);
  savedStatus.className = "css-1-BackStatusUnchanged";
  savedStatus.textContent = "Changes saved";
  root.appendChild(savedStatus);
  doc.getElementById = (id) => findById(root, id);
  doc.querySelector = (selector) => {
    if (selector === 'button[class*="SaveButton"]') return save;
    if (selector === '[class*="oolbar"]') return toolbar;
    return null;
  };
  doc.querySelectorAll = (selector) => (selector === '[class*="BackStatus"]' ? [savedStatus] : []);

  const sandbox = {
    window: {
      location: { hash },
      addEventListener() {},
      CMSPublishProgress: {
        get: () => ({
          ready: true,
          facts: {
            hasOpenPr,
            armed: false,
            checksFailed: false,
            awaitingReviewGate: false,
            mergeConflict: false,
          },
        }),
        subscribe() {},
      },
    },
    document: doc,
    MutationObserver: class {
      observe() {}
    },
    setInterval(fn) {
      intervals.push(fn);
      return intervals.length;
    },
    setTimeout() {},
    fetch() {
      throw new Error("fetch must not run while Publish is disabled");
    },
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ADMIN, "publish-step-hint.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ADMIN, "publish-button.js"), "utf8"), sandbox);
  return {
    doc,
    intervals,
    savedStatus,
    setHash: (value) => {
      sandbox.window.location.hash = value;
    },
  };
}

function collection(config, name) {
  return (config.collections || []).find((item) => item && item.name === name);
}

function field(parent, name) {
  return (parent.fields || []).find((item) => item && item.name === name);
}

test.describe("editor publishing copy", () => {
  test("unsaved work has one instruction, no duplicate badge, and a disabled Publish button", () => {
    const { doc, intervals } = loadEditorCopy();
    const badge = doc.getElementById("cms-publish-state-badge");
    const detail = doc.getElementById("cms-publish-state-text");
    const slot = doc.getElementById("cms-publish-state-actions");

    expect(badge.textContent).toBe("");
    expect(badge.style.getPropertyValue("display")).toBe("none");
    expect(detail.textContent).toBe("Save your changes to enable Publish.");
    expect(slot.children).toHaveLength(1);
    expect(slot.children[0].tagName).toBe("BUTTON");
    expect(slot.children[0].textContent).toBe("Publish");
    expect(slot.children[0].disabled).toBe(true);

    const badgeWrites = badge.style.writeCount;
    for (const tick of intervals) tick();
    expect(badge.style.writeCount, "steady renders must not feed the observer").toBe(badgeWrites);
  });


  // #625 item 2: a brand-new entry that has never been saved must not wear
  // the green "Changes saved" status.
  test("a never-saved new entry does not show the saved status; a saved entry still does", () => {
    const fresh = loadEditorCopy({ hash: "#/collections/media/new", saveDisabled: true });
    expect(fresh.savedStatus.style.getPropertyValue("visibility")).toBe("hidden");
    const writes = fresh.savedStatus.style.writeCount;
    for (const tick of fresh.intervals) tick();
    expect(fresh.savedStatus.style.writeCount, "steady renders must not feed the observer").toBe(writes);

    const saved = loadEditorCopy({ hash: "#/collections/media/entries/a", saveDisabled: true });
    expect(saved.savedStatus.style.getPropertyValue("visibility")).not.toBe("hidden");
  });

  test("the saved status comes back once the entry has a saved route", () => {
    const ctx = loadEditorCopy({ hash: "#/collections/media/new?x=1", saveDisabled: true });
    expect(ctx.savedStatus.style.getPropertyValue("visibility")).toBe("hidden");
    ctx.setHash("#/collections/media/entries/my-item");
    for (const tick of ctx.intervals) tick();
    expect(ctx.savedStatus.style.getPropertyValue("visibility")).not.toBe("hidden");
  });

  // #625 item 6: the bar's first appearance pushed every field down ~46 px.
  // The bar keeps its row on every editor route, so appearing adds no shift.
  test("the bar's row is reserved even when it has nothing to say", () => {
    const live = loadEditorCopy({ saveDisabled: true, hasOpenPr: false });
    const bar = live.doc.getElementById("cms-publish-state");
    expect(bar, "the row stays so fields never move").not.toBeNull();
    expect(bar.getAttribute("data-state")).toBe("idle");
    expect(bar.style.getPropertyValue("min-height")).toBe("calc(2.7rem + 3px)");
    expect(bar.style.getPropertyValue("visibility")).toBe("hidden");

    const drafted = loadEditorCopy({ saveDisabled: false });
    const shown = drafted.doc.getElementById("cms-publish-state");
    expect(shown.style.getPropertyValue("min-height")).toBe("calc(2.7rem + 3px)");
    expect(shown.style.getPropertyValue("visibility")).not.toBe("hidden");
  });
});

test.describe("Decap publishing fields", () => {
  for (const configName of CONFIGS) {
    test(`${configName} keeps the post slug editable and carries hostname-aware hints`, () => {
      const config = YAML.parse(fs.readFileSync(path.join(ADMIN, configName), "utf8"));
      const posts = collection(config, "posts");
      const slug = field(posts, "slug");
      expect(slug.widget).toBe("string");
      expect(slug.required).toBe(false);
      expect(slug.label).toBe("URL Slug");
      expect(slug.hint).toContain("{{CMS_CURRENT_HOST}}");
      expect(field(posts, "published").hint).toBe(POST_PUBLISHED_HINT);
      expect(field(posts, "publish_date").hint).toBe(POST_DATE_HINT);
      expect(field(collection(config, "pages"), "published").hint).toBe(PAGE_PUBLISHED_HINT);
    });
  }

  test("field_library.yml uses the same plain-language contract for reusable content", () => {
    const library = YAML.parse(fs.readFileSync(path.join(ADMIN, "field_library.yml"), "utf8"));
    const pair = library.field_library.published_pair;
    expect(field({ fields: pair }, "published").hint).toBe(CONTENT_PUBLISHED_HINT);
    expect(field({ fields: pair }, "publish_date").hint).toBe(CONTENT_DATE_HINT);
  });
});
