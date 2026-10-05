// @lane: local — reads computed animation state of a locally-rendered page; no network
// #656: the theme's always-running glow animations must stop under
// `prefers-reduced-motion: reduce` and still run with no preference.
const { test, expect } = require("./base");

async function infiniteRunning(page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter(
        (a) =>
          a.playState === "running" &&
          a.effect.getComputedTiming().iterations === Infinity,
      )
      .map((a) => a.animationName),
  );
}

test.describe("Reduced motion", () => {
  test.describe("no-preference (control)", () => {
    test.use({ reducedMotion: "no-preference" });

    test("the glow and thermal animations run", async ({ page }) => {
      await page.goto("/");
      const names = await infiniteRunning(page);
      expect(names).toContain("thermal");
      expect(names).toContain("warmth");
    });
  });

  test.describe("reduce", () => {
    test.use({ reducedMotion: "reduce" });

    test("no infinite animation runs", async ({ page }) => {
      await page.goto("/");
      expect(await infiniteRunning(page)).toEqual([]);
    });
  });
});
