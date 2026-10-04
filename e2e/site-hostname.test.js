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
      return Promise.resolve(config).then((body) => ({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
      }));
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
    { origin: "https://d1234abcd.example.net/admin/", config: servedConfig() },
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
  // Unreadable: fall back to the access host. On a preview that is the
  // preview — never production, which would tell the editor the switch is
  // production's. On a production `www.` it is only cosmetically off.
  [
    "an unreadable config (404) on a preview — the preview host, never production",
    { origin: "https://preview-pr7.example.com/admin/", config: "", status: 404 },
    "preview-pr7.example.com",
  ],
  [
    "a failed config read on a preview — the preview host",
    { origin: "https://preview-pr7.example.com/admin/", config: new Error("offline") },
    "preview-pr7.example.com",
  ],
  ["an unreadable config (404) on www. — the access host", { origin: "https://www.example.com/admin/", config: "", status: 404 }, "www.example.com"],
  [
    "a config with no usable site_url — the access host",
    { origin: "https://www.example.com/admin/", config: "backend:\n  branch: main\nsite_url: javascript:alert(1)\n" },
    "www.example.com",
  ],
]) {
  test(`destination(): ${label}`, async () => {
    const names = load({ siteOrigin: "https://example.com", ...opts });
    expect(names.destination(), "before the read settles it is the access host, current()").toBe(names.current());
    expect(names.destinationOrigin()).toBe(names.publicOrigin());
    await names.binding();
    expect(names.destination()).toBe(expected);
    expect(new URL(names.destinationOrigin()).hostname).toBe(expected);
  });
}

// A stalled read must not hold `{{CMS_CURRENT_HOST}}` on screen forever: after
// 10 s the read is aborted and treated as unreadable. Fake timers — the
// callback is fired by hand, nothing waits.
test("a config read that never answers is abandoned after 10 s and treated as unreadable", async () => {
  const pending = [];
  let signal;
  const location = new URL("https://preview-pr7.example.com/admin/");
  const sandbox = {
    window: { location, CMS_SITE_ORIGIN: "https://example.com", CMS_APEX: "example.com", CMS_ADMIN_ORIGIN: "" },
    document: { readyState: "loading", body: null, baseURI: location.href, addEventListener() {} },
    URL,
    Promise,
    AbortController,
    MutationObserver: class {},
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: (fn, ms) => pending.push({ fn, ms }),
    clearTimeout: () => {},
    fetch: (url, init) => {
      signal = init.signal;
      return new Promise(() => {}); // a connection that stalls forever
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  const names = sandbox.window.CMSHostname;
  expect(pending.map((t) => t.ms), "one read timer, 10 s").toEqual([10000]);
  let settled = null;
  names.binding().then((r) => {
    settled = r;
  });
  await new Promise((r) => setImmediate(r));
  expect(settled, "still waiting before the timer fires").toBeNull();
  pending[0].fn();
  await new Promise((r) => setImmediate(r));
  expect(settled).toEqual({ branch: null, destination: null, destinationOrigin: null });
  expect(names.destinationOrigin()).toBe("https://preview-pr7.example.com");
  expect(signal && signal.aborted, "the stalled request is aborted, not left running").toBe(true);
  expect(names.destination(), "an unreadable read names the access host — the preview").toBe("preview-pr7.example.com");
});

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
  expect(await preview.binding()).toEqual({ branch: "claude/issue-528/x", destination: "preview-pr0.example.com", destinationOrigin: "https://preview-pr0.example.com" });
  for (const bad of ['backend:\n  branch: "quoted"\n', "backend:\n  branch: <b>x</b>\n", "backend:\n  name: github\n"]) {
    expect((await load({ config: bad }).binding()).branch).toBeNull();
  }
  expect(await load({ config: "", status: 500 }).binding()).toEqual({ branch: null, destination: null, destinationOrigin: null });
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
    destinationOrigin: "https://preview-pr42.example.com",
  });
});

