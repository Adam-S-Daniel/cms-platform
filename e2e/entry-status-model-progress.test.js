// @lane: local — pure-Node sandbox unit tests: plain-English check names, "x of y", measured ETA
/*
 * Three editor complaints from one real publish (adamdaniel.ai#3857,
 * 2026-09-28), each locked here against the pure model:
 *
 *   1. "waiting for one last check (e2e / e2e)" — a CI job id is jargon. The
 *      bar names what the check DOES, in words the editor already uses.
 *   2. A count with no total ("3 automatic safety checks") gives no sense of
 *      progress; it says "3 of 9".
 *   3. The minutes-left figure was far off: it assumed 12 minutes of checks
 *      and counted down to the MERGE, not to the page being live. Measured on
 *      the 15 most recent merged cms/* PRs (#3841-#3857): first check → merged
 *      median 3.9 min (p80 5.0); merged → production deployed median 0.67 min
 *      (p80 0.72); whole trip median 4.6 min (p80 5.5, max 6.3).
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

function loadModel() {
  const src = fs.readFileSync(path.resolve(__dirname, "../theme/admin/entry-status-model.js"), "utf8");
  const sandbox = { window: {}, Date, isFinite, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.CMSEntryStatus;
}

const NOW = Date.parse("2026-09-28T13:36:00Z");
const MIN = 60 * 1000;
const armed = (o) =>
  Object.assign({ hasOpenPr: true, armed: true, merged: false, checksFailed: false, deployState: null }, o);

test.describe("entry-status-model — checks in plain English, as x of y", () => {
  test("one check left: names what it does, never its job id, and says 'of y'", () => {
    const m = loadModel();
    const got = m.derive(armed({ checks: { total: 9, pending: ["e2e"] } }), {
      now: NOW,
      currentHostname: "example.com",
      canonicalHostname: "example.com",
    });
    expect(got.detail).not.toMatch(/e2e/);
    expect(got.waitingOn).toBe(
      "the last of 9 automatic safety checks (the check that example.com works on phones, tablets and computers)",
    );
  });

  test("several left: 'n of y', with each one named", () => {
    const m = loadModel();
    const got = m.derive(armed({ checks: { total: 9, pending: ["e2e", "parity"] } }), {
      now: NOW,
      currentHostname: "example.net",
      canonicalHostname: "example.net",
    });
    expect(got.waitingOn).toBe(
      "2 of 9 automatic safety checks to finish (the check that example.net works on phones, tablets and " +
        "computers, and the check that the preview page loads without errors)",
    );
  });

  test("every known check key has a plain name with no job-id vocabulary in it", () => {
    const m = loadModel();
    for (const [key, name] of Object.entries(m.CHECK_NAMES)) {
      expect(name, key).not.toMatch(/\b(e2e|ci|job|workflow|parity|regression|lint|gitleaks|playwright)\b/i);
      expect(name.length, key).toBeGreaterThan(8);
    }
  });

  test("site-wide checks name the production or preview destination supplied to the pure model", () => {
    const m = loadModel();
    const productionOptions = {
      now: NOW,
      currentHostname: "example.com",
      canonicalHostname: "example.com",
    };
    const previewOptions = {
      now: NOW,
      currentHostname: "preview-pr42.example.net",
      canonicalHostname: "example.net",
    };
    const checks = ["e2e", "site-verify", "prerelease-guard"];

    for (const key of checks) {
      const production = m.derive(armed({ checks: { total: 9, pending: [key] } }), productionOptions);
      expect(production.waitingOn, key).toContain("example.com");
      expect(production.waitingOn, key).not.toMatch(/\b(e2e|test|tools?|release|updated site)\b/i);

      const preview = m.derive(
        armed({ previewOnly: true, baseRef: "feature/pdf", checks: { total: 9, pending: [key] } }),
        previewOptions,
      );
      expect(preview.waitingOn, key).toContain("preview-pr42.example.net");
      expect(preview.waitingOn, key).not.toContain("example.net's");
    }
  });

  // #534: "publishing to example.com is ready to use" did not say what the
  // guard checks. scripts/assert-release-pin.js fails when platform.lock pins
  // a trial build (vX.Y.Z-rc.N) of the shared publishing system, on changes
  // headed for the main branch, so the name says exactly that.
  test("the prerelease guard is named for what it checks: a finished, not trial, publishing system", () => {
    const m = loadModel();
    expect(m.CHECK_NAMES["prerelease-guard"]).toBe(
      "the check that {{destination}} will be built with a finished version of its publishing system, not a trial one",
    );
    const got = m.derive(armed({ checks: { total: 9, pending: ["prerelease-guard"] } }), {
      now: NOW,
      currentHostname: "example.com",
      canonicalHostname: "example.com",
    });
    expect(got.waitingOn).toBe(
      "the last of 9 automatic safety checks (the check that example.com will be built with a finished " +
        "version of its publishing system, not a trial one)",
    );
    expect(got.waitingOn).not.toMatch(/ready to use|\brc\b|prerelease/i);
  });

  test("the plain-English 'x of y' phrase is the one linked to the check run (#473 + #3857)", () => {
    const m = loadModel();
    const url = "https://github.com/owner/repo/actions/runs/1";
    const got = m.derive(armed({ checks: { total: 9, pending: ["e2e"] }, checksUrl: url }), { now: NOW });
    expect(got.detailLink).toEqual({ text: got.waitingOn, href: url });
    expect(got.detail).toContain(got.detailLink.text);
  });

  test("an unknown check gets a generic plain name, not its id", () => {
    const m = loadModel();
    const got = m.derive(armed({ checks: { total: 3, pending: ["some-new-job"] } }), { now: NOW });
    expect(got.waitingOn).toBe("the last of 3 automatic safety checks (an automatic safety check)");
    expect(got.detail).not.toMatch(/some-new-job/);
  });

  test("checks not started yet, and all done but not merged, each read sensibly", () => {
    const m = loadModel();
    expect(m.derive(armed({ checks: { total: 0, pending: [] } }), { now: NOW }).waitingOn).toBe(
      "the automatic safety checks to start",
    );
    expect(m.derive(armed({ checks: { total: 9, pending: [] } }), { now: NOW }).waitingOn).toBe(
      "All 9 automatic safety checks passed; now putting it live",
    );
  });

  // #643: "It is waiting for all 2 automatic safety checks passed; now
  // putting it live." Passing is done, not awaited, so it is its own sentence,
  // with the right subject for the count.
  for (const [total, sentence] of [
    [1, "The automatic safety check passed; now putting it live."],
    [2, "Both automatic safety checks passed; now putting it live."],
    [9, "All 9 automatic safety checks passed; now putting it live."],
  ]) {
    test(`all ${total} passed, not merged yet: "${sentence}"`, () => {
      const m = loadModel();
      const got = m.derive(armed({ checks: { total, pending: [] } }), {
        now: NOW,
        currentHostname: "example.com",
        canonicalHostname: "example.com",
      });
      expect(got.detail).toBe(
        "This is on its way to example.com. " + sentence + " You can close this tab — it carries on without you.",
      );
      expect(got.detail).not.toMatch(/waiting for (all|both|the automatic safety check passed)/i);
    });
  }
});

test.describe("entry-status-model — the ETA counts to LIVE, from measured durations", () => {
  test("at the start of the checks it says about 5 minutes — the whole trip, not just the checks", () => {
    const m = loadModel();
    const got = m.derive(armed({ startedAt: NOW }), { now: NOW });
    expect(got.minutesLeft).toBe(5);
    expect(got.label).toBe("Going live… (about 5 minutes left)");
  });

  test("counts down through the checks", () => {
    const m = loadModel();
    expect(m.derive(armed({ startedAt: NOW - 3 * MIN }), { now: NOW }).minutesLeft).toBe(2);
  });

  test("after the merge only the deploy is left: about 1 minute", () => {
    const m = loadModel();
    const got = m.derive({ merged: true, startedAt: NOW, deployState: "pending" }, { now: NOW });
    expect(got.minutesLeft).toBe(1);
    expect(got.label).toBe("Going live… (about 1 minute left)");
  });

  test("past the estimate it says so, rather than sitting on '1 minute left'", () => {
    const m = loadModel();
    const got = m.derive(armed({ startedAt: NOW - 9 * MIN }), { now: NOW });
    expect(got.minutesLeft).toBeNull();
    expect(got.label).toBe("Going live… (taking a little longer than usual)");
  });

  test("with no start time it gives the typical duration, not a made-up countdown", () => {
    const m = loadModel();
    const got = m.derive(armed({}), { now: NOW });
    expect(got.minutesLeft).toBeNull();
    expect(got.label).toBe("Going live… (usually about 5 minutes)");
  });
});

// #643: on a preview the bar read "about 2 minutes" → "about 1 minute" →
// "taking a little longer than usual" within 2.5 minutes. Two causes:
// rounding to nearest ran a one-minute post-merge estimate out after 30 s,
// and the switch of clock at the merge (first check → merge) could take the
// reading back UP from an overrun.
test.describe("entry-status-model — the ETA never goes back up and never runs out early (#643)", () => {
  const merged = (o) => Object.assign({ merged: true, deployState: "pending" }, o);

  test("45 s after the merge the one-minute deploy estimate has not run out", () => {
    const m = loadModel();
    const got = m.derive(merged({ startedAt: NOW - 45 * 1000 }), { now: NOW });
    expect(got.minutesLeft).toBe(1);
    expect(got.label).toBe("Going live… (about 1 minute left)");
  });

  test("4.75 minutes into the checks there is still about 1 minute, not an overrun", () => {
    const m = loadModel();
    expect(m.derive(armed({ startedAt: NOW - 4.75 * MIN }), { now: NOW }).minutesLeft).toBe(1);
  });

  test("checks that overran stay 'longer than usual' after the merge", () => {
    const m = loadModel();
    const before = m.derive(armed({ startedAt: NOW - 6 * MIN, checks: { total: 2, pending: [] } }), { now: NOW });
    expect(before.label).toBe("Going live… (taking a little longer than usual)");
    const after = m.derive(merged({ startedAt: NOW, checksStartedAt: NOW - 6 * MIN }), { now: NOW });
    expect(after.minutesLeft).toBeNull();
    expect(after.label).toBe("Going live… (taking a little longer than usual)");
  });

  test("sampled every 15 s across a merge, the reading only ever goes down", () => {
    const m = loadModel();
    const start = NOW;
    const mergedAt = start + 3.5 * MIN;
    const rank = (got) => (got.minutesLeft === null ? 0 : got.minutesLeft);
    let last = Infinity;
    for (let t = start; t <= start + 7 * MIN; t += 15 * 1000) {
      const facts =
        t < mergedAt
          ? armed({ startedAt: start })
          : merged({ startedAt: mergedAt, checksStartedAt: start });
      const got = m.derive(facts, { now: t });
      expect(rank(got), `at +${(t - start) / 1000}s: ${got.label}`).toBeLessThanOrEqual(last);
      if (got.minutesLeft === null) {
        // An estimate has really elapsed: the deploy's, or the whole trip's.
        const spent =
          (t >= mergedAt && t - mergedAt >= m.DEPLOY_NOMINAL_MIN * MIN) ||
          t - start >= (m.CHECKS_NOMINAL_MIN + m.DEPLOY_NOMINAL_MIN) * MIN;
        expect(spent, `overrun at +${(t - start) / 1000}s before any estimate elapsed`).toBe(true);
      }
      last = rank(got);
    }
  });
});
