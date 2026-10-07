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
const LIVE_URL_SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/live-url-derive.js"), "utf8");
const CONFIG_BASE = path.resolve(__dirname, "../theme/admin/config.base.yml");
const API = "https://api.github.com/repos/owner/repo";
const PULLS = `${API}/pulls?state=open&per_page=100`;
const PREVIEW_ORIGIN = "https://preview-pr7.example.com";
const PREVIEW_BRANCH = "claude/feature";
const HEAD_PULLS = `${API}/pulls?state=open&head=${encodeURIComponent(`owner:${PREVIEW_BRANCH}`)}&per_page=1`;
const SLUG = "2026-09-28-hello";

function load({
  routes = {},
  token = "t0k3n",
  branch = PREVIEW_BRANCH,
  destinationOrigin = PREVIEW_ORIGIN,
  anchors = [],
  withLiveUrl = false,
} = {}) {
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
      querySelectorAll: () => anchors,
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
  // live-url-derive.js owns the slugify the list reuses; the real admin loads
  // it first (index*.html), so a test that checks slugification does too.
  if (withLiveUrl) vm.runInContext(LIVE_URL_SRC, sandbox);
  vm.runInContext(SRC, sandbox);
  return { hook: window.__postsListEnhance, calls };
}

function card(extra = {}) {
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
    ...extra,
  };
}

