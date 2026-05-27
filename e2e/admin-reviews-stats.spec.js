// @lane: local — mocks GitHub API + regression.json fetches via page.route; no auth
const { test, expect } = require("./base");
const { captureStep } = require("./manual-capture");

// Verifies that the /admin/reviews/ dashboard renders the visual-diff
// stats (visuallyDifferent vs potentiallyAffected, plus the per-page
// list) once a card is on screen. Mocks the GitHub API and the
// regression.json fetch so the test runs hermetically with no auth.

const FAKE_TOKEN = "ghp_fake_token_for_test";
const PR_NUMBER = 123;
const REGRESSION_JSON = {
  totals: {
    identical: 7,
    different: 2,
    new: 1,
    visuallyDifferent: 3,
    potentiallyAffected: 10,
  },
  pages: [
    { path: "/", status: "identical", diffRatio: 0 },
    { path: "/blog/", status: "identical", diffRatio: 0 },
    // allowed: literal slug used for known fixture (synthetic regression-stats payload)
    { path: "/blog/test-post/", status: "different", diffRatio: 0.123 },
    { path: "/projects/foo/", status: "different", diffRatio: 0.05 },
    // allowed: literal slug used for known fixture (synthetic regression-stats payload)
    { path: "/blog/brand-new/", status: "new", diffRatio: null },
  ],
};