for (const [access, siteURL] of [
  ["https://example.com", "https://example.com"],
  ["https://www.example.com", "https://example.com"],
  ["https://d1234abcd.example.net", "https://example.com"],
  ["https://preview-pr7.example.com", "https://example.com"],
  ["https://example.com", "https://preview-pr7.example.com"],
  ["https://preview-pr7.example.com", "https://preview-pr7.example.com"],
  ["http://localhost:4000", "https://example.com"],
  ["http://localhost:4000", "http://localhost:4000"],
]) {
  test(`destinationOrigin follows served config: ${access} -> ${siteURL}`, async () => {
    const names = load({ origin: access + "/admin/", config: servedConfig({ siteURL }) });
    expect(names.destinationOrigin()).toBe(access);
    await names.binding();
    expect(names.destinationOrigin()).toBe(siteURL);
    expect(names.publicOrigin()).toBe(access);
    expect(names.current()).toBe(new URL(access).hostname);
    expect(names.options().currentHostname).toBe(names.current());
    await names.binding();
    expect(names.fetchCalls).toHaveLength(1);
  });
}

for (const siteURL of ["javascript:alert(1)", "data:text/plain,x", "ftp://example.com", "//example.com", "invalid"]) {
  test(`destinationOrigin rejects invalid site_url ${siteURL}`, async () => {
    const names = load({ origin: "http://localhost:4000/admin/", config: servedConfig({ siteURL }) });
    await names.binding();
    expect(names.destinationOrigin()).toBe("http://localhost:4000");
    expect(names.parseServedConfig(servedConfig({ siteURL })).destinationOrigin).toBeNull();
  });
}

test("destinationOrigin strips credentials, paths, queries and fragments but keeps protocol and port", async () => {
  const names = load({ config: servedConfig({ siteURL: "http://editor:fixture@example.net:4000/path?q=x#fragment" }) });
  // Also exercise the supported quoted URL form.
  const parsed = names.parseServedConfig('site_url: "http://editor:fixture@example.net:4000/path?q=x"\n');
  expect(parsed.destinationOrigin).toBe("http://example.net:4000");
  expect(parsed.destination).toBe("example.net");
  await names.binding();
  expect(names.destinationOrigin()).toBe("http://example.net:4000");
});

for (const config of [undefined, new Error("offline"), ""]) {
  test(`destinationOrigin unreadable fallback keeps separate-admin public origin: ${String(config)}`, async () => {
    const names = load({
      origin: "https://admin.example.com/admin/", adminOrigin: "https://admin.example.com",
      siteOrigin: "http://example.net:4000", config, status: 404,
    });
    await names.binding();
    expect(names.destinationOrigin()).toBe("http://example.net:4000");
  });
}

test("destinationOrigin updates after delayed config, preserving local fallback port until settled", async () => {
  let answer;
  const config = new Promise((resolve) => { answer = resolve; });
  const names = load({ origin: "http://localhost:4000/admin/", config });
  const read = names.binding();
  expect(names.destinationOrigin()).toBe("http://localhost:4000");
  answer(servedConfig({ siteURL: "https://preview-pr7.example.com:8443/path" }));
  await read;
  expect(names.destinationOrigin()).toBe("https://preview-pr7.example.com:8443");
  expect(names.fetchCalls).toHaveLength(1);
});

test("destinationOrigin accepts an optional fallback before and after an unreadable config", async () => {
  for (const config of [new Error("offline"), "site_url: ftp://example.com\n"]) {
    const names = load({ origin: "https://www.example.com/admin/", siteOrigin: "https://example.com", config });
    expect(names.destinationOrigin("https://example.com")).toBe("https://example.com");
    await names.binding();
    expect(names.destinationOrigin("https://example.com")).toBe("https://example.com");
    expect(names.destinationOrigin()).toBe("https://www.example.com");
  }
});

test("destinationOrigin uses a served preview or local origin ahead of its optional fallback", async () => {
  for (const [origin, siteURL] of [
    ["https://preview-pr7.example.com/admin/", "https://preview-pr7.example.com:8443/path"],
    ["http://localhost:4000/admin/", "http://localhost:4000/path"],
  ]) {
    const names = load({ origin, config: servedConfig({ siteURL }) });
    expect(names.destinationOrigin("https://example.com")).toBe("https://example.com");
    await names.binding();
    const expected = siteURL.startsWith("https:") ? "https://preview-pr7.example.com:8443" : "http://localhost:4000";
    expect(names.destinationOrigin("https://example.com")).toBe(expected);
  }
});

for (const config of [new Error("offline"), "site_url: ftp://example.com\n"]) {
  test(`destinationOrigin unreadable local fallback preserves protocol and port: ${String(config)}`, async () => {
    const names = load({ origin: "http://localhost:4000/admin/", config });
    await names.binding();
    expect(names.destinationOrigin()).toBe("http://localhost:4000");
  });
}
