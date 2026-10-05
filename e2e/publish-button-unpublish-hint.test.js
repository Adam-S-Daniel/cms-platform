// @lane: local — pure-Node vm sandbox test for the Unpublish menu explanation
/*
 * #625 item 7: "Published ▾" on a live entry offers "Unpublish →" and
 * "Duplicate +" with no word on what Unpublish does to the site. publish-button.js
 * adds a plain-language `title` to the Unpublish item — only to that item, and
 * only inside the published-entry dropdown (`PublishedToolbarButton`), never the
 * Publish dropdown. Tiny fake DOM, no browser, no timers (the interval callback
 * is captured and driven by hand).
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM = fs.readFileSync(path.resolve(__dirname, "../theme/admin/publish-button.js"), "utf8");

class El {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
    this.style = { getPropertyValue: () => "", setProperty() {} };
    this.writes = 0;
    for (const c of children) {
      c.parentElement = this;
      this.children.push(c);
    }
  }
  get textContent() {
    return (this.attrs.text || "") + this.children.map((c) => c.textContent).join("");
  }
  getAttribute(n) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  setAttribute(n, v) {
    this.writes += 1;
    this.attrs[n] = String(v);
  }
  matches(sel) {
    const m = /^\[aria-haspopup="true"\]$/.test(sel);
    return m && this.attrs["aria-haspopup"] === "true";
  }
  closest() {
    return null;
  }
  all(out = []) {
    for (const c of this.children) {
      out.push(c);
      c.all(out);
    }
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    if (sel === '[aria-haspopup="true"]') return this.all().filter((e) => e.attrs["aria-haspopup"] === "true");
    if (sel === '[role="menuitem"]') return this.all().filter((e) => e.attrs.role === "menuitem");
    return [];
  }
}

function dropdown(triggerClass, labels) {
  const items = labels.map((text) => new El("div", { role: "menuitem" }, [new El("span", { text })]));
  const wrapper = new El("div", {}, [
    new El("div", {}, [new El("span", { role: "button", "aria-haspopup": "true", class: "css-1-" + triggerClass })]),
    new El("div", { role: "menu" }, [new El("ul", {}, items)]),
  ]);
  return { wrapper, items };
}

function load() {
  const published = dropdown("PublishedToolbarButton", ["Unpublish", "Duplicate"]);
  const publish = dropdown("PublishButton", ["Publish now", "Unpublish look-alike"]);
  const root = new El("div", {}, [published.wrapper, publish.wrapper]);
  const intervals = [];
  const sandbox = {
    window: { addEventListener() {}, CMSPublishProgress: { get: () => null, subscribe() {} } },
    document: {
      readyState: "complete",
      addEventListener() {},
      getElementById: () => null,
      querySelector: (s) => root.querySelector(s),
      querySelectorAll: (s) => root.querySelectorAll(s),
      createElement: (tag) => new El(tag),
    },
    setInterval: (fn) => intervals.push(fn),
    setTimeout() {},
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM, sandbox);
  return { published, publish, tick: () => intervals.forEach((fn) => fn()) };
}

test.describe("publish-button — Unpublish explains itself (#625 item 7)", () => {
  test("the Unpublish item in the published-entry dropdown gets a plain explanation", () => {
    const { published, tick } = load();
    tick();
    const title = published.items[0].getAttribute("title");
    expect(title).toBe(
      "Takes this off the site and moves it back to your drafts. Nothing is lost — you can publish it again.",
    );
    expect(published.items[1].getAttribute("title"), "Duplicate is not ours to explain").toBeNull();
  });

  test("the Publish dropdown is never touched, and steady ticks write nothing", () => {
    const { published, publish, tick } = load();
    tick();
    expect(publish.items[1].getAttribute("title")).toBeNull();
    const writes = published.items[0].writes;
    tick();
    tick();
    expect(published.items[0].writes).toBe(writes);
  });
});
