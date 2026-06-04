// @lane: local — pure-fs lint of workflow YAML; no browser, no network
/*
 * Regression guard for #22: the prod-mutating loop reusables leak
 * ephemeral `cms/*` canary branches when a cycle cancels/fails mid-flight
 * (~35 accumulated on adamdaniel). Each loop reusable must run an
 * `if: always()` cleanup step that deletes its own ephemeral canary
 * branch(es) on completion AND on cancel/failure, idempotently and
 * FAIL-OPEN (a cleanup failure must NOT fail the loop). The daily
 * sweep-stale-cms-prs.yml must additionally prune merged/closed
 * cms/(e2e|e2e-fixture)/* and cms/posts/2099-*-e2e-* branches that have no
 * open PR.
 *
 * Parsed with the `yaml` lib (anchors) per AGENTS.md — never regex over
 * raw text for structure.
 */
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, jobs } = require("./workflow-yaml-utils");

// workflow → heavy loop job name + the branch glob(s) it must clean up.
// The spec runId is `Date.now()`, so the workflow can't know the exact
// branch — a pattern-delete scoped to the loop's own ephemeral prefix
// with no open PR is the sanctioned approach (#22).
const LOOPS = {
  "cms-publish-loop-prod.yml": {
    job: "prod-mutate",
    patterns: ["cms/posts/2099-12-31-e2e-prod-mutate-"],
  },
  "cms-media-roundtrip.yml": {
    job: "media-roundtrip",
    patterns: ["cms/posts/2099-12-31-e2e-media-roundtrip-"],
  },
  "cms-publish-loop-host.yml": {
    job: "host-loop",
    patterns: ["cms/e2e/canary-", "cms/e2e-fixture/"],
  },
};
const LOOP_WORKFLOWS = Object.keys(LOOPS);

// A cleanup step's branch prefix can live in the run: script OR in the
// step's env: block (parameterised). Search both.
function stepText(step) {
  const envVals = Object.values((step && step.env) || {}).map(String);
  return [String((step && step.run) || ""), ...envVals].join("\n");
}

// A step is the branch-cleanup step if its name calls it out.
const CLEANUP_NAME_RE = /clean ?up.*(canary|ephemeral).*branch|ephemeral.*branch.*clean/i;

function findCleanupStep(steps) {
  return (steps || []).find((s) => s && typeof s.name === "string" && CLEANUP_NAME_RE.test(s.name));
}

test.describe("loop reusables clean up ephemeral canary branches (#22)", () => {
  test("each loop job has an `if: always()` branch-cleanup step", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      expect(loopJob, `${wf} must define job ${LOOPS[wf].job}`).toBeTruthy();
      const step = findCleanupStep(loopJob.steps);
      expect(
        step,
        `${wf}: ${LOOPS[wf].job} must have a branch-cleanup step (name ~ "Clean up ephemeral canary branch(es)") — #22`,
      ).toBeTruthy();
      // Must run on completion AND cancel/failure: `if: always()` (or an
      // expression that includes always()).
      const ifExpr = String(step.if || "");
      expect(
        ifExpr,
        `${wf}: the branch-cleanup step must be \`if: always()\` so it runs on success, failure AND cancellation (#22)`,
      ).toMatch(/always\(\)/);
    }
  });

  test("the cleanup step is FAIL-OPEN (continue-on-error + guarded deletes)", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      const step = findCleanupStep(loopJob.steps);
      expect(step, `${wf}: cleanup step must exist`).toBeTruthy();
      // continue-on-error so a non-zero exit never reds the loop.
      expect(
        step["continue-on-error"],
        `${wf}: the branch-cleanup step must be continue-on-error (fail-open) — a cleanup failure must NOT fail the loop (#22)`,
      ).toBe(true);
      const run = String(step.run || "");
      expect(run, `${wf}: cleanup step must be a run: script`).toBeTruthy();
      // Idempotent + fail-open at the shell level too: deletes guarded
      // with `|| true` (or `|| echo`) so a missing/already-gone branch is
      // a no-op, never an error.
      expect(
        run,
        `${wf}: each branch delete must be guarded (\`|| true\`/\`|| echo\`) so a missing branch is a no-op (#22)`,
      ).toMatch(/\|\|\s*(true|echo)/);
      // Must NOT `set -e` without a guard that would propagate a delete
      // failure — if it sets -e it must also continue-on-error (asserted
      // above) AND guard the deletes (asserted above). Belt-and-braces:
      // the delete itself must tolerate failure.
      expect(
        run,
        `${wf}: cleanup must delete refs via the git refs API or \`gh\``,
      ).toMatch(/git\/refs\/heads|gh api .*git\/refs|gh api -X DELETE/);
    }
  });

  test("the cleanup deletes ONLY this loop's own ephemeral branch pattern(s)", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      const step = findCleanupStep(loopJob.steps);
      const text = stepText(step);
      for (const pat of LOOPS[wf].patterns) {
        expect(
          text,
          `${wf}: cleanup must scope to its own branch pattern "${pat}" (#22)`,
        ).toContain(pat);
      }
      // Safety: never delete an unrelated cms/ prefix. The host loop owns
      // cms/e2e* + cms/e2e-fixture*; the post loops own cms/posts/2099-*.
      // Assert a _posts_ loop's cleanup does NOT touch cms/e2e* branches.
      if (LOOPS[wf].job !== "host-loop") {
        expect(
          text,
          `${wf}: a _posts_ loop must NOT touch cms/e2e* branches`,
        ).not.toMatch(/cms\/e2e\b/);
      }
    }
  });

  test("the cleanup only deletes branches with NO open PR (scoped + safe)", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      const step = findCleanupStep(loopJob.steps);
      const run = String((step && step.run) || "");
      // It must consult open PRs for the branch before deleting (a branch
      // with an in-flight PR could still be a live cycle / a real draft).
      expect(
        run,
        `${wf}: cleanup must check for an open PR on the branch before deleting it (#22)`,
      ).toMatch(/pulls\?|pr list|--state open|state=open/);
    }
  });
});

