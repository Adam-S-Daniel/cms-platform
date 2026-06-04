// @lane: local — runtime contract for admin/posts-list-enhance.js (the
// `#cms-ple-bar` dashboard inserted above Decap's Posts list). Runs the
// script in a real browser (Chromium + WebKit iPhone 16) — the pure-fs
// lock in cms-posts-list-enhance.spec.js can't catch behavioural bugs.
const { test, expect } = require("./base");
const path = require("node:path");
const { guard } = require("./base-collections-guards");
// SITE_ROOT for the #33 base_collections guard (build-INDEPENDENT source signal).
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

test.describe(
  "/admin/ posts-list dashboard: runtime interactivity",
  // Tagged @admin-read: drives /admin/* but is read-only (no Decap Save).
  // Runs on chromium-desktop-3k AND webkit-iphone16 — the WebKit run is
  // the one that mattered for the bug this test guards against (a
  // self-sustaining `bar.innerHTML` rewrite loop made the bar's
  // checkbox / Refresh button untappable on iOS Safari).
  { tag: ["@admin-read"] },
  () => {
    // #33 — a base_collections:[] consumer strips the Posts block from
    // config-local.yml, so the dashboard's wait for the Posts sidebar link
    // would time out. Skip unless posts is kept.
    test.skip(...guard(SITE_ROOT, "cms-posts-list-runtime.spec.js"));

    // The bar must NOT churn. A regression where ensureBar() rewrites
    // bar.innerHTML on every MutationObserver-triggered augment()
    // turned the bar into a ~60 Hz re-parse loop, detaching the
    // checkbox / Refresh button mid-tap on iOS Safari so the
    // synthesized click landed on a disconnected element — the page
    // looked normal but tapping anything in the bar did nothing.
    test("bar does not enter an infinite innerHTML rewrite loop", async ({ page }) => {
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
      await page.getByRole("link", { name: /^posts$/i }).click();
      await page.locator("#cms-ple-bar").waitFor({ timeout: 30_000 });

      // Count child-list mutations on the bar over a 2-second window.
      // After the fix this is 0 in steady state; before, it was ~400.
      const mutations = await page.evaluate(async () => {
        const bar = document.getElementById("cms-ple-bar");
        let count = 0;
        const obs = new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === "childList") {
              count += r.addedNodes.length + r.removedNodes.length;
            }
          }
        });
        obs.observe(bar, { childList: true, subtree: true });
        await new Promise((r) => setTimeout(r, 2000));
        obs.disconnect();
        return count;
      });
      // Generous threshold — allows a few legitimate writes (e.g. one
      // initial paint + one when refreshRemote's deploy-status data
      // resolves), but flags the runaway loop (which produced 400+).
      expect(
        mutations,
        `#cms-ple-bar churned ${mutations} child mutations in 2s — ` +
          "ensureBar() is rewriting innerHTML on every augment() pass. " +
          "Diff-check nextHTML against the last-rendered string.",
      ).toBeLessThan(20);
    });

    test("show-fixtures checkbox toggles and the click lands", async ({ page }) => {
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
      await page.getByRole("link", { name: /^posts$/i }).click();

      const cb = page.locator("#cms-ple-show-fixtures");
      await cb.waitFor({ timeout: 30_000 });
      const before = await cb.isChecked();

      // Bounded timeout — under the bug Playwright kept retrying as the
      // element detached, so this `click()` ate 30 s before failing
      // with "element was detached from the DOM". 5 s is plenty for a
      // healthy click and tight enough to fail fast on regression.
      await cb.click({ timeout: 5_000 });
      // Decap's React owns the surrounding DOM; give the change
      // listener one frame to flip applyHideClass(), then re-read.
      await page.waitForTimeout(200);
      const after = await cb.isChecked();
      expect(after).toBe(!before);

      // The hide-class is the user-visible side effect of the toggle.
      const bodyClassFlipped = await page.evaluate(() =>
        document.body.classList.contains("cms-ple-hide-fixtures"),
      );
      // checkbox checked ⇔ fixtures shown ⇔ hide-class absent
      expect(bodyClassFlipped).toBe(!after);
    });
  },
);
