#!/usr/bin/env node
// Crash-resilient static file server for the local e2e lane (#1815).
//
// Drop-in replacement for the bare `serve _site -l 4000` webServer. The root
// cause it fixes: `serve@14` wraps `serve-handler@6.1.7`, whose default
// `createReadStream` is the RAW `fs.createReadStream` (serve-handler/src/
// index.js:543) and which then does `stream.pipe(response)` (line 768) WITHOUT
// attaching an 'error' listener to that source stream. So a racy post-open
// ENOENT — a TOCTOU on a gem asset like `_site/admin/admin-mobile.css` under
// the write-heavy admin lane — emits an UNHANDLED 'error' event, Node throws,
// and the single shared :4000 process EXITS. With no supervision, port 4000
// stays dead and every later `@admin` spec (preview-shell → /preview/,
// cms-editorial-workflow → /admin/index-test.html) gets ERR_CONNECTION_REFUSED:
// the ~85-failure cascade that fails the canary cms/* PR's required `e2e / e2e`
// check, blocks auto-merge, and wedges the prod loops at the reflect/delete leg.
//
// This server uses the SAME engine (serve-handler) with serve@14-equivalent
// config — `{ public, etag: true, symlinks: false }`; serve-handler's defaults
// supply clean URLs, directory-index resolution, and `<dir>/<code>.html` error
// pages — so behaviour is byte-identical for the ~510 specs that rely on it.
// The only change is robustness:
//   1. THE FIX: override `createReadStream` to attach an 'error' listener, so a
//      post-open read error is HANDLED (Node won't throw); the one in-flight
//      response aborts, the server survives.
//   2. Backstop: a process-level `uncaughtException` handler so no stray
//      stream/socket error can ever terminate the shared webServer.
// We do NOT skip any spec or drop the webkit-iphone16 project — that would hide
// real mobile-admin coverage. The specs are correct; the server fragility was
// the bug.
const http = require("node:http");
const fs = require("node:fs");
// serve-handler is the engine `serve@14` itself wraps; we depend on it
// transitively via the retained `serve` devDependency (pinned @6.1.7 in the
// lockfile — past the dependency cooling-off window). Keeping `serve` in
// package.json keeps this require resolvable; don't drop it.
const handler = require("serve-handler");

// serve@14 (build/main.js) sets exactly these and leaves the rest to
// serve-handler's defaults; match it so URL resolution is unchanged.
const SERVE14_CONFIG = { etag: true, symlinks: false };

// THE FIX — see the header. serve-handler calls `handlers.createReadStream`
// for the main file send (src/index.js:741) and pipes the result (768); the
// default has no 'error' listener. Attaching one here makes a post-open read
// error non-fatal: the stream is torn down, the in-flight response aborts, and
// the process keeps serving. Exported so the resilience is unit-testable.
function createReadStream(p, opts) {
  const stream = fs.createReadStream(p, opts);
  stream.on("error", (err) => {
    console.error(`[static-serve] read error ${p}: ${(err && err.message) || err}`);
    // Tear down the half-sent response fast (don't leave the client hanging);
    // Playwright's retries:1 covers the rare transient TOCTOU blip.
    stream.destroy();
  });
  return stream;
}

// Build an http.Server that serves `root` with the resilient handler. Exported
// so tests can drive it in-process on an ephemeral port.
function makeServer(root) {
  const config = { ...SERVE14_CONFIG, public: root };
  const methods = { createReadStream };
  return http.createServer((req, res) => {
    // Swallow client-side aborts (EPIPE/ECONNRESET) so they don't bubble.
    res.on("error", () => {});
    Promise.resolve(handler(req, res, config, methods)).catch((err) => {
      console.error(`[static-serve] handler error: ${(err && err.message) || err}`);
      if (!res.headersSent) res.writeHead(500);
      try {
        res.end();
      } catch (_) {
        /* response already torn down */
      }
    });
  });
}

function main() {
  const root = process.argv[2];
  const port = Number(process.argv[3]) || 4000;
  if (!root) {
    console.error("[static-serve] usage: node static-serve.js <docroot> [port]");
    process.exit(2);
  }
  // Backstop: even with the createReadStream guard, never let a stray uncaught
  // stream/socket error kill the shared webServer — log and keep serving.
  process.on("uncaughtException", (err) => {
    console.error(`[static-serve] swallowed uncaughtException: ${(err && err.message) || err}`);
  });
  makeServer(root).listen(port, () => {
    console.log(`[static-serve] serving ${root} on http://localhost:${port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createReadStream, makeServer, SERVE14_CONFIG };
