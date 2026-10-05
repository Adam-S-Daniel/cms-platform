/**
 * publish-button.js — a Publish pressed before the poller has caught up
 * must re-read GitHub, not give up (#386).
 *
 * publish-progress.js reads the entry's PR every 30 s and on `hashchange`.
 * Saving an EXISTING entry changes no hash, so for up to 30 s after Decap
 * opens the `cms/<collection>/<slug>` PR the poller's snapshot still says
 * "no PR" — and doPublish() used to read that snapshot once and render
 * "could not be published right now". A NEW entry never hit this: its
 * first save navigates `/new` → `entries/<slug>`, which fires `hashchange`
 * and a fresh tick. That asymmetry is exactly what two consecutive
 * adamdaniel.ai host-loop runs measured (cms-platform#386): the CREATE in
 * cms-delete-published passed, the UPDATE in cms-publish-loop sat unarmed.
 *
 * These tests drive doPublish() through the shim's test hook in a vm
 * sandbox with a scripted CMSPublishProgress and a recording fetch. No
 * timers: the sandbox's setTimeout runs its callback synchronously.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM_PATH = path.resolve(__dirname, "../theme/admin/publish-button.js");
const READY_LABEL_PATH = "/repos/owner/repo/issues/42/labels";
const PR_DETAIL_PATH = "/repos/owner/repo/pulls/42";

function response(status = 200, body = { labels: [] }) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/**
 * Load the shim with a CMSPublishProgress whose snapshots are scripted:
 * `snapshots[0]` is what get() returns before any refresh(); each refresh()
 * advances to the next snapshot (the last one sticks). A refresh that
 * should behave like publish-progress.js's in-flight guard — return without
 * changing anything — is spelled as a repeated snapshot.
 */
