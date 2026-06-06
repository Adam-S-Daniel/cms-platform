// Guards the local-lane Playwright `webServer` config so the `target:local`
// lane can never silently break again. "AST always, not regex" (spec-ast.js):
// this parses playwright.config.js and asserts on AST facts, never raw text.
//
// Regression context 1: a change once set the decap-server (8081) webServer to
// an HTTP `url:` readiness probe instead of the open TCP port. Playwright's
// webServer readiness only accepts HTTP 200-403, and decap-server returns 404
// for EVERY GET route (/, /api/v1, /health — empirically verified) and 422 only
// for POST /api/v1. So that probe could never go ready and timed out the ENTIRE
// local lane (60s webServer timeout) for every consuming site.
//
// Regression context 2 (#1815): the :4000 static server was a bare `serve _site
// -l 4000`. serve-handler pipes the file ReadStream to the response with no
// 'error' listener, so a racy post-open ENOENT (TOCTOU on a `_site/admin/*` gem
// asset under the write-heavy admin lane) crashed the single shared :4000
// process, ERR_CONNECTION_REFUSED-ing every later @admin spec — the 85-failure
// cascade that fails the canary cms/* PR's required `e2e / e2e` and wedges the
// prod loops. The fix is the crash-resilient `static-serve.js` wrapper; lock it
// so the fragile bare-`serve` form can't silently return.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { parse, analyzeSpec, stringValue } = require("./spec-ast");

const CONFIG = path.join(__dirname, "playwright.config.js");
function configSrc() {
  return fs.readFileSync(CONFIG, "utf8");
}

// Does any ObjectExpression `Property` named `key` satisfy `valuePred(value)`?
function hasProp(ast, key, valuePred) {
  let found = false;
  walk.full(ast, (n) => {
    if (found || n.type !== "Property" || n.computed) return;
    const k = n.key && (n.key.name != null ? n.key.name : n.key.value);
    if (k === key && valuePred(n.value)) found = true;
  });
  return found;
}

test.describe("local webServer readiness probe", () => {
  test("decap-server (8081) uses a TCP port check, not a 404-prone url probe [AST]", () => {
    const ast = parse(configSrc());
    expect(
      hasProp(ast, "port", (v) => v.type === "Literal" && v.value === 8081),
      "decap webServer must wait on `port: 8081` (TCP)",
    ).toBe(true);
    // No `url:` probe pointing at :8081 — decap 404s every GET route and
    // Playwright's readiness check rejects 404, which times out the local lane.
    expect(
      hasProp(ast, "url", (v) => /https?:\/\/localhost:8081/.test(stringValue(v) || "")),
      "decap webServer must NOT use a url:8081 probe",
    ).toBe(false);
  });

  test("the :4000 static server is the crash-resilient static-serve.js, not bare `serve` [AST]", () => {
    const facts = analyzeSpec(configSrc());
    // The resilient server file is wired (the STATIC_SERVE const resolves to
    // static-serve.js) and referenced by the webServer command.
    expect(
      facts.identifiers.has("STATIC_SERVE"),
      "the :4000 webServer must run static-serve.js (the crash-resilient server) — see #1815",
    ).toBe(true);
    expect(
      facts.strings.some((s) => s.includes("static-serve.js")),
      "the STATIC_SERVE const must resolve to static-serve.js",
    ).toBe(true);
    // The fragile bare-`serve` binary reference (SERVE_BIN) must be gone.
    expect(
      facts.identifiers.has("SERVE_BIN"),
      "the bare-`serve` binary (SERVE_BIN) must be removed — it crashes the shared " +
        ":4000 process on a racy post-open read error (#1815)",
    ).toBe(false);
    // No command string carries `serve`'s `-l 4000` listen flag (static-serve.js
    // takes the port positionally). Matched on the AST-extracted command
    // strings, never the raw source.
    expect(
      facts.strings.some((s) => /-l\s*4000/.test(s)),
      "no :4000 command may shell out to bare `serve … -l 4000` (#1815)",
    ).toBe(false);
  });
});
