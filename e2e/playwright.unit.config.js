const { defineConfig } = require("@playwright/test");

// Unit lane (`npm run test:unit`) — ONLY the pure-Node `e2e/*.test.js`
// unit/lint suite, runnable from a bare platform checkout.
//
// The main playwright.config.js defaults to TARGET=local, whose webServer
// runs `cd $SITE_ROOT && bundle exec jekyll build` — but when the platform
// repo is checked out on its own there IS no consuming site to build, so
// that lane can't even start (the previously documented workaround was
// TARGET=prod plus dummy CMS_* env vars). The `*.test.js` tests never
// instantiate `page` or touch `baseURL` (see the per-test-frames note in
// e2e/base.js), so this config just drops what they don't need: no
// webServer, no globalSetup browser install, one browserless project.
// It selects exactly the files the main config's `*.test.js` set covers —
// the browser/spec matrix and PLATFORM_META_SPECS registry in
// playwright.config.js are untouched (the meta-lints lock that file, not
// this one).
module.exports = defineConfig({
  testDir: ".",
  testMatch: /\.test\.js$/,
  fullyParallel: true,
  reporter: [["list"]],
  projects: [{ name: "node-unit" }],
});
