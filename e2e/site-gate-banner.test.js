// @lane: local — pure-Node sandbox unit tests for the site-gate banner (#528).
/*
 * theme/admin/site-gate-banner.js says, on every admin screen, when the site
 * is in coming-soon mode. The same admin is served from production and from
 * every PR preview, and each surface is built from its OWN branch, so the flag
 * must be read at the branch this admin is bound to and the copy must name the
 * host that branch is served on. It used to read the repository's default
 * branch, so a preview carrying the opposite value showed production's banner.
 *
 * These tests load the REAL site-hostname.js (which reads the served
 * config.yml once and exposes the branch and the destination host) and the
 * REAL site-gate-banner.js into one vm sandbox, with a fake DOM and a stubbed
 * fetch — no browser, no build, no network.
 *
 * Platform-internal: reads the platform's theme/admin SOURCE tree, which a
 * consumer does not have in that position, so it is registered in
 * PLATFORM_META_SPECS and testIgnored on a consumer lane.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "..", "theme", "admin");
const HOSTNAME = path.join(ADMIN, "site-hostname.js");
const GATE = path.join(ADMIN, "site-gate-banner.js");

const GATE_ID = "cms-site-gate-banner";
const REPO = "acme/example";
const PROD_ADMIN = "https://www.example.com/admin/";
const PREVIEW_ADMIN = "https://preview-pr12.example.com/admin/";
const PREVIEW_BRANCH = "claude/issue-528/opposite-gate";
const GATE_DECL = {
  path: "_data/settings.yml",
  field: "site_live",
  entry: "#/collections/settings/entries/settings",
  label: "coming-soon mode",
};

function fakeNode(tag) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: "",
    href: "",
    attrs: {},
    listeners: {},
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    style: { cssText: "" },
    classes: new Set(),
    classList: { add: (c) => el.classes.add(c), contains: (c) => el.classes.has(c) },
    children: [],
    parentNode: null,
    _text: "",
    get textContent() {
      return el.children.length ? el.children.map((c) => c.textContent).join("") : el._text;
    },
    set textContent(v) {
      el.children = [];
      el._text = String(v);
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in el.attrs ? el.attrs[k] : null;
    },
    appendChild(c) {
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      c.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i === -1) el.children.push(c);
      else el.children.splice(i, 0, c);
      return c;
    },
    remove() {
      const p = el.parentNode;
      if (!p) return;
      p.children.splice(p.children.indexOf(el), 1);
      el.parentNode = null;
    },
    get firstChild() {
      return el.children[0] || null;
    },
    get nextSibling() {
      const p = el.parentNode;
      return p ? p.children[p.children.indexOf(el) + 1] || null : null;
    },
  };
  return el;
}

function servedConfig(branch, siteURL) {
  return `backend:\n  name: github\n  repo: ${REPO}\n  branch: ${branch}\n\nsite_url: ${siteURL}\n`;
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * One admin page: `adminURL` is where the tab was opened, `served` the
 * config.yml that surface serves (null → unreadable), `flags` the
 * `site_live` value per branch in the repository (a missing branch → 404,
 * an Error → the request fails), `session` any sessionStorage already there.
 */
async function loadAdmin({ adminURL, served, flags, session = {}, hash = "" }) {
  const body = fakeNode("body");
  const find = (node, id) => {
    if (node.nodeType !== 1) return null;
    if (node.id === id) return node;
    for (const c of node.children) {
      const hit = find(c, id);
      if (hit) return hit;
    }
    return null;
  };
  const document = {
    body,
    readyState: "complete",
    baseURI: adminURL,
    createElement: fakeNode,
    getElementById: (id) => find(body, id),
    addEventListener() {},
  };
  const store = new Map(Object.entries(session));
  const location = new URL(adminURL);
  if (hash) location.hash = hash;
  const reloads = [];
  const pushes = [];
  const history = {
    pushState: (_s, _t, url) => {
      pushes.push(url);
      location.hash = url;
    },
  };
  location.reload = () => reloads.push(location.hash);
  const githubReads = [];
  const sandbox = {
    window: {
      location,
      history,
      CMS_REPO: REPO,
      CMS_SITE_ORIGIN: "https://example.com",
      CMS_APEX: "example.com",
      CMS_ADMIN_ORIGIN: "",
      CMS_PRODUCTION_BRANCH: "main",
      CMS_SITE_GATE: GATE_DECL,
    },
    document,
    URL,
    Date,
    Promise,
    MutationObserver: class {
      observe() {}
    },
    NodeFilter: { SHOW_TEXT: 4 },
    setInterval: () => 0,
    localStorage: { getItem: (k) => (k === "decap-cms-user" ? JSON.stringify({ token: "t0k3n" }) : null) },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    fetch(url) {
      const u = new URL(String(url));
      if (u.hostname === "api.github.com") {
        githubReads.push(String(url));
        const ref = u.searchParams.get("ref");
        const value = flags[ref];
        if (value instanceof Error) return Promise.reject(value);
        if (value === undefined) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
        const body = typeof value === "object" && value.raw !== undefined ? value.raw : `title: x\nsite_live: ${value}\n`;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
      }
      if (u.pathname.endsWith("/admin/config.yml") && served !== null) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(served) });
      }
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(HOSTNAME, "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(GATE, "utf8"), sandbox);
  for (let i = 0; i < 6; i += 1) await flush();
  return { banner: () => document.getElementById(GATE_ID), location, reloads, pushes, githubReads, store, body, api: sandbox.window.CMSSiteGate };
}

