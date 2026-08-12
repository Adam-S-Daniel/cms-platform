// @lane: local — pure-fs lint. The failure-summary RESOLVE step must be
// fail-open in every workflow that calls it.
//
// WHY, from a live cascade on 2026-08-12 that cost a red scheduled run and an
// auto-filed tracking issue:
//
//   adamdaniel.ai e2e run 31569023550 — `e2e / project (chromium-large-text)`
//   PASSED its tests. Its only failing step was "Resolve failure summary on
//   success", whose entire job is to stamp an EXISTING failure comment as
//   resolved. That reddened the job, which reddened the aggregating `e2e / e2e`
//   gate, which blocked the scheduled-publish loop's seed PR #3063, which timed
//   out `waitForMerge` after 25 minutes, which failed the scheduled run, which
//   filed health-audit issue adamdaniel.ai#3064.
//
// A DIAGNOSTIC step became the CAUSE. The composite exists to make CI failures
// legible; it must never manufacture one. Because the step runs under
// `success()`, its failure carries no information about the tests — so it is
// exactly the shape the ephemeral-branch cleanup steps already treat as
// fail-open ("a cleanup hiccup NEVER fails the loop").
//
// `continue-on-error: true` still surfaces a genuine problem as a warning
// annotation on the run, so nothing is hidden — it only stops a cosmetic step
// from gating a merge.
//
// NOTE the asymmetry, deliberately not linted: the `mode: post` call site runs
// under `failure()`, so the job is already red and its failure cannot mask a
// green run. Only `resolve` needs this.
//
// PLATFORM-INTERNAL: reads .github/workflows/, absent on a consumer.
const { test, expect } = require("./base");
const path = require("node:path");
const { listWorkflows, readWorkflow, parseYaml } = require("./workflow-yaml-utils");

// Parse the YAML rather than scanning text: a `continue-on-error` that merely
// appears NEARBY in the file (e.g. on the branch-cleanup step) must not count.
function resolveSteps() {
  const found = [];
  for (const file of listWorkflows()) {
    const name = path.basename(file);
    const doc = parseYaml(readWorkflow(name));
    for (const [jobId, job] of Object.entries((doc && doc.jobs) || {})) {
      for (const step of (job && job.steps) || []) {
        const withBlock = step.with || {};
        if (String(withBlock.mode) === "resolve") {
          found.push({ file: name, jobId, step });
        }
      }
    }
  }
  return found;
}

test.describe("failure-summary resolve steps are fail-open", () => {
  test("every `mode: resolve` call site carries continue-on-error: true", () => {
    const steps = resolveSteps();
    // Guard against the vacuous pass: if the discovery ever finds nothing, the
    // per-step loop below would assert on an empty list and report success.
    expect(
      steps.length,
      "found no `mode: resolve` call sites — the detector is broken, not the fleet clean",
    ).toBeGreaterThanOrEqual(10);

    const offenders = steps
      .filter((s) => s.step["continue-on-error"] !== true)
      .map((s) => `${s.file} (job ${s.jobId}, step ${JSON.stringify(s.step.name || "?")})`);
    expect(
      offenders,
      "these resolve steps can turn a GREEN job red and block a merge — a cosmetic " +
        "comment-stamping step must not gate CI (see this file's header for the 2026-08-12 " +
        "cascade). Add `continue-on-error: true`:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  test("the resolve steps still run only on success()", () => {
    // Fail-open must not become always-run: resolving on a FAILED run would
    // stamp "resolved" over a comment that is still the live failure report.
    for (const s of resolveSteps()) {
      const cond = String(s.step.if || "");
      expect(cond, `${s.file}: resolve step must be gated on success()`).toMatch(/success\(\)/);
      expect(cond, `${s.file}: resolve step must not be always()`).not.toMatch(/always\(\)/);
    }
  });

  test("the `mode: post` call sites are NOT made fail-open", () => {
    // Deliberate asymmetry: post runs under failure(), so it cannot mask a green
    // run, and swallowing ITS error would hide that the failure report never
    // landed — the one thing the composite exists to deliver.
    for (const file of listWorkflows()) {
      const name = path.basename(file);
      const doc = parseYaml(readWorkflow(name));
      for (const [jobId, job] of Object.entries((doc && doc.jobs) || {})) {
        for (const step of (job && job.steps) || []) {
          if (String((step.with || {}).mode) !== "post") continue;
          expect(
            step["continue-on-error"],
            `${name} (job ${jobId}): the post call site must NOT be continue-on-error — it runs ` +
              `under failure(), so it cannot redden a green job, and hiding its error hides ` +
              `that the failure report never posted`,
          ).not.toBe(true);
        }
      }
    }
  });
});
