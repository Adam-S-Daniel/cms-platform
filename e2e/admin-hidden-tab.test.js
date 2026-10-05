// @lane: local — pure-Node behavioral test for #644 (vm sandbox, document.hidden stubbed)
/*
 * A background tab must not dead-end a Publish or stall the admin shims
 * (cms-platform#644).
 *
 * The reported sequence: an editor saves, switches to the Live Preview tab,
 * and the editor tab is now hidden (`document.hidden === true`).
 *
 *   1. Publish ended in "This could not be published right now … press
 *      Publish once more" with no Publish control on screen. publish-progress.js
 *      skipped every tick while hidden, including the re-reads doPublish()
 *      asked for, so it never found the PR; the busy state had hidden Decap's
 *      control and nothing gave it back. The busy note also named production,
 *      not the preview, because the poller had no facts yet.
 *   2. The shims that coalesce their pass on requestAnimationFrame stalled,
 *      because a hidden tab fires no animation frames.
 *
 * Everything runs in vm sandboxes: fetch is a URL router over canned JSON,
 * setTimeout and setInterval are captured or run inline, and nothing touches
 * the network or the wall clock.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");
const { API, loadProgress } = require("./publish-progress-harness");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const read = (name) => fs.readFileSync(path.join(ADMIN, name), "utf8");

const SLUG = "2026-09-28-hello";
const SHA = "4e40000000000000000000000000000000000000";
const OPEN_PR = {
  number: 42,
  html_url: "https://github.com/owner/repo/pull/42",
  head: { ref: `cms/posts/${SLUG}`, sha: SHA },
  base: { ref: "main", repo: { default_branch: "main" } },
  labels: [],
  auto_merge: null,
};
const LABELS_POST = `${API}/issues/42/labels`;
const SLOT_ID = "cms-publish-state-actions";
const HIDDEN_ATTR = "data-one-door-hidden";

// An unarmed open PR whose branch tip has no check runs yet: the state right
// after Save.
function openPrRoutes() {
  return {
    [`${API}/pulls?state=open&per_page=100`]: [OPEN_PR],
    [`${API}/git/ref/heads/cms/posts/${SLUG}`]: { object: { sha: SHA } },
    [`${API}/commits/${SHA}/check-runs?per_page=100`]: { check_runs: [] },
    [`${API}/pulls/42`]: { labels: [] },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test.describe("#644 publish-progress.js — a requested refresh reads in a hidden tab", () => {
  test("refresh() finds the PR while document.hidden is true", async () => {
    const { api } = loadProgress(openPrRoutes(), { hidden: true });
    await api.refresh();
    const state = api.get();
    expect(state.facts, "a refresh the editor asked for must read even in a background tab").toBeTruthy();
    expect(state.prNumber).toBe(42);
  });

  test("the timer tick still reads nothing while hidden (the Budget guard)", async () => {
    const { calls, intervals } = loadProgress(openPrRoutes(), { hidden: true });
    await settle();
    expect(calls, "the load-time tick must not read in a hidden tab").toEqual([]);
    expect(intervals.length, "the poller must register its interval").toBeGreaterThan(0);
    for (const fn of intervals) fn();
    await settle();
    expect(calls, "a background poll must not spend the rate limit").toEqual([]);
  });
});

// ── publish-button.js with the REAL poller and model ────────────────────
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag;
    this.attrs = { ...attrs };
    this.id = attrs.id || "";
    this.children = [];
    this.parentElement = null;
    this.textContent = "";
    this.styles = {};
    const styles = this.styles;
    this.style = {
      setProperty: (k, v) => {
        styles[k] = v;
      },
      getPropertyValue: (k) => styles[k] || "",
      removeProperty: (k) => {
        delete styles[k];
      },
      set cssText(_) {},
      get cssText() {
        return "";
      },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  appendChild(c) {
    this.children.push(c);
    c.parentElement = this;
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    return c;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  closest() {
    return null;
  }
  addEventListener() {}
}

/**
 * The editor in a background tab: the poller, the model and the button, with
 * the state bar's actions slot and Decap's own split button on screen.
 */
