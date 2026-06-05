// @lane: local — mocks every GitHub API request via page.route; runs hermetically
const path = require("node:path");
const { test, expect } = require("./base");
const { captureStep } = require("./manual-capture");
const { guard } = require("./base-collections-guards");

// SITE_ROOT — the consuming site's repo root; the #21 guard-registry meta-proof
// overrides it to point at a fixture.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

// Verifies the /admin/reviews/health.html QA dashboard:
//   - renders one widget per known workflow,
//   - surfaces success / failure / in-progress states with the right
//     indicator colour,
//   - degrades gracefully on 404 (workflow file not yet deployed) and
//     non-200 (API error),
//   - caches the per-workflow response in localStorage for 60s so a
//     repeated navigation doesn't re-hit GitHub,
//   - and busts the cache when the user clicks Refresh.
//
// All GitHub API requests are mocked via `page.route`. The spec MUST NOT
// hit the real GitHub API — the CI harness has no token, and the
// dashboard would otherwise burn through anonymous rate limits.

const FAKE_TOKEN = "ghp_fake_token_for_health_test";

const WORKFLOW_FILES = [
  "e2e-tests.yml",
  "cms-editorial-workflow.yml",
  "deploy-production.yml",
  "canary-prod.yml",
  "cms-publish-loop-prod.yml",
];

// Build a synthetic GitHub Actions run payload — only the fields the
// dashboard actually reads.
function makeRun(opts = {}) {
  const {
    id = 100 + Math.floor(Math.random() * 100000),
    run_number = 42,
    status = "completed",
    conclusion = "success",
    created_at = "2026-04-29T12:34:56Z",
    html_url = "https://github.com/Adam-S-Daniel/adamdaniel.ai/actions/runs/12345",
  } = opts;
  return {
    id,
    run_number,
    status,
    conclusion,
    created_at,
    html_url,
  };
}

// Default mock: every workflow returns one successful run. Tests can
// override per-workflow by passing an `overrides` map keyed by filename.
async function installMocks(
  page,
  { overrides = {}, requestLog = null, userLogin = "health-spec-user" } = {},
) {
  await page.route("https://api.github.com/**", async (route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;

    if (requestLog) requestLog.push(path);

    if (path === "/user") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ login: userLogin }),
      });
    }

    // /repos/<owner>/<repo>/actions/workflows/<file>/runs — site-AGNOSTIC: the
    // dashboard builds <owner>/<repo> from window.CMS_REPO (the consuming site's
    // _config.yml cms.repository), so match ANY owner/repo, not a hardcoded one.
    const m = path.match(new RegExp(`^/repos/[^/]+/[^/]+/actions/workflows/([^/]+)/runs$`));
    if (m) {
      const file = m[1];
      const override = overrides[file];
      if (override === "404") {
        return route.fulfill({ status: 404, body: "{}" });
      }
      if (override === "500") {
        return route.fulfill({ status: 500, body: "{}" });
      }
      if (override === "in_progress") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workflow_runs: [makeRun({ status: "in_progress", conclusion: null })],
          }),
        });
      }
      if (override === "failure") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workflow_runs: [makeRun({ conclusion: "failure" })],
          }),
        });
      }
      // Default: one healthy successful run.
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workflow_runs: [makeRun()],
        }),
      });
    }

    return route.fulfill({ status: 404, body: "{}" });
  });
}

async function setupHealthPage(page, opts = {}) {
  const { token = FAKE_TOKEN } = opts;
  // Seed the OAuth token on every navigation. We deliberately do NOT
  // wipe the cache here — that would also clobber it on `page.reload()`
  // and break the cache-hit assertions. Each test starts on a fresh
  // browser context (Playwright's default), so localStorage is already
  // empty before the first goto.
  await page.addInitScript((t) => {
    localStorage.setItem("gh_reviews_token", t);
  }, token);
}

