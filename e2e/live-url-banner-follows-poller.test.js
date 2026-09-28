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

function load({ poller, cachedPr } = {}) {
  const subscribers = [];
  const session = {};
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
    location: { hash: `#/collections/posts/entries/${SLUG}`, origin: "https://example.com" },
    addEventListener() {},
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
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: () => 0,
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
  return { hook, subscribers };
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
