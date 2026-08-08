// @lane: local — pure-fs/logic unit test; no browser, no network, no wall-clock
// sleeping. Only requires ./wait-for-render (a harness-local module, not
// platform theme/scripts/scaffold/workflow source), so it is NOT a
// PLATFORM_META_SPEC — it runs on consumer lanes same as the harness module it
// tests.
//
// Locks the timing invariant e2e/wait-for-render.js depends on for its
// DOM-quiescence wait (adamdaniel.ai PR #2994 — see that file's header for the
// full incident write-up): the quiet period the MutationObserver waits for
// must be reachable inside the overall bound, or the wait can never resolve
// early and always burns its full timeout.
const { test, expect } = require("./base");
const {
  waitForRenderSettled,
  NETWORK_IDLE_TIMEOUT_MS,
  QUIET_PERIOD_MS,
  QUIESCENCE_TIMEOUT_MS,
} = require("./wait-for-render");

test("QUIET_PERIOD_MS is reachable inside QUIESCENCE_TIMEOUT_MS", () => {
  // If this were inverted (or equal), the quiet timer set inside the
  // MutationObserver wait could never fire before the overall bound cuts it
  // off, so the quiescence leg would time out on EVERY page instead of only
  // the ones that are genuinely still mutating.
  expect(
    QUIET_PERIOD_MS,
    "the quiet period must be strictly smaller than the overall quiescence bound",
  ).toBeLessThan(QUIESCENCE_TIMEOUT_MS);
});

test("all three timing constants are positive, finite bounds", () => {
  for (const ms of [NETWORK_IDLE_TIMEOUT_MS, QUIET_PERIOD_MS, QUIESCENCE_TIMEOUT_MS]) {
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  }
});

test("the networkidle wait is bounded well below Playwright's own 30s action default", () => {
  // Not load-bearing for correctness, but a regression here (someone bumping
  // this toward Playwright's default action timeout) would mean a single slow
  // page eats most of a test's budget before the DOM-quiescence leg even
  // starts.
  expect(NETWORK_IDLE_TIMEOUT_MS).toBeLessThan(30_000);
});

test("waitForRenderSettled never throws when the page's waits time out", async () => {
  // A fake `page` whose waitForLoadState/evaluate always reject — the
  // "hung/slow page" case this function exists to survive. No browser
  // involved: waitForRenderSettled only calls the two methods it's handed.
  const page = {
    waitForLoadState: () => Promise.reject(new Error("networkidle never happened")),
    evaluate: () => Promise.reject(new Error("execution context destroyed")),
  };
  const logged = [];
  await expect(waitForRenderSettled(page, (msg) => logged.push(msg))).resolves.toBeUndefined();
  expect(logged.length).toBe(2);
  expect(logged[0]).toContain("networkidle timed out");
  expect(logged[1]).toContain("DOM-quiescence wait failed");
});

test("waitForRenderSettled resolves quietly when both waits succeed", async () => {
  const page = {
    waitForLoadState: () => Promise.resolve(),
    evaluate: () => Promise.resolve(),
  };
  const logged = [];
  await expect(waitForRenderSettled(page, (msg) => logged.push(msg))).resolves.toBeUndefined();
  expect(logged).toEqual([]);
});

test("waitForRenderSettled passes the exported constants through to page calls", async () => {
  const seen = {};
  const page = {
    waitForLoadState: (state, opts) => {
      seen.state = state;
      seen.timeout = opts.timeout;
      return Promise.resolve();
    },
    evaluate: (fn, arg) => {
      seen.quietMs = arg.quietMs;
      seen.boundMs = arg.boundMs;
      return Promise.resolve();
    },
  };
  await waitForRenderSettled(page);
  expect(seen.state).toBe("networkidle");
  expect(seen.timeout).toBe(NETWORK_IDLE_TIMEOUT_MS);
  expect(seen.quietMs).toBe(QUIET_PERIOD_MS);
  expect(seen.boundMs).toBe(QUIESCENCE_TIMEOUT_MS);
});
