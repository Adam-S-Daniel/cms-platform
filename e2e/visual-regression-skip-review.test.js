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
});
