// @lane: local — pure-Node sandbox unit tests for the branch-binding banner (#412).
/*
 * theme/admin/branch-binding-banner.js says, at the top of every admin screen,
 * which branch the admin is bound to whenever that is not the branch the site
 * deploys to production from — the preview-deploy case, where
 * scripts/patch-preview-config.sh has rewritten the served config.yml's
 * `backend.branch` to the PR head. This file drives the shim in a vm sandbox
 * with a fake DOM and a fake fetch — no browser, no build, no network — the
 * pattern of admin-github-fetch-cache.test.js and
 * single-entry-collection-shortcut.test.js.
 *
 * WHAT THE PURE-FS LINTS CANNOT SEE
 * admin-publishing-ux.test.js asserts the file exists, is wired into the
 * production shell only, paints no fixed overlay and hardcodes no branch name.
 * None of that says the banner RENDERS for a patched config and STAYS QUIET for
 * the production one — the two verdicts that are the whole feature. And the
 * decisive contract is a cross-language one: the reader in this shim must
 * parse exactly the line shape the bash writer emits. So the lockstep test
 * below runs the REAL patch script on the REAL base template and feeds its
 * output to the REAL reader. A drift on either side reds it.
 *
 * Platform-internal: reads the platform's theme/admin SOURCE tree and
 * scripts/, neither of which a consumer has in that position (it ships only
 * the gem-rendered _site/admin), so this file is registered in
 * PLATFORM_META_SPECS and testIgnored on a consumer lane.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const ADMIN = path.join(REPO_ROOT, "theme", "admin");
const SHIM = path.join(ADMIN, "branch-binding-banner.js");
const GATE = path.join(ADMIN, "site-gate-banner.js");
const BASE_CONFIG = path.join(ADMIN, "config.base.yml");
const PATCH = path.join(REPO_ROOT, "scripts", "patch-preview-config.sh");

const BANNER_ID = "cms-branch-binding-banner";
const GATE_ID = "cms-site-gate-banner";
const PR_BRANCH = "claude/issue-412-release-deploy-jhmjix";
const ADMIN_URL = "https://preview-pr9999.example.test/admin/";

// ── A DOM small enough to read in one screen ──────────────────────────────
// The shims use createElement / createTextNode / appendChild / insertBefore /
// remove / getElementById / firstChild / nextSibling / textContent /
// setAttribute, and nothing else. Anything they touch beyond this list throws,
// which is the point: a shim that starts leaning on more DOM than this fails
// here loudly rather than silently in a browser nobody is watching.
function fakeNode(tag) {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: "",
    href: "",
    target: "",
    rel: "",
    attrs: {},
    style: { cssText: "" },
    classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c),
      contains: (c) => el.classes.has(c),
    },
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
      if (c.parentNode) c.remove();
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
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
      if (!p) return null;
      return p.children[p.children.indexOf(el) + 1] || null;
    },
  };
  return el;
}

function fakeTextNode(s) {
  return { nodeType: 3, textContent: String(s), parentNode: null, remove() {} };
}

function fakeDocument() {
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
  return {
    body,
    readyState: "complete",
    baseURI: ADMIN_URL,
    createElement: fakeNode,
    createTextNode: fakeTextNode,
    getElementById: (id) => find(body, id),
    addEventListener() {},
  };
}

function findAnchor(node) {
  if (node.nodeType !== 1) return null;
  if (node.tagName === "A") return node;
  for (const c of node.children) {
    const hit = findAnchor(c);
    if (hit) return hit;
  }
  return null;
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * A sandbox carrying the injected identity the render paths write, a fake
 * document, and a fetch that answers the served config.yml (and, for the
 * ordering tests, the gate flag's GitHub read).
 */
function sandboxFor({ production, config, status = 200, gate = null, siteLive = "false" }) {
  const document = fakeDocument();
  const fetchCalls = [];
  const sandbox = {
    window: {
      CMS_REPO: "acme/example",
      CMS_APEX: "example.test",
      CMS_SITE_ORIGIN: "https://example.test",
      CMS_SITE_GATE: gate,
    },
    document,
    URL,
    setInterval: () => 0,
    console: { info() {}, warn() {} },
    localStorage: {
      getItem: (k) => (k === "decap-cms-user" ? JSON.stringify({ token: "t0k3n" }) : null),
    },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch(url, init) {
      fetchCalls.push({ url: String(url), init: init || {} });
      if (String(url).includes("api.github.com")) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(`site_live: ${siteLive}\n`) });
      }
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(config),
      });
    },
  };
  if (production !== undefined) sandbox.window.CMS_PRODUCTION_BRANCH = production;
  vm.createContext(sandbox);
  return { sandbox, document, fetchCalls };
}