function loadEditor(routes, { hidden = true } = {}) {
  const slot = new El("div", { id: SLOT_ID });
  const decap = new El("div", { class: "css-x-PublishButton" });
  const fetchCalls = [];
  const notesAtFetch = [];
  const intervals = [];
  const slotText = () => slot.children.map((c) => c.textContent).join(" ");
  const document = {
    hidden,
    readyState: "complete",
    addEventListener() {},
    getElementById: (id) => (id === SLOT_ID ? slot : null),
    // No Save button: nothing unsaved.
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (!sel.startsWith('[class*="PublishButton"]')) return [];
      if (sel.includes(`[${HIDDEN_ATTR}]`)) return decap.getAttribute(HIDDEN_ATTR) === null ? [] : [decap];
      return [decap];
    },
    createElement: (tag) => new El(tag),
  };
  const sandbox = {
    window: {
      CMS_REPO: "owner/repo",
      addEventListener() {},
      // A preview deploy: a publish from this admin goes to the preview host.
      CMSHostname: {
        destination: () => "preview-pr7.example.com",
        canonical: () => "example.com",
      },
    },
    document,
    location: { hash: `#/collections/posts/entries/${SLUG}` },
    localStorage: { getItem: (k) => (k === "decap-cms-user" ? JSON.stringify({ token: "t0k3n" }) : null) },
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    fetch: (url, init) => {
      const u = String(url);
      const method = (init && init.method) || "GET";
      fetchCalls.push({ url: u, method });
      notesAtFetch.push(slotText());
      if (method === "POST") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      const hit = Object.prototype.hasOwnProperty.call(routes, u) ? routes[u] : undefined;
      if (hit === undefined || hit === null) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hit) });
    },
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  for (const file of ["entry-status-model.js", "publish-progress.js", "publish-button.js"]) {
    vm.runInContext(read(file), sandbox);
  }
  const api = sandbox.window.__publishButton;
  expect(api && typeof api.doPublish, "publish-button.js must export its test hook").toBe("function");
  const decapHidden = () =>
    decap.style.getPropertyValue("display") === "none" || decap.getAttribute(HIDDEN_ATTR) !== null;
  return { api, decap, decapHidden, fetchCalls, notesAtFetch, intervals, slotText };
}

test.describe("#644 publish-button.js — a Publish pressed just before switching tabs", () => {
  test("completes: the hidden tab still finds the PR and arms it", async () => {
    const { api, fetchCalls, decapHidden } = loadEditor(openPrRoutes());
    await settle();
    await api.doPublish();
    const posts = fetchCalls.filter((c) => c.method === "POST" && c.url === LABELS_POST);
    expect(posts.length, "exactly one cms/ready POST, from a hidden tab").toBe(1);
    expect(api.lastError()).toBeNull();
    expect(decapHidden(), "a successful publish keeps Decap's control replaced, not restored").toBe(true);
  });

  test("the busy note names where this admin publishes, before the poller has facts", async () => {
    const { api, notesAtFetch } = loadEditor(openPrRoutes());
    await settle();
    await api.doPublish();
    const first = notesAtFetch[0] || "";
    expect(first, "the first read happens under the busy note").toContain("Sending it to");
    expect(first, "no facts yet must not mean production").toContain("preview-pr7.example.com");
  });

  const failures = {
    "the poller cannot read the PR list (no facts)": {},
    "the poller reads no open PR": {
      [`${API}/pulls?state=open&per_page=100`]: [],
    },
  };
  for (const [name, routes] of Object.entries(failures)) {
    test(`fails with a visible retry control when ${name}`, async () => {
      const { api, decapHidden, intervals, slotText } = loadEditor(routes);
      await settle();
      await api.doPublish();
      expect(api.lastError()).toContain("could not be published right now");
      expect(slotText()).toContain("press Publish once more");
      expect(decapHidden(), "the error path must give Decap's Publish control back").toBe(false);
      // The 500 ms render tick (and every other interval) must not hide it again.
      for (let i = 0; i < 3; i++) for (const fn of intervals) fn();
      await settle();
      expect(decapHidden(), "a steady-state render must not re-hide the restored control").toBe(false);
    });
  }
});

