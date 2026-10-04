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
  config,
  status = 200,
  configLink = null,
} = {}) {
  const location = new URL(origin);
  const document = {
    readyState: "loading",
    body: null,
    baseURI: location.href,
    addEventListener() {},
    querySelector(sel) {
      return configLink && sel === 'link[rel="cms-config-url"]'
        ? { getAttribute: (k) => (k === "href" ? configLink : null) }
        : null;
    },
  };
  const window = { location, CMS_SITE_ORIGIN: siteOrigin, CMS_APEX: apex, CMS_ADMIN_ORIGIN: adminOrigin };
  const fetchCalls = [];
  const sandbox = { window, document, URL, Promise, MutationObserver: class {}, NodeFilter: { SHOW_TEXT: 4 } };
  // No `config` → no fetch in the sandbox at all (the read settles unknown).
  if (config !== undefined) {
    sandbox.fetch = (url, init) => {
      fetchCalls.push({ url: String(url), init: init || {} });
      if (config instanceof Error) return Promise.reject(config);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(config),
      });
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  const names = window.CMSHostname;
  names.fetchCalls = fetchCalls;
  return names;
}

// The served config.yml, as each surface serves it: both render paths write
// the site's `url` into site_url; patch-preview-config.sh rewrites it (and
// backend.branch) on a preview; the local/test configs name localhost:4000.
function servedConfig({ branch = "main", siteURL = "https://example.com" } = {}) {
  return `backend:\n  name: github\n  repo: acme/example\n  branch: ${branch}\n\nsite_url: ${siteURL}\ndisplay_url: ${siteURL}\n`;
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

test("runtime token replacement is limited to owned Decap field labels and hint nodes", async () => {
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
    location: new URL("https://www.example.com/admin/"),
    CMS_SITE_ORIGIN: "https://example.com",
  };
  let observerCallback;
  let answerConfig;
  const sandbox = {
    window, document, URL, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    },
    // The served production config, answered only when the test says. The tab
    // is on www., so the token must name the destination, not the access host.
    fetch: () =>
      new Promise((resolve) => {
        answerConfig = () => resolve({ ok: true, status: 200, text: () => Promise.resolve(servedConfig()) });
      }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  // Until the served config is read the token is held, not guessed.
  expect(hint.textNode.nodeValue).toBe("Show on {{CMS_CURRENT_HOST}}");
  observerCallback([{ type: "characterData", target: hint.textNode, addedNodes: [] }]);
  expect(hint.textNode.nodeValue).toBe("Show on {{CMS_CURRENT_HOST}}");
  answerConfig();
  await window.CMSHostname.binding();
  await new Promise((r) => setImmediate(r));
  expect(hint.textNode.nodeValue).toBe("Show on example.com");
  expect(label.textNode.nodeValue).toBe("Publish on example.com");
  expect(authoredContent.textNode.nodeValue).toBe("Authored {{CMS_CURRENT_HOST}}");
  expect(hint.textNode.writes).toBe(1);
  expect(label.textNode.writes).toBe(1);

  hint.textNode.nodeValue = "Again on {{CMS_CURRENT_HOST}}";
  const writesBeforeObserver = hint.textNode.writes;
  observerCallback([{ type: "characterData", target: hint.textNode, addedNodes: [] }]);
  expect(hint.textNode.nodeValue).toBe("Again on example.com");
  expect(hint.textNode.writes).toBe(writesBeforeObserver + 1);
  observerCallback([{ type: "characterData", target: hint.textNode, addedNodes: [] }]);
  expect(hint.textNode.writes).toBe(writesBeforeObserver + 1);

  const addedHint = element("css-def-ControlHint", "Added on {{CMS_CURRENT_HOST}}");
  observerCallback([{ type: "childList", target: addedHint, addedNodes: [addedHint.textNode] }]);
  expect(addedHint.textNode.nodeValue).toBe("Added on example.com");
  const addedWrites = addedHint.textNode.writes;
  observerCallback([{ type: "childList", target: addedHint, addedNodes: [addedHint.textNode] }]);
  expect(addedHint.textNode.writes).toBe(addedWrites);

  const addedLabel = element("css-def-FieldLabel", "Added label on {{CMS_CURRENT_HOST}}");
  observerCallback([{ type: "childList", target: addedLabel, addedNodes: [addedLabel.textNode] }]);
  expect(addedLabel.textNode.nodeValue).toBe("Added label on example.com");
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

// #533 — `{{CMS_CURRENT_HOST}}` promises where a publish goes, so it resolves
// to the served config's site_url host, not the address the admin was opened
// on. Each row is one access host; the served config is what that surface
// really serves.
for (const [label, opts, expected] of [
  ["production on the apex", { origin: "https://example.com/admin/", config: servedConfig() }, "example.com"],
  ["production on www.", { origin: "https://www.example.com/admin/", config: servedConfig() }, "example.com"],
  [
    "production on the CloudFront distribution hostname",
    { origin: "https://d1234abcd.cloudfront.net/admin/", config: servedConfig() },
    "example.com",
  ],
  [
    "a preview admin (patched branch and site_url)",
    {
      origin: "https://preview-pr7.example.com/admin/",
      config: servedConfig({ branch: "claude/fix", siteURL: "https://preview-pr7.example.com" }),
    },
    "preview-pr7.example.com",
  ],
  [
    "local development (config names localhost:4000 — the documented local fallback)",
    {
      origin: "http://localhost:4000/admin/index-local.html",
      config: servedConfig({ siteURL: "http://localhost:4000" }),
      configLink: "config-local.yml",
    },
    "localhost",
  ],
  [
    "the separate admin origin (#517)",
    {
      origin: "https://admin.example.com/admin/",
      adminOrigin: "https://admin.example.com",
      config: servedConfig(),
    },
    "example.com",
  ],
  ["an unreadable config (404) — the canonical host", { origin: "https://www.example.com/admin/", config: "", status: 404 }, "example.com"],
  ["a failed config read — the canonical host", { origin: "https://www.example.com/admin/", config: new Error("offline") }, "example.com"],
  [
    "a config with no usable site_url — the canonical host",
    { origin: "https://www.example.com/admin/", config: "backend:\n  branch: main\nsite_url: javascript:alert(1)\n" },
    "example.com",
  ],
]) {
  test(`destination(): ${label}`, async () => {
    const names = load({ siteOrigin: "https://example.com", ...opts });
    expect(names.destination(), "before the read settles it is the canonical host, never the access host").toBe(
      "example.com",
    );
    await names.binding();
    expect(names.destination()).toBe(expected);
  });
}

test("binding() reads the config file the shell names, once, past the HTTP cache", async () => {
  const names = load({
    origin: "http://localhost:4000/admin/index-test.html",
    config: servedConfig({ siteURL: "http://localhost:4000" }),
    configLink: "config-test.yml",
  });
  await names.binding();
  await names.binding();
  expect(names.fetchCalls.map((c) => c.url)).toEqual(["http://localhost:4000/admin/config-test.yml"]);
  expect(names.fetchCalls[0].init.cache).toBe("no-cache");

  const prod = load({ origin: "https://www.example.com/admin/", config: servedConfig() });
  await prod.binding();
  expect(prod.fetchCalls.map((c) => c.url)).toEqual(["https://www.example.com/admin/config.yml"]);
});

test("binding() reports the served branch, slashes kept, and null for anything that is not a plain ref", async () => {
  const preview = load({ config: servedConfig({ branch: "claude/issue-528/x", siteURL: "https://preview-pr0.example.com" }) });
  expect(await preview.binding()).toEqual({ branch: "claude/issue-528/x", destination: "preview-pr0.example.com" });
  for (const bad of ['backend:\n  branch: "quoted"\n', "backend:\n  branch: <b>x</b>\n", "backend:\n  name: github\n"]) {
    expect((await load({ config: bad }).binding()).branch).toBeNull();
  }
  expect(await load({ config: "", status: 500 }).binding()).toEqual({ branch: null, destination: null });
});

// The reader mirrors the writer: run the real preview patch on the real base
// template and hand the bytes to the real parser (branch-binding-banner.test.js
// does the same for the branch banner's own reader).
test("parses the branch and site_url patch-preview-config.sh writes into the real base template", () => {
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-hostname-"));
  const cfg = path.join(tmp, "config.yml");
  fs.copyFileSync(path.resolve(__dirname, "../theme/admin/config.base.yml"), cfg);
  execFileSync(
    path.resolve(__dirname, "../scripts/patch-preview-config.sh"),
    [cfg, "42", "claude/issue-528-x", "preview-pr42.example.com"],
    { stdio: "pipe" },
  );
  const names = load();
  expect(names.parseServedConfig(fs.readFileSync(cfg, "utf8"))).toEqual({
    branch: "claude/issue-528-x",
    destination: "preview-pr42.example.com",
  });
});