const production = (flags, extra = {}) =>
  loadAdmin({ adminURL: PROD_ADMIN, served: servedConfig("main", "https://example.com"), flags, ...extra });
const preview = (flags, extra = {}) =>
  loadAdmin({
    adminURL: PREVIEW_ADMIN,
    served: servedConfig(PREVIEW_BRANCH, "https://preview-pr12.example.com"),
    flags,
    ...extra,
  });

test.describe("site-gate-banner.js — reads the branch this admin is bound to (#528)", () => {
  test("main live, preview gated: the preview shows the banner naming the preview host; production does not", async () => {
    const flags = { main: "true", [PREVIEW_BRANCH]: "false" };
    const prod = await production(flags);
    expect(prod.banner(), "production's own branch is live").toBeNull();

    const pre = await preview(flags);
    const b = pre.banner();
    expect(b, "the preview's branch is gated, so the preview admin must say so").not.toBeNull();
    expect(b.textContent).toContain("preview-pr12.example.com is in coming-soon mode");
    expect(b.textContent, "the preview's banner is not about the production host").not.toMatch(/(^|[^.\w-])example\.com/);
  });

  test("main gated, preview live: production shows the banner naming the canonical host; the preview does not", async () => {
    const flags = { main: "false", [PREVIEW_BRANCH]: "true" };
    const pre = await preview(flags);
    expect(pre.banner(), "the preview's own branch is live — production's gate must not leak onto it").toBeNull();

    const prod = await production(flags);
    const b = prod.banner();
    expect(b).not.toBeNull();
    expect(
      b.textContent,
      "opened on www., the banner still names the canonical production host",
    ).toContain("example.com is in coming-soon mode");
    expect(b.textContent).not.toContain("www.example.com");
  });

  test("the contents API is asked for the bound branch, slashes encoded", async () => {
    const pre = await preview({ [PREVIEW_BRANCH]: "false" });
    expect(pre.githubReads).toEqual([
      `https://api.github.com/repos/${REPO}/contents/_data/settings.yml?ref=claude%2Fissue-528%2Fopposite-gate`,
    ]);
    const prod = await production({ main: "true" });
    expect(prod.githubReads).toEqual([`https://api.github.com/repos/${REPO}/contents/_data/settings.yml?ref=main`]);
  });

  for (const [label, flags] of [
    ["the settings file is missing on the branch (404)", {}],
    ["the settings request fails", { [PREVIEW_BRANCH]: new Error("offline") }],
    ["the value is not a plain boolean", { [PREVIEW_BRANCH]: '"no"' }],
  ]) {
    test(`says nothing when ${label}`, async () => {
      const pre = await preview(flags);
      expect(pre.banner()).toBeNull();
    });
  }

  test("says nothing, and reads nothing from GitHub, when the bound branch cannot be read", async () => {
    const pre = await loadAdmin({ adminURL: PREVIEW_ADMIN, served: null, flags: { main: "false" } });
    expect(pre.githubReads, "no branch → no guessed default-branch read").toEqual([]);
    expect(pre.banner()).toBeNull();
  });

  test("a cached production value cannot mask the preview's own value", async () => {
    // What earlier versions stored under one unscoped key, and what this
    // version stores for main — both say "live".
    const fresh = JSON.stringify({ at: Date.now(), live: true });
    const mainKey = `cms-site-gate-state:${JSON.stringify([REPO, "main", GATE_DECL.path, GATE_DECL.field])}`;
    const pre = await preview(
      { [PREVIEW_BRANCH]: "false" },
      { session: { "cms-site-gate-state": fresh, [mainKey]: fresh } },
    );
    expect(pre.githubReads.length, "the preview branch has no cached value of its own, so it is read").toBe(1);
    expect(pre.banner(), "the preview's own gated value wins").not.toBeNull();
    const previewKey = `cms-site-gate-state:${JSON.stringify([REPO, PREVIEW_BRANCH, GATE_DECL.path, GATE_DECL.field])}`;
    expect(JSON.parse(pre.store.get(previewKey)).live).toBe(false);
    expect(JSON.parse(pre.store.get(mainKey)).live, "production's entry is left alone").toBe(true);
  });

  test("a value cached for the same branch is used without a request", async () => {
    const previewKey = `cms-site-gate-state:${JSON.stringify([REPO, PREVIEW_BRANCH, GATE_DECL.path, GATE_DECL.field])}`;
    const pre = await preview(
      { [PREVIEW_BRANCH]: "true" },
      { session: { [previewKey]: JSON.stringify({ at: Date.now(), live: false }) } },
    );
    expect(pre.githubReads).toEqual([]);
    expect(pre.banner()).not.toBeNull();
  });
});

