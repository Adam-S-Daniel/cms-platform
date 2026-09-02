/**
 * Admin shims must not let the browser cache a GitHub API read (#386).
 *
 * GitHub REST responses carry `Cache-Control: private, max-age=60`, and a
 * browser `fetch()` honours it: for 60 s after any GET, the same URL is
 * answered from Chromium's HTTP cache without touching the network. For a
 * POLLER that is fatal — every `refresh()` inside that minute returns the
 * snapshot from before the thing it is polling for happened.
 *
 * Measured on adamdaniel.ai host-loop run 33580693718 (platform v0.1.100):
 * publish-button.js labelled PR #3489 `cms/ready` at 01:48:58.657; the
 * harness then drove publish-progress.js's refresh() every 2 s; every
 * `GET /pulls?state=open` from 01:48:58.658 to 01:49:54.7 completed in
 * ONE millisecond (a real round trip is 150-500 ms); the first genuine
 * read at 01:49:56.7 is the tick that saw `armed`. The PR had merged by
 * 01:51:03 while the editor's bar still said the publish had not started.
 *
 * Two tests. The behavioural one loads publish-progress.js in a vm
 * sandbox on an entry route and asserts every request it makes opts out
 * of the cache. The lint parses every shim under theme/admin/ (acorn —
 * the house rule; a regex cannot tell a fetch inside a comment from a real
 * one) and requires every fetch() with an object-literal init to declare
 * either `cache` or a non-GET `method`. A DELETE/POST is never cached, so
 * the mutation calls need nothing.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const NO_CACHE = "no-cache";

function loadProgressOnEntryRoute() {
  const src = fs.readFileSync(path.join(ADMIN, "publish-progress.js"), "utf8");
  const fetchCalls = [];
  const sandbox = {
    window: { CMS_REPO: "owner/repo", addEventListener() {} },
    document: { hidden: false, readyState: "complete", addEventListener() {} },
    location: { hash: "#/collections/posts/entries/hello" },
    localStorage: { getItem: (k) => (k === "decap-cms-user" ? JSON.stringify({ token: "t0k3n" }) : null) },
    setInterval: () => 0,
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), init: init || {} });
      // An empty open-PR list is the shortest honest path: one /pulls read,
      // then the deployment pair. Three requests, all GETs.
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    },
    console: { info() {}, warn() {} },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.CMSPublishProgress;
  expect(api && typeof api.refresh, "publish-progress.js must export refresh()").toBe("function");
  return { api, fetchCalls };
}

test.describe("publish-progress.js reads GitHub past the browser's HTTP cache (#386)", () => {
  test("every request a tick makes carries cache: no-cache", async () => {
    const { api, fetchCalls } = loadProgressOnEntryRoute();
    await api.refresh();
    expect(fetchCalls.length, "a tick on an entry route must fetch").toBeGreaterThan(0);
    for (const c of fetchCalls) {
      expect(c.init.cache, `${c.url} must opt out of the HTTP cache`).toBe(NO_CACHE);
    }
  });
});

// ── The lint ───────────────────────────────────────────────────────────

function parse(src) {
  return acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true });
}

function propNamed(obj, name) {
  return obj.properties.find(
    (p) =>
      p.type === "Property" &&
      ((p.key.type === "Identifier" && p.key.name === name) ||
        (p.key.type === "Literal" && p.key.value === name)),
  );
}

/**
 * Every `fetch(<url>, {…})` in the source whose init literal names neither
 * `cache` nor a non-GET `method`. A fetch with no init, or an init that is
 * not an object literal, is reported too — the wrapper in
 * deploy-status-pill.js builds its literal at the fetch call for exactly
 * this reason.
 */
function uncachedGetFetches(src) {
  const out = [];
  walk.simple(parse(src), {
    CallExpression(node) {
      if (!(node.callee.type === "Identifier" && node.callee.name === "fetch")) return;
      const init = node.arguments[1];
      const line = node.loc ? node.loc.start.line : "?";
      if (!init || init.type !== "ObjectExpression") {
        out.push(`line ${line}: fetch() without an object-literal init`);
        return;
      }
      if (propNamed(init, "cache")) return;
      const method = propNamed(init, "method");
      if (method && method.value.type === "Literal" && String(method.value.value).toUpperCase() !== "GET") return;
      out.push(`line ${line}: GET fetch() without cache:`);
    },
  });
  return out;
}

test.describe("every admin shim's GitHub GET opts out of the HTTP cache (#386)", () => {
  const shims = fs.readdirSync(ADMIN).filter((f) => f.endsWith(".js"));
  for (const f of shims) {
    test(`${f}`, () => {
      const src = fs.readFileSync(path.join(ADMIN, f), "utf8");
      if (!/\bfetch\s*\(/.test(src)) return; // nothing to police
      const findings = uncachedGetFetches(src);
      expect(findings, `${f}: ${findings.join("; ")}`).toEqual([]);
    });
  }

  test("the detector fails on a bare GET and passes cache: / non-GET method", () => {
    expect(uncachedGetFetches('fetch("https://api.github.com/x", { headers: {} });')).toHaveLength(1);
    expect(uncachedGetFetches("fetch(u);")).toHaveLength(1);
    expect(uncachedGetFetches('fetch(u, { headers: {}, cache: "no-cache" });')).toEqual([]);
    expect(uncachedGetFetches('fetch(u, { method: "POST", headers: {} });')).toEqual([]);
    expect(uncachedGetFetches('fetch(u, { method: "GET" });')).toHaveLength(1);
    expect(uncachedGetFetches('// fetch(u)\nvar s = "fetch(u)";')).toEqual([]);
  });
});
