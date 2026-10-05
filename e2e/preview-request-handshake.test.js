// @lane: local — pure-Node sandbox tests for the /preview/ load-time request handshake (#646)
/*
 * Issue #646: Live Preview on an already-saved entry opened /preview/ on its
 * empty state, because the page filled only from the editor's Save
 * broadcasts. Now, on load, /preview/ posts
 * `{ type: "cms-preview-request", collection }` on the shared
 * BroadcastChannel; theme/admin/preview-bridge.js answers with the entry its
 * editor route has open, in the save broadcast's own shape, taken from the
 * in-editor preview pane's latest render (theme/admin/preview-pane.js) or the
 * tab's last postSave.
 *
 * Both sides run here for real: the editor tab is preview-pane.js +
 * preview-bridge.js in one vm context, the preview tab is the render script
 * of theme/_layouts/preview.html in another, over a fake BroadcastChannel bus
 * that stamps each message with its sender's origin and delivers only on an
 * explicit flush(). No timers, no network, no browser.
 *
 * Also covered: the empty state's wording per backend, and that no Body hint
 * still sends writers to a raw /preview/ path.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ROOT = path.resolve(__dirname, "..");
const ADMIN = path.join(ROOT, "theme", "admin");
const PANE_SRC = fs.readFileSync(path.join(ADMIN, "preview-pane.js"), "utf8");
const BRIDGE_SRC = fs.readFileSync(path.join(ADMIN, "preview-bridge.js"), "utf8");
const LAYOUT = fs.readFileSync(path.join(ROOT, "theme", "_layouts", "preview.html"), "utf8");

const ORIGIN = "https://site.example.com";
const FOREIGN = "https://elsewhere.example.net";
const CHANNEL = "adamdaniel-cms-preview";

// The layout's render script: the inline <script> that subscribes to the
// channel. Liquid-free, so it runs as written.
function previewScript() {
  const blocks = [...LAYOUT.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const mine = blocks.filter((b) => b.includes("new BroadcastChannel("));
  expect(mine, "preview.html has exactly one render script on the channel").toHaveLength(1);
  return mine[0];
}

// ── A deterministic BroadcastChannel ──────────────────────────────────

function makeBus() {
  const channels = [];
  const queue = [];
  const log = [];
  function channelClass(origin) {
    return class FakeChannel {
      constructor(name) {
        this.name = name;
        this.listeners = [];
        channels.push(this);
      }
      addEventListener(type, fn) {
        if (type === "message") this.listeners.push(fn);
      }
      postMessage(msg) {
        const data = structuredClone(msg);
        log.push({ origin, data });
        queue.push({ from: this, origin, data });
      }
    };
  }
  // Deliver everything queued, including what deliveries post in turn.
  function flush() {
    for (let guard = 0; queue.length; guard += 1) {
      if (guard > 100) throw new Error("bus did not settle");
      const { from, origin, data } = queue.shift();
      for (const ch of channels) {
        if (ch === from || ch.name !== from.name) continue;
        for (const fn of ch.listeners) fn({ data: structuredClone(data), origin });
      }
    }
  }
  return { channelClass, flush, log, channels };
}

// ── The editor tab: preview-pane.js + preview-bridge.js ───────────────

function immutableEntry({ collection, slug, data }) {
  return {
    get: (k) => (k === "data" ? { toJS: () => data } : { collection, slug }[k]),
    getIn: ([, k]) => data[k],
  };
}

function bootEditor(bus, { hash, origin = ORIGIN } = {}) {
  const templates = {};
  const handlers = {};
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const window = {
    location: { origin, href: origin + "/admin/index.html", hash: hash || "" },
    h,
    CMS: {
      registerPreviewStyle() {},
      registerPreviewTemplate: (name, component) => (templates[name] = component),
      registerEventListener: ({ name, handler }) => (handlers[name] = handler),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const BroadcastChannel = bus.channelClass(origin);
  const sandbox = {
    window,
    document: { readyState: "complete", addEventListener() {} },
    BroadcastChannel,
    URL,
    Date,
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(PANE_SRC, sandbox);
  vm.runInContext(BRIDGE_SRC, sandbox);
  expect(typeof handlers.postSave, "the bridge registers postSave").toBe("function");
  const channel = bus.channels[bus.channels.length - 1];
  return {
    window,
    channel,
    route: (next) => (window.location.hash = next),
    // What Decap does when the pane draws the entry open in the editor.
    draw: (entry) =>
      templates[entry.collection]({
        entry: immutableEntry(entry),
        widgetFor: () => null,
        getAsset: String,
      }),
    save: (entry) => handlers.postSave({ entry: immutableEntry(entry) }),
  };
}

// ── The preview tab: preview.html's render script on a fake DOM ───────

function fakeSlot() {
  const attrs = {};
  return {
    textContent: "",
    innerHTML: "",
    hidden: false,
    setAttribute: (k, v) => (attrs[k] = v),
    removeAttribute: (k) => delete attrs[k],
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    querySelector: () => null,
  };
}

function fakeVariant(name) {
  const slots = {};
  return {
    hidden: true,
    removed: false,
    slots,
    getAttribute: (k) => (k === "data-preview-layout" ? name : null),
    remove() {
      this.removed = true;
    },
    querySelector(sel) {
      const m = /^\[data-preview-slot="([^"]+)"\]$/.exec(sel);
      if (!m) return null;
      return (slots[m[1]] ||= fakeSlot());
    },
  };
}

function bootPreview(bus, { search = "?collection=posts", storedUser, origin = ORIGIN } = {}) {
  const variants = ["posts", "pages", "projects"].map(fakeVariant);
  const classes = new Set();
  const emptyState = {
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
    },
    remove() {},
  };
  const hints = ["github", "local"].map((name) => ({
    hidden: name === "local",
    getAttribute: (k) => (k === "data-empty-hint" ? name : null),
  }));
  const banner = { hidden: true };
  const windowListeners = [];
  const store = storedUser === undefined ? {} : { "decap-cms-user": storedUser };
  const window = {
    location: { origin, search },
    addEventListener: (type, fn) => type === "message" && windowListeners.push(fn),
    postMessage() {},
    opener: null,
    marked: { parse: (md) => `<p>${md}</p>` },
    localStorage: { getItem: (k) => (k in store ? store[k] : null) },
  };
  window.parent = window;
  const document = {
    readyState: "complete",
    querySelectorAll(sel) {
      if (sel === "[data-preview-layout]") return variants;
      if (sel === "#preview-empty-state [data-empty-hint]") return hints;
      return [];
    },
    getElementById(id) {
      if (id === "preview-empty-state") return emptyState;
      if (id === "preview-embed-banner") return banner;
      return null;
    },
  };
  const sandbox = {
    window,
    document,
    BroadcastChannel: bus.channelClass(origin),
    URLSearchParams,
    CSS: { escape: (s) => s },
    setTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(previewScript(), sandbox);
  const channel = bus.channels[bus.channels.length - 1];
  const active = variants.find((v) => !v.removed);
  return {
    title: () => (active.slots.title ? active.slots.title.textContent : ""),
    body: () => (active.slots.body ? active.slots.body.innerHTML : ""),
    emptyHidden: () => classes.has("hidden"),
    hint: (name) => hints.find((p) => p.getAttribute("data-empty-hint") === name),
    // A message straight to the page's channel listener, any origin.
    deliver: (data, from = origin) => channel.listeners.forEach((fn) => fn({ data, origin: from })),
    // A window.postMessage from any origin.
    postWindow: (data, from = origin) => windowListeners.forEach((fn) => fn({ data, origin: from })),
  };
}

const SAVED = {
  collection: "posts",
  slug: "2026-01-15-hello-world",
  data: { title: "Hello world", body: "Already saved." },
};
const SAVED_ROUTE = "#/collections/posts/entries/2026-01-15-hello-world";

const updates = (bus) => bus.log.filter((m) => m.data.type === "cms-preview-update").map((m) => m.data);

test.describe("/preview/ asks the editor tab for the open entry on load (#646)", () => {
  test("the preview requests its collection on load, from its own origin", () => {
    const bus = makeBus();
    bootPreview(bus, { search: "?collection=pages" });
    expect(bus.log).toEqual([
      { origin: ORIGIN, data: { type: "cms-preview-request", collection: "pages" } },
    ]);
  });

  test("a saved entry renders from the pane's render, with no Save", () => {
    const bus = makeBus();
    const editor = bootEditor(bus, { hash: SAVED_ROUTE });
    editor.draw(SAVED);
    const preview = bootPreview(bus);
    expect(preview.emptyHidden(), "nothing has answered yet").toBe(false);
    bus.flush();
    expect(updates(bus), "the reply is the save broadcast's own shape").toEqual([
      {
        type: "cms-preview-update",
        collection: "posts",
        slug: "2026-01-15-hello-world",
        fields: { title: "Hello world", body: "Already saved." },
      },
    ]);
    expect(preview.title()).toBe("Hello world");
    expect(preview.body()).toBe("<p>Already saved.</p>");
    expect(preview.emptyHidden(), "the empty state goes once the entry renders").toBe(true);
  });

  test("the reply carries what the pane drew last, unsaved edits included", () => {
    const bus = makeBus();
    const editor = bootEditor(bus, { hash: SAVED_ROUTE });
    editor.draw(SAVED);
    editor.draw({ ...SAVED, data: { title: "Hello again", body: "Edited." } });
    const preview = bootPreview(bus);
    bus.flush();
    expect(preview.title()).toBe("Hello again");
  });

  test("with no pane render, the reply is the tab's last save", () => {
    const bus = makeBus();
    const editor = bootEditor(bus, { hash: SAVED_ROUTE });
    editor.save(SAVED);
    bus.log.length = 0;
    const preview = bootPreview(bus);
    bus.flush();
    expect(updates(bus)).toHaveLength(1);
    expect(preview.title()).toBe("Hello world");
  });

  test("a new, unsaved entry on #/collections/<c>/new is answered from the pane", () => {
    const bus = makeBus();
    const editor = bootEditor(bus, { hash: "#/collections/posts/new" });
    editor.draw({ collection: "posts", slug: "", data: { title: "Draft" } });
    const preview = bootPreview(bus);
    bus.flush();
    expect(updates(bus)[0]).toEqual({
      type: "cms-preview-update",
      collection: "posts",
      slug: null,
      fields: { title: "Draft" },
    });
    expect(preview.title()).toBe("Draft");
  });

  test("no reply off the editor, on another collection's editor, or for another entry", () => {
    for (const [hash, why] of [
      ["#/collections/posts", "a collection list is not an editor"],
      ["#/collections/pages/entries/about", "the editor is on another collection"],
      ["#/collections/posts/entries/2026-02-01-other", "the pane last drew a different entry"],
      ["#/collections/posts/new", "a new entry is not the saved one the pane drew"],
    ]) {
      const bus = makeBus();
      const editor = bootEditor(bus, { hash: SAVED_ROUTE });
      editor.draw(SAVED);
      editor.route(hash);
      const preview = bootPreview(bus);
      bus.flush();
      expect(updates(bus), why).toEqual([]);
      expect(preview.emptyHidden(), why).toBe(false);
    }
  });

  test("the editor ignores a foreign-origin, malformed or mismatched request", () => {
    const bus = makeBus();
    const editor = bootEditor(bus, { hash: SAVED_ROUTE });
    editor.draw(SAVED);
    const ask = (data, origin = ORIGIN) => editor.channel.listeners.forEach((fn) => fn({ data, origin }));
    ask({ type: "cms-preview-request", collection: "posts" }, FOREIGN);
    ask({ type: "cms-preview-request", collection: "pages" });
    ask({ type: "cms-preview-request", collection: "posts/../x" });
    ask({ type: "cms-preview-request", collection: ["posts"] });
    ask({ type: "cms-preview-request" });
    ask({ type: "cms-preview-update", collection: "posts" });
    ask([{ type: "cms-preview-request", collection: "posts" }]);
    ask("cms-preview-request");
    ask(null);
    expect(bus.log, "nothing was sent").toEqual([]);
    ask({ type: "cms-preview-request", collection: "posts" });
    expect(updates(bus), "the well-formed same-origin request is answered").toHaveLength(1);
  });

  test("the preview ignores a foreign-origin, malformed or other-collection update", () => {
    const bus = makeBus();
    const preview = bootPreview(bus);
    const fields = { title: "Should not render" };
    preview.deliver({ type: "cms-preview-update", collection: "posts", fields }, FOREIGN);
    preview.postWindow({ type: "cms-preview-update", collection: "posts", fields }, FOREIGN);
    preview.deliver({ type: "cms-preview-update", collection: "pages", fields });
    preview.postWindow({ type: "cms-preview-update", collection: "projects", fields });
    preview.deliver({ type: "cms-preview-update", collection: "posts", fields: ["title"] });
    preview.deliver({ type: "cms-preview-update", collection: "posts", fields: "title" });
    preview.deliver({ type: "cms-preview-update", collection: "posts", slug: 7, fields });
    preview.deliver([{ type: "cms-preview-update", fields }]);
    preview.deliver({ type: "cms-preview-request", collection: "posts" });
    preview.deliver(null);
    expect(preview.title()).toBe("");
    expect(preview.emptyHidden()).toBe(false);
    preview.deliver({ type: "cms-preview-update", collection: "posts", slug: "s", fields: { title: "Yes" } });
    expect(preview.title(), "a well-formed update for this collection renders").toBe("Yes");
  });
});

test.describe("/preview/ empty state names the backend's real controls (#646)", () => {
  const shown = (p) => ["github", "local"].filter((n) => !p.hint(n).hidden);

  test("a local_backend (decap-server) session gets Publish → Publish now", () => {
    const p = bootPreview(makeBus(), { storedUser: JSON.stringify({ backendName: "proxy", token: "x" }) });
    expect(shown(p)).toEqual(["local"]);
  });

  test("a GitHub session gets Save", () => {
    const p = bootPreview(makeBus(), { storedUser: JSON.stringify({ backendName: "github" }) });
    expect(shown(p)).toEqual(["github"]);
  });

  test("no session, or an unreadable one, keeps the Save wording", () => {
    for (const storedUser of [undefined, "not json", "null", JSON.stringify(["proxy"])]) {
      expect(shown(bootPreview(makeBus(), { storedUser })), String(storedUser)).toEqual(["github"]);
    }
  });

  test("each paragraph names only its backend's controls", () => {
    const block = LAYOUT.slice(
      LAYOUT.indexOf('<div id="preview-empty-state">'),
      LAYOUT.indexOf("</div>", LAYOUT.indexOf('<div id="preview-empty-state">')),
    );
    const para = (name) => {
      const m = new RegExp(`<p data-empty-hint="${name}"[^>]*>([\\s\\S]*?)</p>`).exec(block);
      expect(m, `the ${name} paragraph exists`).not.toBeNull();
      return m[1].replace(/\s+/g, " ");
    };
    expect(para("github")).toContain("<code>Save</code>");
    expect(para("github")).not.toContain("Publish now");
    expect(para("local")).toContain("<code>Publish</code> → <code>Publish now</code>");
    expect(para("local"), "the local backend has no Save button").not.toContain("Save");
    expect(block, "the local paragraph starts hidden; the script reveals it").toMatch(
      /<p data-empty-hint="local" hidden>/,
    );
  });
});

test.describe("Body field hints leave /preview/ to the Live Preview button (#646)", () => {
  test("no field hint in any admin config or the field library carries a raw /preview/ path", () => {
    const hints = [];
    const collect = (node, where) => {
      if (Array.isArray(node)) node.forEach((n, i) => collect(n, `${where}[${i}]`));
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "hint" && typeof v === "string") hints.push([where, v]);
          else collect(v, `${where}.${k}`);
        }
      }
    };
    for (const f of ["config.base.yml", "config-local.base.yml", "config-test.yml", "field_library.yml"]) {
      // Template placeholders ({{CMS_REPO}}) are not YAML; name them plainly.
      const text = fs.readFileSync(path.join(ADMIN, f), "utf8").replace(/\{\{(\w+)\}\}/g, "$1");
      collect(YAML.parse(text), f);
    }
    expect(hints.length, "the walk found the configs' hints").toBeGreaterThan(10);
    expect(hints.filter(([, v]) => v.includes("/preview/"))).toEqual([]);
  });
});
