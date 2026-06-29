// @lane: local — unit test for gh()'s bounded transient-retry (#1771 step 1).
//
// Exercises the retry wrapper without touching the network: global.fetch
// is monkey-patched to return a scripted sequence of responses, and the
// sleep is injected as a no-op (`_sleep`) so the test runs instantly and
// asserts nothing about wall-clock backoff except the value passed to the
// injected sleep (for the Retry-After case).
const { test, expect } = require("./base");
const {
  gh,
  makeDeployQueueExtender,
  deployLaneActivity,
  headChecksTrulyGreen,
  makePreviewCanaryRecoverer,
} = require("./github-actions-poll");

// Minimal fetch Response stand-in. `headers.get(name)` is case-insensitive
// to match the real Headers contract gh() relies on for Retry-After.
function fakeResponse({ status = 200, body = "", json = undefined, headers = {} } = {}) {
  const ok = status >= 200 && status < 300;
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok,
    status,
    statusText: `STATUS_${status}`,
    headers: { get: (name) => (name == null ? null : (lower[name.toLowerCase()] ?? null)) },
    text: async () => body,
    json: async () => (json !== undefined ? json : JSON.parse(body || "null")),
  };
}

// Build a fetch double that returns each queued response in order and
// records how many times it was invoked.
function scriptFetch(responses) {
  const calls = { count: 0 };
  const fn = async () => {
    const r = responses[Math.min(calls.count, responses.length - 1)];
    calls.count += 1;
    return r;
  };
  return { fn, calls };
}

