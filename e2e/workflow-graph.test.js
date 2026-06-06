// @lane: local — pure-fs lint of cms-editorial-workflow YAML; no browser, no network
/*
 * Regression tests for the cms-editorial-workflow job graph.
 *
 * Catches the parallel-execution bug where `auto-merge-when-ready` ran
 * alongside `validate-content` instead of after it — a malformed front
 * matter could enable auto-merge before the content-validation job had
 * a chance to fail. (Audit finding #13.)
 */
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

function autoMergeJob() {
  return parseYaml(readWorkflow("cms-editorial-workflow.yml")).jobs["auto-merge-when-ready"];
}

// `needs: validate-content` was deliberately removed (see the workflow:
// enablePullRequestAutoMerge only sets merge *intent* — GitHub waits for
// the required-status-checks ruleset, which includes validate-content,
// before actually merging, so a needs edge was redundant AND re-coupled
// this job to the cancel-in-progress bug it was split out to avoid).
// The previous text-grep version of this test passed only because it
// matched that explanatory comment, not the structure; parsing the YAML
// shows there is no needs edge, so the guard is inverted to its real
// current invariant: nobody may re-add the needs.
test("auto-merge-when-ready does NOT need validate-content (ordering via required checks)", () => {
  const job = autoMergeJob();
  expect(job, "auto-merge-when-ready job not found").toBeTruthy();
  const needs = job.needs == null ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
  expect(
    needs,
    "auto-merge-when-ready must NOT `needs: validate-content` — ordering is " +
      "delegated to the required-status-checks ruleset; a needs edge re-" +
      "introduces the cancel-in-progress coupling (see the workflow comment).",
  ).not.toContain("validate-content");
});

test("auto-merge-when-ready fires only on labeled cms/ready", () => {
  const job = autoMergeJob();
  expect(job).toBeTruthy();
  const cond = JSON.stringify(job);
  expect(cond).toMatch(/github\.event\.action\s*==\s*'labeled'/);
  expect(cond).toMatch(/github\.event\.label\.name\s*==\s*'cms\/ready'/);
});

test("validate-content has no pull_request paths filter (required check must always report)", () => {
  // The `cms-feature-branches` ruleset makes validate-content a required
  // check on PRs into every feature-branch pattern. If we gate this
  // workflow by `paths:`, a feature-branch PR that doesn't touch CMS
  // content never produces the check, the merge stays BLOCKED forever,
  // and the auto-merge regression issue #79 was meant to fix returns.
  const on = parseYaml(readWorkflow("cms-editorial-workflow.yml")).on;
  const pullRequest = on && typeof on === "object" ? on.pull_request : null;
  // `paths-ignore:` is fine; only a positive `paths:` filter would make
  // the check vanish on non-CMS diffs.
  const hasPathsFilter = !!(
    pullRequest &&
    typeof pullRequest === "object" &&
    "paths" in pullRequest
  );
  expect(
    hasPathsFilter,
    "cms-editorial-workflow.yml must NOT gate `validate-content` by paths — see comment block in the workflow.",
  ).toBe(false);
});

test("validate-content does NOT cancel-in-progress (a cancelled required check non-deterministically blocks the merge — #1815)", () => {
  // The canary PRs fire several editorial-workflow runs on the SAME head sha
  // (same-second opened+labeled, then each label flip). With cancel-in-progress
  // those leave a CANCELLED `validate-content` check-run beside the later
  // SUCCESS, and GitHub branch protection evaluates the required context
  // non-deterministically — sometimes blocking the merge HARD ("Required status
  // check 'editorial / validate-content' is cancelled", 405), which no merge
  // mechanism can override. cancel-in-progress:false queues same-sha re-runs to
  // success so the context is unambiguously green. Parse the YAML (not regex).
  const job = parseYaml(readWorkflow("cms-editorial-workflow.yml")).jobs["validate-content"];
  expect(job, "validate-content job not found").toBeTruthy();
  expect(job.concurrency, "validate-content must declare per-job concurrency").toBeTruthy();
  expect(
    job.concurrency["cancel-in-progress"],
    "validate-content.concurrency.cancel-in-progress must be FALSE — a cancelled " +
      "validate-content check-run shadows the success and GitHub blocks the merge " +
      "non-deterministically (405), wedging the prod loops (#1815).",
  ).toBe(false);
});
