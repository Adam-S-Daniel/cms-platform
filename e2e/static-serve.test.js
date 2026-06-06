// @lane: local — unit/integration test for static-serve.js, the crash-resilient
// :4000 static server that replaced bare `serve` (#1815).
//
// Consumer-SAFE (reads only the harness's own static-serve.js, never the
// platform scripts/ theme/ .github trees), so it is NOT a PLATFORM_META_SPEC —
// it runs on consumers too and proves their copied static-serve.js is resilient.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const { createReadStream, makeServer } = require("./static-serve");

// Build a throwaway docroot in the OS temp dir (NOT under scripts/theme/.github,
// so the platform-meta-spec-registry detector never flags this spec).
function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "static-serve-fixture-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>root-index</h1>");
  fs.writeFileSync(path.join(root, "a.txt"), "alpha");
  fs.writeFileSync(path.join(root, "404.html"), "<h1>custom-404</h1>");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "index.html"), "<h1>sub-index</h1>");
  return root;
}

test.describe("static-serve.js — crash-resilient :4000 server (#1815)", () => {
  // THE FIX, proven deterministically: the createReadStream override must
  // attach an 'error' listener so a post-open ENOENT (the TOCTOU on
  // _site/admin/admin-mobile.css) is HANDLED instead of crashing the process.
  test("createReadStream attaches an 'error' listener (a post-open read error can't crash the server)", async () => {
    const stream = createReadStream(path.join(os.tmpdir(), "static-serve-definitely-missing-xyz"));
    expect(
      stream.listenerCount("error"),
      "the resilient createReadStream must attach an 'error' listener — without it serve-handler's " +
        "unguarded stream.pipe(response) crashes the shared :4000 process on a racy ENOENT (#1815)",
    ).toBeGreaterThanOrEqual(1);
    // Let the async ENOENT fire and be swallowed by our listener — proves no
    // unhandled 'error' (which would have failed this test by crashing the run).
    await new Promise((r) => stream.once("error", r));
    stream.destroy();
  });

  // Behavioural parity with serve@14 (the ~510 specs depend on these) + liveness
  // after a 404 (the exact regression: a 404/read-miss must NOT kill the server).
  test("serves files, directory index, and the site 404.html; stays alive after a miss", async () => {
    const root = makeFixtureRoot();
    const server = makeServer(root);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const get = (p) =>
      new Promise((resolve, reject) => {
        http
          .get(`http://localhost:${port}${p}`, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          })
          .on("error", reject);
      });
    try {
      const file = await get("/a.txt");
      expect(file.status).toBe(200);
      expect(file.body).toBe("alpha");

      // Directory-index resolution (serve-handler default, like serve@14).
      const dir = await get("/sub/");
      expect(dir.status).toBe(200);
      expect(dir.body).toContain("sub-index");

      // Missing path → 404 served from the site's own 404.html (serve@14 parity).
      const miss = await get("/does-not-exist");
      expect(miss.status).toBe(404);
      expect(miss.body).toContain("custom-404");

      // The server is STILL alive after the miss (the #1815 crash regression).
      const again = await get("/a.txt");
      expect(again.status).toBe(200);
      expect(again.body).toBe("alpha");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
