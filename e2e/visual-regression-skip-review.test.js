// @lane: local — pure-fs unit tests on the visual-regression-skip-review helper
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml, allStrings } = require("./workflow-yaml-utils");

// Locks in the "skip manual review when no visual regressions" behavior of
// .github/workflows/visual-regression.yml. The signal is the
// `totals.visuallyDifferent` count produced by compute-visual-diffs.js
// (different + new pages). When that count is zero, the approve-regression
// job must NOT enter the `regression-review` environment that requires a
// human reviewer — it should auto-pass the required status check.
//
// Structure (job outputs, the conditional `environment:`) is asserted off
// the parsed workflow; script/expression shapes (the `$GITHUB_OUTPUT`
// echo, the comment-builder branch) are matched against the parser's
// resolved string values — the tokens GitHub Actions actually evaluates,
// minus any commented-out mention.

const WORKFLOW = path.join(__dirname, "..", ".github", "workflows", "visual-regression.yml");

function workflow() {
  return parseYaml(fs.readFileSync(WORKFLOW, "utf8"));
}

function workflowStrings() {
  return allStrings(workflow()).join("\n");
}

function approveRegressionEnv() {
  const env = workflow().jobs["approve-regression"].environment;
  return typeof env === "string" ? env : env == null ? "" : JSON.stringify(env);
}

test.describe("visual-regression workflow: auto-approve when no diffs", () => {
  test("generate job exposes visually-different as a job output", () => {
    const outputs = workflow().jobs.generate.outputs || {};
    expect(
      String(outputs["visually-different"] || ""),
      "generate must expose a `visually-different` job output sourced from a step",
    ).toMatch(/\$\{\{\s*steps\.[a-zA-Z0-9_-]+\.outputs\.visually-different\s*\}\}/);
  });

  test("compute-visual-diffs step writes visually-different to GITHUB_OUTPUT", () => {
    // The step that runs compute-visual-diffs.js must also publish the
    // visuallyDifferent count to $GITHUB_OUTPUT. Check the literal echo
    // shape so a refactor that drops it fails loudly.
    expect(workflowStrings()).toMatch(/visually-different=.*>>\s*"?\$GITHUB_OUTPUT"?/);
  });

  test("approve-regression environment is conditional on visually-different", () => {
    // Conditional environment: only enter `regression-review` when the
    // count is non-zero. Empty string means "no environment" — the job
    // still runs and reports its required status check.
    expect(approveRegressionEnv()).toMatch(
      /\$\{\{[^}]*needs\.generate\.outputs\.visually-different[^}]*'regression-review'[^}]*\}\}/,
    );
  });

  test("approve-regression no longer hard-codes the regression-review environment", () => {
    // Guard against regressing to `environment: regression-review` (the
    // unconditional gate). A bare literal, with no `${{` expression,
    // would re-introduce the always-manual review.
    expect(
      approveRegressionEnv(),
      "approve-regression.environment must be a conditional `${{ … }}` expression, not the bare `regression-review` gate",
    ).not.toBe("regression-review");
  });

  test("PR comment varies by visuallyDifferent count", () => {
    // The bot comment script branches on `t.visuallyDifferent === 0` so
    // editors see "Auto-approved" instead of "Review required" when no
    // regressions are detected.
    const scripts = workflowStrings();
    expect(scripts).toMatch(/t\.visuallyDifferent\s*===\s*0/);
    expect(scripts).toMatch(/Auto-approved/i);
  });

  test("approve-regression fails closed when detect or generate did not complete (#1058)", () => {
    const job = workflow().jobs["approve-regression"];
    // Still runs under always() so the required check reports a status.
    expect(String(job.if).trim()).toBe("always()");
    expect(job.needs).toEqual(expect.arrayContaining(["detect", "generate"]));
    const step = job.steps.find((s) => s.name === "Approval confirmed");
    expect(step.env.DETECT_RESULT).toMatch(/needs\.detect\.result/);
    expect(step.env.GENERATE_RESULT).toMatch(/needs\.generate\.result/);
    const run = step.run;
    // detect must have succeeded before anything is auto-approved.
    expect(run).toMatch(/\[ "\$DETECT_RESULT" != "success" \][\s\S]*?exit 1/);
    // failed or cancelled generate fails the job.
    expect(run).toMatch(/"\$GENERATE_RESULT" = "failure"[\s\S]*"\$GENERATE_RESULT" = "cancelled"[\s\S]*?exit 1/);
    // the skipped-generate auto-approve comes after both failure branches.
    expect(run.indexOf("Auto-approved: no salient")).toBeGreaterThan(run.lastIndexOf("exit 1"));
  });

  test("approve-regression run: text has no expression interpolation and the job has minimal permissions", () => {
    // `needs.generate.outputs.visually-different` derives from the PR's built
    // tree, so it must reach the shell through `env:`, never `${{ }}` inside
    // `run:`: the script runs after a reviewer approves the environment.
    const job = workflow().jobs["approve-regression"];
    for (const step of job.steps) {
      if (step.run) expect(step.run, `step "${step.name}" run:`).not.toContain("${{");
    }
    const step = job.steps.find((s) => s.name === "Approval confirmed");
    expect(step.env.VISUALLY_DIFFERENT).toMatch(/needs\.generate\.outputs\.visually-different/);
    expect(step.run).toMatch(/"\$VISUALLY_DIFFERENT"/);
    // The echo-only job gets no token scopes (no inherited id-token or
    // pull-requests: write).
    expect(job.permissions).toEqual({});
  });
});
