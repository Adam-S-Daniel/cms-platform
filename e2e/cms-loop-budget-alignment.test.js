// @lane: local — PURE-FS lint over the two real-prod-loop spec SOURCES (NO
// Jekyll build, NO browser). Platform-internal: it reads the platform's OWN
// e2e/cms-*.spec.js budget literals, so it's registered in PLATFORM_META_SPECS.
//
// #1815 — the real-prod media-roundtrip and prod-mutate loops drive the SAME
// chain (Decap → cms PR → cms/ready → auto-merge → deploy-production → CDN) and
// must tolerate the SAME real-prod latency. A live media run failed when its
// per-leg URL-REFLECT budget (then 15 min) was SHORTER than the actual canary
// auto-merge latency (~907s and climbing): the deploy-queue extender saw "merge
// still pending, nothing deploying yet", mis-called it "NO deploy-production run
// fired", and gave up — even though the canary DID merge + deploy minutes later.
//
// This lint locks the budget INVARIANTS so a future edit can't silently shrink
// the media loop back under the auto-merge latency (or under its prod-mutate
// twin):
//
//   (1) media's per-leg REFLECT budget (the MIN urlTimeoutMs across its
//       waitForChangeReflected legs — the binding constraint) is >= the
//       prod-mutate twin's, AND >= the 30-min auto-merge latency FLOOR the
//       waitForMerge budget already tolerates.
//   (2) media's waitForMerge budget is >= prod-mutate's.
//   (3) media's TEST_TIMEOUT_MS is >= prod-mutate's (it runs a strictly longer
//       create+delete-post+delete-image loop, so it needs at least as much).
//   (4) the spec's TEST_TIMEOUT_MS fits inside its workflow job's
//       timeout-minutes (so the spec budget can never be silently truncated by
//       a smaller job cap).
//
// It does NOT change the publish mechanism — it only asserts the budget numbers
// the two specs already declare, resolving named constants
// (REFLECT_TIMEOUT_MS / MERGE_TIMEOUT_MS) and `<n> * 60 * 1000` literals.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const HARNESS = __dirname;
const WORKFLOWS = path.join(HARNESS, "..", ".github", "workflows");
const MIN = 60 * 1000;

const MEDIA_SPEC = "cms-media-roundtrip.spec.js";
const PRODMUTATE_SPEC = "cms-publish-loop-prod-mutate.spec.js";
// The auto-merge-latency FLOOR each reflect leg must clear so a slow (but
// healthy) real-prod auto-merge can't be mis-diagnosed as a chain miss (#1815).
const AUTO_MERGE_LATENCY_FLOOR_MS = 30 * MIN;

function read(spec) {
  return fs.readFileSync(path.join(HARNESS, spec), "utf8");
}

// Resolve a ms expression to a number. Handles a bare integer, the
// `<n> * 60 * 1000` minute idiom, and a named module-scope const that itself
// resolves to one of those (REFLECT_TIMEOUT_MS / MERGE_TIMEOUT_MS / …).
function resolveMs(expr, src) {
  const e = String(expr).trim();
  let m = e.match(/^(\d+)\s*\*\s*60\s*\*\s*1000$/);
  if (m) return Number(m[1]) * MIN;
  m = e.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  // A named const — look up its module-scope definition and resolve that.
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const def = src.match(new RegExp(`const\\s+${e}\\s*=\\s*([^;]+);`));
    if (def) return resolveMs(def[1], src);
  }
  throw new Error(`cms-loop-budget-alignment: could not resolve ms expression "${expr}"`);
}

// Every `urlTimeoutMs: <expr>,` in a spec's waitForChangeReflected legs.
function reflectBudgets(src) {
  const out = [];
  for (const m of src.matchAll(/urlTimeoutMs:\s*([^,]+),/g)) {
    out.push(resolveMs(m[1], src));
  }
  return out;
}

// The waitForMerge({ …, timeoutMs: <expr> }) budget (the create-PR merge wait).
function mergeBudget(src) {
  const m = src.match(/waitForMerge\(\{[^}]*timeoutMs:\s*([^,}]+)[,}]/);
  if (!m) throw new Error("cms-loop-budget-alignment: no waitForMerge timeoutMs found");
  return resolveMs(m[1], src);
}

