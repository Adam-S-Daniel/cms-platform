// @lane: local — pure-Node sandbox unit tests for sign-in-renewal.js and its hook in the fetch wrap
/*
 * A GitHub sign-in that ends mid-edit used to cost the typed work: Save
 * fails, the automatic save fails with it, and the reload needed to sign in
 * again loses the draft (#516 spike row 11). sign-in-renewal.js signs in
 * again in the same tab and swaps the dead token on later requests.
 *
 * Both shims run here in one vm sandbox, with Node's real Headers / Request /
 * Response, a fake network that answers 401 "Bad credentials" for any token
 * but the live one, and a small fake DOM. No browser, no network.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const RENEWAL_SRC = fs.readFileSync(path.join(ADMIN, "sign-in-renewal.js"), "utf8");
const WRAP_SRC = fs.readFileSync(path.join(ADMIN, "publish-via-auto-merge.js"), "utf8");

const API = "https://api.github.com";
const REPO = "TestOwner/test-repo";
const PROXY = "https://oauth.example.test";
const OLD = "ghu_old";
const NEW = "ghu_new";

function element(tag) {
  return {
    tag,
    id: "",
    children: [],
    attrs: {},
    style: { cssText: "", display: "" },
    textContent: "",
    listeners: {},
    removed: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(kind, fn) { this.listeners[kind] = fn; },
    appendChild(child) { this.children.push(child); },
    remove() { this.removed = true; },
  };
}

function boot({ user = { login: "Writer", token: OLD, backendName: "github" }, live = [], logins = {} } = {}) {
  const liveTokens = new Set(live);
  const network = []; // every request that really left the page
  const timers = [];
  const listeners = new Map();
  const opened = [];
  const bodyChildren = [];
  const classes = new Set();
  const local = new Map();
  const session = new Map();
  if (user) local.set("decap-cms-user", JSON.stringify(user));

  function fakeFetch(input, init) {
    const request = new Request(input, init);
    const auth = request.headers.get("Authorization") || "";
    const token = auth.replace(/^(token|bearer)\s+/i, "");
    network.push({ url: request.url, method: request.method, auth, rawInput: input, rawInit: init });
    if (!liveTokens.has(token)) {
      return Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 }));
    }
    if (request.url === `${API}/user`) return Promise.resolve(Response.json({ login: logins[token] || "Writer" }));
    return Promise.resolve(Response.json({ ok: true }));
  }

  const storage = (map) => ({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  });
  const document = {
    createElement: element,
    getElementById: (id) => bodyChildren.find((n) => n.id === id && !n.removed) || null,
    body: {
      get firstChild() { return bodyChildren[0] || null; },
      insertBefore: (node) => bodyChildren.unshift(node),
      appendChild: (node) => bodyChildren.push(node),
      classList: { add: (c) => classes.add(c) },
    },
  };
  const window = {
    fetch: fakeFetch,
    CMS_REPO: REPO,
    CMS_OAUTH_BASE_URL: PROXY,
    location: { href: "https://admin.example.test/admin/#/collections/posts/entries/a" },
    addEventListener: (kind, fn) => listeners.set(kind, fn),
    removeEventListener: (kind, fn) => { if (listeners.get(kind) === fn) listeners.delete(kind); },
    open: (url, name) => {
      const popup = { url, name, closed: false, posted: [], postMessage(d, o) { this.posted.push([d, o]); }, close() { this.closed = true; } };
      opened.push(popup);
      return popup;
    },
  };
  window.window = window;
  const sandbox = {
    window, document, Headers, Request, Response, URL,
    localStorage: storage(local), sessionStorage: storage(session),
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  window.Response = Response;
  vm.createContext(sandbox);
  vm.runInContext(RENEWAL_SRC, sandbox);
  vm.runInContext(WRAP_SRC, sandbox);

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const banner = () => document.getElementById("cms-sign-in-expired-banner");
  return {
    window, network, timers, opened, local, session, classes, liveTokens, settle, banner,
    renewal: window.CMSSignInRenewal,
    fetch: (input, init) => window.fetch(input, init),
    runTimers: () => { for (const t of timers.splice(0)) t.fn(); },
    message: (event) => { const fn = listeners.get("message"); if (fn) fn(event); },
    hasMessageListener: () => listeners.has("message"),
    storedToken: () => JSON.parse(local.get("decap-cms-user")).token,
    text: () => banner().children[0].textContent,
    button: () => banner().children[1],
  };
}

const withToken = (token, extra) => ({ headers: { Authorization: `token ${token}`, ...extra } });

// Drive the whole flow: a save fails on the dead token, the notice appears,
// the owner signs in again in the popup, the proxy hands back `token`.
async function expireAndSignIn(h, token = NEW) {
  await h.fetch(`${API}/repos/${REPO}/git/trees`, withToken(OLD));
  await h.settle();
  h.runTimers();
  h.button().listeners.click();
  const popup = h.opened[0];
  h.message({ origin: PROXY, source: popup, data: "authorizing:github" });
  h.message({ origin: PROXY, source: popup, data: `authorization:github:success:${JSON.stringify({ token, provider: "github" })}` });
  await h.settle();
  await h.settle();
  return popup;
}

test.describe("sign-in-renewal.js", () => {
  test("a request with a working sign-in goes out with the caller's own arguments", async () => {
    const h = boot({ live: [OLD] });
    const init = withToken(OLD);
    const res = await h.fetch(`${API}/repos/${REPO}/branches/main`, init);
    expect(res.status).toBe(200);
    expect(h.network[0].rawInit).toBe(init);
    await h.fetch(`${API}/rate_limit`);
    expect(h.network[1].rawInit).toBeUndefined();
    await h.settle();
    h.runTimers();
    expect(h.banner()).toBeNull();
  });

  test("GitHub's Bad credentials shows the notice in flow and marks the session", async () => {
    const h = boot();
    const res = await h.fetch(`${API}/repos/${REPO}/git/trees`, { method: "POST", ...withToken(OLD), body: "{}" });
    expect(res.status).toBe(401);
    await h.settle();
    expect(h.banner(), "nothing until the settle delay has passed").toBeNull();
    h.runTimers();
    expect(h.banner().attrs.role).toBe("alert");
    expect(h.banner().style.cssText).not.toMatch(/position\s*:\s*fixed/);
    expect(h.classes.has("cms-notice-band")).toBe(true);
    expect(h.text()).toContain("still on this page");
    expect(h.button().textContent).toBe("Sign in again");
    expect(h.session.get("cms-sign-in-expired")).toBe("1");
  });

  test("no notice when the stored session is gone by then (the editor's own sign-in page)", async () => {
    const h = boot();
    await h.fetch(`${API}/user`, withToken(OLD));
    await h.settle();
    h.local.delete("decap-cms-user");
    h.runTimers();
    expect(h.banner()).toBeNull();
    expect(h.session.has("cms-sign-in-expired")).toBe(false);
  });

  test("a 401 that is not Bad credentials does not end the session", async () => {
    const h = boot({ live: [OLD] });
    h.renewal.observe(`${API}/user`, withToken(OLD), Response.json({ message: "Requires authentication" }, { status: 401 }));
    await h.settle();
    h.runTimers();
    expect(h.banner()).toBeNull();
    expect((await h.fetch(`${API}/user`, withToken(OLD))).status).toBe(200);
  });

  test("a token known to be dead is answered here, not sent again", async () => {
    const h = boot();
    await h.fetch(`${API}/repos/${REPO}/pulls`, withToken(OLD));
    await h.settle();
    expect(h.network).toHaveLength(1);
    const again = await h.fetch(`${API}/repos/${REPO}/pulls`, withToken(OLD));
    expect(again.status).toBe(401);
    expect((await again.json()).message).toBe("Bad credentials");
    expect(h.network, "no second round trip").toHaveLength(1);
  });

  test("the popup handshake ignores every window but the proxy popup it opened", async () => {
    const h = boot();
    h.liveTokens.add(NEW);
    await h.fetch(`${API}/repos/${REPO}/git/trees`, withToken(OLD));
    await h.settle();
    h.runTimers();
    h.button().listeners.click();
    const popup = h.opened[0];
    expect(popup.url).toBe(`${PROXY}/prod/auth`);
    const success = `authorization:github:success:${JSON.stringify({ token: NEW })}`;
    h.message({ origin: "https://evil.example.test", source: popup, data: "authorizing:github" });
    h.message({ origin: "https://evil.example.test", source: popup, data: success });
    h.message({ origin: PROXY, source: { other: true }, data: success });
    await h.settle();
    expect(popup.posted).toEqual([]);
    expect(h.storedToken()).toBe(OLD);
    h.message({ origin: PROXY, source: popup, data: "authorizing:github" });
    expect(popup.posted, "the echo goes only to the checked origin").toEqual([["authorizing:github", PROXY]]);
  });

  test("after signing in again, the old token is swapped on every later request and the page is told", async () => {
    const h = boot();
    h.liveTokens.add(NEW);
    const popup = await expireAndSignIn(h);
    expect(popup.closed).toBe(true);
    expect(h.hasMessageListener()).toBe(false);
    expect(h.storedToken()).toBe(NEW);
    expect(h.session.has("cms-sign-in-expired")).toBe(false);
    expect(h.text()).toContain("signed in again");
    expect(h.button().style.display).toBe("none");

    // The editor still holds the old token in memory: all three call shapes.
    h.network.length = 0;
    const init = { method: "POST", headers: { authorization: `token ${OLD}`, "Content-Type": "application/json" }, body: "{}" };
    expect((await h.fetch(`${API}/repos/${REPO}/git/blobs`, init)).status).toBe(200);
    expect(init.headers.authorization, "the caller's init is never mutated").toBe(`token ${OLD}`);
    expect((await h.fetch(`${API}/user`, { headers: new Headers({ Authorization: `Bearer ${OLD}` }) })).status).toBe(200);
    expect((await h.fetch(new Request(`${API}/user`, { headers: { Authorization: `token ${OLD}` } }))).status).toBe(200);
    expect(h.network.map((n) => n.auth)).toEqual([`token ${NEW}`, `Bearer ${NEW}`, `token ${NEW}`]);
    expect(h.network[0].method).toBe("POST");
    expect(h.network[2].rawInit).toBeUndefined();

    h.runTimers();
    expect(h.banner(), "the confirmation clears itself").toBeNull();
  });

  test("the token is never swapped onto a request to another host", async () => {
    const h = boot();
    h.liveTokens.add(NEW);
    await expireAndSignIn(h);
    h.network.length = 0;
    const init = withToken(OLD);
    await h.fetch("https://elsewhere.example.test/api", init);
    expect(h.network[0].rawInit).toBe(init);
    expect(h.network[0].auth).toBe(`token ${OLD}`);
  });

  test("a sign-in as a different account is refused", async () => {
    const h = boot({ logins: { [NEW]: "SomeoneElse" } });
    h.liveTokens.add(NEW);
    await expireAndSignIn(h);
    expect(h.storedToken()).toBe(OLD);
    expect(h.text()).toContain("SomeoneElse");
    expect(h.button().style.display).toBe("");
    expect(h.session.get("cms-sign-in-expired")).toBe("1");
  });

  test("a stored session without a login is refused, since the account cannot be checked", async () => {
    const h = boot({ user: { token: OLD, backendName: "github" } });
    h.liveTokens.add(NEW);
    await expireAndSignIn(h);
    expect(h.storedToken()).toBe(OLD);
    expect(h.text()).toContain("did not work");
    expect(h.session.get("cms-sign-in-expired")).toBe("1");
  });

  test("a failed or malformed sign-in keeps the notice and the old session", async () => {
    const h = boot();
    await h.fetch(`${API}/repos/${REPO}/git/trees`, withToken(OLD));
    await h.settle();
    h.runTimers();
    h.button().listeners.click();
    h.message({ origin: PROXY, source: h.opened[0], data: 'authorization:github:error:{"error":"denied"}' });
    await h.settle();
    expect(h.storedToken()).toBe(OLD);
    expect(h.text()).toContain("did not work");
    expect(h.button().style.display).toBe("");
  });

  test("a blocked popup says so", async () => {
    const h = boot();
    await h.fetch(`${API}/repos/${REPO}/git/trees`, withToken(OLD));
    await h.settle();
    h.runTimers();
    h.window.open = () => null;
    h.button().listeners.click();
    expect(h.text()).toContain("pop-ups");
    expect(h.hasMessageListener()).toBe(false);
  });
});

test.describe("admin shells: sign-in-renewal load order", () => {
  test("index.html loads it non-deferred, before the fetch wrap that calls it", async () => {
    const { parse } = await import("parse5");
    const scripts = [];
    (function visit(node) {
      if (node.tagName === "script") {
        const attr = (name) => (node.attrs || []).find((a) => a.name === name);
        if (attr("src")) scripts.push({ src: attr("src").value, defer: !!attr("defer") });
      }
      for (const child of node.childNodes || []) visit(child);
      if (node.content) visit(node.content);
    })(parse(fs.readFileSync(path.join(ADMIN, "index.html"), "utf8")));
    const at = (src) => scripts.findIndex((s) => s.src === src);
    expect(at("sign-in-renewal.js")).toBeGreaterThan(-1);
    expect(scripts[at("sign-in-renewal.js")].defer).toBe(false);
    expect(at("sign-in-renewal.js")).toBeLessThan(at("publish-via-auto-merge.js"));
    expect(at("publish-via-auto-merge.js")).toBeLessThan(scripts.findIndex((s) => /decap-cms@/.test(s.src)));
  });

  test("the toast clearance measures the sign-in notice too", () => {
    const src = fs.readFileSync(path.join(ADMIN, "notice-toast-clearance.js"), "utf8");
    const values = new Map();
    let mutated;
    const notices = new Map();
    vm.runInNewContext(src, {
      document: {
        body: { style: {
          getPropertyValue: (k) => values.get(k) || "",
          setProperty: (k, v) => values.set(k, v),
          removeProperty: (k) => values.delete(k),
        } },
        getElementById: (id) => notices.get(id) || null,
      },
      window: { addEventListener() {} },
      MutationObserver: class { constructor(fn) { mutated = fn; } observe() {} },
    });
    notices.set("cms-sign-in-expired-banner", { getBoundingClientRect: () => ({ bottom: 64 }) });
    mutated();
    expect(values.get("--cms-admin-notice-bottom")).toBe("64px");
  });
});
