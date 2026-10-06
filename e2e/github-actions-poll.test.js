// @lane: local — unit test for gh()'s bounded transient-retry (#1771 step 1).
//
// Exercises the retry wrapper without touching the network: global.fetch
// is monkey-patched to return a scripted sequence of responses, and the
// sleep is injected as a no-op (`_sleep`) so the test runs instantly and
// asserts nothing about wall-clock backoff except the value passed to the
// injected sleep (for the Retry-After case).
const { test, expect } = require("./base");
const {
  addLabel,
  describeError,
  gh,
  getFileTextAtRef,
  makeDeployQueueExtender,
  deployLaneActivity,
  headChecksTrulyGreen,
  makePreviewCanaryRecoverer,
  waitForCmsPullRequest,
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

// ── #215: an UNMERGED PR is not a deploy-chain miss ───────────────────
//
// Verdict (3) ("no-deploy-fired") reads "the chain never fired" from an idle
// deploy lane — but the lane is LEGITIMATELY idle for as long as the cms PR
// hasn't merged (nothing can deploy before a merge). That mis-diagnosed a
// live media-roundtrip run at ~907s as "NO deploy-production run fired" when
// the canary auto-merge was merely slow. With `getPr` supplied the extender
// asks the weaker, list-free question "has it merged?" first, and check-run
// STATE alone distinguishes "awaiting" from "red" — no requiredContexts list.
test.describe("makeDeployQueueExtender PR-state verdicts (#215)", () => {
  const MIN = 60 * 1000;
  const idleLane = async () => ({
    inFlight: 0,
    recent: 0,
    deployCompletedSinceMerge: false,
    runsSinceMerge: 0,
  });
  // gh() double for the head-sha check-runs read the extender does.
  const checkRunsGh = (checkRuns) => async (pathname) => {
    if (String(pathname).includes("/check-runs")) return { check_runs: checkRuns };
    throw new Error(`unexpected gh path ${pathname}`);
  };
  const unmergedPr = (overrides = {}) => ({
    number: 4242,
    merged: false,
    merged_at: null,
    head: { sha: "head-sha-1" },
    ...overrides,
  });

  test("(1) BACK-COMPAT: with no getPr an idle lane still yields no-deploy-fired", async () => {
    // The 13 bare call sites must keep today's verdicts byte-for-behaviour.
    const ext = makeDeployQueueExtender({ mergedAt: 0, activity: idleLane });
    const grant = await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(grant).toBe(0);
    expect(ext.verdict.kind).toBe("no-deploy-fired");
    expect(ext.verdict.realMiss).toBe(true);
  });

  test("(2) unmerged PR + a not-completed check ⇒ pr-awaiting-required-check + a POSITIVE extension", async () => {
    const ext = makeDeployQueueExtender({
      getPr: async () => unmergedPr(),
      activity: idleLane,
      minExtendMs: 3 * MIN,
      maxTotalExtendMs: 30 * MIN,
      _gh: checkRunsGh([{ name: "editorial / validate-content", status: "in_progress" }]),
    });
    const grant = await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(grant, "keep waiting through a slow auto-merge").toBe(3 * MIN);
    expect(ext.verdict.kind).toBe("pr-awaiting-required-check");
    expect(ext.verdict.realMiss, "an unmerged PR is NOT a deploy-chain miss").toBe(false);
    expect(ext.verdict.prNumber).toBe(4242);
    expect(ext.verdict.why).toMatch(/validate-content/);
    expect(ext.verdict.why).toMatch(/in_progress/);
  });

  test("(3) unmerged PR + a completed FAILING check ⇒ pr-required-check-red", async () => {
    const ext = makeDeployQueueExtender({
      getPr: async () => unmergedPr(),
      activity: idleLane,
      _gh: checkRunsGh([
        { name: "e2e / e2e", status: "completed", conclusion: "failure" },
        { name: "scan / scan", status: "completed", conclusion: "success" },
      ]),
    });
    await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(ext.verdict.kind).toBe("pr-required-check-red");
    expect(ext.verdict.realMiss).toBe(false);
    expect(ext.verdict.why).toMatch(/e2e \/ e2e/);
    expect(ext.verdict.why).toMatch(/failure/);
  });

  test("(4) unmerged PR + all checks green ⇒ pr-awaiting-required-check (awaiting the merge mechanism)", async () => {
    const ext = makeDeployQueueExtender({
      getPr: async () => unmergedPr(),
      activity: idleLane,
      _gh: checkRunsGh([
        { name: "editorial / validate-content", status: "completed", conclusion: "success" },
        { name: "e2e / e2e", status: "completed", conclusion: "skipped" },
      ]),
    });
    await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(ext.verdict.kind).toBe("pr-awaiting-required-check");
    expect(ext.verdict.realMiss).toBe(false);
    expect(ext.verdict.why).toMatch(/awaiting the merge mechanism/i);
  });

  test("(5) REACHABILITY LOCK: a MERGED PR + idle lane is STILL no-deploy-fired (realMiss true)", async () => {
    // Load-bearing: if 'no-deploy-fired' became unreachable, a genuine chain
    // miss would turn into silence — the opposite of #215's intent.
    const ext = makeDeployQueueExtender({
      getPr: async () => ({
        number: 99,
        merged: true,
        merged_at: "2026-08-08T00:00:00Z",
        head: { sha: "s" },
      }),
      activity: idleLane,
      _gh: checkRunsGh([]),
    });
    const grant = await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(grant, "a merged PR with no deploy is a real miss ⇒ give up").toBe(0);
    expect(ext.verdict.kind).toBe("no-deploy-fired");
    expect(ext.verdict.realMiss).toBe(true);
  });

  test("(6) a check-run probe error never upgrades to a real miss", async () => {
    const ext = makeDeployQueueExtender({
      getPr: async () => unmergedPr(),
      activity: idleLane,
      _gh: async () => {
        throw new Error("api 502");
      },
    });
    const grant = await ext({ elapsedMs: 20 * MIN, extensionCount: 0 });
    expect(grant).toBeGreaterThan(0);
    expect(ext.verdict.kind).toBe("pr-awaiting-required-check");
    expect(ext.verdict.realMiss).toBe(false);
    expect(ext.verdict.why).toMatch(/probe failed/i);
  });

  test("(7) BOUND: repeated unmerged-PR rounds cannot exceed maxTotalExtendMs", async () => {
    const ext = makeDeployQueueExtender({
      getPr: async () => unmergedPr(),
      activity: idleLane,
      minExtendMs: 3 * MIN,
      maxTotalExtendMs: 10 * MIN,
      _gh: checkRunsGh([{ name: "editorial / validate-content", status: "queued" }]),
    });
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const g = await ext({ elapsedMs: 20 * MIN, extensionCount: i });
      total += g;
      if (g === 0) break;
    }
    expect(total, "the extender can never extend past its own ceiling").toBeLessThanOrEqual(10 * MIN);
    expect(await ext({ elapsedMs: 40 * MIN, extensionCount: 99 })).toBe(0);
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

test.describe("getFileTextAtRef (#531)", () => {
  let originalFetch;
  test.beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reads the file at the given ref, decoding base64 and encoding the path and ref", async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return fakeResponse({
        json: { encoding: "base64", content: Buffer.from("---\ntitle: Ünï\n---\n", "utf8").toString("base64") },
      });
    };
    const text = await getFileTextAtRef({ repo: "o/r", filePath: "_posts/2099-12-31-e2e a.md", ref: "feat/x y" });
    expect(text).toBe("---\ntitle: Ünï\n---\n");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/repos/o/r/contents/_posts/2099-12-31-e2e%20a.md?ref=feat%2Fx%20y");
  });

  test("requires a file path and a ref, and rejects a non-file response", async () => {
    await expect(getFileTextAtRef({ filePath: "a.md" })).rejects.toThrow(/needs a filePath and a ref/);
    await expect(getFileTextAtRef({ ref: "abc" })).rejects.toThrow(/needs a filePath and a ref/);
    globalThis.fetch = async () => fakeResponse({ json: [{ name: "a.md" }] });
    await expect(getFileTextAtRef({ repo: "o/r", filePath: "a.md", ref: "abc" })).rejects.toThrow(/base64 file/);
  });
});