function render(hook, pr, extra = {}) {
  const c = card(extra);
  hook.decorate(c, {
    lastEdited: { [c.filePath]: { url: null, pr: null } },
    prBySlug: pr ? { [c.slug]: pr } : {},
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

// A post's public URL follows Jekyll's rules, not just its file name:
// `permalink: /blog/:slug/` takes :slug from the front-matter `slug:` when one
// is set, and a front-matter `permalink:` replaces the template. adamdaniel.ai's
// `_posts/2026-09-28-quoting-simon-willison-on-coding-agents.md` carries
// `slug: quoting-simon-willison-on-unlocking-coding-agents-potential`, so the
// list linked it at a 404 (cms-link-crawler.spec.js failed on the platform
// bump, adamdaniel.ai#4137; the link became same-origin in cms-platform#682).
const PROD_ORIGIN = "https://example.com";
const FILE_SLUG = "2026-09-28-quoting-simon-willison-on-coding-agents";
const FM_SLUG = "quoting-simon-willison-on-unlocking-coding-agents-potential";

function publishedHref(fm = {}, { origin = PROD_ORIGIN } = {}) {
  const { hook } = load({ destinationOrigin: origin, branch: "main", withLiveUrl: true });
  const html = render(hook, null, { slug: FILE_SLUG, ...fm });
  const m = /<a href="([^"]*)"[^>]*>published ↗<\/a>/.exec(html);
  return m ? m[1] : null;
}

test.describe("posts-list-enhance.js public URL follows the front matter, as Jekyll does", () => {
  test("no front-matter slug → the file name minus its date prefix", () => {
    expect(publishedHref()).toBe(`${PROD_ORIGIN}/blog/quoting-simon-willison-on-coding-agents/`);
  });

  test("a front-matter slug wins over the file name", () => {
    expect(publishedHref({ fmSlug: FM_SLUG })).toBe(`${PROD_ORIGIN}/blog/${FM_SLUG}/`);
  });

  test("a front-matter slug is slugified the way Jekyll's :slug is", () => {
    expect(publishedHref({ fmSlug: "  Bad Slug! (Take 2)  " })).toBe(`${PROD_ORIGIN}/blog/bad-slug-take-2/`);
  });

  test("a blank front-matter slug falls back to the file name", () => {
    expect(publishedHref({ fmSlug: "   " })).toBe(`${PROD_ORIGIN}/blog/quoting-simon-willison-on-coding-agents/`);
  });

  test("a front-matter permalink is the URL, with :slug expanded", () => {
    expect(publishedHref({ fmPermalink: "/essays/custom/" })).toBe(`${PROD_ORIGIN}/essays/custom/`);
    expect(publishedHref({ fmPermalink: "/essays/:slug/", fmSlug: "My Essay" })).toBe(`${PROD_ORIGIN}/essays/my-essay/`);
    expect(publishedHref({ fmPermalink: "/essays/:slug/" })).toBe(
      `${PROD_ORIGIN}/essays/quoting-simon-willison-on-coding-agents/`,
    );
  });

  test("a permalink using a placeholder the list does not reproduce gets no link, not a guessed one", () => {
    expect(publishedHref({ fmPermalink: "/:year/:slug/", fmSlug: FM_SLUG })).toBeNull();
    expect(publishedHref({ fmPermalink: "/:categories/post/" })).toBeNull();
    const { hook } = load({ withLiveUrl: true });
    expect(hook.urlPath({ slug: FILE_SLUG, fmSlug: FM_SLUG, fmPermalink: "/:year/:slug/" })).toBeNull();
    // ...and a draft's per-PR preview link is left out too.
    const pr = { number: 42, url: "https://github.com/owner/repo/pull/42", previewOnly: false };
    const html = render(hook, pr, { slug: FILE_SLUG, fmPermalink: "/:year/:slug/" });
    expect(html).not.toContain("preview draft");
    expect(html).not.toContain("Published OFF");
  });

  test("a permalink without a leading slash is served from the root, as Jekyll does", () => {
    expect(publishedHref({ fmPermalink: "essays/custom/" })).toBe(`${PROD_ORIGIN}/essays/custom/`);
  });

  test("the draft's per-PR preview link and the not-yet-live label use the same path", () => {
    const { hook } = load({ branch: "main", destinationOrigin: PROD_ORIGIN, withLiveUrl: true });
    const pr = { number: 42, url: "https://github.com/owner/repo/pull/42", previewOnly: false };
    const html = render(hook, pr, { slug: FILE_SLUG, fmSlug: FM_SLUG });
    expect(html).toContain(`href="https://preview-pr42.example.com/blog/${FM_SLUG}/"`);
    expect(html).not.toContain("on-coding-agents/");
    const draft = render(hook, null, {
      slug: FILE_SLUG,
      fmSlug: FM_SLUG,
      state: { label: "Draft", color: "#57606a", live: false },
    });
    expect(draft).toContain(`>/blog/${FM_SLUG}/</span>`);
  });
});

test.describe("posts-list-enhance.js reads the front matter off the summary", () => {
  const SEP = "⁣";

  // Decap 3.15.1 renders the card heading as [summary text, <TitleIcons>]: two
  // children, with the workflow badge text ("In review") inside the second.
  // h2.textContent therefore is NOT the summary. A global-search result also
  // puts the collection label ("Posts") in an <h2> BEFORE the title's.
  function anchor(summary, slug = FILE_SLUG, { badge = "", search = false } = {}) {
    const text = { nodeType: 3, nodeValue: summary };
    const icons = { nodeType: 1, textContent: badge };
    const h2 = { childNodes: [text, icons] };
    Object.defineProperty(h2, "textContent", { get: () => text.nodeValue + icons.textContent });
    const label = { childNodes: [{ nodeType: 3, nodeValue: "Posts" }] };
    const headings = search ? [label, h2] : [h2];
    const li = {};
    return {
      getAttribute: () => `#/collections/posts/entries/${slug}`,
      closest: () => li,
      querySelector: (sel) => (sel === "h2" ? headings[0] : null),
      querySelectorAll: (sel) => (sel === "h2" ? headings : []),
      textContent: h2.textContent,
      h2,
      text,
      label,
    };
  }

  test("collectCards splits the title, the state and the carried slug/permalink", () => {
    const a = anchor(`Quoting Simon — DRAFT${SEP}${FM_SLUG}${SEP}/essays/x/`);
    const { hook } = load({ anchors: [a] });
    const [c] = hook.collectCards();
    expect(c.slug).toBe(FILE_SLUG);
    expect(c.fmSlug).toBe(FM_SLUG);
    expect(c.fmPermalink).toBe("/essays/x/");
    expect(c.title).toBe("Quoting Simon");
    expect(c.state.label).toBe("Draft");
    // The carrier never reaches the visible title.
    expect(a.text.nodeValue).toBe("Quoting Simon");
  });

  test("a published post with no front-matter slug carries an empty tail", () => {
    const a = anchor(`Hello${SEP}${SEP}`);
    const { hook } = load({ anchors: [a] });
    const [c] = hook.collectCards();
    expect(c.fmSlug).toBe("");
    expect(c.fmPermalink).toBe("");
    expect(c.title).toBe("Hello");
    expect(c.state.live).toBe(true);
  });

  test("a summary without the tail (an older config) still parses", () => {
    const a = anchor("Hello — Scheduled");
    const { hook } = load({ anchors: [a] });
    const [c] = hook.collectCards();
    expect(c.fmSlug).toBe("");
    expect(c.title).toBe("Hello");
    expect(c.state.label).toBe("Scheduled");
  });

  test("the visible title loses the tail and the DRAFT suffix with the 2-child heading too", () => {
    const a = anchor(`Quoting Simon — DRAFT${SEP}${FM_SLUG}${SEP}`);
    const { hook } = load({ anchors: [a] });
    hook.collectCards();
    expect(a.text.nodeValue).toBe("Quoting Simon");
    expect(a.h2.textContent).not.toContain(SEP);
    expect(a.h2.textContent).not.toContain(FM_SLUG);
    // A second pass (Decap has not re-rendered) keeps the state it read.
    const [c] = hook.collectCards();
    expect(c.state.label).toBe("Draft");
    expect(c.fmSlug).toBe(FM_SLUG);
  });

  test("the tail is read from the summary text node, not h2.textContent (a workflow badge cannot leak into the permalink)", () => {
    const a = anchor(`Hello${SEP}${FM_SLUG}${SEP}`, FILE_SLUG, { badge: "In review" });
    const { hook } = load({ anchors: [a] });
    const [c] = hook.collectCards();
    expect(c.fmPermalink).toBe("");
    expect(c.fmSlug).toBe(FM_SLUG);
  });

  test("outside the posts list (global search) the tail comes off and the DRAFT suffix stays", () => {
    const a = anchor(`Quoting Simon — DRAFT${SEP}${FM_SLUG}${SEP}/x/`, FILE_SLUG, { search: true });
    const b = anchor("Plain title", FILE_SLUG, { search: true });
    const { hook } = load({ anchors: [a, b] });
    hook.hideCarrierOutsideList();
    expect(a.text.nodeValue).toBe("Quoting Simon — DRAFT");
    expect(a.label.childNodes[0].nodeValue).toBe("Posts");
    expect(b.text.nodeValue).toBe("Plain title");
  });

  test("the posts summary in config.base.yml writes the tail in the layout the list reads", () => {
    const YAML = require("yaml");
    const cfg = YAML.parse(fs.readFileSync(CONFIG_BASE, "utf8"));
    const summary = cfg.collections.find((c) => c.name === "posts").summary;
    // Stand in for Decap's stringTemplate: the two field tokens get values,
    // every other token renders empty (a published, unscheduled post).
    const rendered = summary.replace(/\{\{([^}|]+?)(?: \|[^}]*)?\}\}/g, (_, key) =>
      key.trim() === "fields.slug" ? FM_SLUG : key.trim() === "fields.permalink" ? "/p/" : key.trim() === "title" ? "T" : "",
    );
    const { hook } = load();
    expect(hook.splitSummary(rendered)).toEqual({ text: "T", slug: FM_SLUG, permalink: "/p/" });
  });
});

