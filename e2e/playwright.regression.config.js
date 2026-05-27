const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: /regression-video\.spec\.js/,
  webServer: {
    command: "npx serve ../_site -l 4000 --no-clipboard",
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