function run(sandbox, file) {
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox);
}

async function loadShim(opts) {
  const ctx = sandboxFor(opts);
  run(ctx.sandbox, SHIM);
  await flush();
  await flush();
  return { ...ctx, api: ctx.sandbox.window.CMSBranchBinding, banner: () => ctx.document.getElementById(BANNER_ID) };
}

const productionConfig = "backend:\n  name: github\n  repo: acme/example\n  branch: main\n\nsite_url: https://example.test\n";
const previewConfig = productionConfig.replace("  branch: main", `  branch: ${PR_BRANCH}`);

test.describe("branch-binding-banner.js — the two verdicts (#412)", () => {
  test("is inert when window.CMS_PRODUCTION_BRANCH was not injected — no fetch, no banner", async () => {
    const { fetchCalls, banner, api } = await loadShim({ production: undefined, config: previewConfig });
    expect(fetchCalls, "a shim with no production branch to compare against must not even fetch").toEqual([]);
    expect(banner()).toBeNull();
    expect(api, "no API is exported when the shim is inert").toBeUndefined();
  });

  test("says nothing when the served branch IS the production branch", async () => {
    const { fetchCalls, banner, document } = await loadShim({ production: "main", config: productionConfig });
    expect(fetchCalls.length, "one read of the served config").toBe(1);
    expect(fetchCalls[0].url).toBe(`${ADMIN_URL}config.yml`);
    expect(fetchCalls[0].init.cache, "read past the HTTP cache, like every other admin GET").toBe("no-cache");
    expect(banner()).toBeNull();
    expect(
      document.body.classList.contains("cms-notice-band"),
      "no banner, no layout change — a production admin must not be re-laid-out for nothing",
    ).toBe(false);
  });

  test("names the served branch when it differs, links its pull request, and names the production site", async () => {
    const { document, banner } = await loadShim({ production: "main", config: previewConfig });
    const b = banner();
    expect(b, "the banner must render for a served branch that is not production").not.toBeNull();
    expect(document.body.firstChild, "it is the FIRST thing on the page").toBe(b);
    expect(b.getAttribute("role")).toBe("status");
    expect(b.getAttribute("data-visreg-ignore"), "UI chrome, excluded from the visual-regression text diff").not.toBeNull();
    const text = b.textContent;
    expect(text).toContain(PR_BRANCH);
    expect(text, "the copy names where the change ends up — the production apex").toContain("example.test");
    expect(text).toMatch(/pull request/i);
    expect(
      document.body.classList.contains("cms-notice-band"),
      "body must carry cms-notice-band so admin-notice-band.css makes room for the banner " +
        "under Decap's viewport-anchored editor (measured: it paints over a bare in-flow banner)",
    ).toBe(true);
    const a = findAnchor(b);
    expect(a, "the pull request is a link").not.toBeNull();
    expect(a.href).toBe(
      "https://github.com/acme/example/pulls?q=" + encodeURIComponent(`is:pr head:${PR_BRANCH}`),
    );
    expect(a.target).toBe("_blank");
    expect(a.rel).toContain("noopener");
  });

  test("renders once — a second refresh neither duplicates nor recreates the banner", async () => {
    const { document, api, banner } = await loadShim({ production: "main", config: previewConfig });
    const first = banner();
    await api.refresh();
    await flush();
    expect(document.body.children.filter((c) => c.id === BANNER_ID).length).toBe(1);
    expect(banner(), "the same node — permanent while it applies, never re-created").toBe(first);
  });

  for (const [label, opts] of [
    ["config.yml cannot be read (404)", { config: previewConfig, status: 404 }],
    ["config.yml carries no `  branch:` line", { config: "backend:\n  name: github\n" }],
    ["the value is not a plain git ref name (markup)", { config: "backend:\n  branch: <b>x</b>\n" }],
    ["the value is not a plain git ref name (two words)", { config: "backend:\n  branch: two words\n" }],
    ["the value is quoted (not the shape the writer emits)", { config: 'backend:\n  branch: "claude/x"\n' }],
  ]) {
    test(`says nothing rather than guessing when ${label}`, async () => {
      const { banner } = await loadShim({ production: "main", ...opts });
      expect(banner()).toBeNull();
    });
  }
});