function load(snapshots, responses = {}) {
  const src = fs.readFileSync(SHIM_PATH, "utf8");
  let i = 0;
  const refreshCalls = [];
  const fetchCalls = [];
  const warnings = [];
  const progress = {
    get: () => snapshots[Math.min(i, snapshots.length - 1)],
    refresh: () => {
      refreshCalls.push(i);
      i += 1;
      return Promise.resolve();
    },
    getToken: () => "t0k3n",
    subscribe: () => () => {},
  };
  const sandbox = {
    window: { CMS_REPO: "owner/repo", CMSPublishProgress: progress, addEventListener() {} },
    document: {
      readyState: "complete",
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    setInterval: () => 0,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    fetch: (url, init) => {
      const method = (init && init.method) || "GET";
      fetchCalls.push({ url: String(url), method, body: init && init.body, cache: init && init.cache });
      const res = responses[method] || response();
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    },
    console: { info() {}, warn: (...args) => warnings.push(args) },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.__publishButton;
  expect(api && typeof api.doPublish, "publish-button.js must export window.__publishButton.doPublish").toBe(
    "function",
  );
  return { api, fetchCalls, refreshCalls, warnings };
}

const NO_PR = { ready: true, facts: { hasOpenPr: false, armed: false }, prNumber: null, prUrl: null };
const PR_42 = {
  ready: true,
  facts: { hasOpenPr: true, armed: false },
  prNumber: 42,
  prUrl: "https://github.com/owner/repo/pull/42",
};

function armPosts(fetchCalls) {
  return fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith(READY_LABEL_PATH));
}

test.describe("publish-button — a stale poller snapshot is re-read before giving up (#386)", () => {
  test("Publish pressed before the poller saw the PR still arms it", async () => {
    // Snapshot from before Decap opened the PR, then the truth on refresh.
    const { api, fetchCalls, refreshCalls } = load([NO_PR, PR_42]);
    await api.doPublish();
    expect(refreshCalls.length, "doPublish() must refresh() when the snapshot has no PR").toBeGreaterThan(0);
    const posts = armPosts(fetchCalls);
    expect(posts.length, "exactly one cms/ready POST").toBe(1);
    expect(JSON.parse(posts[0].body)).toEqual({ labels: ["cms/ready"] });
    expect(api.lastError()).toBeNull();
  });

  test("a refresh that lands on an in-flight tick is retried, not trusted", async () => {
    // publish-progress.js's refresh() returns at once while a tick is in
    // flight, leaving the snapshot unchanged. One unchanged read must not
    // end the attempt.
    const { api, fetchCalls, refreshCalls } = load([NO_PR, NO_PR, PR_42]);
    await api.doPublish();
    expect(refreshCalls.length).toBeGreaterThanOrEqual(2);
    expect(armPosts(fetchCalls).length).toBe(1);
    expect(api.lastError()).toBeNull();
  });

  test("with genuinely no PR it still says so, and touches GitHub only to look", async () => {
    const { api, fetchCalls, refreshCalls } = load([NO_PR]);
    await api.doPublish();
    expect(refreshCalls.length, "bounded retries — never a spin").toBeLessThanOrEqual(5);
    expect(armPosts(fetchCalls).length, "no PR means nothing to label").toBe(0);
    expect(api.lastError()).toContain("could not be published right now");
  });

  test("the fast path is unchanged: a fresh snapshot arms without a pre-flight refresh", async () => {
    const { api, fetchCalls, refreshCalls } = load([PR_42]);
    await api.doPublish();
    expect(armPosts(fetchCalls).length).toBe(1);
    // The one refresh() is the POST-arm "Going live…" nudge that already
    // existed; nothing runs before the arm.
    expect(refreshCalls.length).toBe(1);
    expect(api.lastError()).toBeNull();
  });
});

test.describe("publish-button — re-arm only after checking the current labels", () => {
  test("an absent ready label is added without a needless DELETE", async () => {
    // A PR detail contains all labels, unlike a paginated label-list read.
    const labels = Array.from({ length: 35 }, (_, i) => ({ name: `label-${i}` }));
    const { api, fetchCalls, warnings } = load([PR_42], { GET: response(200, { labels }) });
    await api.doPublish();
    expect(fetchCalls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(fetchCalls[0].url).toBe(`https://api.github.com${PR_DETAIL_PATH}`);
    expect(fetchCalls[0].cache).toBe("no-cache");
    expect(JSON.parse(armPosts(fetchCalls)[0].body)).toEqual({ labels: ["cms/ready"] });
    expect(warnings).toEqual([]);
    expect(api.lastError()).toBeNull();
  });

  test("a present ready label is removed before it is added again", async () => {
    const labels = [{ name: "decap-cms/draft" }, { name: "cms/draft" }, { name: "cms/ready" }];
    const { api, fetchCalls, warnings } = load([PR_42], { GET: response(200, { labels }) });
    await api.doPublish();
    expect(fetchCalls.map((c) => c.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(fetchCalls[1].url).toBe(`https://api.github.com${READY_LABEL_PATH}/cms%2Fready`);
    expect(JSON.parse(armPosts(fetchCalls)[0].body)).toEqual({ labels: ["cms/ready"] });
    expect(warnings).toEqual([]);
    expect(api.lastError()).toBeNull();
  });

  test("a racing DELETE 404 is silent and still adds the ready label", async () => {
    const { api, fetchCalls, warnings } = load([PR_42], {
      GET: response(200, { labels: [{ name: "cms/ready" }] }),
      DELETE: response(404, { message: "private response body" }),
    });
    await api.doPublish();
    expect(fetchCalls.map((c) => c.method)).toEqual(["GET", "DELETE", "POST"]);
    expect(warnings).toEqual([]);
    expect(api.lastError()).toBeNull();
  });

  for (const method of ["GET", "DELETE"]) {
    for (const status of [403, 500]) {
      test(`${method} ${status} stops before adding and warns with only the status`, async () => {
        const responses = { GET: response(200, { labels: [{ name: "cms/ready" }] }) };
        responses[method] = response(status, { message: "private body, credential and contact" });
        const { api, fetchCalls, warnings, refreshCalls } = load([PR_42], responses);
        await api.doPublish();
        expect(armPosts(fetchCalls)).toEqual([]);
        expect(fetchCalls.map((c) => c.method)).toEqual(method === "GET" ? ["GET"] : ["GET", "DELETE"]);
        expect(warnings).toEqual([[`publish-button: label re-arm failed (HTTP ${status})`]]);
        expect(api.lastError()).toContain("Could not re-arm publishing");
        expect(api.lastError()).not.toContain("private");
        expect(refreshCalls).toEqual([]);
      });
    }

    test(`${method} network failure stops before adding without exposing the Error`, async () => {
      const responses = { GET: response(200, { labels: [{ name: "cms/ready" }] }) };
      responses[method] = new Error("private contact and credential in network error");
      const { api, fetchCalls, warnings } = load([PR_42], responses);
      await api.doPublish();
      expect(armPosts(fetchCalls)).toEqual([]);
      expect(warnings).toEqual([["publish-button: label re-arm failed (HTTP unknown)"]]);
      expect(api.lastError()).toContain("Could not re-arm publishing");
      expect(api.lastError()).not.toContain("private");
    });

    test(`${method} rejects a nonnumeric response status without logging its contents`, async () => {
      const responses = { GET: response(200, { labels: [{ name: "cms/ready" }] }) };
      responses[method] = response(403);
      responses[method].status = "private response status";
      const { api, fetchCalls, warnings } = load([PR_42], responses);
      await api.doPublish();
      expect(armPosts(fetchCalls)).toEqual([]);
      expect(warnings).toEqual([["publish-button: label re-arm failed (HTTP unknown)"]]);
      expect(api.lastError()).toContain("Could not re-arm publishing");
      expect(api.lastError()).not.toContain("private");
    });
  }

  const malformed = [null, {}, { labels: null }, { labels: "cms/ready" }, { labels: [null] },
    { labels: ["cms/ready"] }, { labels: [{ name: 42 }] }];
  for (const [index, body] of malformed.entries()) {
    test(`malformed label schema ${index + 1} stops before either write`, async () => {
      const { api, fetchCalls, warnings } = load([PR_42], { GET: response(200, body) });
      await api.doPublish();
      expect(fetchCalls.map((c) => c.method)).toEqual(["GET"]);
      expect(warnings).toEqual([["publish-button: label re-arm failed (HTTP 200)"]]);
      expect(api.lastError()).toContain("Could not re-arm publishing");
    });
  }

  test("invalid JSON stops before either write without exposing the parse error", async () => {
    const read = response();
    read.json = () => Promise.reject(new Error("private response body in parse error"));
    const { api, fetchCalls, warnings } = load([PR_42], { GET: read });
    await api.doPublish();
    expect(fetchCalls.map((c) => c.method)).toEqual(["GET"]);
    expect(warnings).toEqual([["publish-button: label re-arm failed (HTTP 200)"]]);
    expect(api.lastError()).toContain("Could not re-arm publishing");
    expect(api.lastError()).not.toContain("private");
  });
});