function testTimeout(src) {
  const m = src.match(/const\s+TEST_TIMEOUT_MS\s*=\s*([^;]+);/);
  if (!m) throw new Error("cms-loop-budget-alignment: no TEST_TIMEOUT_MS found");
  return resolveMs(m[1], src);
}

// The media loop's job `timeout-minutes:` in cms-media-roundtrip.yml.
function jobTimeoutMinutes(wf) {
  const src = fs.readFileSync(path.join(WORKFLOWS, wf), "utf8");
  const m = src.match(/timeout-minutes:\s*(\d+)/);
  if (!m) throw new Error(`cms-loop-budget-alignment: no timeout-minutes in ${wf}`);
  return Number(m[1]);
}

test.describe("#1815 real-prod loop budget alignment — media >= prod-mutate", () => {
  const mediaSrc = read(MEDIA_SPEC);
  const prodSrc = read(PRODMUTATE_SPEC);

  const mediaReflects = reflectBudgets(mediaSrc);
  const prodReflects = reflectBudgets(prodSrc);
  // The MIN reflect leg is the binding constraint — the shortest leg is the one
  // that times out first under a slow auto-merge.
  const mediaMinReflect = Math.min(...mediaReflects);
  const prodMinReflect = Math.min(...prodReflects);

  test("both specs declare reflect + merge budgets the lint can read", () => {
    expect(mediaReflects.length, `${MEDIA_SPEC} must declare urlTimeoutMs reflect legs`).toBeGreaterThan(0);
    expect(prodReflects.length, `${PRODMUTATE_SPEC} must declare urlTimeoutMs reflect legs`).toBeGreaterThan(0);
  });

  test("media per-leg reflect budget >= prod-mutate's (binding MIN leg)", () => {
    expect(
      mediaMinReflect,
      `${MEDIA_SPEC}'s shortest URL-reflect leg (${mediaMinReflect / MIN}min) must be >= ` +
        `${PRODMUTATE_SPEC}'s shortest (${prodMinReflect / MIN}min) — the two loops drive the ` +
        `same chain and must tolerate the same auto-merge latency (#1815).`,
    ).toBeGreaterThanOrEqual(prodMinReflect);
  });

  test("media reflect budget clears the 30-min auto-merge latency floor (#1815)", () => {
    expect(
      mediaMinReflect,
      `${MEDIA_SPEC}'s reflect legs must each span >= the ${AUTO_MERGE_LATENCY_FLOOR_MS / MIN}-min ` +
        `auto-merge latency floor, so a slow-but-healthy real-prod auto-merge can't be mis-called ` +
        `"NO deploy-production run fired" (the live #1815 failure at ~907s/15min).`,
    ).toBeGreaterThanOrEqual(AUTO_MERGE_LATENCY_FLOOR_MS);
  });

  test("media waitForMerge budget >= prod-mutate's", () => {
    const mediaMerge = mergeBudget(mediaSrc);
    const prodMerge = mergeBudget(prodSrc);
    expect(
      mediaMerge,
      `${MEDIA_SPEC}'s waitForMerge (${mediaMerge / MIN}min) must be >= ${PRODMUTATE_SPEC}'s ` +
        `(${prodMerge / MIN}min) — same auto-merge latency (#1815).`,
    ).toBeGreaterThanOrEqual(prodMerge);
  });

  test("media TEST_TIMEOUT_MS >= prod-mutate's (longer loop)", () => {
    const mediaTT = testTimeout(mediaSrc);
    const prodTT = testTimeout(prodSrc);
    expect(
      mediaTT,
      `${MEDIA_SPEC}'s TEST_TIMEOUT_MS (${mediaTT / MIN}min) must be >= ${PRODMUTATE_SPEC}'s ` +
        `(${prodTT / MIN}min) — media runs the strictly longer create+delete-post+delete-image loop.`,
    ).toBeGreaterThanOrEqual(prodTT);
  });

  test("media job timeout-minutes accommodates its TEST_TIMEOUT_MS", () => {
    const mediaTT = testTimeout(mediaSrc);
    const jobMin = jobTimeoutMinutes("cms-media-roundtrip.yml");
    expect(
      jobMin,
      `cms-media-roundtrip.yml's timeout-minutes (${jobMin}) must be >= the spec's ` +
        `TEST_TIMEOUT_MS (${mediaTT / MIN}min) so the job cap can't truncate a deploy leg.`,
    ).toBeGreaterThanOrEqual(mediaTT / MIN);
  });
});
