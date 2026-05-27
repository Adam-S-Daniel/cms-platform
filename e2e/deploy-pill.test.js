// @lane: local — pure-logic invariants for the queue-aware reflect wait (#1723 Cat 1)
//
// No browser: waitForChangeReflected is driven through a tiny fake
// `page` (its DOM calls are stubbed) so the deadline / extension /
// failure-message logic is unit-testable without a real deploy chain.
const { test, expect } = require("./base");
const { waitForChangeReflected } = require("./deploy-pill");
const { makeDeployQueueExtender } = require("./github-actions-poll");

// Fake Playwright page: pill never in failure state, waits are near-
// instant (capped so the wall-clock deadline still advances), terminal
// pill check passes immediately.
function makeFakePage() {
  return {
    evaluate: async () => false, // pill never "failed"
    waitForTimeout: async (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 4))),
    waitForFunction: async () => {}, // terminal pill state OK
  };
}

test.describe("waitForChangeReflected queue-aware budget (#1723 Cat 1)", () => {
  test("extends while the lane is draining, then fails citing the extensions", async () => {
    let calls = 0;
    // Return a positive extension twice, then 0 (give up).
    const onBudgetExhausted = async ({ extensionCount }) => {
      calls += 1;
      expect(extensionCount).toBe(calls - 1); // monotonic round counter
      return calls <= 2 ? 25 : 0;
    };
    let threw;
    try {
      await waitForChangeReflected({
        page: makeFakePage(),
        pillId: "x",
        urlCheck: async () => false, // never reflects
        urlTimeoutMs: 40,
        urlPollMs: 10,
        onBudgetExhausted,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw, "must time out when the URL never reflects").toBeTruthy();
    expect(calls, "extender consulted once per exhausted budget round").toBe(3);
    // extensionCount > 0 ⇒ the "drained a backlog but still never
    // reflected" message, not the blind-budget one.
    expect(threw.message).toMatch(/2 queue-aware extension/);
    expect(threw.message).not.toMatch(/lane was idle/);
  });

  test("idle lane (extender returns 0 first time) fails as a real miss, fast", async () => {
    let calls = 0;
    const onBudgetExhausted = async () => {
      calls += 1;
      return 0; // lane idle ⇒ give up immediately
    };
    let threw;
    try {
      await waitForChangeReflected({
        page: makeFakePage(),
        pillId: "x",
        urlCheck: async () => false,
        urlTimeoutMs: 30,
        urlPollMs: 10,
        onBudgetExhausted,
      });
    } catch (e) {
      threw = e;
    }
    expect(calls).toBe(1);
    expect(threw.message).toMatch(/lane was idle/);
    expect(threw.message).toMatch(/never fired the chain/);
  });

  test("respects maxExtensions (a stuck lane cannot extend forever)", async () => {
    let calls = 0;
    const onBudgetExhausted = async () => {
      calls += 1;
      return 25; // always claims a backlog
    };
    let threw;
    try {
      await waitForChangeReflected({
        page: makeFakePage(),
        pillId: "x",
        urlCheck: async () => false,
        urlTimeoutMs: 25,
        urlPollMs: 8,
        onBudgetExhausted,
        maxExtensions: 3,
      });
    } catch (e) {
      threw = e;
    }
    expect(calls, "extender consulted at most maxExtensions times").toBe(3);
    expect(threw.message).toMatch(/3 queue-aware extension/);
  });

  test("a probe/extender error does not mask the failure (treated as no extension)", async () => {
    const onBudgetExhausted = async () => {
      throw new Error("boom");
    };
    let threw;
    try {
      await waitForChangeReflected({
        page: makeFakePage(),
        pillId: "x",
        urlCheck: async () => false,
        urlTimeoutMs: 25,
        urlPollMs: 8,
        onBudgetExhausted,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw, "still throws on timeout when the extender errors").toBeTruthy();
    // No successful extension happened.
    expect(threw.message).not.toMatch(/queue-aware extension/);
  });

  test("no extender ⇒ original blind-budget behaviour (back-compat)", async () => {
    let threw;
    try {
      await waitForChangeReflected({
        page: makeFakePage(),
        pillId: "x",
        urlCheck: async () => false,
        urlTimeoutMs: 20,
        urlPollMs: 8,
      });
    } catch (e) {
      threw = e;
    }
    expect(threw.message).toMatch(/Timed out within/);
    expect(threw.message).not.toMatch(/queue-aware extension/);
    expect(threw.message).not.toMatch(/lane was idle/);
  });

  test("resolves (no throw) when the URL reflects before the budget", async () => {
    let n = 0;
    await waitForChangeReflected({
      page: makeFakePage(),
      pillId: "x",
      urlCheck: async () => ++n >= 2, // reflects on the 2nd poll
      urlTimeoutMs: 5000,
      urlPollMs: 5,
    });
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

test.describe("makeDeployQueueExtender lane activity (#1723 Cat 1, refined)", () => {
  // `activity` returns { inFlight, recent }. Quiescent = both 0.
  const act = (inFlight, recent) => async () => ({ inFlight, recent });

  test("genuinely quiescent lane (0 in flight, 0 recent) → 0 (give up)", async () => {
    const ext = makeDeployQueueExtender({ activity: act(0, 0) });
    expect(await ext({ elapsedMs: 1000, extensionCount: 0 })).toBe(0);
  });

  test("recently-active lane (0 in flight but recent>0) → EXTENDS, not idle", async () => {
    // The refinement: a momentary gap between frequent deploys must NOT
    // be read as "chain never fired". With a deploy completed recently,
    // the lane is cycling — extend (prod-mutate run 26487434047 regressor).
    const ext = makeDeployQueueExtender({
      activity: act(0, 2),
      perDeployMs: 60_000,
      minExtendMs: 180_000,
      maxTotalExtendMs: 1_000_000,
    });
    // No in-flight → scale by 1 deploy's worth = 60s, floored to 180s.
    expect(await ext({})).toBe(180_000);
  });

  test("in-flight lane → proportional, floored extension", async () => {
    const ext = makeDeployQueueExtender({
      activity: act(1, 1),
      perDeployMs: 60_000,
      minExtendMs: 180_000,
      maxTotalExtendMs: 1_000_000,
    });
    expect(await ext({})).toBe(180_000); // 1×60s floored to 180s
    const ext2 = makeDeployQueueExtender({
      activity: act(4, 4),
      perDeployMs: 60_000,
      minExtendMs: 60_000,
      maxTotalExtendMs: 1_000_000,
    });
    expect(await ext2({})).toBe(240_000); // 4×60s
  });

  test("respects the overall maxTotalExtendMs ceiling across rounds", async () => {
    const ext = makeDeployQueueExtender({
      activity: act(10, 10), // always active
      perDeployMs: 60_000,
      minExtendMs: 60_000,
      maxTotalExtendMs: 500_000,
    });
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const g = await ext({ extensionCount: i });
      total += g;
      if (g === 0) break;
    }
    expect(total).toBeLessThanOrEqual(500_000);
    expect(await ext({ extensionCount: 99 })).toBe(0);
  });

  test("probe error → one conservative extension (no false fail on an API blip)", async () => {
    const ext = makeDeployQueueExtender({
      activity: async () => {
        throw new Error("api 502");
      },
      minExtendMs: 120_000,
      maxTotalExtendMs: 1_000_000,
    });
    expect(await ext({ extensionCount: 0 })).toBe(120_000);
  });
});
