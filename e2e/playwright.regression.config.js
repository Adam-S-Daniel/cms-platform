const path = require("node:path");
const { defineConfig } = require("@playwright/test");

// The Jekyll build outputs to <site-root>/_site. When the platform is
// CONSUMED, this config runs from <site>/.cms-platform/e2e, so a path
// relative to here (`../_site`) points at the PLATFORM checkout, not the
// site — serving an empty dir, so every PR-side page 404s and the
// regression compares a 404 against styled prod (~100% diff on every page).
// Resolve the SITE root the same way detect-changed-pages.js does
// (SITE_ROOT / GITHUB_WORKSPACE, falling back to the e2e parent when the
// harness sits at <site>/e2e in the non-consumed layout).
const SITE_ROOT =
  process.env.SITE_ROOT || process.env.GITHUB_WORKSPACE || path.resolve(__dirname, "..");

module.exports = defineConfig({
  testDir: ".",
  testMatch: /regression-video\.spec\.js/,
  webServer: {
    command: `npx serve "${SITE_ROOT}/_site" -l 4000 --no-clipboard`,
    port: 4000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: process.env.CMS_BASE_URL || "http://localhost:4000",
    viewport: { width: 1920, height: 1080 },
  },
  projects: [
    {
      name: "regression-video",
      use: { browserName: "chromium" },
    },
  ],
});
