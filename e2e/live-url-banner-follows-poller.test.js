// @lane: local — pure-Node behavioral test for live-url-banner.js (vm sandbox)
/*
 * The "View page on site" link must switch from the per-PR preview host to
 * the production host when the entry's PR closes, WITHOUT a reload.
 *
 * live-url-banner.js looked the open PRs up once per page (plus a 5-minute
 * sessionStorage cache) and never again, so after a publish merged the link
 * kept pointing at preview-pr<N> — a preview the teardown job deletes at the
 * merge — until the editor refreshed (adamdaniel.ai#3857). publish-progress.js
 * already re-reads the entry's PR every 30 s; the banner now follows it when
 * it has an answer for the entry on screen, and keeps its own lookup only for
 * shells that do not load the poller.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/live-url-banner.js"), "utf8");
const SLUG = "2026-09-28-hello";
const PROD = "https://example.com/blog/hello/";

function load({ poller, cachedPr, banner = null, data, access = "https://example.com", destinationOrigin = "https://example.com" } = {}) {
  const frames = [];
  const subscribers = [];
  const session = {};
  const windowListeners = {};
  if (cachedPr != null) {
    session["cms-live-url-pr-cache-v1"] = JSON.stringify({ at: Date.now(), data: { [SLUG]: cachedPr } });
    session["cms-ple-remote-cache-v1"] = JSON.stringify({
      at: Date.now(),
      data: { prBySlug: { [SLUG]: { number: cachedPr } } },
    });
  }
  const window = {
    CMS_REPO: "owner/repo",
    CMS_APEX: "example.com",
    CMSHostname: {
      current: () => new URL(access).hostname,
      destination: () => new URL(destinationOrigin).hostname,
      fromURL: (value) => { try { return value ? new URL(value).hostname : null; } catch { return null; } },
    },
    LiveURL: data ? { compute: () => data } : undefined,
    location: { hash: `#/collections/posts/entries/${SLUG}`, origin: access },
    addEventListener: (type, fn) => { windowListeners[type] = fn; },
  };
  if (poller) {
    window.CMSPublishProgress = {
      get: () => poller,
      subscribe: (fn) => {
        subscribers.push(fn);
        return () => {};
      },
    };
  }
  const sandbox = {
    window,
    document: {
      body: {},
      readyState: "complete",
      addEventListener() {},
      getElementById: (id) => id === "cms-live-url" ? (typeof banner === "function" ? banner() : banner) : null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: () => 0,
    sessionStorage: { getItem: (k) => session[k] || null, setItem() {} },
    localStorage: { getItem: () => null },
    fetch: () => new Promise(() => {}), // never answers — the cache or poller must decide
    URL,
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const hook = window.__liveUrlBanner;
  expect(hook && typeof hook.previewAwareURL, "live-url-banner.js must expose previewAwareURL for tests").toBe(
    "function",
  );
  return { hook, subscribers, hashchange: () => windowListeners.hashchange(), render: () => frames.splice(0).forEach((fn) => fn()) };
}

const snap = (prNumber, slug = SLUG) => ({
  ready: true,
  prNumber,
  entry: { collection: "posts", slug },
  facts: { hasOpenPr: prNumber != null },
});

test.describe("live-url-banner.js follows the live poller's PR, not a load-time snapshot (#3857)", () => {
  test("open PR per the poller → the preview host", () => {
    const { hook } = load({ poller: snap(42) });
    expect(hook.previewAwareURL(PROD)).toBe("https://preview-pr42.example.com/blog/hello/");
  });

  test("PR closed per the poller → production, even while an old cache still says PR 42", () => {
    const { hook } = load({ poller: snap(null), cachedPr: 42 });
    expect(hook.previewAwareURL(PROD)).toBe(PROD);
  });

  test("the poller's answer for a DIFFERENT entry is ignored — the banner's own lookup decides", () => {
    const { hook } = load({ poller: snap(null, "2026-01-01-other"), cachedPr: 42 });
    expect(hook.previewAwareURL(PROD)).toBe("https://preview-pr42.example.com/blog/hello/");
  });

  test("no poller on this shell → the banner's own lookup, as before", () => {
    const { hook } = load({ cachedPr: 42 });
    expect(hook.previewAwareURL(PROD)).toBe("https://preview-pr42.example.com/blog/hello/");
  });

  test("the banner re-renders when the poller reports", () => {
    const { subscribers } = load({ poller: snap(42) });
    expect(subscribers.length, "live-url-banner.js must subscribe to CMSPublishProgress").toBeGreaterThan(0);
  });
});

for (const [access, destinationOrigin] of [
  ["https://example.com", "https://example.com"],
  ["https://www.example.com", "https://example.com"],
  ["https://d1234abcd.example.net", "https://example.com"],
  ["https://preview-pr7.example.com", "https://example.com"],
  ["https://example.com", "https://preview-pr7.example.com"],
  ["https://preview-pr7.example.com", "https://preview-pr7.example.com"],
  ["http://localhost:4000", "https://example.com"],
  ["http://localhost:4000", "http://localhost:4000"],
]) {
  for (const withURL of [false, true]) {
    test(`live banner publication ${withURL ? "URL label" : "label fallback"}: ${access} -> ${destinationOrigin}`, () => {
      const banner = { style: {}, innerHTML: "" };
      const data = { published: true, url: withURL ? destinationOrigin + "/blog/hello/" : null };
      const { render } = load({ poller: snap(null), banner, data, access, destinationOrigin });
      render();
      expect(banner.innerHTML).toContain("View page on " + new URL(destinationOrigin).hostname + ":");
      if (withURL) expect(banner.innerHTML).toContain('href="' + destinationOrigin + '/blog/hello/"');
    });
  }
}

test("live banner names the actual per-PR preview URL rather than the publication fallback", () => {
  const banner = { style: {}, innerHTML: "" };
  const { render } = load({ poller: snap(42), banner, data: { published: true, url: PROD } });
  render();
  expect(banner.innerHTML).toContain("View page on preview-pr42.example.com:");
  expect(banner.innerHTML).toContain('href="https://preview-pr42.example.com/blog/hello/"');
});

test("a fresh banner element gets the markup even when it is identical to the last render (#641)", () => {
  // Decap remounts the form on /new -> /entries/<slug>; the old node is
  // discarded and ensureBanner() returns a new, empty one.
  let current = { style: {}, innerHTML: "" };
  const { render, hashchange } = load({ banner: () => current, data: { published: false, url: null } });
  render();
  expect(current.innerHTML).toContain("Not yet published.");
  current = { style: {}, innerHTML: "" };
  hashchange();
  render();
  expect(current.innerHTML).toContain("Not yet published.");
});