test.describe("branch-binding-banner.js — the reader mirrors the writer", () => {
  // THE contract that matters. patch-preview-config.sh rewrites `^  branch:`
  // with sed; the shim reads the same anchor back. Neither side can see the
  // other, so this test runs the real script on the real template and hands
  // the bytes it wrote to the real reader.
  test("parses exactly the line patch-preview-config.sh writes into the real base template", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "branch-binding-"));
    const cfg = path.join(tmp, "config.yml");
    fs.copyFileSync(BASE_CONFIG, cfg);
    execFileSync(PATCH, [cfg, "9999", PR_BRANCH, "preview-pr9999.example.test"], { stdio: "pipe" });
    const patched = fs.readFileSync(cfg, "utf8");

    const { api, banner } = await loadShim({ production: "main", config: patched });
    expect(api.parseBranch(patched)).toBe(PR_BRANCH);
    expect(banner(), "the real patched config must render the banner").not.toBeNull();
    expect(banner().textContent).toContain(PR_BRANCH);
  });

  test("reads the unpatched template as its production branch — so a production admin stays quiet", async () => {
    const { api } = await loadShim({ production: "main", config: productionConfig });
    const base = fs.readFileSync(BASE_CONFIG, "utf8");
    expect(api.parseBranch(base), "config.base.yml's backend.branch, as the reader sees it").toBe("main");
  });

  test("a comment after the value does not become part of the branch name", async () => {
    const { api } = await loadShim({ production: "main", config: productionConfig });
    expect(api.parseBranch("backend:\n  branch: release/1.2   # the branch\n")).toBe("release/1.2");
  });
});

test.describe("branch-binding-banner.js + site-gate-banner.js — a fixed reading order", () => {
  // Both banners are permanent, in-flow blocks at the top of <body>, and both
  // insert themselves after an async read. Without a rule, whichever fetch
  // resolved LAST would be on top, and the two would swap places between
  // loads. The rule: the branch banner is always first, the gate second.
  const gate = { path: "_data/settings.yml", field: "site_live", entry: "#/collections/x/entries/y", label: "coming-soon mode" };

  for (const [order, files] of [
    ["branch banner first, gate second", [SHIM, GATE]],
    ["gate first, branch banner second", [GATE, SHIM]],
  ]) {
    test(`reads branch → gate when loaded ${order}`, async () => {
      const { sandbox, document } = sandboxFor({ production: "main", config: previewConfig, gate });
      for (const f of files) {
        run(sandbox, f);
        await flush();
        await flush();
        await flush();
      }
      expect(document.body.children.map((c) => c.id)).toEqual([BANNER_ID, GATE_ID]);
    });
  }

  test("the gate banner alone still lands at the top of the page", async () => {
    const { sandbox, document } = sandboxFor({ production: "main", config: productionConfig, gate });
    run(sandbox, GATE);
    await flush();
    await flush();
    await flush();
    expect(document.body.children.map((c) => c.id)).toEqual([GATE_ID]);
  });

  // The gate copy used to say "the whole site … nothing you publish is
  // visible to the public" — read on a preview admin, where a publish changes
  // the preview and reaches the public site only on merge, every clause named
  // the wrong surface. It now names the public site by its apex, which is
  // true from either host.
  test("the gate banner names the public site by its apex, so its copy is true on a preview too", async () => {
    const { sandbox, document } = sandboxFor({ production: "main", config: productionConfig, gate });
    run(sandbox, GATE);
    await flush();
    await flush();
    await flush();
    const g = document.getElementById(GATE_ID);
    expect(g).not.toBeNull();
    expect(document.body.classList.contains("cms-notice-band"), "the gate banner reserves the band too").toBe(true);
    expect(g.textContent).toContain("example.test");
    expect(g.textContent).toContain("coming-soon mode");
    expect(g.textContent, "no clause may claim what 'you publish' does — that differs by host").not.toMatch(/you publish/i);
  });
});