test.describe(
  "/admin/reviews/ visual-diff stats",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test("renders stat grid and per-page list from regression.json", async ({ page }) => {
      // Pre-seed the auth token so the dashboard skips the sign-in screen.
      await page.addInitScript((token) => {
        localStorage.setItem("gh_reviews_token", token);
      }, FAKE_TOKEN);

      // Mock GitHub API responses the dashboard issues during init().
      await page.route("https://api.github.com/**", async (route) => {
        const url = route.request().url();
        const path = new URL(url).pathname;

        if (path === "/user") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ login: "stat-spec-user" }),
          });
        }

        if (path.endsWith("/actions/runs")) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              workflow_runs: [
                {
                  id: 9999,
                  name: "Visual Regression",
                  head_sha: "abcdef1234567890",
                  pull_requests: [{ number: PR_NUMBER }],
                },
              ],
            }),
          });
        }

        if (path.endsWith("/pending_deployments")) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([{ environment: { id: 7 } }]),
          });
        }

        if (path.endsWith(`/pulls/${PR_NUMBER}`)) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              title: "Test PR title",
              head: { ref: "cms/draft-test" },
            }),
          });
        }

        return route.fulfill({ status: 404, body: "{}" });
      });

      // Mock the regression.json fetch the dashboard makes per card.
      await page.route(
        `https://preview-pr${PR_NUMBER}.adamdaniel.ai/regression.json`,
        async (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(REGRESSION_JSON),
          }),
      );

      await page.goto("/admin/reviews/");
      await expect(page.locator("#dashboard")).toBeVisible();

      // The stat-grid must render the four headline stats.
      const grid = page.locator(".review-card .stat-grid");
      await expect(grid).toBeVisible();

      // Visually different — 3
      await expect(grid.locator(".stat-card.stat-different .stat-value")).toHaveText("3");

      // Potentially affected — 10
      await expect(grid.locator(".stat-card.stat-affected .stat-value")).toHaveText("10");

      // Identical — 7
      await expect(grid.locator(".stat-card.stat-identical .stat-value")).toHaveText("7");

      // The per-page list of visually-different paths must include each
      // different + new entry. We don't assert order — the implementation
      // is free to reorder.
      const pagesLine = page.locator(".review-card .stat-pages");
      // allowed: literal slug used for known fixture (matches the synthetic payload above)
      await expect(pagesLine).toContainText("/blog/test-post/");
      await expect(pagesLine).toContainText("/projects/foo/");
      // allowed: literal slug used for known fixture (matches the synthetic payload above)
      await expect(pagesLine).toContainText("/blog/brand-new/");
      // Identical pages must NOT appear in the per-page list. Match on
      // the exact path (terminated by space-dot-space delimiter or end)
      // so `/blog/` doesn't false-match the `/blog/test-post/` prefix.
      const pagesText = await pagesLine.textContent();
      expect(pagesText.split(/\s·\s/)).not.toContain("/blog/");
      expect(pagesText.split(/\s·\s/)).not.toContain("/");
      await captureStep(page, {
        section: "Reviewing visual regressions",
        step: "11.1",
        title: "Visual-diff dashboard",
        body: "The `/admin/reviews/` dashboard shows one card per open visual-regression review. The stat grid summarises how many pages are visually different vs. potentially affected vs. identical, and the per-page line lists every URL that changed — click through to compare the before/after on the preview deploy.",
      });
    });

    test("falls back gracefully when regression.json is unavailable", async ({ page }) => {
      await page.addInitScript((token) => {
        localStorage.setItem("gh_reviews_token", token);
      }, FAKE_TOKEN);

      await page.route("https://api.github.com/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/user") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ login: "fallback-spec-user" }),
          });
        }
        if (path.endsWith("/actions/runs")) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              workflow_runs: [
                {
                  id: 8888,
                  name: "Visual Regression",
                  head_sha: "0123456789abcdef",
                  pull_requests: [{ number: PR_NUMBER }],
                },
              ],
            }),
          });
        }
        if (path.endsWith("/pending_deployments")) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([{ environment: { id: 1 } }]),
          });
        }
        if (path.endsWith(`/pulls/${PR_NUMBER}`)) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              title: "Older PR",
              head: { ref: "cms/draft-older" },
            }),
          });
        }
        return route.fulfill({ status: 404, body: "{}" });
      });

      await page.route(
        `https://preview-pr${PR_NUMBER}.adamdaniel.ai/regression.json`,
        async (route) => route.fulfill({ status: 404, body: "" }),
      );

      await page.goto("/admin/reviews/");
      await expect(page.locator("#dashboard")).toBeVisible();

      // Card still renders, video still plays — only the stats area
      // shows a polite placeholder.
      await expect(page.locator(".review-card")).toBeVisible();
      await expect(page.locator(".review-card .stat-pages-loading")).toContainText(
        /not available/i,
      );
      await captureStep(page, {
        section: "Reviewing visual regressions",
        step: "11.2",
        title: "Review card without regression data",
        body: "When a preview deploy hasn't published `regression.json` yet (or the file 404s for any other reason), the card still renders but the stats area shows a polite placeholder. Re-run the visual-regression workflow on the PR to repopulate the data.",
      });
    });

    // Defensive lock-in for the cobalt theme: if the reviews dashboard ever
    // grows a Decap-styled `ControlHint` (helper text under a form input),
    // its colour MUST stay readable on the cobalt background. Decap's
    // default `rgb(93, 98, 111)` is too dark and was the chat finding #12
    // motivator. Today the dashboard uses its own form controls (no Decap),
    // so the assertion skips when no `ControlHint` is visible — but if one
    // ever appears, contrast gets enforced automatically.
    test("any rendered ControlHint has ≥ 4.5:1 contrast on its background", async ({ page }) => {
      await page.addInitScript((token) => {
        localStorage.setItem("gh_reviews_token", token);
      }, FAKE_TOKEN);

      // Bare-bones GitHub mocks — we only need the dashboard to render.
      await page.route("https://api.github.com/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/user") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ login: "controlhint-spec-user" }),
          });
        }
        if (path.endsWith("/actions/runs")) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ workflow_runs: [] }),
          });
        }
        return route.fulfill({ status: 404, body: "{}" });
      });

      await page.goto("/admin/reviews/");
      await expect(page.locator("#dashboard")).toBeVisible();

      // Look for any element whose class contains `ControlHint` (Decap's
      // emotion-CSS-in-JS naming convention). The reviews dashboard
      // currently doesn't ship Decap, so this is expected to be empty —
      // but if a future change embeds a Decap widget (or copy-pastes
      // its class names), we want the assertion to fire.
      const hints = page.locator('[class*="ControlHint"]:visible');
      const count = await hints.count();

      test.skip(
        count === 0,
        "No ControlHint elements on /admin/reviews/ — skipping contrast assertion",
      );

      for (let i = 0; i < count; i++) {
        const ratio = await hints.nth(i).evaluate((el) => {
          // Walk to the first ancestor that has a non-transparent background
          // colour — that's the surface this hint actually paints onto.
          function rgbToLuma(rgb) {
            // rgb / rgba string → 0..1 relative luminance per WCAG.
            const m = rgb.match(/\d+(?:\.\d+)?/g);
            if (!m || m.length < 3) return null;
            const [r, g, b] = m.slice(0, 3).map(Number);
            const norm = [r, g, b].map((c) => {
              const v = c / 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * norm[0] + 0.7152 * norm[1] + 0.0722 * norm[2];
          }
          function isOpaque(rgb) {
            const m = rgb.match(/[\d.]+/g);
            if (!m) return false;
            // rgb(...) → 3 values, opaque. rgba(...) with alpha 1 also opaque.
            if (m.length === 3) return true;
            return Number(m[3]) >= 0.999;
          }
          const fg = getComputedStyle(el).color;
          let cur = el;
          let bg = "";
          while (cur && cur !== document.documentElement) {
            const c = getComputedStyle(cur).backgroundColor;
            if (c && isOpaque(c)) {
              bg = c;
              break;
            }
            cur = cur.parentElement;
          }
          if (!bg) bg = getComputedStyle(document.body).backgroundColor || "rgb(4,6,15)";

          const lFg = rgbToLuma(fg);
          const lBg = rgbToLuma(bg);
          if (lFg == null || lBg == null) return null;
          const [lighter, darker] = lFg > lBg ? [lFg, lBg] : [lBg, lFg];
          return (lighter + 0.05) / (darker + 0.05);
        });

        expect(
          ratio,
          `ControlHint #${i} contrast ratio against its background must be ≥ 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  },
);
