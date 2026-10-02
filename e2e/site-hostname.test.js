// @lane: local — pure-Node tests for hostname-aware admin copy.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = path.resolve(__dirname, "../theme/admin/site-hostname.js");

function load({
  origin = "https://preview-pr0.example.com/admin/",
  siteOrigin = "",
  apex = "example.com",
  adminOrigin = "",
} = {}) {
  const location = new URL(origin);
  const document = {
    readyState: "loading",
    body: null,
    addEventListener() {},
  };
  const window = { location, CMS_SITE_ORIGIN: siteOrigin, CMS_APEX: apex, CMS_ADMIN_ORIGIN: adminOrigin };
  const sandbox = { window, document, URL, MutationObserver: class {}, NodeFilter: { SHOW_TEXT: 4 } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  return window.CMSHostname;
}

test("uses the routed preview host for current copy and configured host for canonical copy", () => {
  const names = load();
  expect(names.current()).toBe("preview-pr0.example.com");
  expect(names.canonical()).toBe("example.com");
  expect(names.fromURL("https://preview-pr9.example.net/blog/a/")).toBe("preview-pr9.example.net");
});

// #517 — on the separate admin origin the tab is the editor, not the site, so
// "on <host>" copy and public URLs name the configured site. Anywhere else
// (the site's own origin, a preview admin) the tab's origin is still the site.
test("on the configured admin origin, current host and public origin are the site's", () => {
  const names = load({
    origin: "https://admin.example.com/admin/",
    siteOrigin: "https://example.com",
    adminOrigin: "https://admin.example.com",
  });
  expect(names.current()).toBe("example.com");
  expect(names.publicOrigin()).toBe("https://example.com");
});

test("a preview admin keeps its own host even when an admin origin is configured", () => {
  const names = load({
    origin: "https://preview-pr7.example.com/admin/",
    siteOrigin: "https://example.com",
    adminOrigin: "https://admin.example.com",
  });
  expect(names.current()).toBe("preview-pr7.example.com");
  expect(names.publicOrigin()).toBe("https://preview-pr7.example.com");
});

test("with no admin origin configured, the tab's own origin is the public one", () => {
  const names = load({ origin: "https://example.com/admin/", siteOrigin: "https://example.com" });
  expect(names.current()).toBe("example.com");
  expect(names.publicOrigin()).toBe("https://example.com");
});

test("an empty origin falls through to a validated apex", () => {
  expect(load({ siteOrigin: "", apex: "example.net" }).canonical()).toBe("example.net");
});

test("all admin shells load hostname identity before copy consumers", () => {
  for (const name of ["index.html", "index-local.html", "index-test.html"]) {
    const html = fs.readFileSync(path.resolve(__dirname, "../theme/admin", name), "utf8");
    expect(html.indexOf('src="site-hostname.js"')).toBeGreaterThan(-1);
    expect(html.indexOf('src="site-hostname.js"')).toBeLessThan(html.indexOf('src="entry-status-model.js"'));
  }
});

test("runtime token replacement is limited to owned Decap field labels and hint nodes", () => {
  function element(className, text) {
    let value = text;
    const textNode = { nodeType: 3, parentElement: null, writes: 0 };
    Object.defineProperty(textNode, "nodeValue", {
      get() { return value; },
      set(next) { value = next; textNode.writes += 1; },
    });
    const el = {
      nodeType: 1,
      className,
      textNode,
      children: [],
      parentElement: null,
      matches(selector) {
        if (selector.includes("ControlHint")) return className.includes("ControlHint");
        if (selector.includes("FieldLabel")) return className.includes("FieldLabel");
        if (selector.includes("ControlContainer")) return className.includes("ControlContainer");
        return false;
      },
      querySelectorAll(selector) {
        const found = [];
        function visit(node) {
          for (const child of node.children || []) {
            if (child.matches(selector)) found.push(child);
            visit(child);
          }
        }
        visit(this);
        return found;
      },
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
      },
      closest(selector) {
        for (let node = this; node; node = node.parentElement) {
          if (node.matches && node.matches(selector)) return node;
        }
        return null;
      },
    };
    textNode.parentElement = el;
    return el;
  }
  const hint = element("css-abc-ControlHint", "Show on {{CMS_CURRENT_HOST}}");
  const label = element("css-abc-FieldLabel", "Publish on {{CMS_CURRENT_HOST}}");
  const authored = element("css-abc-ControlContainer", "");
  const authoredContent = element("css-abc-RichText", "Authored {{CMS_CURRENT_HOST}}");
  authored.appendChild(authoredContent);
  const body = element("body", "");
  body.appendChild(hint);
  body.appendChild(label);
  body.appendChild(authored);
  const document = {
    readyState: "complete",
    body,
    createTreeWalker(root) {
      const nodes = [];
      function visit(node) {
        if (node.textNode && node.textNode.nodeValue) nodes.push(node.textNode);
        for (const child of node.children || []) visit(child);
      }
      visit(root);
      let index = 0;
      return { nextNode() { return nodes[index++] || null; } };
    },
  };
  const window = {
    location: new URL("https://preview-pr0.example.com/admin/"),
    CMS_SITE_ORIGIN: "https://example.com",
  };
  let observerCallback;
  const sandbox = {
    window, document, URL, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  expect(hint.textNode.nodeValue).toBe("Show on preview-pr0.example.com");
  expect(label.textNode.nodeValue).toBe("Publish on preview-pr0.example.com");
  expect(authoredContent.textNode.nodeValue).toBe("Authored {{CMS_CURRENT_HOST}}");
  expect(hint.textNode.writes).toBe(1);
  expect(label.textNode.writes).toBe(1);

  hint.textNode.nodeValue = "Again on {{CMS_CURRENT_HOST}}";
  const writesBeforeObserver = hint.textNode.writes;
  observerCallback([{ type: "characterData", target: hint.textNode, addedNodes: [] }]);
  expect(hint.textNode.nodeValue).toBe("Again on preview-pr0.example.com");
  expect(hint.textNode.writes).toBe(writesBeforeObserver + 1);
  observerCallback([{ type: "characterData", target: hint.textNode, addedNodes: [] }]);
  expect(hint.textNode.writes).toBe(writesBeforeObserver + 1);

  const addedHint = element("css-def-ControlHint", "Added on {{CMS_CURRENT_HOST}}");
  observerCallback([{ type: "childList", target: addedHint, addedNodes: [addedHint.textNode] }]);
  expect(addedHint.textNode.nodeValue).toBe("Added on preview-pr0.example.com");
  const addedWrites = addedHint.textNode.writes;
  observerCallback([{ type: "childList", target: addedHint, addedNodes: [addedHint.textNode] }]);
  expect(addedHint.textNode.writes).toBe(addedWrites);

  const addedLabel = element("css-def-FieldLabel", "Added label on {{CMS_CURRENT_HOST}}");
  observerCallback([{ type: "childList", target: addedLabel, addedNodes: [addedLabel.textNode] }]);
  expect(addedLabel.textNode.nodeValue).toBe("Added label on preview-pr0.example.com");
  const addedLabelWrites = addedLabel.textNode.writes;
  observerCallback([{ type: "childList", target: addedLabel, addedNodes: [addedLabel.textNode] }]);
  expect(addedLabel.textNode.writes).toBe(addedLabelWrites);
});

// #517 — the in-editor "View page on site" URL (live-url-derive.js) must name
// the public site, not the admin origin the editor tab is on. Both scripts run
// in one sandbox, in the shells' load order (site-hostname.js first).
test("live-url-derive.js builds live URLs on the public site from the admin origin", () => {
  const document = {
    readyState: "loading",
    body: null,
    addEventListener() {},
    querySelector(sel) {
      return /id\^="title-field"/.test(sel) ? { value: "Hello World" } : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const location = new URL("https://admin.example.com/admin/#/collections/posts/entries/x");
  const window = {
    location,
    CMS_SITE_ORIGIN: "https://example.com",
    CMS_ADMIN_ORIGIN: "https://admin.example.com",
  };
  const sandbox = { window, document, URL, MutationObserver: class {}, NodeFilter: { SHOW_TEXT: 4 } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, "../theme/admin/live-url-derive.js"), "utf8"),
    sandbox,
  );
  expect(window.LiveURL.compute().url).toBe("https://example.com/blog/hello-world/");
});