// ── API response bodies stay out of public output ───────────────────────
//
// This harness runs in the public CI of consumer repos: console output lands
// in the job log, an uncaught error's message in the `list` reporter, the
// live-failure PR comment and the media-roundtrip artifact. gh() keeps the
// raw response body in err.responseBody only, and every harness site that
// logs or rethrows a caught error goes through describeError(). Each case
// drives the REAL gh() against a fetch double whose body carries a marker.
test.describe("API response bodies never reach logs or thrown messages", () => {
  test.describe.configure({ mode: "serial" });

  const MARKER = "SECRET-BODY-MARKER-7c1e";
  const BODY = JSON.stringify({
    message: "Resource not accessible",
    detail: MARKER,
    documentation_url: "https://example.com/docs",
  });
  const denied = () => fakeResponse({ status: 403, body: BODY });

  let originalFetch;
  let originalWarn;
  let logged;
  test.beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    logged = [];
    console.warn = (...args) => logged.push(args.join(" "));
  });
  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  async function ghError() {
    globalThis.fetch = async () => denied();
    try {
      await gh("https://api.example.com/repos/o/r/pulls/7/merge");
    } catch (e) {
      return e;
    }
    throw new Error("expected gh() to throw");
  }

  test("gh()'s thrown message carries the status but not the body; responseBody keeps it", async () => {
    const err = await ghError();
    expect(err.status).toBe(403);
    expect(err.message).toContain("403");
    expect(err.message).not.toContain(MARKER);
    expect(err.message).not.toContain("example.com/docs");
    expect(err.responseBody).toContain(MARKER);
  });

  test("a 2xx whose body is not JSON throws a body-free SyntaxError carrying the status", async () => {
    // A real Response, so res.json() throws V8's own SyntaxError, which
    // quotes a body this short in full.
    const short = "leak.example.com";
    globalThis.fetch = async () => new Response(short, { status: 200 });
    const err = await gh("https://api.example.com/repos/o/r/pulls").catch((e) => e);
    expect(err.message).not.toContain(short);
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err.status).toBe(200);
    expect(describeError(err)).toBe("HTTP 200 SyntaxError");
    // An empty 204 (POST .../dispatches) still rejects as a SyntaxError,
    // which cms-scheduled-publish-loop.spec.js treats as success.
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await expect(gh("https://api.example.com/x/dispatches")).rejects.toBeInstanceOf(SyntaxError);
  });

  test("describeError gives `HTTP <status> <type>` or just the type", async () => {
    expect(describeError(await ghError())).toBe("HTTP 403 Error");
    expect(describeError(new TypeError(`fetch failed: ${MARKER}`))).toBe("TypeError");
    expect(describeError(new SyntaxError(`Unexpected token in "${MARKER}"`))).toBe("SyntaxError");
    expect(describeError("plain string")).toBe("String");
    expect(describeError(undefined)).toBe("undefined");
  });

  test("addLabel's failed pre-read warns with the status only", async () => {
    let issueReads = 0;
    globalThis.fetch = async (url, init = {}) => {
      if ((init.method || "GET") === "POST") return fakeResponse({ json: [] });
      issueReads += 1;
      return issueReads === 1 ? denied() : fakeResponse({ json: { labels: [{ name: "cms/ready" }] } });
    };
    await addLabel({ repo: "o/r", prNumber: 7, label: "cms/ready", verifyDelayMs: 0 });
    const out = logged.join("\n");
    expect(out).toContain("pre-read of #7 labels failed (HTTP 403 Error)");
    expect(out).not.toContain(MARKER);
  });

  test("waitForCmsPullRequest's failed auto-label warns with the status only", async () => {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("/pulls?")) return fakeResponse({ json: [{ number: 7, head: { ref: "cms/posts/x" } }] });
      if (u.includes("/pulls/7/files")) {
        return fakeResponse({ json: [{ filename: "_posts/x.md", patch: "+marker-run-1" }] });
      }
      if ((init.method || "GET") === "POST") return denied();
      throw new Error(`unexpected request ${u}`);
    };
    const pr = await waitForCmsPullRequest({
      repo: "o/r",
      base: "main",
      filePath: "_posts/x.md",
      canaryMarker: "marker-run-1",
    });
    expect(pr.number).toBe(7);
    const out = logged.join("\n");
    expect(out).toContain("could not label PR #7 automated-test: HTTP 403 Error");
    expect(out).not.toContain(MARKER);
  });

  test("the deploy-queue extender's failed lane probe warns with the status only", async () => {
    globalThis.fetch = async () => denied();
    const extend = makeDeployQueueExtender({ repo: "o/r", mergedAt: "2099-01-01T00:00:00Z" });
    const grant = await extend({ elapsedMs: 1000, extensionCount: 0 });
    expect(grant).toBeGreaterThan(0);
    const out = logged.join("\n");
    expect(out).toContain("could not probe the deploy-production.yml lane (HTTP 403 Error)");
    expect(out).not.toContain(MARKER);
  });

  test("a failed check-run probe puts only the status in the verdict that reaches the timeout error", async () => {
    globalThis.fetch = async () => denied();
    const extend = makeDeployQueueExtender({
      repo: "o/r",
      maxTotalExtendMs: 0,
      getPr: async () => ({ number: 7, merged: false, head: { sha: "abc" }, labels: [] }),
    });
    expect(await extend({ elapsedMs: 1000 })).toBe(0);
    expect(extend.verdict.kind).toBe("pr-awaiting-required-check");
    expect(extend.verdict.why).toContain("check-run probe failed (HTTP 403 Error)");
    expect(extend.verdict.why).not.toContain(MARKER);
  });

  test("the canary recoverer reads `already merged` from the body and records only the status otherwise", async () => {
    const already = new Error("GitHub API 405 Method Not Allowed on https://api.example.com/x");
    already.status = 405;
    already.responseBody = JSON.stringify({ message: "Pull Request is already merged" });
    let rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      _gh: recovererGhDouble({
        pr: OUR_CANARY(),
        mergeImpl: () => {
          throw already;
        },
      }),
      _headChecksTrulyGreen: async () => ({ ok: true }),
    });
    await rec();
    expect(rec.verdict.kind).toBe("merged-awaiting-deploy");

    const real = await ghError();
    rec = makePreviewCanaryRecoverer({
      base: "feat/preview-branch",
      getPrNumber: () => 7,
      _gh: recovererGhDouble({
        pr: OUR_CANARY(),
        mergeImpl: () => {
          throw real;
        },
      }),
      _headChecksTrulyGreen: async () => ({ ok: true }),
    });
    await rec();
    expect(rec.verdict.kind).toBe("merge-retry");
    expect(rec.verdict.why).toBe("HTTP 403 Error");
  });
});
