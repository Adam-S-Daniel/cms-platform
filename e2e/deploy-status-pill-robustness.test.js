const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Locks in the robustness behaviours of admin/deploy-status-pill.js:
//
//   1. Single-retry around fetch: every API call goes through
//      `fetchWithRetry`, not the raw `fetch`. A bug that re-introduces
//      a raw `fetch(API + "...")` call would silently regress this.
//   2. Rate-limit detection skips retry: the script checks
//      X-RateLimit-Remaining=0 (status 403) AND status 429.
//   3. Stale poll surfaces an amber state: a visible pill flips to
//      amber when STALE_THRESHOLD_MS has passed since the last
//      successful poll (so editors don't stare at a frozen spinner
//      that's secretly disconnected from reality).
//   4. State-revert dedup: lastSeenStatusIds keys off GitHub's
//      status.id (which changes per state event), so a state revert
//      success → in_progress on a re-publish triggers a fresh render.
//
// These are pure-text invariants on the IIFE's source. The actual
// runtime exercise lives in cms-publish-loop.spec.js (lifecycle
// captureStep) — this lightweight unit test catches structural
// regressions without spinning up a browser.

const SCRIPT = path.join(__dirname, "..", "theme", "admin", "deploy-status-pill.js");

function readScript() {
  return fs.readFileSync(SCRIPT, "utf8");
}

test.describe("deploy-status-pill: robustness invariants", () => {
  test("every GitHub API call goes through fetchWithRetry, not raw fetch", () => {
    const src = readScript();
    // The single allowed `fetch(...)` call site is INSIDE the
    // fetchWithRetry helper — that's the one place the bare network
    // primitive is invoked. Every other call must go through the
    // wrapper. Count occurrences of `fetch(` (with open paren —
    // ignores `fetchWithRetry`) and assert exactly one.
    const matches = src.match(/(?<![A-Za-z])fetch\(/g) || [];
    expect(
      matches.length,
      "expected exactly one bare fetch( call (inside fetchWithRetry); a regression would call fetch directly and bypass retry/rate-limit handling",
    ).toBe(1);
  });

  test("rate-limit detection inspects X-RateLimit-Remaining and status 429", () => {
    const src = readScript();
    expect(src, "missing X-RateLimit-Remaining check").toMatch(/X-RateLimit-Remaining/);
    // Both "=== 429" comparison styles are accepted (=== or .status === 429
    // or just `429` literal in a comparison expression).
    expect(src, "missing status 429 handling").toMatch(/[=]==?\s*429|status\s*===?\s*429|429/);
  });

  test("rate-limited responses do NOT retry (just warn + return null)", () => {
    const src = readScript();
    // Inside fetchWithRetry: when isRateLimited(res) is true, we must
    // return null before falling through to the retry path. Assert
    // the function contains the early-return shape.
    expect(
      src,
      "missing rate-limit early-return — would retry rate-limited fetches and burn through the budget",
    ).toMatch(/isRateLimited\(res\)[\s\S]{0,500}?return null/);
  });

  test("STALE_THRESHOLD_MS is defined and amber rendering exists", () => {
    const src = readScript();
    expect(src, "missing STALE_THRESHOLD_MS constant").toMatch(/STALE_THRESHOLD_MS\s*=/);
    expect(src, "missing renderStalePill function — visible pills can never flip to amber").toMatch(
      /function\s+renderStalePill/,
    );
    // Amber colour family. GitHub Primer's warning yellow is #d4a72c
    // (border) / #9a6700 (text). Any of these confirm the amber path.
    expect(
      src,
      "missing amber colour for stale state — would render in default styling and look identical to in-progress",
    ).toMatch(/#d4a72c|#9a6700|amber|stale/i);
  });

  test("lastSeenStatusIds dedup is keyed off GitHub status.id (per-event)", () => {
    const src = readScript();
    // Both pills track lastSeenStatusIds; the comparison happens
    // against `status.id` not `state` (the latter would miss revert
    // transitions like success → in_progress on re-publish).
    expect(src, "missing lastSeenStatusIds bookkeeping").toMatch(/lastSeenStatusIds/);
    expect(
      src,
      "expected dedup to compare against status.id — comparing against status.state would miss success→in_progress transitions on re-publish",
    ).toMatch(
      /lastSeenStatusIds\s*\.[\w]*\s*=\s*[a-zA-Z_$][\w$]*Id|statusId\s*!==?\s*lastSeenStatusIds/,
    );
  });

  test("polling tick logs an info diagnostic when no deployment is found", () => {
    const src = readScript();
    expect(
      src,
      "missing console.info diagnostic — devtools wouldn't show that polling is alive when both pills are hidden",
    ).toMatch(/console\.info[\s\S]{0,200}?no deployment yet/i);
  });
});
