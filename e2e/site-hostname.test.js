// @lane: local — pure-Node tests for hostname-aware admin copy.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = path.resolve(__dirname, "../theme/admin/site-hostname.js");

function load({ origin = "https://preview-pr0.example.com/admin/", siteOrigin = "", apex = "example.com" } = {}) {
  const location = new URL(origin);
  const document = {
    readyState: "loading",
    body: null,
    addEventListener() {},
  };
  const window = { location, CMS_SITE_ORIGIN: siteOrigin, CMS_APEX: apex };
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

test("runtime token replacement is limited to owned Decap hint nodes", () => {
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
  const authored = element("css-abc-ControlContainer", "");
  const authoredContent = element("css-abc-RichText", "Authored {{CMS_CURRENT_HOST}}");
  authored.appendChild(authoredContent);
  const body = element("body", "");
  body.appendChild(hint);
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
  expect(authoredContent.textNode.nodeValue).toBe("Authored {{CMS_CURRENT_HOST}}");
  expect(hint.textNode.writes).toBe(1);

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
});