test.describe(
  "/admin/reviews/health.html QA dashboard",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    // #21 — a single-page consumer (cms.base_collections:[]) runs no CMS
    // publish-loop / canary / deploy review workflows for this QA dashboard to
    // surface (a static bio has no review subject matter). Guard via the shared
    // registry on the build-INDEPENDENT isSinglePage signal. Full consumer →
    // RUNS (the dashboard is site-agnostic — it reads window.CMS_REPO).
    test.skip(...guard(SITE_ROOT, "admin-reviews-health.spec.js"));

    test("renders one widget per known workflow with success indicator", async ({ page }) => {
      await setupHealthPage(page);
      await installMocks(page);

      await page.goto("/admin/reviews/health.html");
      await expect(page.locator("#dashboard")).toBeVisible();

      // Five workflow tiles, one per entry in the WORKFLOWS list.
      const cards = page.locator(".health-card");
      await expect(cards).toHaveCount(WORKFLOW_FILES.length);

      // Each tile's title + indicator must be present.
      for (const file of WORKFLOW_FILES) {
        const card = page.locator(`.health-card[data-workflow="${file}"]`);
        await expect(card).toBeVisible();
        await expect(card.locator(".health-indicator")).toBeVisible();
        await expect(card.locator(".health-card-title")).not.toBeEmpty();
      }

      // Default mock returns successful runs for every workflow.
      await expect(page.locator(".health-card .health-indicator.health-success")).toHaveCount(
        WORKFLOW_FILES.length,
      );

      await captureStep(page, {
        section: "QA health dashboard",
        step: "12.1",
        title: "QA health overview",
        body: "The `/admin/reviews/health.html` dashboard renders one tile per critical workflow. Green indicators mean the most recent run succeeded; red means failure; yellow means a run is currently in progress. Click `View on GitHub` on any tile to jump to the run.",
      });
    });

    test("failure response renders red error indicator", async ({ page }) => {
      await setupHealthPage(page);
      await installMocks(page, {
        overrides: { "deploy-production.yml": "failure" },
      });

      await page.goto("/admin/reviews/health.html");
      await expect(page.locator("#dashboard")).toBeVisible();

      const failedCard = page.locator('.health-card[data-workflow="deploy-production.yml"]');
      await expect(failedCard).toBeVisible();
      await expect(failedCard.locator(".health-indicator.health-failure")).toBeVisible();

      // Other tiles still render successfully — one tile's failure must
      // not poison the rest of the dashboard.
      const others = WORKFLOW_FILES.filter((f) => f !== "deploy-production.yml");
      for (const file of others) {
        await expect(
          page.locator(`.health-card[data-workflow="${file}"] .health-indicator.health-success`),
        ).toBeVisible();
      }
    });

    test("404 response renders graceful 'not deployed' fallback", async ({ page }) => {
      await setupHealthPage(page);
      await installMocks(page, {
        overrides: { "cms-publish-loop-prod.yml": "404" },
      });

      await page.goto("/admin/reviews/health.html");
      await expect(page.locator("#dashboard")).toBeVisible();

      const missingCard = page.locator('.health-card[data-workflow="cms-publish-loop-prod.yml"]');
      await expect(missingCard).toBeVisible();
      await expect(missingCard).toHaveAttribute("data-state", "missing");
      await expect(missingCard.locator(".health-card-message")).toContainText(/not yet deployed/i);

      // 500 from a different workflow surfaces the generic API-error tile.
      await page.unroute("https://api.github.com/**");
      await installMocks(page, {
        overrides: {
          "cms-publish-loop-prod.yml": "404",
          "canary-prod.yml": "500",
        },
      });
      // Manually bust the in-memory cache so the second goto re-fetches.
      await page.evaluate(() => {
        const toDrop = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("gh_health_cache:")) toDrop.push(k);
        }
        toDrop.forEach((k) => localStorage.removeItem(k));
      });
      await page.reload();
      await expect(page.locator("#dashboard")).toBeVisible();

      const errorCard = page.locator('.health-card[data-workflow="canary-prod.yml"]');
      await expect(errorCard).toHaveAttribute("data-state", "error");
      await expect(errorCard.locator(".health-indicator.health-failure")).toBeVisible();
    });

    test("localStorage cache prevents re-fetch within 60s", async ({ page }) => {
      await setupHealthPage(page);

      const requestLog = [];
      await installMocks(page, { requestLog });

      await page.goto("/admin/reviews/health.html");
      await expect(page.locator("#dashboard")).toBeVisible();
      // Wait for all five tiles to land.
      await expect(page.locator(".health-card")).toHaveCount(WORKFLOW_FILES.length);

      // First load: one /runs request per workflow (plus /user).
      const firstWorkflowHits = requestLog.filter((p) => p.includes("/actions/workflows/")).length;
      expect(firstWorkflowHits).toBe(WORKFLOW_FILES.length);

      // Reload — the cache is fresh, so we should see ZERO additional
      // /actions/workflows requests. /user gets re-validated, that's fine.
      requestLog.length = 0;
      await page.reload();
      await expect(page.locator("#dashboard")).toBeVisible();
      await expect(page.locator(".health-card")).toHaveCount(WORKFLOW_FILES.length);

      const secondWorkflowHits = requestLog.filter((p) => p.includes("/actions/workflows/")).length;
      expect(
        secondWorkflowHits,
        "second navigation within 60s should be served from localStorage cache",
      ).toBe(0);
    });

    test("Refresh button busts cache and re-fetches", async ({ page }) => {
      await setupHealthPage(page);

      const requestLog = [];
      await installMocks(page, { requestLog });

      await page.goto("/admin/reviews/health.html");
      await expect(page.locator("#dashboard")).toBeVisible();
      await expect(page.locator(".health-card")).toHaveCount(WORKFLOW_FILES.length);

      const initialWorkflowHits = requestLog.filter((p) =>
        p.includes("/actions/workflows/"),
      ).length;
      expect(initialWorkflowHits).toBe(WORKFLOW_FILES.length);

      requestLog.length = 0;
      await page.locator("#refresh-btn").click();

      // Wait for at least one new workflow fetch to land. The button
      // should bust every cache key and re-issue all five requests.
      await expect
        .poll(() => requestLog.filter((p) => p.includes("/actions/workflows/")).length)
        .toBe(WORKFLOW_FILES.length);
    });
  },
);
