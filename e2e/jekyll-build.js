/*
 * Serialised `bundle exec jekyll build` for the specs that rebuild the served
 * site mid-test.
 *
 * NINE specs shell out to `jekyll build` against the SAME site tree and the SAME
 * `_site` the :4000 webServer serves, while their project runs several tests at
 * once. (Nine are @admin-write, so they share one runner; draft-isolation is
 * too. cms-html-embed was UNTAGGED until v0.1.70 — held to one project only by a
 * hand-rolled beforeEach gate the @admin-write tag has since replaced; see
 * e2e/admin-tag-lint.test.js.) Jekyll cleans `_site` and then regenerates it, and
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

// A holder older than this is presumed dead — its worker was killed before the
// `finally` ran — and its lock is broken. A build is ~5 s, so 120 s is ~24x the
// real thing while still being FAR less than a waiter's budget.
const STALE_MS = 120_000;
// How long a build may WAIT for the lock. MUST stay comfortably ABOVE STALE_MS:
// a waiter breaks a lock only once it is older than STALE_MS, so with the
// inequality reversed (it was WAIT 180 s / STALE 300 s) a fresh waiter could
// never reach the break — a killed holder's lock wedged the next build into
// `timed out waiting for the build lock`, the exact opposite of the guarantee
// this file documents. Locked by jekyll-build.test.js. It may safely exceed a
// caller's own test timeout (these specs default to 30 s) BECAUSE the wait is
// credited to that timeout INCREMENTALLY, as it happens, via `acquire`'s
// `onWait` — see jekyllBuild. Crediting only after the fact would let
// Playwright kill the test before the wait (or acquire's own timeout
// diagnostic) ever completed, so the incremental credit is load-bearing, not
// a nicety.
const WAIT_TIMEOUT_MS = 300_000;
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

// Who holds the lock. Written INSIDE the lock dir, so it appears only after the
// atomic mkdir won — and read back before any destructive act. Without it,
// breaking a lock is unowned: a build that merely ran long (not dead) keeps
// going, a waiter breaks its lock and starts a second build, and the original's
// `finally` then deletes the NEW holder's lock — two concurrent builds and a
// free-for-all, which is the very thing the lock exists to prevent.
function ownerFile(lockDir) {
  return path.join(lockDir, "owner");
}

function readOwner(lockDir) {
  try {
    return fs.readFileSync(ownerFile(lockDir), "utf8");
  } catch (e) {
    // No owner file yet (we caught the holder mid-acquire) or the lock is gone.
    return "";
  }
}

// `staleMs`/`waitMs`/`pollMs`/`breakLock`/`onWait` are all dep-injectable so
// jekyll-build.test.js can drive the timeout and stale-lock paths in
// milliseconds instead of the real 300 s, and prove the deadline is honoured
// even when a break can never succeed — the same reason e2e/run-cms-loop.js is
// dep-injected for its own unit tests. `onWait` exists solely so jekyllBuild
// can credit the wait to the caller's test budget AS IT HAPPENS (see there).
function acquire(
  lockDir,
  token,
  {
    staleMs = STALE_MS,
    waitMs = WAIT_TIMEOUT_MS,
    pollMs = POLL_MS,
    breakLock = forceRelease,
    onWait = () => {},
  } = {},
) {
  const deadline = Date.now() + waitMs;
  const expired = () =>
    new Error(
      `[jekyll-build] timed out after ${waitMs / 1000}s waiting for the build lock ` +
        `${lockDir}. Another spec's 'jekyll build' is not finishing.`,
    );
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile(lockDir), token);
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
    if (age > staleMs) {
      // Re-read the owner, pause, and re-read: if it changed, the lock legitimately
      // changed hands while we were deciding and is NOT stale, so don't break it.
      const seen = readOwner(lockDir);
      sleepSync(pollMs);
      onWait();
      if (readOwner(lockDir) === seen && fs.existsSync(lockDir)) {
        console.warn(
          `[jekyll-build] breaking a stale build lock (${lockDir}, held ${Math.round(age / 1000)}s ` +
            `by ${seen || "an unknown holder"}) — a worker was probably killed mid-build.`,
        );
        breakLock(lockDir);
      }
      // This branch used to `continue` straight past the deadline check below,
      // so an unremovable lock (wrong owner UID, a stuck filesystem — `breakLock`
      // failed to actually remove it) spun the wait forever: neither returning
      // nor throwing. A hang is worse than a timeout, so check the deadline here
      // too.
      if (Date.now() > deadline) throw expired();
      continue;
    }
    if (Date.now() > deadline) throw expired();
    sleepSync(pollMs);
    onWait();
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

function forceRelease(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[jekyll-build] could not remove the build lock ${lockDir}: ${e && e.message}`);
  }
}

// Release ONLY our own lock, and ONLY when we can PROVE it: the owner file
// must read back EXACTLY our token. `readOwner` returns "" on ANY read
// failure (missing file, transient EIO) as well as on a legitimate hand-off —
// those are indistinguishable from here, so an unreadable owner is treated
// the same as "not ours". The cost is a LEAK, never a double build: we walk
// away from a lock we can't prove is ours, and the next waiter's stale check
// reclaims it after STALE_MS — a bounded degradation. Deleting a lock we
// can't verify is unowned would free someone else's lock and let a third
// build start alongside them.
function release(lockDir, token) {
  const owner = readOwner(lockDir);
  if (owner !== token) {
    console.warn(
      `[jekyll-build] not releasing ${lockDir}: owner reads back as ` +
        `${owner || "unreadable/absent"}, not our token (${token}) — either held by someone ` +
        `else, or we simply can't prove it's ours. A stale-broken lock's new holder survives; ` +
        `an abandoned one is reclaimed after ${STALE_MS / 1000}s.`,
    );
    return;
  }
  forceRelease(lockDir);
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
  // Unique per call, so `release` can prove the lock it is removing is ours.
  const token = `pid${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const waitStart = Date.now();
  let credited = 0;
  // Credit the wait to the test's budget AS IT HAPPENS, not after: `acquire`
  // may wait up to WAIT_TIMEOUT_MS, which is far longer than these specs'
  // 30 s default, so crediting only at the end meant Playwright killed the
  // test before `acquire`'s own "the lock is not being released" diagnostic
  // could ever surface — you got a generic test timeout instead of the cause.
  const onWait = () => {
    const pending = Date.now() - waitStart - credited;
    if (pending >= 1000) {
      creditWaitToTest(pending);
      credited += pending;
    }
  };
  acquire(lockDir, token, { onWait });
  onWait();
  try {
    execFileSync("bundle", args, { cwd, stdio: "inherit" });
  } finally {
    release(lockDir, token);
  }
}

module.exports = {
  jekyllBuild,
  lockDirFor,
  creditWaitToTest,
  acquire,
  release,
  STALE_MS,
  WAIT_TIMEOUT_MS,
};
