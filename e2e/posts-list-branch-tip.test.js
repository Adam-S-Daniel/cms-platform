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

function load(routes) {
  const calls = [];
  const sandbox = {
    window: {
      CMS_REPO: "owner/repo",
      CMS_SITE_ORIGIN: "https://example.com",
      location: { hash: "#/" }, // not the list route — nothing runs at load
      addEventListener() {},
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
});
