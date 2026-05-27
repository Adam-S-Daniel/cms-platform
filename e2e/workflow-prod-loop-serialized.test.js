// @lane: local — pure-fs lint of workflow YAML; no browser, no network
/*
 * Regression guard for #1101 + #1178 + the changed-files recursion
 * gate. The three real-prod-mutating loop workflows must (a) put ONE
 * shared concurrency lane on each heavy loop job — NOT the workflow
 * (#1178) — so the loops can never run concurrently (a parallel pair
 * races deploy-production and blows each other's URL-reflect budgets —
 * observed on merge 3dbade7) while the cheap `recursion-gate` job, which
 * carries no concurrency, runs OUTSIDE the lane; (b) gate on the
 * await-prod-deploy composite so a post-merge push never drives a stale
 * (not-yet-deployed) prod site; and (c) gate on the cms-recursion-gate
 * composite via that `recursion-gate` job so the loop never re-fires on
 * its own Decap auto-merge (run 26108485428 — the old `publish: `
 * head-commit guard could not see Decap's `Update Post "…"` squash
 * template). Same ethos as #1053's ALWAYS_RUN guard: make the invariant
 * fail loud at CI time instead of silently regressing in a workflow edit
 * months later.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, jobSubBlock } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");

// workflow → its heavy loop job name + the recursion-gate `loop:` input.
const LOOPS = {
  "cms-publish-loop-prod.yml": { job: "prod-mutate", loop: "prod" },
  "cms-media-roundtrip.yml": { job: "media-roundtrip", loop: "media" },
  "cms-publish-loop-host.yml": { job: "host-loop", loop: "host" },
};
const LOOP_WORKFLOWS = Object.keys(LOOPS);
const SHARED_GROUP = "prod-mutating-loop";
const AWAIT_ACTION = "./.github/actions/await-prod-deploy";
const GATE_ACTION = "./.github/actions/cms-recursion-gate";
const GATE_JOB = "recursion-gate";
const GATE_IF = "${{ needs." + GATE_JOB + ".outputs.run == 'true' }}";
// build-image is the reusable-workflow caller that produces the
// prebaked ci-runner image consumed by each loop's `container.image:`.
// Independent of recursion-gate so a Dockerfile/lockfile-only push
// still rebuilds the image even when the recursion gate skips the
// heavy loop. See .github/workflows/ci-runner-image.yml.
const BUILD_IMAGE_JOB = "build-image";
const BUILD_IMAGE_USES = "./.github/workflows/ci-runner-image.yml";

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

test.describe("real-prod loop workflows are serialized + deploy-gated (#1101)", () => {
  test("each loop JOB shares ONE concurrency group, cancel-in-progress:false (no workflow-level lane — #1178)", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      // #1178: the lane MUST live on the heavy loop job, not the
      // workflow, so the cheap recursion-gate job runs outside it and a
      // recursion-skipped loop never enters the lane at all.
      expect(
        doc.concurrency,
        `${wf} must NOT declare workflow-level concurrency — the lane belongs on the ${LOOPS[wf].job} job so recursion-gate runs outside it (#1178)`,
      ).toBeFalsy();
      const loopJob = doc.jobs[LOOPS[wf].job];
      expect(
        loopJob && loopJob.concurrency,
        `${wf}: the ${LOOPS[wf].job} job must declare job-level concurrency (#1178)`,
      ).toBeTruthy();
      expect(
        loopJob.concurrency.group,
        `${wf}: ${LOOPS[wf].job} concurrency.group must be the shared lane so the three real-prod loops are mutually exclusive (#1101)`,
      ).toBe(SHARED_GROUP);
      expect(
        loopJob.concurrency["cancel-in-progress"],
        `${wf}: ${LOOPS[wf].job} must NOT cancel-in-progress — a real-prod loop killed mid-flow can leave the canary dirty; queue instead (#1101)`,
      ).toBe(false);
      // The whole point of #1178: the gate job must stay OUT of the lane
      // so its skip decision is instant regardless of lane state.
      const gateJob = doc.jobs[GATE_JOB];
      expect(
        gateJob && gateJob.concurrency,
        `${wf}: ${GATE_JOB} must NOT declare concurrency — it runs outside the lane so the skip decision is computed immediately (#1178)`,
      ).toBeFalsy();
    }
  });

  test("the loop job's concurrency block is byte-identical across the three (drift guard)", () => {
    // Extract each heavy loop job's job-level `concurrency:` sub-block
    // (#1178 moved it off the workflow). Byte-identical across the three
    // keeps a partial edit (e.g. flipping cancel-in-progress in one, or
    // tweaking the comment) from silently desynchronising the lane.
    const blocks = LOOP_WORKFLOWS.map((wf) =>
      jobSubBlock(readWorkflow(wf), LOOPS[wf].job, "concurrency").trim(),
    );
    expect(
      blocks[0],
      "cms-publish-loop-prod.yml prod-mutate job must declare a concurrency block (#1178)",
    ).toBeTruthy();
    expect(
      blocks[1],
      "cms-media-roundtrip.yml media-roundtrip job concurrency block drifted from cms-publish-loop-prod.yml's prod-mutate — keep them byte-identical (#1101/#1178)",
    ).toBe(blocks[0]);
    expect(
      blocks[2],
      "cms-publish-loop-host.yml host-loop job concurrency block drifted from cms-publish-loop-prod.yml's prod-mutate — keep them byte-identical (#1101/#1178)",
    ).toBe(blocks[0]);
  });

  test("each workflow has exactly the recursion-gate + build-image + loop jobs", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const names = Object.keys(doc.jobs);
      expect(
        names.sort(),
        `${wf} must have exactly three jobs: ${GATE_JOB} + ${BUILD_IMAGE_JOB} + ${LOOPS[wf].job}`,
      ).toEqual([GATE_JOB, BUILD_IMAGE_JOB, LOOPS[wf].job].sort());
    }
  });

  test("each workflow's build-image job is the reusable ci-runner-image workflow", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const buildJob = doc.jobs[BUILD_IMAGE_JOB];
      expect(
        buildJob,
        `${wf} must define a ${BUILD_IMAGE_JOB} job calling the reusable image-build workflow`,
      ).toBeTruthy();
      expect(
        buildJob.uses,
        `${wf}: ${BUILD_IMAGE_JOB}.uses must point at ${BUILD_IMAGE_USES}`,
      ).toBe(BUILD_IMAGE_USES);
    }
  });

  test("each loop job awaits the prod deploy on push, gated to push events", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      // `actions: read` is required for the gate's REST query of the
      // Deploy to Production run.
      expect(
        doc.permissions && doc.permissions.actions,
        `${wf} must grant 'actions: read' for the await-prod-deploy gate`,
      ).toBe("read");
      // Select the heavy loop job by name (NOT jobs[0] — the
      // recursion-gate job is also present now).
      const loopJob = doc.jobs[LOOPS[wf].job];
      expect(loopJob, `${wf} must define job ${LOOPS[wf].job}`).toBeTruthy();
      const steps = loopJob.steps || [];
      const gate = steps.find((s) => s && s.uses === AWAIT_ACTION);
      expect(
        gate,
        `${wf}'s loop job must invoke ${AWAIT_ACTION} so it never tests a not-yet-deployed prod (#1101)`,
      ).toBeTruthy();
      expect(
        String(gate.if || ""),
        `${wf}'s await-prod-deploy step must be gated to push events (workflow_dispatch/schedule have no associated merge)`,
      ).toContain("github.event_name == 'push'");
      // Must run before the spec actually drives prod: assert the gate
      // precedes the step that invokes the playwright loop spec.
      const gateIdx = steps.indexOf(gate);
      const specIdx = steps.findIndex((s) =>
        JSON.stringify(s || {}).match(/playwright test|RUN_PROD_MUTATE|RUN_HOST_REPO/i),
      );
      if (specIdx !== -1) {
        expect(gateIdx, `${wf}: await-prod-deploy must run BEFORE the loop spec step`).toBeLessThan(
          specIdx,
        );
      }
    }
  });

  test("the await-prod-deploy composite action exists and is composite", () => {
    const actionPath = path.join(
      REPO_ROOT,
      ".github",
      "actions",
      "await-prod-deploy",
      "action.yml",
    );
    expect(
      fs.existsSync(actionPath),
      `${actionPath} must exist (referenced by the loop workflows)`,
    ).toBe(true);
    const action = parseYaml(fs.readFileSync(actionPath, "utf8"));
    expect(action.runs && action.runs.using).toBe("composite");
  });

  test("await-prod-deploy tolerates prod being AHEAD of the merge (descendant) — #1714", () => {
    // A lane-serialized loop can reach its CDN-reflect check after prod
    // has advanced past the triggering SHA (a sibling/canary merge
    // deployed during the lane wait). prod is then a DESCENDANT of the
    // merge — ahead, not stale — so the gate must proceed, not time out
    // (run 26473129148 timed out 600s against an exact-SHA match while
    // prod sat 15 commits ahead). Lock the descendant-accept logic.
    const actionPath = path.join(
      REPO_ROOT,
      ".github",
      "actions",
      "await-prod-deploy",
      "action.yml",
    );
    const action = parseYaml(fs.readFileSync(actionPath, "utf8"));
    const shell = ((action.runs && action.runs.steps) || [])
      .map((s) => String((s && s.run) || ""))
      .join("\n");
    expect(shell, "await-prod-deploy must define a run step").toBeTruthy();
    // Exact-SHA fast path retained.
    expect(shell, "await-prod-deploy must keep the exact-SHA reflect fast path").toContain(
      '"$live" = "$AD_SHA"',
    );
    // Must consult the compare API (base=merge, head=live) ...
    expect(
      shell,
      "await-prod-deploy must query the compare API to detect prod-ahead (#1714)",
    ).toMatch(/compare\/\$AD_SHA\.\.\.\$live/);
    // ... and proceed when prod is a descendant (compare status 'ahead').
    expect(
      shell,
      "await-prod-deploy must proceed when prod is a descendant of the merge (compare status 'ahead') — #1714",
    ).toContain('"$rel" = "ahead"');
  });

  test("await-prod-deploy step 2 defers a superseded/non-success deploy conclusion to ground truth (#1723 Cat 3)", () => {
    // The `production` lane is `cancel-in-progress: false`, so a deploy
    // QUEUED for this merge can be superseded (conclusion 'cancelled')
    // by a newer sibling/canary deploy that carries main — including
    // this merge's tree — forward; prod ends up AHEAD of the merge
    // (healthy) while the merge's OWN run shows non-success. The old
    // step-2 behaviour hard-failed there ("not driving prod off a
    // bad/superseded deploy" → exit 1), red-ing the gate on a live prod
    // (#1723 Cat 3 — the sub-case left open after #1714/#1715 fixed
    // step 3's exact-match). Step 2 must now DEFER to the step-3
    // ground-truth (descendant) check instead of hard-failing.
    const actionPath = path.join(
      REPO_ROOT,
      ".github",
      "actions",
      "await-prod-deploy",
      "action.yml",
    );
    const action = parseYaml(fs.readFileSync(actionPath, "utf8"));
    const shell = ((action.runs && action.runs.steps) || [])
      .map((s) => String((s && s.run) || ""))
      .join("\n");
    // The old hard-fail string must be gone — a non-success conclusion
    // no longer exits 1 in step 2.
    expect(
      shell,
      "step 2 must no longer hard-fail on a non-success conclusion (#1723 Cat 3)",
    ).not.toContain("not driving prod off a bad/superseded deploy");
    // It now logs and defers to ground truth.
    expect(
      shell,
      "step 2 must defer a non-success/superseded conclusion to the step-3 ground-truth check (#1723 Cat 3)",
    ).toMatch(/Deferring to ground truth/i);
    // The step-3 descendant check remains the sole loud-fail gate — a
    // genuinely stale/diverged prod (never reaching the merge or a
    // descendant) still fails loud.
    expect(
      shell,
      "step 3 must keep its loud failure when prod never reaches the merge SHA or a newer descendant",
    ).toMatch(/never served \$AD_SHA or a newer descendant/);
  });
});

test.describe("changed-files recursion gate wiring (run 26108485428)", () => {
  test("each workflow has a recursion-gate job using the composite + fetch-depth:2", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const gateJob = doc.jobs[GATE_JOB];
      expect(gateJob, `${wf} must define the ${GATE_JOB} job`).toBeTruthy();

      // It must expose `run` as a job output so the loop job's `if:`
      // can read it.
      expect(
        String((gateJob.outputs && gateJob.outputs.run) || ""),
        `${wf}: ${GATE_JOB}.outputs.run must map to the composite step output`,
      ).toContain("steps.");

      const steps = gateJob.steps || [];
      const gateStep = steps.find((s) => s && s.uses === GATE_ACTION);
      expect(gateStep, `${wf}: ${GATE_JOB} must invoke ${GATE_ACTION}`).toBeTruthy();
      expect(
        gateStep.id,
        `${wf}: the ${GATE_ACTION} step must have an id so outputs.run can reference it`,
      ).toBeTruthy();
      expect(
        gateStep.with && gateStep.with.loop,
        `${wf}: ${GATE_ACTION} must be called with the correct loop key`,
      ).toBe(LOOPS[wf].loop);

      // fetch-depth: 2 is load-bearing — without it `git diff
      // <before> <sha>` can't resolve and the gate always fails OPEN,
      // silently defeating the skip.
      const checkout = steps.find(
        (s) => s && typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"),
      );
      expect(checkout, `${wf}: ${GATE_JOB} must check the repo out (for git diff)`).toBeTruthy();
      expect(
        checkout.with && Number(checkout.with["fetch-depth"]),
        `${wf}: ${GATE_JOB} checkout must set fetch-depth: 2 (git diff <before> <sha> needs the parent commit)`,
      ).toBe(2);
    }
  });

  test("each loop job needs the gate and is gated on its output", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      expect(
        asArray(loopJob.needs),
        `${wf}: ${LOOPS[wf].job} must \`needs: ${GATE_JOB}\``,
      ).toContain(GATE_JOB);
      expect(
        String(loopJob.if || "").trim(),
        `${wf}: ${LOOPS[wf].job}.if must be exactly "${GATE_IF}" (the old head_ref/publish: guard must be gone)`,
      ).toBe(GATE_IF);
      // The retired message guard must not linger anywhere in the job.
      expect(
        JSON.stringify(loopJob),
        `${wf}: ${LOOPS[wf].job} still references the retired publish:/head_ref recursion guard`,
      ).not.toMatch(/head_commit\.message|github\.head_ref/);
    }
  });

  test("the cms-recursion-gate composite exists, is composite, no transitive uses", () => {
    const actionPath = path.join(
      REPO_ROOT,
      ".github",
      "actions",
      "cms-recursion-gate",
      "action.yml",
    );
    expect(
      fs.existsSync(actionPath),
      `${actionPath} must exist (referenced by the loop workflows)`,
    ).toBe(true);
    const raw = fs.readFileSync(actionPath, "utf8");
    const action = parseYaml(raw);
    expect(action.runs && action.runs.using).toBe("composite");
    // Bash + node only — no nested `uses:` to keep it clean for the
    // repo's SHA-pin convention (mirrors await-prod-deploy).
    for (const step of action.runs.steps || []) {
      expect(
        step.uses,
        `cms-recursion-gate must not nest external actions (found uses: ${step.uses})`,
      ).toBeUndefined();
    }
  });

  test("the recursion-churn module covers every loop key the workflows use", () => {
    // Import the single source and assert it knows every loop the
    // workflows reference — a workflow asking for an unknown loop key
    // would fail OPEN forever (gate never skips).
    const { SELF_CHURN } = require("./cms-recursion-churn");
    for (const wf of LOOP_WORKFLOWS) {
      expect(
        Object.prototype.hasOwnProperty.call(SELF_CHURN, LOOPS[wf].loop),
        `cms-recursion-churn.SELF_CHURN is missing the '${LOOPS[wf].loop}' key used by ${wf}`,
      ).toBe(true);
      expect(
        SELF_CHURN[LOOPS[wf].loop].length,
        `cms-recursion-churn.SELF_CHURN.${LOOPS[wf].loop} must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });
});