// ── The requestAnimationFrame shims ──────────────────────────────────────
const RAF_SHIMS = [
  "native-preview-href.js",
  "live-url-banner.js",
  "posts-list-enhance.js",
  "one-door-publish.js",
  "collection-controls-trim.js",
];

/**
 * Load a shim with a DOM that answers every query empty and counts them, an
 * animation-frame queue that runs only when the test says so (a hidden tab
 * never says so), and a timer queue likewise. `queries` counting up is the
 * observable sign that the shim's coalesced pass ran.
 */
function loadShim(file, hidden) {
  const frames = [];
  const timers = [];
  const visibility = [];
  const observers = [];
  const counts = { queries: 0 };
  const query = (empty) => () => {
    counts.queries += 1;
    return empty;
  };
  const location = { hash: "#/", pathname: "/admin/", search: "" };
  const document = {
    hidden,
    readyState: "complete",
    body: { classList: { toggle() {} } },
    documentElement: {},
    head: {},
    addEventListener: (type, fn) => {
      if (type === "visibilitychange") visibility.push(fn);
    },
    querySelectorAll: query([]),
    querySelector: query(null),
    getElementById: query(null),
  };
  const sandbox = {
    window: { CMS_REPO: "owner/repo", addEventListener() {}, location },
    document,
    location,
    MutationObserver: class {
      constructor(cb) {
        observers.push(cb);
      }
      observe() {}
    },
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
    setInterval: () => 0,
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}),
    URL,
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(read(file), sandbox);
  // Drain whatever the load scheduled, so the next schedule starts clean.
  for (let i = 0; i < 10 && (frames.length || timers.length); i++) {
    frames.splice(0).forEach((fn) => fn());
    timers.splice(0).forEach((fn) => fn());
  }
  counts.queries = 0;
  expect(observers.length, `${file} must observe the DOM`).toBeGreaterThan(0);
  const mutate = () => observers.forEach((cb) => cb([]));
  return { document, frames, timers, visibility, counts, mutate };
}

test.describe("#644 admin shims — a hidden tab does not wait for an animation frame", () => {
  for (const file of RAF_SHIMS) {
    test(`${file}: a pass scheduled in a hidden tab runs on the next task`, () => {
      const { frames, timers, counts, mutate } = loadShim(file, true);
      mutate();
      expect(counts.queries, "the pass is still coalesced, not run inline").toBe(0);
      expect(frames.length, "no animation frame is requested in a hidden tab").toBe(0);
      timers.splice(0).forEach((fn) => fn());
      expect(counts.queries, "the pass ran without the tab coming back").toBeGreaterThan(0);
    });

    test(`${file}: a frame still pending when the tab hides runs at once`, () => {
      const { document, frames, timers, visibility, counts, mutate } = loadShim(file, false);
      mutate();
      expect(frames.length, "a visible tab still coalesces on the frame").toBe(1);
      expect(timers.length, "and adds no timer").toBe(0);
      document.hidden = true;
      visibility.forEach((fn) => fn());
      const ran = counts.queries;
      expect(ran, "hiding the tab runs the pending pass").toBeGreaterThan(0);
      frames.splice(0).forEach((fn) => fn());
      expect(counts.queries, "the stale frame does not run the pass a second time").toBe(ran);
    });

    test(`${file}: a visible tab behaves as before, one pass per frame`, () => {
      const { frames, counts, mutate } = loadShim(file, false);
      mutate();
      mutate();
      expect(frames.length, "two mutations, one frame").toBe(1);
      expect(counts.queries).toBe(0);
      frames.splice(0).forEach((fn) => fn());
      expect(counts.queries).toBeGreaterThan(0);
    });
  }
});