test.describe("sweep-stale-cms-prs prunes orphaned canary BRANCHES (#22)", () => {
  const SWEEP = "sweep-stale-cms-prs.yml";

  // The orphan-BRANCH prune step is the one that deletes a branch ref via
  // `git/refs/heads/${branch}`. (Distinct from the file sweeps, which DELETE
  // contents paths.) #22 extends it to cover the ephemeral prod-loop post
  // branches the create/media loops force-push.
  function findBranchPruneStep(sweepJob) {
    return (sweepJob.steps || []).find((s) =>
      /git\/refs\/heads\/\$\{?branch/.test(String((s && s.run) || "")),
    );
  }

  test("the sweep deletes orphaned cms/posts/2099-*-e2e-* BRANCHES with no open PR", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    expect(sweepJob, `${SWEEP} must define the sweep job`).toBeTruthy();
    // The existing sweep prunes _posts/ FILES and cms/e2e* / cms/e2e-fixture*
    // BRANCHES, but NOT the ephemeral cms/posts/2099-*-e2e-* BRANCHES the
    // prod-mutate/media loops force-push. #22 needs the BRANCH prune to cover
    // those too — assert the orphan-branch prune step's prefix safelist
    // includes the prod-loop post-branch prefixes.
    const step = findBranchPruneStep(sweepJob);
    expect(
      step,
      `${SWEEP} must have an orphan-branch prune step (deletes git/refs/heads/<branch>)`,
    ).toBeTruthy();
    const run = String(step.run);
    expect(
      run,
      `${SWEEP}: the orphan-branch prune must include cms/posts/2099-*-e2e-prod-mutate-* (#22)`,
    ).toMatch(/cms\/posts\/2099-.*e2e-prod-mutate|2099-12-31-e2e-prod-mutate-/);
    expect(
      run,
      `${SWEEP}: the orphan-branch prune must include cms/posts/2099-*-e2e-media-roundtrip-* (#22)`,
    ).toMatch(/cms\/posts\/2099-.*e2e-media-roundtrip|2099-12-31-e2e-media-roundtrip-/);
  });

  test("the cms/(e2e|e2e-fixture)/* orphan-branch prune is present (Tier 3 retained/extended)", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    const runText = (sweepJob.steps || [])
      .map((s) => String((s && s.run) || ""))
      .join("\n");
    expect(runText, `${SWEEP} must still prune cms/e2e/ orphan branches`).toContain("cms/e2e/");
    expect(runText, `${SWEEP} must still prune cms/e2e-fixture/ orphan branches`).toContain(
      "cms/e2e-fixture/",
    );
  });

  test("the orphan-branch prune (incl. prod-loop) is fail-open", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    const step = findBranchPruneStep(sweepJob);
    expect(step, `${SWEEP} must have an orphan-branch prune step`).toBeTruthy();
    expect(
      String(step.run),
      `${SWEEP}: the orphan-branch ref delete must be guarded fail-open (\`|| echo\`/\`|| true\`)`,
    ).toMatch(/\|\|\s*(echo|true)/);
  });

  test("ALL loop workflows + the sweep referenced by the cleanup lints exist", () => {
    // Sanity: the YAML this suite asserts on is real.
    for (const wf of [...LOOP_WORKFLOWS, SWEEP]) {
      expect(() => parseYaml(readWorkflow(wf)), `${wf} must parse`).not.toThrow();
    }
    // jobs() helper sanity — at least the loop job + sweep job resolve.
    for (const wf of LOOP_WORKFLOWS) {
      const names = jobs(readWorkflow(wf)).map((j) => j.name);
      expect(names, `${wf} must contain ${LOOPS[wf].job}`).toContain(LOOPS[wf].job);
    }
  });
});
