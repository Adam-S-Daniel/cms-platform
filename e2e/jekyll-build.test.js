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
const walk = require("acorn-walk");
const { parse, stringValue, calleeName, calleeTail } = require("./spec-ast");
const {
  lockDirFor,
  creditWaitToTest,
  acquire,
  release,
  STALE_MS,
  WAIT_TIMEOUT_MS,
} = require("./jekyll-build");

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

// AST, not regex, per AGENTS.md: the old lint was
// `/execFileSync\(\s*["']bundle["']\s*,\s*\[\s*["']exec["']\s*,\s*["']jekyll["']/`,
// which matches exactly ONE call shape and sidesteps as easily as
// `execSync("bundle exec jekyll build")`, `spawnSync("bundle", [...])`, or an
// args array built one line above the call — none of which go through the
// lock either. This detector matches the code-SHAPE ("a call to an exec/spawn
// variant whose arguments mention jekyll") instead of one literal call.
const EXEC_TAILS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);

// Does `src` shell out to jekyll directly (bypassing e2e/jekyll-build.js)?
// Resolves ONE hop of local aliasing — `const args = [...]; execFileSync(x, args)`
// — because that is exactly the shape a hand-rolled build call tends to take.
function buildsJekyllDirectly(src) {
  const ast = parse(src);

  // Locals bound anywhere in the file to an array or string literal, so an
  // args array assembled above the call is still visible at the call site.
  const aliases = new Map(); // localName -> string[]
  const stringishValues = (node) => {
    if (!node) return [];
    if (node.type === "ArrayExpression") return node.elements.flatMap(stringishValues);
    if (node.type === "Identifier" && aliases.has(node.name)) return aliases.get(node.name);
    const s = stringValue(node);
    return s == null ? [] : [s];
  };
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      const values = stringishValues(node.init);
      if (values.length) aliases.set(node.id.name, values);
    },
  });

  let flagged = false;
  walk.simple(ast, {
    CallExpression(node) {
      if (flagged) return;
      const tail = calleeTail(calleeName(node.callee));
      if (!EXEC_TAILS.has(tail)) return;
      const mentionsJekyll = node.arguments.some((arg) =>
        stringishValues(arg).some((v) => v.toLowerCase().includes("jekyll")),
      );
      if (mentionsJekyll) flagged = true;
    },
  });
  return flagged;
}

function offendingBuildSpecs() {
  const offenders = [];
  for (const file of fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".spec.js"))
    .sort()) {
    let src;
    try {
      src = fs.readFileSync(path.join(__dirname, file), "utf8");
    } catch (e) {
      continue;
    }
    try {
      if (buildsJekyllDirectly(src)) offenders.push(file);
    } catch (e) {
      // Unparseable, or an AST shape the detector doesn't expect — not this
      // lint's problem to diagnose (mirrors fs-poll-lint.test.js).
      continue;
    }
  }
  return offenders;
}

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

test("a waiter can actually REACH the stale break (STALE_MS < WAIT_TIMEOUT_MS)", () => {
  // The bug this guards: the file shipped with WAIT 180 s / STALE 300 s. A
  // waiter breaks a lock only once it is older than STALE_MS, so a FRESH waiter
  // ran out its whole 180 s budget while the lock was still only 180 s old and
  // threw "timed out waiting for the build lock" — a killed worker wedged the
  // next build, the exact opposite of this file's documented guarantee. Any
  // future retune must keep the break reachable.
  expect(
    STALE_MS,
    "a lock must go stale well BEFORE a waiter gives up, or the break is dead code",
  ).toBeLessThan(WAIT_TIMEOUT_MS);
});

test("a stale lock from a killed worker is broken, not waited on", () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
  // Backdate it just past STALE_MS — NOT by minutes. At 10 min the old
  // (broken) constants passed this test too; a hair over the threshold is what
  // proves the break fires at the documented age.
  const old = Date.now() - (STALE_MS + 10_000);
  fs.utimesSync(lock, old / 1000, old / 1000);

  const r = runWithFakeBundle(`#!/bin/sh\nexit 0\n`, { cwd: site });
  expect(r.stdout).toContain("BUILT");
  expect(r.stderr).toContain("stale build lock");
  expect(fs.existsSync(lock)).toBe(false);
});

test("a build refuses to release a lock that is no longer its own", () => {
  // If a waiter breaks our lock as stale and a new holder takes it, our
  // `finally` must NOT remove it — that would free THEIR lock and let a third
  // build start alongside them, which is what the lock exists to prevent.
  // Simulated deterministically: the fake build rewrites the owner file
  // mid-build, exactly as a hand-off would.
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });

  const r = runWithFakeBundle(
    `#!/bin/sh\nprintf 'someone-else' > "${lock}/owner"\nexit 0\n`,
    { cwd: site },
  );
  expect(r.stdout).toContain("BUILT");
  expect(r.stderr).toContain("not releasing");
  expect(
    fs.existsSync(lock),
    "the new holder's lock must survive the previous holder's finally",
  ).toBe(true);
  fs.rmSync(lock, { recursive: true, force: true });
});

