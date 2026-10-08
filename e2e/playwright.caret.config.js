const { defineConfig } = require("@playwright/test");
const path = require("node:path");

// Platform-only, offline browser diagnostic. No site build, static server,
// decap-server, credentials, or live publishing.
module.exports = defineConfig({
  testDir: ".",
  // Fixture placement copies the harness into nested e2e directories;
  // a basename match would discover those copies as additional tests.
  testMatch: path.join(__dirname, "decap-caret-selection.spec.js"),
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
});
