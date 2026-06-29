// @lane: local — pure-table unit test for computeBaselineHeal (FIX 2).
// No browser, no network: the page/gh side-effects stay in
// cms-unpublish-republish.spec.js and are exercised by the live host loop.
const { test, expect } = require("./base");
const { computeBaselineHeal } = require("./canary-baseline-heal");

test.describe("computeBaselineHeal — canary self-heal decision (FIX 2)", () => {
  const cases = [
    {
      name: "clean baseline (all false) ⇒ atBaseline, no action",
      in: { mainPublished: false, lingeringPR: false, urlServes: false },
      out: { atBaseline: true, needClosePr: false, needSeed: false, needUrlWait: false },
    },
    {
      name: "mainPublished only ⇒ close PR + seed + url-wait",
      in: { mainPublished: true, lingeringPR: false, urlServes: false },
      out: { atBaseline: false, needClosePr: true, needSeed: true, needUrlWait: true },
    },
    {
      name: "urlServes only (stale CDN, main already false) ⇒ close PR + url-wait, NO seed",
      in: { mainPublished: false, lingeringPR: false, urlServes: true },
      out: { atBaseline: false, needClosePr: true, needSeed: false, needUrlWait: true },
    },
    {
      name: "lingeringPR only ⇒ close PR, NO seed, NO url-wait",
      in: { mainPublished: false, lingeringPR: true, urlServes: false },
      out: { atBaseline: false, needClosePr: true, needSeed: false, needUrlWait: false },
    },
    {
      name: "all dirty ⇒ close PR + seed + url-wait",
      in: { mainPublished: true, lingeringPR: true, urlServes: true },
      out: { atBaseline: false, needClosePr: true, needSeed: true, needUrlWait: true },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(computeBaselineHeal(c.in)).toEqual(c.out);
    });
  }

  test("any single dirty signal ⇒ not atBaseline", () => {
    expect(
      computeBaselineHeal({ mainPublished: true, lingeringPR: false, urlServes: false }).atBaseline,
    ).toBe(false);
    expect(
      computeBaselineHeal({ mainPublished: false, lingeringPR: true, urlServes: false }).atBaseline,
    ).toBe(false);
    expect(
      computeBaselineHeal({ mainPublished: false, lingeringPR: false, urlServes: true }).atBaseline,
    ).toBe(false);
  });
});
