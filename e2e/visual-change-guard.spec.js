// @lane: local — pure-fs invariants on locally-captured screenshot frames
const { test, expect } = require("./base");
const { PNG } = require("pngjs");
const fs = require("fs");
const path = require("path");

const AFTER_DIR = path.join(__dirname, "visual-regression.spec.js-snapshots");
const BEFORE_DIR = AFTER_DIR + "-before";

test.describe(
  "Visual change guard",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test("snapshot updates are present and bounded", async () => {
      // Pure file comparison — only needs to run once, not per-project.
      test.skip(
        !fs.existsSync(BEFORE_DIR),
        "No -before directory (not a snapshot update workflow)",
      );

      const files = fs
        .readdirSync(AFTER_DIR)
        .filter((f) => f.endsWith(".png"))
        .sort();

      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const beforePath = path.join(BEFORE_DIR, file);
        if (!fs.existsSync(beforePath)) continue;

        const afterPng = PNG.sync.read(fs.readFileSync(path.join(AFTER_DIR, file)));
        const beforePng = PNG.sync.read(fs.readFileSync(beforePath));

        // Count pixels that differ in any RGB channel.
        let diffPixels = 0;
        const totalPixels = afterPng.width * afterPng.height;

        for (let i = 0; i < afterPng.data.length; i += 4) {
          if (
            afterPng.data[i] !== beforePng.data[i] ||
            afterPng.data[i + 1] !== beforePng.data[i + 1] ||
            afterPng.data[i + 2] !== beforePng.data[i + 2]
          ) {
            diffPixels++;
          }
        }

        const diffRatio = diffPixels / totalPixels;

        // The change should actually be visible — identical snapshots mean
        // the intended visual change never took effect.
        expect(
          diffRatio,
          `${file}: expected visual change but snapshots are identical`,
        ).toBeGreaterThan(0);

        // A change over 25% of pixels is likely a broken render, not an
        // intentional tweak.
        expect(
          diffRatio,
          `${file}: change exceeds 25% of pixels — possible broken render`,
        ).toBeLessThan(0.25);
      }
    });
  },
);
