// @lane: local — pixel-level sample of a locally-rendered page; no network
const { test, expect } = require("./base");
const { PNG } = require("pngjs");

test.describe("Glow effect quality", () => {
  test("background glow gradient renders without visible color banding", async ({
    page,
  }, testInfo) => {
    // Chromium's forced-colors emulation overrides background rendering, which
    // produces long runs of identical pixels that aren't meaningful banding.
    // Check the project config directly — matchMedia() isn't reliable under
    // Playwright's forced-colors emulation.
    test.skip(
      testInfo.project.use.forcedColors === "active",
      "Gradient rendering differs in forced-colors mode",
    );

    await page.goto("/");

    // Hide page content so only background glow is visible for pixel analysis.
    // Freeze all animations at peak glow (end of the 8s warmth cycle = max opacity).
    await page.addStyleTag({
      content: `
        .site-wrapper { visibility: hidden !important; }
        *, *::before, *::after {
          animation-play-state: paused !important;
          animation-delay: -8s !important;
        }
      `,
    });

    await page.waitForTimeout(200);

    const screenshot = await page.screenshot({ type: "png" });
    const png = PNG.sync.read(screenshot);

    // Sample a horizontal line at the vertical center of the viewport,
    // from 10% to 50% width — this crosses through the radial gradient
    // transition where banding is most visible.
    const y = Math.floor(png.height / 2);
    const startX = Math.floor(png.width * 0.1);
    const endX = Math.floor(png.width * 0.5);

    const pixelColors = [];
    for (let x = startX; x < endX; x++) {
      const idx = (y * png.width + x) * 4;
      pixelColors.push({
        r: png.data[idx],
        g: png.data[idx + 1],
        b: png.data[idx + 2],
      });
    }

    // Measure the longest consecutive run of identical pixel colors.
    // With banding, the gradient forms visible "steps" — large blocks of the
    // same color that the eye perceives as discrete bands rather than a smooth
    // transition.  A smooth (dithered) gradient should never produce runs
    // longer than a few pixels.
    let maxRun = 1;
    let currentRun = 1;
    for (let i = 1; i < pixelColors.length; i++) {
      const prev = pixelColors[i - 1];
      const curr = pixelColors[i];
      if (prev.r === curr.r && prev.g === curr.g && prev.b === curr.b) {
        currentRun++;
        if (currentRun > maxRun) maxRun = currentRun;
      } else {
        currentRun = 1;
      }
    }

    // Real banding produces flat runs of 15+ pixels; tighter thresholds flake
    // on cross-project sub-pixel rendering variance (5 is common, observed on
    // chromium-large-text and chromium-forced-colors). 8 still catches the
    // visible step pattern this test exists for.
    expect(maxRun).toBeLessThanOrEqual(8);
  });
});