// #624 — Decap 3.15.1 mounts an entry editor on an entry→entry hash change
// without loading the entry: the form is empty under "Changes saved" (F5
// fixes it). The banner link is an entry route rendered inside the entry
// editor, so it must force a full page load when clicked from an entry route.
test.describe("site-gate-banner.js — the link survives entry → entry navigation (#624)", () => {
  const link = (pre) => pre.banner().children.find((c) => c.tagName === "A");
  const click = (pre) => {
    const ev = { prevented: false, button: 0, preventDefault() { this.prevented = true; } };
    for (const fn of link(pre).listeners.click || []) fn(ev);
    return ev;
  };

  test("clicked from inside an entry: lands on the target hash with a full reload", async () => {
    const pre = await production({ main: "false" }, { hash: "#/collections/media/entries/some-item" });
    const ev = click(pre);
    expect(ev.prevented, "the in-app hash change is what leaves the form blank").toBe(true);
    expect(pre.pushes, "pushState, so no hashchange reaches Decap's router").toEqual([GATE_DECL.entry]);
    expect(pre.reloads, "reloaded once, at the target").toEqual([GATE_DECL.entry]);
  });

  test("clicked from a non-entry route: left to the browser, no reload", async () => {
    for (const hash of ["", "#/", "#/collections/media", "#/collections/media/new"]) {
      const pre = await production({ main: "false" }, { hash });
      const ev = click(pre);
      expect(ev.prevented, `hash ${JSON.stringify(hash)}`).toBe(false);
      expect(pre.reloads).toEqual([]);
      expect(pre.pushes).toEqual([]);
    }
  });

  test("a modified click (new tab) is left alone even inside an entry", async () => {
    const pre = await production({ main: "false" }, { hash: "#/collections/media/entries/x" });
    const fns = link(pre).listeners.click || [];
    for (const mod of ["ctrlKey", "metaKey", "shiftKey"]) {
      const ev = { [mod]: true, button: 0, preventDefault() { this.prevented = true; } };
      fns.forEach((fn) => fn(ev));
      expect(ev.prevented, mod).toBeUndefined();
    }
    expect(pre.reloads).toEqual([]);
  });
});

// Only a TOP-LEVEL key at column 0, spelled exactly as declared, is the gate.
// An indented line is a nested key or the body of a block scalar; a
// differently-cased key is another key. Each of these files is valid YAML
// whose real `site_live` is TRUE, and the old line regex (any indentation,
// any case) read FALSE — a coming-soon banner over a live site.
test.describe("site-gate-banner.js — only the top-level key is the gate", () => {
  for (const [label, raw] of [
    ["a nested key of the same name", "launch:\n  site_live: false\nsite_live: true\n"],
    ["a block scalar whose text looks like the key", "notes: |\n  site_live: false\nsite_live: true\n"],
    ["a differently-cased key", "Site_Live: false\nsite_live: true\n"],
  ]) {
    test(`reads the top-level value past ${label}`, async () => {
      const pre = await preview({ [PREVIEW_BRANCH]: { raw } });
      expect(pre.api.parseFlag(raw)).toBe(true);
      expect(pre.banner(), "the site is live — no coming-soon banner").toBeNull();
    });
  }

  test("YAML boolean spellings count; anything else, or an ambiguous file, is unknown", async () => {
    const { api } = await preview({ [PREVIEW_BRANCH]: "true" });
    expect(api.parseFlag("site_live: False\n")).toBe(false);
    expect(api.parseFlag("site_live: TRUE   # launched\n")).toBe(true);
    expect(api.parseFlag("site_live: false\r\ntitle: x\r\n"), "CRLF line endings").toBe(false);
    expect(api.parseFlag("site_live: tRuE\n"), "not a YAML boolean").toBeNull();
    expect(api.parseFlag('site_live: "false"\n'), "quoted is a string").toBeNull();
    expect(api.parseFlag("  site_live: false\n"), "indented only — no top-level key").toBeNull();
    expect(api.parseFlag("site_live: false\nsite_live: true\n"), "a duplicate key").toBeNull();
    expect(api.parseFlag("site_live_extra: false\n"), "a longer key").toBeNull();
  });
});
