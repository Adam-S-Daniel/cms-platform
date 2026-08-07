/*
 * Serialised `bundle exec jekyll build` for the specs that rebuild the served
 * site mid-test.
 *
 * NINE specs shell out to `jekyll build` against the SAME site tree and the SAME
 * `_site` the :4000 webServer serves, while their project runs several tests at
 * once. (Eight are @admin-write, so they share one runner; draft-isolation is
 * too. cms-html-embed was UNTAGGED and therefore built on all eight public-lane
 * runners as well — see e2e/admin-tag-lint.test.js.) Jekyll cleans `_site` and then regenerates it, and
 * shares `.jekyll-cache` / `.jekyll-metadata`, so two builds in flight together
 * fight — and one of them dies:
 *
 *     Error: Command failed: bundle exec jekyll build --quiet
 *
 * which is exactly how cms-inline-image flaked once the admin project ran one
 * worker per vCPU (4 concurrent builds instead of 2). It is a latent bug at ANY
 * worker count — two overlapping builds also leave whichever spec reads `_site`
 * next looking at a half-written tree.
 *
 * A build is ~5 s, so serialising them costs little and removes the whole class.
 * The lock is a DIRECTORY (`mkdir` is atomic everywhere Playwright runs) keyed
 * on the site root, with a stale-holder timeout so a killed worker can't wedge
 * the suite. It is intentionally cross-PROCESS: Playwright workers are separate
 * processes, so an in-process mutex would not see them.
 */
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// How long a build may WAIT for the lock. Comfortably above the worst case
// (every worker queued behind a ~5-30 s build) and well under the specs' own
// test timeouts, so a wedged lock surfaces as this error rather than as an
// opaque test timeout.
const WAIT_TIMEOUT_MS = 180_000;
// A holder older than this is presumed dead (its worker was killed before the
// `finally` ran) and its lock is broken. Longer than any real build.
const STALE_MS = 300_000;
const POLL_MS = 150;

function lockDirFor(cwd) {
  const key = crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `e2e-jekyll-build-${key}.lock`);
}

// Block this worker without spinning the CPU. Playwright specs call the build
// synchronously (execFileSync), so the wait has to be synchronous too.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lockDir) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let age;
    try {
      age = Date.now() - fs.statSync(lockDir).mtimeMs;
    } catch (e) {
      // The holder released it between our mkdir and our stat — just retry.
      age = 0;
    }
    if (age > STALE_MS) {
      console.warn(
        `[jekyll-build] breaking a stale build lock (${lockDir}, held ${Math.round(age / 1000)}s) ` +
          `— a worker was probably killed mid-build.`,
      );
      release(lockDir);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `[jekyll-build] timed out after ${WAIT_TIMEOUT_MS / 1000}s waiting for the build lock ` +
          `${lockDir}. Another spec's 'jekyll build' is not finishing.`,
      );
    }
    sleepSync(POLL_MS);
  }
}

// Waiting for the lock must not eat the CALLER's test budget. These specs run on
// Playwright's 30 s default and a build is ~4 s, so a queue three deep would
// otherwise time the third test out — trading the build race for a timeout race.
// Give back exactly the time spent waiting.
function creditWaitToTest(waitedMs) {
  if (waitedMs < 1000) return;
  try {
    // `test.info()` throws outside a Playwright test (the unit test drives this
    // helper from a bare node process), in which case there is nothing to credit.
    const info = require("@playwright/test").test.info();
    info.setTimeout(info.timeout + waitedMs);
  } catch (e) {
    if (process.env.DEBUG_JEKYLL_BUILD_LOCK) {
      console.warn(`[jekyll-build] no test context to credit ${waitedMs}ms of lock wait to`);
    }
  }
}

function release(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[jekyll-build] could not remove the build lock ${lockDir}: ${e && e.message}`);
  }
}

/*
 * Rebuild the site at `cwd` into its own `_site`, one build at a time.
 *
 * `future: true` is needed by specs whose fixture post is future-dated (Jekyll
 * skips those unless asked) — see cms-featured-image-lifecycle.
 */
function jekyllBuild({ cwd, future = false } = {}) {
  if (!cwd) throw new Error("[jekyll-build] cwd is required (the site root to build)");
  const args = ["exec", "jekyll", "build", "--quiet"];
  if (future) args.push("--future");

  const lockDir = lockDirFor(cwd);
  const waitStart = Date.now();
  acquire(lockDir);
  creditWaitToTest(Date.now() - waitStart);
  try {
    execFileSync("bundle", args, { cwd, stdio: "inherit" });
  } finally {
    release(lockDir);
  }
}

module.exports = { jekyllBuild, lockDirFor, creditWaitToTest };
