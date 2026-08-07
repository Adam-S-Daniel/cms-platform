// @lane: local — pure-fs/process unit test; no browser, no Jekyll, no network.
//
// Lint + unit test for e2e/jekyll-build.js: the cross-process build lock that
// stops two specs' `jekyll build` from fighting over the same `_site` (the
// cms-inline-image flake once the admin project ran one worker per vCPU).
//
// The lock is worth a real test because its failure modes are both bad: a lock
// that doesn't hold brings the flake back, and a lock that never releases wedges
// every build-using spec behind a 3-minute timeout.
const { test, expect } = require("@playwright/test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { lockDirFor } = require("./jekyll-build");

const HELPER = path.join(__dirname, "jekyll-build.js");

// Drive the helper in a child process with `bundle` stubbed by a script we
// control, so nothing here needs Ruby or a site to build.
function runWithFakeBundle(script, { cwd, env = {} } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bundle-"));
  fs.writeFileSync(path.join(bin, "bundle"), script, { mode: 0o755 });
  return spawnSync("node", ["-e", RUNNER, HELPER, cwd], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
}

const RUNNER =
  "const { jekyllBuild } = require(process.argv[1]);" +
  "jekyllBuild({ cwd: process.argv[2] });" +
  "process.stdout.write('BUILT');";

test("the lock is per site root and lands in a writable temp dir", () => {
  expect(lockDirFor("/a/site")).not.toBe(lockDirFor("/b/site"));
  expect(lockDirFor("/a/site")).toBe(lockDirFor("/a/site/"));
  expect(path.dirname(lockDirFor("/a/site"))).toBe(os.tmpdir());
});

test("a build takes the lock and releases it, even when the build fails", () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });

  // Happy path: the lock exists DURING the build (the stub proves it) and is
  // gone afterwards.
  const ok = runWithFakeBundle(`#!/bin/sh\n[ -d "${lock}" ] || exit 3\nexit 0\n`, { cwd: site });
  expect(ok.stderr).toBe("");
  expect(ok.status, "the stub exits 3 if the lock was NOT held during the build").toBe(0);
  expect(ok.stdout).toContain("BUILT");
  expect(fs.existsSync(lock), "the lock must be released after a build").toBe(false);

  // Failure path: a failing build must still release, or every later spec hangs.
  const bad = runWithFakeBundle(`#!/bin/sh\nexit 1\n`, { cwd: site });
  expect(bad.status).not.toBe(0);
  expect(fs.existsSync(lock), "the lock must be released after a FAILED build").toBe(false);
});

test("a second build waits for the first instead of running concurrently", () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });
  const marker = path.join(site, "concurrent");

  // The stub records overlap: it fails if another instance is already inside.
  const stub =
    `#!/bin/sh\n` +
    `if [ -e "${marker}" ]; then echo OVERLAP >&2; exit 9; fi\n` +
    `touch "${marker}"\nsleep 1\nrm -f "${marker}"\nexit 0\n`;

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bundle-"));
  fs.writeFileSync(path.join(bin, "bundle"), stub, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  const kids = [0, 1, 2].map(() =>
    spawn("node", ["-e", RUNNER, HELPER, site], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const done = Promise.all(
    kids.map(
      (k) =>
        new Promise((resolve) => {
          let err = "";
          k.stderr.on("data", (d) => (err += d));
          k.on("close", (code) => resolve({ code, err }));
        }),
    ),
  );

  return done.then((results) => {
    for (const r of results) {
      expect(r.err, "two builds ran at the same time — the lock did not hold").not.toContain(
        "OVERLAP",
      );
      expect(r.code).toBe(0);
    }
    expect(fs.existsSync(lock)).toBe(false);
  });
});

test("a stale lock from a killed worker is broken, not waited on", () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
  // Backdate it past STALE_MS (300 s).
  const old = Date.now() - 10 * 60 * 1000;
  fs.utimesSync(lock, old / 1000, old / 1000);

  const r = runWithFakeBundle(`#!/bin/sh\nexit 0\n`, { cwd: site });
  expect(r.stdout).toContain("BUILT");
  expect(r.stderr).toContain("stale build lock");
  expect(fs.existsSync(lock)).toBe(false);
});

test("every in-test `jekyll build` goes through the helper", () => {
  // A spec that shells out to `bundle exec jekyll build` directly would sidestep
  // the lock and bring the flake back for everyone.
  const offenders = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".spec.js"))
    .filter((f) => {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      return /execFileSync\(\s*["']bundle["']\s*,\s*\[\s*["']exec["']\s*,\s*["']jekyll["']/.test(src);
    });

  expect(
    offenders,
    "these specs build the site directly — call jekyllBuild() from e2e/jekyll-build.js instead",
  ).toEqual([]);
});

test("the helper refuses to build an unspecified site root", () => {
  const { jekyllBuild } = require("./jekyll-build");
  expect(() => jekyllBuild({})).toThrow(/cwd is required/);
});

test("the workflow's site build is the only other build path", () => {
  // playwright.config.js's webServer builds once at bring-up, before any test
  // exists to race it — the one legitimate unlocked build.
  const config = fs.readFileSync(path.join(__dirname, "playwright.config.js"), "utf8");
  const commands = config
    .split("\n")
    .filter((l) => /^\s*command:/.test(l) && l.includes("jekyll build"));
  expect(commands.length, "webServer should have exactly one jekyll build command").toBe(1);
});
