// Guards the local-lane Playwright `webServer` readiness probes so the
// `target:local` lane can never silently break again.
//
// Regression context: a change once set the decap-server (8081) webServer to an
// HTTP `url:` readiness probe instead of the open TCP port. But Playwright's
// webServer readiness only accepts HTTP 200-403, and decap-server returns 404
// for EVERY GET route (/, /api/v1, /health — empirically verified) and 422 only
// for POST /api/v1. So that probe could never go ready and timed out the ENTIRE
// local lane (60s webServer timeout) for every consuming site — while
// cms-platform's own Self CI runs TARGET=prod and never exercises this lane, so
// it shipped untested.
const { test, expect } = require("./base");
const fs = require("fs");
const path = require("path");

test.describe("local webServer readiness probe", () => {
  // Match FUNCTIONAL lines only — strip full-line `//` comments so a comment
  // that quotes the bad pattern (like the ones above) can't trip or satisfy the
  // assertion (de-tautologized).
  const functional = fs
    .readFileSync(path.join(__dirname, "playwright.config.js"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  test("decap-server (8081) uses a TCP port check, not a 404-prone url probe", () => {
    expect(functional, "decap webServer must wait on `port: 8081` (TCP)").toMatch(/port:\s*8081/);
    expect(
      /url:\s*["'`]https?:\/\/localhost:8081/.test(functional),
      "decap webServer must NOT use a url:8081 probe — decap 404s every GET route and " +
        "Playwright's readiness check rejects 404, which times out the whole local lane",
    ).toBe(false);
  });
});