test.describe("posts-list-enhance.js urlPath is drift-locked to e2e/public-content.js postPublicPath", () => {
  const { postPublicPath } = require("./public-content");
  const cases = [
    ["2026-09-28-hello", {}],
    ["2026-09-28-hello", { slug: FM_SLUG }],
    ["2026-09-28-hello", { slug: "  Bad Slug! (Take 2)  " }],
    ["2026-09-28-hello", { slug: "" }],
    ["2026-05-28-quoting-\"somewhat-less-robust\"", {}],
    ["2026-09-28-hello", { permalink: "/essays/custom/" }],
    ["2026-09-28-hello", { permalink: "/essays/:slug/", slug: "My Essay" }],
    ["2026-09-28-hello", { permalink: "essays/custom/" }],
    ["2026-09-28-hello", { permalink: "/:year/:slug/" }],
    ["2026-09-28-hello", { permalink: "/:slugs/" }],
  ];
  for (const [fileSlug, fm] of cases) {
    test(`${fileSlug} ${JSON.stringify(fm)}`, () => {
      const { hook } = load({ withLiveUrl: true });
      const card = { slug: fileSlug, fmSlug: fm.slug, fmPermalink: fm.permalink };
      expect(hook.urlPath(card)).toBe(postPublicPath(fileSlug, fm));
    });
  }
});