test.describe("gh() bounded transient-retry (#1771 step 1)", () => {
  test.describe.configure({ mode: "serial" });

  let originalFetch;
  test.beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("(a) retries a 500 then resolves with the 200 body", async () => {
    const { fn, calls } = scriptFetch([
      fakeResponse({ status: 500, body: "upstream boom" }),
      fakeResponse({ status: 200, json: { ok: true, n: 42 } }),
    ]);
    globalThis.fetch = fn;
    const sleeps = [];
    const result = await gh("/repos/x/y", {
      retries: 5,
      _sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ ok: true, n: 42 });
    expect(calls.count).toBe(2); // one failed attempt + one success
    expect(sleeps.length).toBe(1); // slept exactly once between the two
  });

  test("(b) retries:0 throws on the first 500 (no retry)", async () => {
    const { fn, calls } = scriptFetch([
      fakeResponse({ status: 500, body: "boom" }),
      fakeResponse({ status: 200, json: { ok: true } }),
    ]);
    globalThis.fetch = fn;
    let thrown;
    try {
      await gh("/repos/x/y", { retries: 0 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(500);
    expect(calls.count).toBe(1); // never retried
  });

  test("(c) a 404 is NOT retried even with retries:5 (throws immediately)", async () => {
    const { fn, calls } = scriptFetch([
      fakeResponse({ status: 404, body: "Not Found" }),
      fakeResponse({ status: 200, json: { ok: true } }),
    ]);
    globalThis.fetch = fn;
    let thrown;
    try {
      await gh("/repos/x/y", { retries: 5, _sleep: async () => {} });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(404);
    expect(calls.count).toBe(1); // non-transient → no retry
  });

  test("(d) honours a numeric Retry-After header (seconds → ms)", async () => {
    const { fn } = scriptFetch([
      fakeResponse({ status: 429, body: "rate limited", headers: { "Retry-After": "3" } }),
      fakeResponse({ status: 200, json: { ok: true } }),
    ]);
    globalThis.fetch = fn;
    const sleeps = [];
    const result = await gh("/repos/x/y", {
      retries: 5,
      _sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ ok: true });
    // Retry-After: 3 (seconds) ⇒ 3000ms passed to the injected sleep.
    expect(sleeps).toEqual([3000]);
  });

  test("(e) a 403 secondary-rate-limit body IS retried; a plain 403 is not", async () => {
    // Secondary rate limit → transient → retried to a 200.
    const rl = scriptFetch([
      fakeResponse({
        status: 403,
        body: "You have exceeded a secondary rate limit. Please wait...",
      }),
      fakeResponse({ status: 200, json: { ok: true } }),
    ]);
    globalThis.fetch = rl.fn;
    const result = await gh("/repos/x/y", { retries: 5, _sleep: async () => {} });
    expect(result).toEqual({ ok: true });
    expect(rl.calls.count).toBe(2);

    // Plain permission-denied 403 → NOT transient → throws on first try.
    const denied = scriptFetch([
      fakeResponse({ status: 403, body: "Resource not accessible by personal access token" }),
      fakeResponse({ status: 200, json: { ok: true } }),
    ]);
    globalThis.fetch = denied.fn;
    let thrown;
    try {
      await gh("/repos/x/y", { retries: 5, _sleep: async () => {} });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(403);
    expect(denied.calls.count).toBe(1);
  });

  test("(f) exhausting retries throws the last error with err.status", async () => {
    // Always 503 — every attempt is transient, so it should retry
    // exactly `retries` times then throw the last 503.
    const { fn, calls } = scriptFetch([fakeResponse({ status: 503, body: "still down" })]);
    globalThis.fetch = fn;
    let thrown;
    try {
      await gh("/repos/x/y", { retries: 3, _sleep: async () => {} });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.status).toBe(503);
    expect(calls.count).toBe(4); // 1 initial + 3 retries
  });

  test("(g) happy path on first try never sleeps (default retries:0)", async () => {
    const { fn, calls } = scriptFetch([fakeResponse({ status: 200, json: { ok: true } })]);
    globalThis.fetch = fn;
    let slept = false;
    const result = await gh("/repos/x/y", {
      _sleep: async () => {
        slept = true;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls.count).toBe(1);
    expect(slept).toBe(false);
  });
});

// ── #21: the deploy-lane extender judged against the SPEC'S OWN deploy ──
//
// The pre-#21 extender judged the deploy lane on a sliding ~5-min wall-
// clock window anchored to "now" (recentWindowMs). When the spec's
// URL-reflect budget elapsed >5min AFTER the spec's own deploy completed,
// the lane read "quiescent" and the extender declared a REAL MISS
// ("lane is QUIESCENT") even though the deploy DID fire + complete — a
// FALSE NEGATIVE that mis-diagnosed the true failure (URL never served).
//
// #21 anchors the judgment on the create PR's `mergedAt`: count
// deploy-production runs with `run.created_at >= mergedAt`. A completed
// such run is CONCLUSIVE — the deploy fired + finished, so the chain is
// healthy and the failure is URL-not-served (S3/CloudFront). "No run
// created_at>=mergedAt AND lane idle" is the genuine real-miss.
test.describe("makeDeployQueueExtender anchored on the spec's own merge (#21)", () => {
  const MIN = 60 * 1000;
  // Build a deployLaneActivity stand-in from an explicit verdict object so
  // these tests don't depend on the wall-clock-window internals.
  const laneActivity = ({ inFlight = 0, recent = 0, deployCompletedSinceMerge = false, runsSinceMerge = 0 } = {}) =>
    async () => ({ inFlight, recent, deployCompletedSinceMerge, runsSinceMerge });

  test("(a) a deploy-production run created_at>=mergedAt that COMPLETED is conclusive (not a real miss) even >5min after merge", async () => {
    // mergedAt = T0; a deploy ran + completed for it; the URL-reflect
    // budget elapsed at T0+20min (>> the old 5-min recent window). The
    // pre-#21 logic would call the lane QUIESCENT → real miss; #21 must
    // instead recognise the spec's deploy fired + finished and stop
    // extending with a verdict that this is URL-not-served, NOT a miss.
    const ext = makeDeployQueueExtender({
      mergedAt: 0,
      activity: laneActivity({ inFlight: 0, recent: 0, deployCompletedSinceMerge: true, runsSinceMerge: 1 }),
    });
    const grant = await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(grant, "a completed deploy for THIS merge ⇒ stop extending (no point waiting longer)").toBe(0);
    // The verdict must be the high-value self-diagnosis: the deploy
    // completed but the URL never served — an S3/CloudFront problem — NOT
    // a chain-never-fired miss.
    expect(ext.verdict, "extender must expose a verdict for the diagnostic message").toBeTruthy();
    expect(ext.verdict.kind).toBe("deploy-completed-url-missing");
    expect(ext.verdict.realMiss, "a completed deploy is NOT a real miss").toBe(false);
  });

  test("(b) no deploy run created_at>=mergedAt AND idle lane ⇒ genuine real-miss", async () => {
    const ext = makeDeployQueueExtender({
      mergedAt: 0,
      activity: laneActivity({ inFlight: 0, recent: 0, deployCompletedSinceMerge: false, runsSinceMerge: 0 }),
    });
    const grant = await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(grant, "no deploy for the merge + idle lane ⇒ give up (real miss)").toBe(0);
    expect(ext.verdict.kind).toBe("no-deploy-fired");
    expect(ext.verdict.realMiss, "the chain never fired ⇒ a real miss").toBe(true);
  });

  test("(c) a deploy run created_at<mergedAt (a PRIOR unrelated deploy) does NOT count", async () => {
    // The lane shows recent activity, but none of it is FOR this merge
    // (runsSinceMerge 0, nothing completed since the merge). With the lane
    // otherwise idle (0 in flight), that prior deploy must not rescue the
    // judgment into "deploy completed" — it's still a no-deploy-fired miss.
    const ext = makeDeployQueueExtender({
      mergedAt: 0,
      activity: laneActivity({ inFlight: 0, recent: 0, deployCompletedSinceMerge: false, runsSinceMerge: 0 }),
    });
    const grant = await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(grant).toBe(0);
    expect(ext.verdict.kind).toBe("no-deploy-fired");
    expect(ext.verdict.realMiss).toBe(true);
  });

  test("an in-flight/queued deploy for the merge still EXTENDS (backlog draining)", async () => {
    const ext = makeDeployQueueExtender({
      mergedAt: 0,
      perDeployMs: 60_000,
      minExtendMs: 180_000,
      maxTotalExtendMs: 1_000_000,
      activity: laneActivity({ inFlight: 1, recent: 1, deployCompletedSinceMerge: false, runsSinceMerge: 1 }),
    });
    const grant = await ext({ elapsedMs: 5 * MIN, extensionCount: 0 });
    expect(grant, "deploy queued/in-flight for the merge ⇒ keep waiting").toBeGreaterThan(0);
  });

  test("back-compat: with no mergedAt the wall-clock-window heuristic still drives the verdict", async () => {
    // No mergedAt supplied ⇒ fall back to the legacy inFlight/recent logic
    // (a recently-active lane extends; a quiescent one gives up). This
    // keeps the existing deploy-pill.test.js cases passing.
    const idle = makeDeployQueueExtender({ activity: async () => ({ inFlight: 0, recent: 0 }) });
    expect(await idle({ elapsedMs: 1000, extensionCount: 0 })).toBe(0);
    const active = makeDeployQueueExtender({
      activity: async () => ({ inFlight: 0, recent: 2 }),
      perDeployMs: 60_000,
      minExtendMs: 180_000,
      maxTotalExtendMs: 1_000_000,
    });
    expect(await active({})).toBe(180_000);
  });
});

// ── #21: deployLaneActivity counts runs against mergedAt ───────────────
test.describe("deployLaneActivity anchored on mergedAt (#21)", () => {
  // Mutates globalThis.fetch in beforeEach/afterEach — run serial so the
  // global swap can't race sibling fetch-using tests under fullyParallel.
  test.describe.configure({ mode: "serial" });
  let originalFetch;
  test.beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Make global.fetch return a fixed deploy-production runs page for the
  // per_page list call, and 0 for the in_progress/queued count calls.
  function stubRuns(runs) {
    globalThis.fetch = async (url) => {
      const u = String(url);
      let workflow_runs = [];
      if (u.includes("status=in_progress") || u.includes("status=queued")) {
        workflow_runs = [];
      } else {
        workflow_runs = runs;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => JSON.stringify({ workflow_runs }),
        json: async () => ({ workflow_runs }),
      };
    };
  }

  test("counts only runs created_at>=mergedAt and flags a completed one", async () => {
    const mergedAt = Date.parse("2026-06-04T02:44:59Z");
    stubRuns([
      // FOR this merge: created after merge, completed success.
      { created_at: "2026-06-04T02:45:02Z", status: "completed", conclusion: "success" },
      // PRIOR unrelated deploy: created BEFORE the merge — must not count.
      { created_at: "2026-06-04T02:30:00Z", status: "completed", conclusion: "success" },
    ]);
    const act = await deployLaneActivity({ mergedAt });
    expect(act.runsSinceMerge, "only the post-merge run counts").toBe(1);
    expect(act.deployCompletedSinceMerge, "the post-merge run completed").toBe(true);
  });

  test("a prior-only deploy page yields runsSinceMerge 0, not completed", async () => {
    const mergedAt = Date.parse("2026-06-04T02:44:59Z");
    stubRuns([{ created_at: "2026-06-04T02:30:00Z", status: "completed", conclusion: "success" }]);
    const act = await deployLaneActivity({ mergedAt });
    expect(act.runsSinceMerge).toBe(0);
    expect(act.deployCompletedSinceMerge).toBe(false);
  });

  test("a post-merge run still in_progress is counted but not 'completed'", async () => {
    const mergedAt = Date.parse("2026-06-04T02:44:59Z");
    stubRuns([{ created_at: "2026-06-04T02:45:02Z", status: "in_progress", conclusion: null }]);
    const act = await deployLaneActivity({ mergedAt });
    expect(act.runsSinceMerge).toBe(1);
    expect(act.deployCompletedSinceMerge).toBe(false);
  });
});


// ── FIX 1 (#82): headChecksTrulyGreen + makePreviewCanaryRecoverer ──────
//
// Pure-injection unit tests (inject `_gh` / `_headChecksTrulyGreen`); no
// network, no globalThis.fetch swap. headChecksTrulyGreen is the
// feature-branch port of the nudge's headIsTrulyGreen; the recoverer is the
// in-spec preview canary recovery wired onto deploy-pill's onBudgetExhausted
// seam.

// Scripted gh() double for headChecksTrulyGreen: returns the queued
// check_runs page for any `/check-runs` path and statuses for `/status`.
function checksGhDouble({ checkRuns = [], statuses = [] } = {}) {
  const calls = [];
  const fn = async (pathname) => {
    calls.push(pathname);
    if (pathname.includes("/check-runs")) return { check_runs: checkRuns };
    if (pathname.endsWith("/status")) return { statuses };
    throw new Error(`unexpected gh path ${pathname}`);
  };
  fn.calls = calls;
  return fn;
}

test.describe("headChecksTrulyGreen (#82 feature-branch port)", () => {
  test("(a) all required green ⇒ ok", async () => {
    const _gh = checksGhDouble({
      checkRuns: [
        { name: "validate-content", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok).toBe(true);
  });

  test("CORRECTION #1: a prefixed `editorial / validate-content` run satisfies the bare context", async () => {
    const _gh = checksGhDouble({
      checkRuns: [
        { name: "editorial / validate-content", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok, "the suffix-tolerant match must find the workflow/job-prefixed check-run").toBe(true);
  });

  test("CORRECTION #1: tolerant match also applies to a legacy commit status context", async () => {
    const _gh = checksGhDouble({
      checkRuns: [],
      statuses: [{ context: "editorial / validate-content", state: "success" }],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok).toBe(true);
  });

  test("(b) a required run still in_progress ⇒ not ok (stub hazard)", async () => {
    const _gh = checksGhDouble({
      checkRuns: [{ name: "validate-content", status: "in_progress", conclusion: null }],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/still in_progress/);
  });

  test("(c) a cancelled run + a later success (same name) ⇒ ok (decisive = success)", async () => {
    const _gh = checksGhDouble({
      checkRuns: [
        { name: "validate-content", status: "completed", conclusion: "cancelled", started_at: "2026-01-01T00:00:00Z" },
        { name: "validate-content", status: "completed", conclusion: "success", started_at: "2026-01-01T00:05:00Z" },
      ],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok).toBe(true);
  });

  test("(d) all runs cancelled ⇒ not ok", async () => {
    const _gh = checksGhDouble({
      checkRuns: [{ name: "validate-content", status: "completed", conclusion: "cancelled", started_at: "2026-01-01T00:00:00Z" }],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/all runs cancelled/);
  });

  test("(e) missing context (no run, no status) ⇒ not ok", async () => {
    const _gh = checksGhDouble({
      checkRuns: [{ name: "some-unrelated-check", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" }],
      statuses: [],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/missing on head sha/);
  });

  test("(f) a red required run ⇒ not ok", async () => {
    const _gh = checksGhDouble({
      checkRuns: [{ name: "validate-content", status: "completed", conclusion: "failure", started_at: "2026-01-01T00:00:00Z" }],
    });
    const res = await headChecksTrulyGreen({ sha: "abc", requiredContexts: ["validate-content"], _gh });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/validate-content=failure/);
  });

  test("an empty requiredContexts throws (guards against an all-pass no-op)", async () => {
    const _gh = checksGhDouble({ checkRuns: [] });
    let thrown;
    try {
      await headChecksTrulyGreen({ sha: "abc", requiredContexts: [], _gh });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
  });
});

// Scripted gh() double for the recoverer: GET `/pulls/{n}` returns `pr`,
// PUT `/pulls/{n}/merge` runs mergeImpl (default success). Records call
// counts + the merge init so the test can assert the squash PUT shape.
function recovererGhDouble({ pr, mergeImpl } = {}) {
  const calls = { get: 0, merge: 0, mergeInits: [] };
  const fn = async (pathname, init) => {
    if (/\/merge$/.test(pathname)) {
      calls.merge += 1;
      calls.mergeInits.push(init);
      if (typeof mergeImpl === "function") return mergeImpl();
      return { merged: true };
    }
    calls.get += 1;
    return pr;
  };
  fn.calls = calls;
  return fn;
}

const OUR_CANARY = (overrides = {}) => ({
  state: "open",
  head: { ref: "cms/posts/x", sha: "sha-1" },
  base: { ref: "feat/preview-branch" },
  labels: [{ name: "automated-test" }],
  ...overrides,
});

test.describe("makePreviewCanaryRecoverer (#82 in-spec recovery)", () => {
  const greenChecks = async () => ({ ok: true });

  test("(a) an already-merged PR ⇒ extends (>0), never issues a merge PUT", async () => {
    const _gh = recovererGhDouble({ pr: { merged: true } });
    const rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      _gh,
      _headChecksTrulyGreen: greenChecks,
    });
    const grant = await rec();
    expect(grant).toBeGreaterThan(0);
    expect(_gh.calls.merge).toBe(0);
    expect(rec.verdict.kind).toBe("merged-awaiting-deploy");
  });

  test("(b) a closed (unmerged) canary ⇒ gives up (0), verdict canary-closed", async () => {
    const _gh = recovererGhDouble({ pr: { state: "closed" } });
    const rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      _gh,
      _headChecksTrulyGreen: greenChecks,
    });
    const grant = await rec();
    expect(grant).toBe(0);
    expect(_gh.calls.merge).toBe(0);
    expect(rec.verdict.kind).toBe("canary-closed");
  });

  test("(c) base mismatch / missing label / non-cms head ⇒ no merge PUT, verdict not-our-canary", async () => {
    // base mismatch
    let _gh = recovererGhDouble({ pr: OUR_CANARY({ base: { ref: "main" } }) });
    let rec = makePreviewCanaryRecoverer({ base: "feat/preview-branch", getPrNumber: () => 7, _gh, _headChecksTrulyGreen: greenChecks });
    await rec();
    expect(_gh.calls.merge, "base mismatch must not merge").toBe(0);
    expect(rec.verdict.kind).toBe("not-our-canary");

    // missing automated-test label
    _gh = recovererGhDouble({ pr: OUR_CANARY({ labels: [] }) });
    rec = makePreviewCanaryRecoverer({ base: "feat/preview-branch", getPrNumber: () => 7, _gh, _headChecksTrulyGreen: greenChecks });
    await rec();
    expect(_gh.calls.merge, "missing label must not merge").toBe(0);
    expect(rec.verdict.kind).toBe("not-our-canary");

    // non-cms/ head ref
    _gh = recovererGhDouble({ pr: OUR_CANARY({ head: { ref: "feature/foo", sha: "s" } }) });
    rec = makePreviewCanaryRecoverer({ base: "feat/preview-branch", getPrNumber: () => 7, _gh, _headChecksTrulyGreen: greenChecks });
    await rec();
    expect(_gh.calls.merge, "non-cms head must not merge").toBe(0);
    expect(rec.verdict.kind).toBe("not-our-canary");
  });

  test("(d) checks not green ⇒ no merge PUT, extends (>0)", async () => {
    const _gh = recovererGhDouble({ pr: OUR_CANARY() });
    const rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      _gh,
      _headChecksTrulyGreen: async () => ({ ok: false, why: "validate-content=failure" }),
    });
    const grant = await rec();
    expect(grant).toBeGreaterThan(0);
    expect(_gh.calls.merge).toBe(0);
    expect(rec.verdict.kind).toBe("checks-not-green");
  });

  test("(e) green + open + our canary ⇒ exactly one squash merge PUT, verdict recovery-merged", async () => {
    const _gh = recovererGhDouble({ pr: OUR_CANARY() });
    const rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      _gh,
      _headChecksTrulyGreen: greenChecks,
    });
    const grant = await rec();
    expect(grant).toBeGreaterThan(0);
    expect(_gh.calls.merge).toBe(1);
    expect(_gh.calls.mergeInits[0].method).toBe("PUT");
    expect(JSON.parse(_gh.calls.mergeInits[0].body)).toEqual({ merge_method: "squash" });
    expect(rec.verdict.kind).toBe("recovery-merged");
  });

  test("(f) merge throws 'already merged' ⇒ verdict merged-awaiting-deploy, extends (>0)", async () => {
    const _gh = recovererGhDouble({
      pr: OUR_CANARY(),
      mergeImpl: () => {
        throw new Error("GitHub API 405 Method Not Allowed: Pull Request is already merged");
      },
    });
    const rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      _gh,
      _headChecksTrulyGreen: greenChecks,
    });
    const grant = await rec();
    expect(grant).toBeGreaterThan(0);
    expect(_gh.calls.merge).toBe(1);
    expect(rec.verdict.kind).toBe("merged-awaiting-deploy");
  });

  test("(g) the maxTotalExtendMs ceiling is enforced ⇒ eventually returns 0 (no-deploy-fired)", async () => {
    const _gh = recovererGhDouble({ pr: OUR_CANARY() });
    const rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      perDeployMs: 5 * 60 * 1000,
      minExtendMs: 3 * 60 * 1000,
      maxTotalExtendMs: 6 * 60 * 1000,
      _gh,
      _headChecksTrulyGreen: greenChecks,
    });
    let last;
    for (let i = 0; i < 5; i++) last = await rec();
    expect(last, "once the extension budget is spent the recoverer gives up").toBe(0);
    expect(rec.verdict.kind).toBe("no-deploy-fired");
    expect(rec.verdict.realMiss).toBe(true);
  });

  test("no PR yet (getPrNumber resolves null) ⇒ no merge PUT, extends (>0)", async () => {
    const _gh = recovererGhDouble({ pr: OUR_CANARY() });
    const rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => null,
      _gh,
      _headChecksTrulyGreen: greenChecks,
    });
    const grant = await rec();
    expect(grant).toBeGreaterThan(0);
    expect(_gh.calls.get, "no PR ⇒ never even fetch the PR").toBe(0);
    expect(_gh.calls.merge).toBe(0);
    expect(rec.verdict.kind).toBe("no-pr-yet");
  });

  test("constructor guards: missing base or getPrNumber throw", () => {
    expect(() => makePreviewCanaryRecoverer({ getPrNumber: () => 1 })).toThrow(/requires base/);
    expect(() => makePreviewCanaryRecoverer({ base: "feat/x" })).toThrow(/requires getPrNumber/);
  });
});
