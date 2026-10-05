// @lane: local — pure-Node behavioral test for posts-list-enhance.js on a preview admin (vm sandbox, scripted fetch)
/*
 * #642: on a preview admin (`preview-pr<N>.<apex>/admin/`, bound to the PR's
 * own branch) the Posts list pointed editors at hosts and data that are not
 * the preview:
 *
 *   - "published ↗" linked to production, not to the preview the list edits;
 *   - "preview draft ↗" linked a `cms/preview-only` draft to
 *     `preview-pr<draft PR>.<apex>`, which deploy-preview never builds (it
 *     builds only PRs into the default branch);
 *   - the freshness line reported production's deployment;
 *   - a signed-in editor was told "Sign in to see publishing details"
 *     whenever the bar had no deployment to show — e.g. landing back on the
 *     list after a delete, before the refresh had answered.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/posts-list-enhance.js"), "utf8");
const API = "https://api.github.com/repos/owner/repo";
const PULLS = `${API}/pulls?state=open&per_page=100`;
const PREVIEW_ORIGIN = "https://preview-pr7.example.com";
const PREVIEW_BRANCH = "claude/feature";
const HEAD_PULLS = `${API}/pulls?state=open&head=${encodeURIComponent(`owner:${PREVIEW_BRANCH}`)}&per_page=1`;
const SLUG = "2026-09-28-hello";

function load({ routes = {}, token = "t0k3n", branch = PREVIEW_BRANCH, destinationOrigin = PREVIEW_ORIGIN } = {}) {
  const calls = [];
  const window = {
    CMS_REPO: "owner/repo",
    CMS_SITE_ORIGIN: "https://example.com",
    CMS_APEX: "example.com",
    CMS_PRODUCTION_BRANCH: "main",
    CMSHostname: {
      canonical: () => "example.com",
      destination: () => new URL(destinationOrigin).hostname,
      destinationOrigin: () => destinationOrigin,
      binding: () => Promise.resolve({ branch, destination: null, destinationOrigin: null }),
    },
    location: { hash: "#/" }, // not the list route — nothing runs at load
    addEventListener() {},
  };
  const sandbox = {
    window,
    document: {
      readyState: "complete",
      body: {},
      addEventListener() {},
      createElement: () => ({ className: "", innerHTML: "" }),
    },
    requestAnimationFrame: () => 0,
    MutationObserver: class {
      observe() {}
    },
    localStorage: { getItem: (k) => (k === "decap-cms-user" && token ? JSON.stringify({ token }) : null) },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: (url) => {
      const u = String(url);
      calls.push(u);
      const hit = routes[u];
      if (hit === undefined || hit === null) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hit) });
    },
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { hook: window.__postsListEnhance, calls };
}

function card() {
  const li = {
    children: [],
    querySelector: () => li.children[0] || null,
    appendChild: (c) => li.children.push(c),
  };
  return {
    li,
    slug: SLUG,
    filePath: `_posts/${SLUG}.md`,
    title: "Hello",
    state: { label: "Published", color: "#1a7f37", live: true },
    isFixture: false,
    postDate: null,
  };
}

function render(hook, pr) {
  const c = card();
  hook.decorate(c, {
    lastEdited: { [c.filePath]: { url: null, pr: null } },
    prBySlug: pr ? { [SLUG]: pr } : {},
  });
  return c.li.children[0].innerHTML;
}

const openPr = (base, labels = []) => ({
  number: 42,
  html_url: "https://github.com/owner/repo/pull/42",
  head: { ref: `cms/posts/${SLUG}`, sha: "a".repeat(40) },
  base: { ref: base, repo: { default_branch: "main" } },
  labels,
  auto_merge: null,
});

test.describe("posts-list-enhance.js links on a preview admin (#642)", () => {
  test('"published ↗" opens the post on the preview this admin publishes to, not production', () => {
    const { hook } = load();
    const html = render(hook, null);
    expect(html).toContain(`href="${PREVIEW_ORIGIN}/blog/hello/"`);
    expect(html).not.toContain('href="https://example.com/');
  });

  test("a preview-only draft gets no link to a preview-pr<N> host, and is pointed at Live Preview", () => {
    const { hook } = load();
    const html = render(hook, { number: 42, url: "https://github.com/owner/repo/pull/42", previewOnly: true });
    expect(html).not.toContain("preview-pr42");
    expect(html).toContain("draft — open to preview");
    expect(html).toContain("Live Preview");
    expect(html).toContain("view draft changes");
  });

  test("a draft PR into the default branch keeps its per-PR preview link", () => {
    const { hook } = load({ branch: "main", destinationOrigin: "https://example.com" });
    const html = render(hook, { number: 42, url: "https://github.com/owner/repo/pull/42", previewOnly: false });
    expect(html).toContain('href="https://preview-pr42.example.com/blog/hello/"');
  });

  for (const [name, pr, expected] of [
    ["base is a feature branch", openPr(PREVIEW_BRANCH), true],
    ["labeled cms/preview-only", openPr("main", [{ name: "cms/preview-only" }]), true],
    ["base is the default branch", openPr("main"), false],
  ]) {
    test(`fetchOpenPrBySlug marks previewOnly=${expected} when ${name}`, async () => {
      const { hook } = load({ routes: { [PULLS]: [pr] } });
      const map = await hook.fetchOpenPrBySlug("t0k3n");
      expect(map[SLUG].previewOnly).toBe(expected);
    });
  }
});

test.describe("posts-list-enhance.js freshness is the preview's own deployment on a preview admin (#642)", () => {
  test("on the production branch the bar reads production, with no extra request", async () => {
    const { hook, calls } = load({ branch: "main", destinationOrigin: "https://example.com" });
    const target = await hook.deployTarget("t0k3n");
    expect(target.environment).toBe("production");
    expect(target.onPreview).toBe(false);
    expect(calls).toEqual([]);
  });

  test("on a preview branch the bar reads the preview-pr-<N> environment of the branch's own PR", async () => {
    const { hook } = load({ routes: { [HEAD_PULLS]: [{ number: 7 }] } });
    const target = await hook.deployTarget("t0k3n");
    expect(target.environment).toBe("preview-pr-7");
    expect(target.onPreview).toBe(true);
  });

  test("on a preview branch with no findable PR the bar reads nothing — never production", async () => {
    const { hook } = load();
    const target = await hook.deployTarget("t0k3n");
    expect(target.environment).toBe(null);
    expect(target.onPreview).toBe(true);
  });

  test("a refresh on a preview admin reads the preview's deployment and never production's", async () => {
    const { hook, calls } = load({
      routes: {
        [HEAD_PULLS]: [{ number: 7 }],
        [`${API}/deployments?environment=preview-pr-7&per_page=1`]: [{ id: 99 }],
        [`${API}/deployments/99/statuses?per_page=1`]: [
          { state: "success", created_at: null, log_url: "https://github.com/owner/repo/actions/runs/5" },
        ],
      },
    });
    const data = await hook.refreshRemote([]);
    expect(data.onPreview).toBe(true);
    expect(data.siteDeploy.url).toBe("https://github.com/owner/repo/actions/runs/5");
    expect(calls.some((u) => u.includes("environment=production"))).toBe(false);
    expect(hook.publishingBarHTML(data, true)).toBe(
      'preview-pr7.example.com <a href="https://github.com/owner/repo/actions/runs/5" target="_blank" rel="noopener">updated</a>',
    );
  });
});

test.describe('posts-list-enhance.js says "Sign in" only when signed out (#642)', () => {
  test("signed out → sign in", () => {
    const { hook } = load({ token: null });
    expect(hook.publishingBarHTML(null, false)).toContain("Sign in to see publishing details");
  });

  test("signed in, first read not landed yet (e.g. back on the list after a delete) → loading, not sign in", () => {
    const { hook } = load();
    const html = hook.publishingBarHTML(null, true);
    expect(html).toContain(hook.publishingBarCopy().loading);
    expect(html).not.toContain("Sign in");
  });

  test("signed in, the read found no deployment → status unknown, not sign in", () => {
    const { hook } = load({ branch: "main", destinationOrigin: "https://example.com" });
    expect(hook.publishingBarHTML({ siteDeploy: null, onPreview: false }, true)).toBe(
      "example.com update status unknown",
    );
  });

  test("the loading words carry no internal vocabulary", () => {
    const { hook } = load();
    expect(hook.publishingBarCopy().loading).not.toMatch(/\b(deploy|PR)\b/);
  });
});
