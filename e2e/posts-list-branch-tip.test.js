// @lane: local — pure-Node behavioral test for posts-list-enhance.js (vm sandbox, scripted fetch)
/*
 * The collection list's status chip must judge each draft by the checks of
 * the commit its branch is ACTUALLY on — the same fix publish-progress.js got
 * for the editor bar (see e2e/publish-progress-branch-tip.test.js). The /pulls
 * LIST reports `head.sha` with a lag after a push, so reading it would paint
 * "Needs attention" on a post whose re-save is already going live
 * (adamdaniel.ai#3857).
 *
 * One `git/matching-refs/heads/cms/posts/` read covers every draft in the
 * list, so this costs one request per refresh, not one per row.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/posts-list-enhance.js"), "utf8");
const API = "https://api.github.com/repos/owner/repo";
const PULLS = `${API}/pulls?state=open&per_page=100`;
const REFS = `${API}/git/matching-refs/heads/cms/posts/`;
const OLD = "0ld0000000000000000000000000000000000000";
const NEW = "4e40000000000000000000000000000000000000";

function load(routes, extra = {}, windowExtra = {}) {
  const calls = [];
  const sandbox = {
    window: {
      CMS_REPO: "owner/repo",
      CMS_SITE_ORIGIN: "https://example.com",
      location: { hash: "#/" }, // not the list route — nothing runs at load
      addEventListener() {},
      ...windowExtra,
    },
    document: { readyState: "complete", body: {}, addEventListener() {} },
    requestAnimationFrame: () => 0,
    MutationObserver: class {
      observe() {}
    },
    localStorage: { getItem: () => null },
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
    ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const hook = sandbox.window.__postsListEnhance;
  expect(hook && typeof hook.fetchOpenPrBySlug, "posts-list-enhance.js must expose fetchOpenPrBySlug for tests").toBe(
    "function",
  );
  return { hook, calls };
}

const PR = {
  number: 42,
  html_url: "https://github.com/owner/repo/pull/42",
  head: { ref: "cms/posts/2026-09-28-hello", sha: OLD },
  labels: [{ name: "cms/ready" }],
  auto_merge: null,
};

test.describe("posts-list-enhance.js reads draft branch tips, not the PR list's lagging head.sha (#3857)", () => {
  test("a draft's sha is its branch tip when the refs read answers", async () => {
    const { hook, calls } = load({
      [PULLS]: [PR],
      [REFS]: [{ ref: "refs/heads/cms/posts/2026-09-28-hello", object: { sha: NEW } }],
    });
    const map = await hook.fetchOpenPrBySlug("t0k3n");
    expect(map["2026-09-28-hello"].sha).toBe(NEW);
    expect(calls.filter((u) => u === REFS), "one refs read per refresh, not per row").toHaveLength(1);
  });

  test("a draft with no matching ref, or a failed refs read, keeps the list's head.sha", async () => {
    let { hook } = load({ [PULLS]: [PR], [REFS]: [] });
    expect((await hook.fetchOpenPrBySlug("t0k3n"))["2026-09-28-hello"].sha).toBe(OLD);
    ({ hook } = load({ [PULLS]: [PR] }));
    expect((await hook.fetchOpenPrBySlug("t0k3n"))["2026-09-28-hello"].sha).toBe(OLD);
  });

  test("the header names the published destination with plain publishing copy", () => {
    const { hook } = load({});
    expect(typeof hook.publishingSummaryHTML).toBe("function");
    expect(typeof hook.publishingBarCopy).toBe("function");

    const summary = hook.publishingSummaryHTML(
      {
        state: "success",
        at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        url: "https://github.com/owner/repo/actions/runs/1",
      },
      "example.com",
    );
    expect(summary).toContain("example.com");
    expect(summary).toContain("updated");
    expect(summary).not.toMatch(/\bdeployed\b/i);

    const copy = hook.publishingBarCopy();
    expect(copy.signedOut).toBe("Sign in to see publishing details");
    expect(copy.refreshTitle).toBe("Refresh latest edits and publishing details");
    expect(`${copy.signedOut} ${copy.refreshTitle}`).not.toMatch(/\b(deploy|PR)\b/);
  });
});

// #534: the summary once read "example.com publishing details 3h ago" for any
// state it did not list — including `inactive`, a state GitHub really sends.
// Every documented deployment status gets words that are true with "<n> ago"
// after them, and an unrecognized one says plainly that it is unknown.
const FIXED_NOW = Date.parse("2026-10-01T12:00:00Z");
class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [FIXED_NOW]));
  }
  static now() {
    return FIXED_NOW;
  }
}
const FIVE_MIN_AGO = new Date(FIXED_NOW - 5 * 60 * 1000).toISOString();

const STATE_SUMMARIES = [
  ["success", "example.com updated 5m ago"],
  ["failure", "example.com update did not finish 5m ago"],
  ["error", "example.com update did not finish 5m ago"],
  ["in_progress", "example.com update started 5m ago"],
  ["queued", "example.com update requested 5m ago"],
  ["pending", "example.com update requested 5m ago"],
  ["inactive", "example.com update replaced by a newer one 5m ago"],
  ["some_future_state", "example.com update status unknown (last reported 5m ago)"],
  [undefined, "example.com update status unknown (last reported 5m ago)"],
];

test.describe("posts-list-enhance.js publishing summary: every deployment state in plain words (#534)", () => {
  for (const [state, expected] of STATE_SUMMARIES) {
    test(`state ${String(state)} renders "${expected}"`, () => {
      const { hook } = load({}, { Date: FixedDate });
      const html = hook.publishingSummaryHTML({ state, at: FIVE_MIN_AGO, url: null }, "example.com");
      expect(html).toBe(expected);
      expect(html).not.toMatch(/publishing details/);
      expect(html).not.toMatch(/\b(deploy\w*|inactive|in_progress|queued|pending|error)\b/i);
    });
  }

  test("the state words link to the update's details without changing the words", () => {
    const { hook } = load({}, { Date: FixedDate });
    const html = hook.publishingSummaryHTML(
      { state: "inactive", at: FIVE_MIN_AGO, url: "https://github.com/owner/repo/actions/runs/1" },
      "example.com",
    );
    expect(html).toBe(
      'example.com <a href="https://github.com/owner/repo/actions/runs/1" target="_blank" rel="noopener">' +
        "update replaced by a newer one</a> 5m ago",
    );
  });

  // Review of #558, N3: the URL comes from a workflow's deployment status,
  // so only an https: one is put in an href.
  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "http://example.com/log",
    "data:text/html,x",
    "//example.com/log",
    // The scheme test is anchored: https:// later in the string is not enough.
    "javascript:x//https://example.com/",
    // Userinfo can disguise the host the link really goes to.
    "https://user:pw@example.com/log",
    "https://example.net@example.com/log",
    "https://example.net\\@example.com/log",
  ]) {
    test(`an update URL that is not plain https (${url}) leaves the words unlinked`, () => {
      const { hook } = load({}, { Date: FixedDate });
      const html = hook.publishingSummaryHTML({ state: "success", at: FIVE_MIN_AGO, url }, "example.com");
      expect(html).toBe("example.com updated 5m ago");
    });
  }

  test("an https URL is escaped into the href", () => {
    const { hook } = load({}, { Date: FixedDate });
    const html = hook.publishingSummaryHTML(
      { state: "success", at: FIVE_MIN_AGO, url: 'https://example.com/log?a=1&b="x"' },
      "example.com",
    );
    expect(html).toBe(
      'example.com <a href="https://example.com/log?a=1&amp;b=&quot;x&quot;" target="_blank" rel="noopener">updated</a> 5m ago',
    );
  });

  test("with no time recorded the summary ends at the state words", () => {
    const { hook } = load({}, { Date: FixedDate });
    expect(hook.publishingSummaryHTML({ state: "success", at: null }, "example.com")).toBe("example.com updated");
    expect(hook.publishingSummaryHTML({ state: "bogus", at: null }, "example.com")).toBe(
      "example.com update status unknown",
    );
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
  test(`Posts badge model receives publication host: ${access} -> ${destinationOrigin}`, () => {
    const calls = [];
    const destination = new URL(destinationOrigin).hostname;
    const { hook } = load({}, { Date: FixedDate }, {
      CMSHostname: {
        current: () => new URL(access).hostname,
        destination: () => destination,
        canonical: () => "example.com",
        options: () => ({ currentHostname: new URL(access).hostname, canonicalHostname: "example.com" }),
      },
      CMSEntryStatus: {
        derive(facts, options) {
          calls.push({ facts, options });
          return { badge: "live", label: options.currentHostname };
        },
        SHORT_LABELS: {}, BADGE_COLORS: {}, MODIFIER_LABELS: {},
      },
    });
    const card = { slug: "hello", state: { label: "Live", color: "green" } };
    expect(hook.badgeFor(card, {}).label).toBe(destination);
    expect(calls[0].options.currentHostname).toBe(destination);
    expect(calls[0].options.canonicalHostname).toBe("example.com");
    expect(calls[0].options.now).toBe(FIXED_NOW);
  });
}
