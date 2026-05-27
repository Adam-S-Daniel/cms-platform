// @lane: local — unit test for gh()'s bounded transient-retry (#1771 step 1).
//
// Exercises the retry wrapper without touching the network: global.fetch
// is monkey-patched to return a scripted sequence of responses, and the
// sleep is injected as a no-op (`_sleep`) so the test runs instantly and
// asserts nothing about wall-clock backoff except the value passed to the
// injected sleep (for the Retry-After case).
const { test, expect } = require("./base");
const { gh } = require("./github-actions-poll");

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
