const { defineConfig } = require("@playwright/test");

// Platform-only, offline browser diagnostic. No site build, static server,
// decap-server, credentials, or live publishing.
module.exports = defineConfig({
  testDir: ".",
  testMatch: "decap-caret-selection.spec.js",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
});