test("a build refuses to release a lock whose owner it cannot prove", () => {
  // `readOwner` returns "" on ANY read failure, not only on a legitimate
  // hand-off. The old `owner && owner !== token` check treated that "" the
  // same as "no lock exists" and fell through to delete a lock it could not
  // prove was ours — reachable whenever the owner file is missing mid-acquire.
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });
  acquire(lock, "us");
  fs.rmSync(path.join(lock, "owner"));

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    release(lock, "us");
  } finally {
    console.warn = originalWarn;
  }

  expect(fs.existsSync(lock), "an unprovable owner must LEAK the lock, not free it").toBe(true);
  expect(warnings.some((w) => w.includes("not releasing"))).toBe(true);
  fs.rmSync(lock, { recursive: true, force: true });
});

test("the wait deadline is honoured even when the stale lock cannot be broken", () => {
  // Regression test for the `continue`-past-the-deadline bug: with a no-op
  // breakLock (simulating a wrong-owner UID or a stuck filesystem), the old
  // code never re-checked the deadline in the stale branch and this call
  // never returned at all — a hang, which is worse than a timeout.
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock);
  const old = Date.now() - 1000;
  fs.utimesSync(lock, old / 1000, old / 1000);

  // A no-op breakLock re-triggers the stale branch's own "breaking a stale
  // build lock" warning every poll — real, but not what this test is
  // checking, so silence it rather than spam the report.
  const originalWarn = console.warn;
  console.warn = () => {};
  let start;
  try {
    start = Date.now();
    expect(() =>
      acquire(lock, "us", { staleMs: 20, waitMs: 300, pollMs: 10, breakLock: () => {} }),
    ).toThrow(/timed out/);
  } finally {
    console.warn = originalWarn;
  }
  expect(
    Date.now() - start,
    "the old bug spun forever here instead of returning promptly",
  ).toBeLessThan(5_000);

  fs.rmSync(lock, { recursive: true, force: true });
});

test("the lock wait is credited to the test budget while it is still waiting", () => {
  // The credit has to arrive AS THE WAIT HAPPENS, not after: crediting once at
  // the end would let Playwright kill the test before acquire's own diagnostic
  // ever surfaces (see jekyllBuild's `onWait`). Deterministic without a real
  // concurrent build: hold the lock ourselves, so the waiter can never acquire
  // it and must poll until it gives up.
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const lock = lockDirFor(site);
  fs.rmSync(lock, { recursive: true, force: true });
  acquire(lock, "other");

  try {
    let calls = 0;
    expect(() =>
      acquire(lock, "us", {
        staleMs: 999_999,
        waitMs: 400,
        pollMs: 10,
        onWait: () => calls++,
      }),
    ).toThrow(/timed out/);
    expect(calls, "onWait must fire once per poll, not once at the end").toBeGreaterThan(1);
  } finally {
    release(lock, "other");
  }
});

test("every in-test `jekyll build` goes through the helper", () => {
  // A spec that shells out to jekyll directly — via ANY exec/spawn variant,
  // not just the one literal shape the old regex matched — would sidestep the
  // lock and bring the flake back for everyone.
  expect(
    offendingBuildSpecs(),
    "these specs build the site directly — call jekyllBuild() from e2e/jekyll-build.js instead",
  ).toEqual([]);
});

test("the detector recognises the shapes it polices", () => {
  // Guards against the AST walk silently matching nothing after a refactor.
  expect(buildsJekyllDirectly('execSync("bundle exec jekyll build");')).toBe(true);
  expect(buildsJekyllDirectly('spawnSync("bundle", ["exec", "jekyll", "build"]);')).toBe(true);
  expect(
    buildsJekyllDirectly(
      'const args = ["exec", "jekyll", "build"]; execFileSync("bundle", args);',
    ),
  ).toBe(true);
  expect(
    buildsJekyllDirectly(
      'const { jekyllBuild } = require("./jekyll-build"); jekyllBuild({ cwd: site });',
    ),
  ).toBe(false);
});

test("time spent waiting for the lock is credited back to the test's budget", () => {
  // Otherwise the lock just trades the build race for a timeout race: these
  // specs run on Playwright's 30 s default and a build is ~4 s.
  const before = test.info().timeout;
  creditWaitToTest(7_000);
  expect(test.info().timeout).toBe(before + 7_000);

  // Sub-second waits are noise, not budget.
  creditWaitToTest(300);
  expect(test.info().timeout).toBe(before + 7_000);
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
