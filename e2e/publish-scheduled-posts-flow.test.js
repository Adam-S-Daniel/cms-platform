// @lane: local — pure-fs lint of the scheduled-publish PR flow; no browser, no network
/*
 * Regression guard for the publish-scheduled-posts rework: the scheduler
 * must publish via a PR + auto-merge, NEVER a direct push to main.
 *
 * The failure this locks out (verified live): the old workflow flipped
 * `published: false → true` and `git push origin main` with the default
 * GITHUB_TOKEN. Consumer repos protect main with a ruleset
 * (`pull_request` rule + required status checks, no bypass actors), so
 * that push was rejected the FIRST time a post ever came due — scheduled
 * publishing was silently broken (zero auto-publish commits exist in
 * consumer history). And even where a push could land, a GITHUB_TOKEN
 * push does not trigger deploy-production (the token-suppression trap
 * documented on cms-editorial-workflow.yml's auto-merge-when-ready job).
 *
 * What this lint asserts, per the AST/yaml-parser rule (structural
 * checks parse the real YAML via workflow-yaml-utils; regex only for
 * genuinely lexical tokens — a branch-prefix string, a ms literal):
 *
 *   1. publish-scheduled-posts.yml declares the CMS_E2E_PAT secret, no
 *      run block ever pushes main again, the stacking guard + fail-loud
 *      guard exist, and the PR-creation step is github-script
 *      authenticated as the PAT and applies cms/draft + cms/ready.
 *   2. The per-run branch prefix stays Decap-shaped: its first segment
 *      is derived from e2e/cms-fixture-pr.js's FIXTURE_BRANCH_PREFIX
 *      (the same source label-non-decap-prs.yml keys off), so
 *      label-non-decap + the content-PR guards classify the publish PR
 *      with the rest of the CMS content PRs. Workflow and spec must
 *      agree on the full prefix.
 *   3. Loop wiring: cms-scheduled-publish-loop.yml runs ONLY the new
 *      spec, joins the shared prod-mutating-loop lane, and its job
 *      timeout accommodates the spec's TEST_TIMEOUT_MS (the
 *      cms-loop-budget-alignment doctrine); the thin caller's
 *      platform_ref matches its uses: pin; the spec is @lane: real.
 *
 * Platform-internal (reads the platform's own workflow DEFINITIONS +
 * the examples/site templates), so it is registered in
 * PLATFORM_META_SPECS (playwright.config.js).
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, runScripts } = require("./workflow-yaml-utils");
const { FIXTURE_BRANCH_PREFIX } = require("./cms-fixture-pr");
const { parseLaneDirective } = require("./select-specs");

const SCHEDULER_WF = "publish-scheduled-posts.yml";
const LOOP_WF = "cms-scheduled-publish-loop.yml";
const LOOP_SPEC = "cms-scheduled-publish-loop.spec.js";
const LOOP_JOB = "scheduled-publish-loop";
const BRANCH_PREFIX = "cms/posts/scheduled-publish-";
const CALLER = path.join(
  __dirname,
  "..",
  "examples",
  "site",
  ".github",
  "workflows",
  LOOP_WF,
);

const GITHUB_SCRIPT_ACTION = /^actions\/github-script@/;

function schedulerDoc() {
  return parseYaml(readWorkflow(SCHEDULER_WF));
}

function publishSteps() {
  return (schedulerDoc().jobs.publish || {}).steps || [];
}

// The github-script steps of the publish job, with their inline script text.
function githubScriptSteps() {
  return publishSteps()
    .filter((s) => s && typeof s.uses === "string" && GITHUB_SCRIPT_ACTION.test(s.uses))
    .map((s) => ({ step: s, script: String((s.with && s.with.script) || "") }));
}

// Resolve a `<n> * 60 * 1000` / bare-int / named-const ms expression from a
// spec source — the same idiom cms-loop-budget-alignment.test.js resolves.
function resolveMs(expr, src) {
  const e = String(expr).trim();
  let m = e.match(/^(\d+)\s*\*\s*60\s*\*\s*1000$/);
  if (m) return Number(m[1]) * 60 * 1000;
  m = e.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const def = src.match(new RegExp(`const\\s+${e}\\s*=\\s*([^;]+);`));
    if (def) return resolveMs(def[1], src);
  }
  throw new Error(`publish-scheduled-posts-flow: could not resolve ms expression "${expr}"`);
}

test.describe("publish-scheduled-posts.yml publishes via PR + auto-merge (never a main push)", () => {
  test("declares the CMS_E2E_PAT workflow_call secret", () => {
    const on = schedulerDoc().on || {};
    const secrets = (on.workflow_call && on.workflow_call.secrets) || {};
    expect(
      Object.prototype.hasOwnProperty.call(secrets, "CMS_E2E_PAT"),
      `${SCHEDULER_WF} must declare a CMS_E2E_PAT secret on workflow_call — the PR flow ` +
        "cannot work without it (a GITHUB_TOKEN-created PR triggers no required checks)",
    ).toBe(true);
  });

  test("no run block pushes main (the ruleset-rejected shape must never return)", () => {
    const offenders = [];
    for (const { script, line } of runScripts(readWorkflow(SCHEDULER_WF))) {
      if (/git push origin main\b/.test(script)) offenders.push(`run block at line ${line}`);
    }
    expect(
      offenders,
      `${SCHEDULER_WF} contains \`git push origin main\` — the main ruleset rejects direct ` +
        "pushes and a GITHUB_TOKEN push would not fire deploy-production; publish via the " +
        "cms/posts/scheduled-publish-* PR + auto-merge flow instead (see the workflow header)",
    ).toEqual([]);
  });

  test("GITHUB_TOKEN permissions stay read-only (the PAT does every write)", () => {
    const perms = schedulerDoc().permissions || {};
    expect(
      perms.contents,
      `${SCHEDULER_WF} must grant GITHUB_TOKEN only contents:read — the branch push, PR, ` +
        "and labels all ride CMS_E2E_PAT (contents:write belonged to the retired push shape)",
    ).toBe("read");
    expect(
      Object.values(perms).some((v) => v === "write"),
      `${SCHEDULER_WF} must not grant GITHUB_TOKEN any write scope`,
    ).toBe(false);
  });

  test("fails loud when posts are due but CMS_E2E_PAT is missing (no degraded mode)", () => {
    const guard = githubScriptSteps().find(
      ({ script }) => /core\.setFailed\(/.test(script) && /CMS_E2E_PAT/.test(script),
    );
    expect(
      guard,
      `${SCHEDULER_WF} must carry a github-script guard that core.setFailed()s naming ` +
        "CMS_E2E_PAT when posts are due and the secret is absent",
    ).toBeTruthy();
    // Secrets aren't readable in a reusable's step `if:` — presence must be
    // surfaced through a step env expression the script branches on.
    const env = guard.step.env || {};
    expect(
      Object.values(env).some((v) => /secrets\.CMS_E2E_PAT\s*!=\s*''/.test(String(v))),
      "the fail-loud guard must detect the secret via a `secrets.CMS_E2E_PAT != ''` " +
        "expression passed into step env (not a step if:, where secrets are unreadable)",
    ).toBe(true);
  });

  test("stacking guard: an already-open scheduled-publish PR suppresses a second one", () => {
    const stack = githubScriptSteps().find(
      ({ script }) => script.includes(BRANCH_PREFIX) && /pulls\.list/.test(script),
    );
    expect(
      stack,
      `${SCHEDULER_WF} must carry a github-script stacking guard that lists open PRs on ` +
        `the ${BRANCH_PREFIX} head prefix — a second PR flipping the same posts would conflict ` +
        "with yesterday's still-pending one",
    ).toBeTruthy();
    expect(
      String((stack.step.with && stack.step.with["github-token"]) || ""),
      "the stacking guard must authenticate as CMS_E2E_PAT",
    ).toContain("secrets.CMS_E2E_PAT");
    expect(
      /core\.notice\(/.test(stack.script),
      "the stacking guard must core.notice() the skip (log + exit success, not fail)",
    ).toBe(true);
    // Its skip output must actually gate the write steps.
    const gated = publishSteps().filter((s) => /steps\.stack\.outputs\.skip/.test(String(s.if || "")));
    expect(
      gated.length,
      "the commit/push and PR-creation steps must be gated on the stacking guard's output",
    ).toBeGreaterThanOrEqual(2);
  });

  test("the flips land on a cms/posts/scheduled-publish-<run_id> branch", () => {
    const commitScript = runScripts(readWorkflow(SCHEDULER_WF)).find(({ script }) =>
      /git checkout -b/.test(script),
    );
    expect(commitScript, `${SCHEDULER_WF} must create the publish branch in a run block`).toBeTruthy();
    expect(
      commitScript.script,
      `the publish branch must use the ${BRANCH_PREFIX}<run_id> template`,
    ).toContain(BRANCH_PREFIX);
    expect(
      /git push origin "?cms\/posts\/scheduled-publish-/.test(commitScript.script),
      "the branch (not main) must be what gets pushed",
    ).toBe(true);
  });

  test("PR creation is github-script, PAT-authenticated, labelled cms/draft + cms/ready", () => {
    const create = githubScriptSteps().find(({ script }) => /pulls\.create/.test(script));
    expect(
      create,
      `${SCHEDULER_WF} must open the auto-publish PR via actions/github-script`,
    ).toBeTruthy();
    expect(
      String((create.step.with && create.step.with["github-token"]) || ""),
      "the PR-creation step must authenticate as CMS_E2E_PAT — a GITHUB_TOKEN-created PR " +
        "cannot trigger the required checks, so it would never auto-merge",
    ).toContain("secrets.CMS_E2E_PAT");
    // The branch template rides in via step env (the run_id expression).
    const envVals = Object.values(create.step.env || {}).map(String);
    expect(
      envVals.some((v) => v.startsWith(BRANCH_PREFIX)),
      `the PR head branch env must carry the ${BRANCH_PREFIX} template`,
    ).toBe(true);
    // Labels: createLabel try/catch first (the cms-editorial-workflow
    // pattern), then cms/draft + cms/ready applied — cms/ready is what
    // fires auto-merge-when-ready's `labeled` trigger.
    expect(/createLabel/.test(create.script), "labels must be ensured via createLabel").toBe(true);
    expect(/addLabels/.test(create.script), "labels must be applied via addLabels").toBe(true);
    for (const label of ["cms/draft", "cms/ready"]) {
      expect(
        create.script.includes(`'${label}'`) || create.script.includes(`"${label}"`),
        `the auto-publish PR must be labelled ${label}`,
      ).toBe(true);
    }
  });
});

test.describe("the scheduled-publish branch prefix stays Decap-shaped (lexical)", () => {
  // label-non-decap-prs.yml derives Decap's branchPrefix from
  // FIXTURE_BRANCH_PREFIX's first segment; the publish branch must live
  // under the same segment so the labeller + content-PR guards classify
  // the auto-publish PR as CMS-shaped.
  const decapSegment = `${FIXTURE_BRANCH_PREFIX.split("/")[0]}/`;

  test(`the branch prefix starts with the Decap segment (${decapSegment})`, () => {
    expect(
      BRANCH_PREFIX.startsWith(decapSegment),
      `the scheduled-publish branch prefix (${BRANCH_PREFIX}) must start with the Decap ` +
        `branch segment ${decapSegment} (derived from e2e/cms-fixture-pr.js FIXTURE_BRANCH_PREFIX)`,
    ).toBe(true);
    expect(
      readWorkflow(SCHEDULER_WF).includes(BRANCH_PREFIX),
      `${SCHEDULER_WF} must use the ${BRANCH_PREFIX} prefix this lint asserts on`,
    ).toBe(true);
  });

  test("workflow and loop spec agree on the full prefix (lockstep)", () => {
    const specSrc = fs.readFileSync(path.join(__dirname, LOOP_SPEC), "utf8");
    expect(
      specSrc.includes(`"${BRANCH_PREFIX}"`),
      `${LOOP_SPEC} must key its PR discovery off the same ${BRANCH_PREFIX} prefix the workflow pushes`,
    ).toBe(true);
  });
});

test.describe("cms-scheduled-publish-loop wiring (reusable + caller + spec)", () => {
  test("the reusable runs ONLY the scheduled-publish loop spec", () => {
    const doc = parseYaml(readWorkflow(LOOP_WF));
    const job = doc.jobs[LOOP_JOB];
    expect(job, `${LOOP_WF} must define the ${LOOP_JOB} job`).toBeTruthy();
    const specStep = (job.steps || []).find(
      (s) => s && typeof s.run === "string" && /playwright\s+test\b/.test(s.run),
    );
    expect(specStep, `${LOOP_WF} must run the spec via \`npx playwright test\``).toBeTruthy();
    const specTokens = specStep.run.match(/[\w./-]+\.spec\.js/g) || [];
    expect(
      specTokens,
      `${LOOP_WF} must run ONLY ${LOOP_SPEC} — this loop validates one chain; bundling ` +
        "another spec would stretch the shared prod-mutating lane hold",
    ).toEqual([LOOP_SPEC]);
    expect(
      String((specStep.env || {}).RUN_SCHEDULED_PUBLISH_LOOP || ""),
      `${LOOP_WF} must opt the spec in via RUN_SCHEDULED_PUBLISH_LOOP=1`,
    ).toBe("1");
  });

  test("the loop job joins the shared prod-mutating lane (queued, never cancelled)", () => {
    const job = parseYaml(readWorkflow(LOOP_WF)).jobs[LOOP_JOB];
    expect(
      job.concurrency && job.concurrency.group,
      `${LOOP_WF}: ${LOOP_JOB} must join the shared prod-mutating-loop concurrency lane — ` +
        "it mutates prod through the same PR → auto-merge → deploy-production chain as the " +
        "three sibling loops",
    ).toBe("prod-mutating-loop");
    expect(
      job.concurrency["cancel-in-progress"],
      `${LOOP_WF}: cancel-in-progress must be false (a mid-flow cancel leaves the fixture dirty)`,
    ).toBe(false);
  });

  test("job timeout-minutes accommodates the spec's TEST_TIMEOUT_MS (budget alignment)", () => {
    const specSrc = fs.readFileSync(path.join(__dirname, LOOP_SPEC), "utf8");
    const m = specSrc.match(/const\s+TEST_TIMEOUT_MS\s*=\s*([^;]+);/);
    expect(m, `${LOOP_SPEC} must declare TEST_TIMEOUT_MS`).toBeTruthy();
    const specMin = resolveMs(m[1], specSrc) / 60000;
    const job = parseYaml(readWorkflow(LOOP_WF)).jobs[LOOP_JOB];
    expect(
      Number(job["timeout-minutes"]),
      `${LOOP_WF}'s timeout-minutes (${job["timeout-minutes"]}) must be >= the spec's ` +
        `TEST_TIMEOUT_MS (${specMin}min) so the job cap can never truncate a deploy leg ` +
        "(the cms-loop-budget-alignment doctrine, #1815)",
    ).toBeGreaterThanOrEqual(specMin);
  });

  test("the spec is @lane: real", () => {
    expect(
      parseLaneDirective(path.join(__dirname, LOOP_SPEC)),
      `${LOOP_SPEC} drives real GitHub + prod HTTP — it must carry the \`// @lane: real\` header`,
    ).toBe("real");
  });

  test("the thin caller pins platform_ref to the same ref as its uses: pin", () => {
    const doc = parseYaml(fs.readFileSync(CALLER, "utf8"));
    const jobs = Object.values(doc.jobs || {});
    expect(jobs.length, "the caller must declare exactly one job").toBe(1);
    const job = jobs[0];
    const uses = String(job.uses || "");
    const ref = uses.split("@")[1];
    expect(ref, `caller uses: must be @-pinned (${uses})`).toBeTruthy();
    expect(
      (job.with || {}).platform_ref,
      "the caller's platform_ref input must equal the @ref on its uses: line so the " +
        "harness checkout matches the reusable that runs it",
    ).toBe(ref);
    expect(
      String(((job.secrets || {}).CMS_E2E_PAT) || ""),
      "the caller must pass secrets: CMS_E2E_PAT through to the reusable",
    ).toContain("secrets.CMS_E2E_PAT");
    // Schedule + dispatch only: the reusable dropped the recursion-gate
    // job the push-triggered loops carry, so a push trigger here would
    // reopen the self-churn recursion class (see the reusable's notes).
    const on = doc.on || doc[true] || {};
    expect(
      Object.keys(on).sort(),
      "the caller must trigger on schedule + workflow_dispatch ONLY (no push — the " +
        "reusable has no recursion gate)",
    ).toEqual(["schedule", "workflow_dispatch"]);
  });
});
