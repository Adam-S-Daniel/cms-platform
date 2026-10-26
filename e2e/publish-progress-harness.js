// Shared vm-sandbox harness for publish-progress.js behavioral tests.
//
// Loads the REAL theme/admin/publish-progress.js with a scripted fetch (a URL
// router over canned JSON) and an injected clock, so no test touches the
// network or the wall clock. Used by publish-progress-branch-tip.test.js and
// publish-progress-post-merge.test.js.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/publish-progress.js"), "utf8");
const API = "https://api.github.com/repos/owner/repo";

/**
 * `routes` maps an exact URL to a JSON body; a missing URL or `null` answers
 * 404. `now` fixes Date.now() inside the sandbox. `hash` is the Decap route.
 * `hidden` stubs document.hidden (a background tab); `intervals` collects what
 * the poller hands setInterval, so a test can fire a timer tick by hand.
 */
function loadProgress(routes, { now = Date.UTC(2026, 8, 28, 13, 41, 0), hash, hidden = false } = {}) {
  const calls = [];
  const intervals = [];
  class FixedDate extends Date {
    static now() {
      return now;
    }
  }
  const sandbox = {
    window: { CMS_REPO: "owner/repo", addEventListener() {} },
    document: { hidden, readyState: "complete", addEventListener() {} },
    location: { hash: hash || "#/collections/posts/entries/2026-09-28-hello" },
    localStorage: { getItem: (k) => (k === "decap-cms-user" ? JSON.stringify({ token: "t0k3n" }) : null) },
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    fetch: (url) => {
      const u = String(url);
      calls.push(u);
      const hit = Object.prototype.hasOwnProperty.call(routes, u) ? routes[u] : undefined;
      if (hit === undefined || hit === null) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hit) });
    },
    console: { info() {}, warn() {} },
    Date: FixedDate,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.window.CMSPublishProgress;
  // start() fires one tick at load; its fetches all resolve as microtasks,
  // so one macrotask turn drains it. Without this, refresh() hits the
  // in-flight guard and returns having done nothing.
  const refresh = async () => {
    await new Promise((r) => setImmediate(r));
    calls.length = 0;
    await api.refresh();
  };
  return { api: { get: api.get, refresh }, calls, intervals };
}

module.exports = { API, loadProgress };
