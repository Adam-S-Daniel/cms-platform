// @lane: local — pure-fs lint over two workflow files plus the reusable's
// decision script lifted out of it and executed against a fake runner in
// scratch dirs. No browser, no network. Runs in self-ci.yml's node-unit-lints
// lane (picked up by exclusion).
//
// THE GAP (_agent-guidance#313, adamdaniel.ai#4346): both consumer sites carry
// the fleet's `.githooks/agent-checks` runner, and no CI workflow ran it. A
// consumer cannot own the workflow (workflow-SET parity flags any caller absent
// from examples/site as EXTRA on a required check), so it is a platform seam:
// `.github/workflows/site-agent-checks.yml` (reusable) + the dictated thin
// caller `examples/site/.github/workflows/agent-checks.yml`.
//
// WHAT THIS FILE PROVES
//   - the caller fires on `edited` (the pr-tldr rule reads the description),
//     and nothing in caller or reusable can SKIP on that event (#222): the only
//     `if:` anywhere is the gate's `always()`;
//   - the work/gate split holds against every cause
//     required-context-cancellable-utils.js can see;
//   - the checkout is full-history and credential-free;
//   - the decision script BEHAVES: a Decap PR (`cms/` head branch, a human
//     author) and a bot's PR turn a refusal into a warning and exit 0, a human
//     non-Decap PR keeps the runner's exit code — executed, not pattern-matched;
//   - the `cms/` prefix is the one label-non-decap-prs.yml derives from
//     e2e/cms-fixture-pr.js's FIXTURE_BRANCH_PREFIX;
//   - the context is NOT required yet (#371 sequencing).
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: it reads this repo's
// own workflow definitions and the examples/site templates.
//
// Parses YAML through workflow-yaml-utils — never a line scan (house rule).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, readWorkflow, listWorkflows, events, allStrings } = require("./workflow-yaml-utils");
const {
  cancellationHazards,
  reusableBasename,
  requiredContexts,
} = require("./required-context-cancellable-utils");
const { FIXTURE_BRANCH_PREFIX } = require("./cms-fixture-pr");

const REPO_ROOT = path.resolve(__dirname, "..");
const REUSABLE = "site-agent-checks.yml";
const SELF_WORKFLOW = "agent-checks.yml";
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const CALLER_PATH = path.join(EXAMPLES_DIR, "agent-checks.yml");
const NUDGE_PATH = path.join(EXAMPLES_DIR, "cms-automerge-nudge.yml");
const MANIFEST_PATH = path.join(REPO_ROOT, "repo-settings.yml");

const WORK_JOB = "checks";
const GATE_JOB = "agent-checks";
const CALLER_JOB = "agent-checks";
const CONTEXT = `${CALLER_JOB} / ${GATE_JOB}`;
const RUN_STEP = "Run the commit-time checks over this change";
// label-non-decap-prs.yml's derivation, verbatim: the first segment of the
// fixture prefix, plus a slash.
const DECAP_BRANCH_PREFIX = `${FIXTURE_BRANCH_PREFIX.split("/")[0]}/`;

const reusable = () => parseYaml(readWorkflow(REUSABLE)) || {};
const caller = () => parseYaml(fs.readFileSync(CALLER_PATH, "utf8")) || {};
const workSteps = () => ((reusable().jobs || {})[WORK_JOB] || {}).steps || [];
const stepRun = (s) => String((s && s.run) || "");
const isCheckout = (s) => /^actions\/checkout@/.test(String(s.uses || ""));
const isSetupNode = (s) => /^actions\/setup-node@/.test(String(s.uses || ""));
const runStep = () => {
  const s = workSteps().find((x) => x.name === RUN_STEP);
  expect(s, `the ${WORK_JOB} job must carry the step ${JSON.stringify(RUN_STEP)}`).toBeTruthy();
  return s;
};

const SCRATCH_DIRS = [];
test.afterAll(() => {
  for (const dir of SCRATCH_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-agent-checks-"));
  SCRATCH_DIRS.push(dir);
  return dir;
}

// Run a step's `run:` script under bash as the runner would, in `cwd`, with
// `env` on top of a minimal environment.
function runScript(script, { cwd, env }) {
  const scriptPath = path.join(scratch(), "step.sh");
  fs.writeFileSync(scriptPath, script);
  const r = spawnSync("bash", [scriptPath], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

// A caller tree whose `.githooks/agent-checks` records its arguments and exits
// with FAKE_EXIT — a stand-in for the real runner refusing or passing.
function fakeTree() {
  const cwd = scratch();
  fs.mkdirSync(path.join(cwd, ".githooks"));
  fs.writeFileSync(
    path.join(cwd, ".githooks", "agent-checks"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$FAKE_ARGS"\necho "agent-checks: fake refusal" >&2\nexit "${FAKE_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  return cwd;
}

function decide({ headRef, authorType, fakeExit, cwd = fakeTree() }) {
  const args = path.join(cwd, "fake_args");
  const r = runScript(stepRun(runStep()), {
    cwd,
    env: {
      BASE: "1111111111111111111111111111111111111111",
      HEAD_SHA: "2222222222222222222222222222222222222222",
      HEAD_REF: headRef,
      AUTHOR_TYPE: authorType,
      FAKE_EXIT: String(fakeExit),
      FAKE_ARGS: args,
    },
  });
  return { ...r, args: fs.existsSync(args) ? fs.readFileSync(args, "utf8").trim().split("\n") : null };
}

test.describe("site-agent-checks — the reusable's contract", () => {
  test("exists, is workflow_call-only, and takes NO inputs and NO secrets", () => {
    expect(listWorkflows().map((f) => path.basename(f))).toContain(REUSABLE);
    const on = reusable().on || {};
    expect(Object.keys(on)).toEqual(["workflow_call"]);
    expect((on.workflow_call || {}).inputs, "convention, not configuration").toBeUndefined();
    expect((on.workflow_call || {}).secrets).toBeUndefined();
    expect(reusable().permissions).toEqual({ contents: "read" });
    expect(reusable().concurrency, "no workflow-level group").toBeUndefined();
  });

  test("is a WORK job plus a GATE job, and nothing else", () => {
    const jobs = reusable().jobs || {};
    expect(Object.keys(jobs).sort()).toEqual([GATE_JOB, WORK_JOB].sort());
    expect(typeof jobs[WORK_JOB]["timeout-minutes"], "the wall lives on the work job").toBe("number");
    expect(jobs[WORK_JOB].needs).toBeUndefined();
  });

  test("the gate has `if: always()`, no timeout, no concurrency, and no cancellation hazard", () => {
    const reusableDoc = reusable();
    const callerDoc = caller();
    const gate = reusableDoc.jobs[GATE_JOB];
    expect(gate.needs).toBe(WORK_JOB);
    expect(String(gate.if || "")).toMatch(/^\$\{\{\s*always\(\)\s*\}\}$/);
    expect(gate["timeout-minutes"]).toBeUndefined();
    expect(gate.concurrency).toBeUndefined();
    const hazards = cancellationHazards({
      callerDoc,
      callerJob: (callerDoc.jobs || {})[CALLER_JOB],
      reusableDoc,
      reusableJob: gate,
    });
    expect(hazards.map((h) => `${h.where}: ${h.what}`)).toEqual([]);
  });

  test("the gate script BEHAVES: exit 0 only on success", () => {
    const gate = reusable().jobs[GATE_JOB];
    const step = (gate.steps || []).find((s) => s.run);
    expect(String((step.env || {}).CHECKS_RESULT)).toContain(`needs.${WORK_JOB}.result`);
    const cwd = scratch();
    expect(runScript(stepRun(step), { cwd, env: { CHECKS_RESULT: "success" } }).status).toBe(0);
    for (const bad of ["failure", "cancelled", "skipped", ""]) {
      const r = runScript(stepRun(step), { cwd, env: { CHECKS_RESULT: bad } });
      expect(r.status, `work result ${JSON.stringify(bad)} must red the gate`).toBe(1);
      expect(r.out).toContain("::error::");
    }
  });

  test("#222: no job or step in the reusable carries an `if:` but the gate's always()", () => {
    const jobs = reusable().jobs || {};
    for (const [name, job] of Object.entries(jobs)) {
      if (name !== GATE_JOB) expect(job.if, `job ${name} must be unconditional`).toBeUndefined();
      for (const s of job.steps || []) {
        expect(
          s.if,
          `step ${JSON.stringify(s.name || s.uses)} in ${name} must be unconditional — the caller ` +
            "fires on `edited`, and nothing may skip on it",
        ).toBeUndefined();
      }
    }
  });

  test("checkout is the caller's tree, full history, no persisted credential, same pin as the self workflow", () => {
    const steps = workSteps();
    const checkout = steps.find(isCheckout);
    expect(checkout).toBeTruthy();
    expect(checkout.with || {}).toEqual({ "fetch-depth": 0, "persist-credentials": false });
    const selfCheckout = Object.values(parseYaml(readWorkflow(SELF_WORKFLOW)).jobs || {})
      .flatMap((j) => j.steps || [])
      .find(isCheckout);
    expect(String(checkout.uses).split("@")[1]).toMatch(/^[0-9a-f]{40}$/);
    expect(checkout.uses).toBe(selfCheckout.uses);
  });

  test("Node is set up before the runner, and the runner gets the PR's base/head", () => {
    const steps = workSteps();
    const run = steps.find((x) => x.name === RUN_STEP);
    const node = steps.find(isSetupNode);
    expect(node, "the runner calls node; pin it (workflow-runtime-pinned)").toBeTruthy();
    expect(steps.indexOf(node)).toBeLessThan(steps.indexOf(run));
    expect(steps.indexOf(steps.find(isCheckout))).toBeLessThan(steps.indexOf(node));
    expect(run.env).toEqual({
      BASE: "${{ github.event.pull_request.base.sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      HEAD_REF: "${{ github.event.pull_request.head.ref }}",
      AUTHOR_TYPE: "${{ github.event.pull_request.user.type }}",
    });
    expect(steps.length, "checkout, setup-node, run — nothing else").toBe(3);
  });

  test("no step interpolates `${{ }}` into a run block", () => {
    for (const job of Object.values(reusable().jobs || {})) {
      for (const s of job.steps || []) expect(stepRun(s)).not.toContain("${{");
    }
  });

  test("the warn-only branch keys on label-non-decap-prs.yml's `cms/` prefix and the Bot type", () => {
    // Lexical checks on two leaf tokens; the behavior is proven below.
    expect(DECAP_BRANCH_PREFIX).toBe("cms/");
    const labeller = parseYaml(readWorkflow("label-non-decap-prs.yml")) || {};
    const labellerScript = allStrings(labeller.jobs).join("\n");
    expect(
      labellerScript,
      "label-non-decap-prs.yml must still derive its Decap prefix from FIXTURE_BRANCH_PREFIX; " +
        "if that rule moves, move this one with it",
    ).toContain("FIXTURE_BRANCH_PREFIX.split('/')[0]");
    const script = stepRun(runStep());
    expect(script).toContain(`${DECAP_BRANCH_PREFIX}*)`);
    expect(script).toContain('"Bot"');
  });
});

test.describe("site-agent-checks — the decision script BEHAVES (fake runner)", () => {
  test("a Decap PR (cms/ head branch, human author) warns and exits 0 on a refusal", () => {
    const r = decide({ headRef: "cms/posts/x", authorType: "User", fakeExit: 1 });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("::warning");
    expect(r.args, "the runner still RUNS, with the PR's range").toEqual([
      "ci",
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    ]);
  });

  test("a bot's PR warns and exits 0 on a refusal", () => {
    const r = decide({ headRef: "dependabot/npm_and_yarn/x", authorType: "Bot", fakeExit: 1 });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("::warning");
    expect(r.args).not.toBe(null);
  });

  test("a human non-Decap PR keeps the runner's real exit code", () => {
    for (const code of [1, 3]) {
      const r = decide({ headRef: "feat/x", authorType: "User", fakeExit: code });
      expect(r.status, r.out).toBe(code);
      expect(r.out).not.toContain("::warning");
    }
    // A branch merely CONTAINING cms/ is not Decap's convention.
    expect(decide({ headRef: "feat/cms/x", authorType: "User", fakeExit: 1 }).status).toBe(1);
  });

  test("a passing runner exits 0 with no warning, whoever the author", () => {
    for (const [headRef, authorType] of [["feat/x", "User"], ["cms/posts/x", "User"], ["x", "Bot"]]) {
      const r = decide({ headRef, authorType, fakeExit: 0 });
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain("::warning");
    }
  });

  test("no runner in the tree: a notice, exit 0", () => {
    const r = decide({ headRef: "feat/x", authorType: "User", fakeExit: 1, cwd: scratch() });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("::notice");
    expect(r.args).toBe(null);
  });
});

test.describe("site-agent-checks — the dictated thin caller", () => {
  test("exists, calls the reusable on a release tag, and passes NOTHING", () => {
    expect(fs.existsSync(CALLER_PATH)).toBe(true);
    const jobs = caller().jobs || {};
    expect(Object.keys(jobs), `one job, so the context is exactly \`${CONTEXT}\``).toEqual([CALLER_JOB]);
    const job = jobs[CALLER_JOB];
    expect(reusableBasename(job.uses)).toBe(REUSABLE);
    expect(String(job.uses)).toMatch(
      /^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/site-agent-checks\.yml@v\d+\.\d+\.\d+$/,
    );
    expect(job.with).toBeUndefined();
    expect(job.secrets).toBeUndefined();
    expect(job.if, "#222: the caller job must never skip on `edited`").toBeUndefined();
    expect(job.concurrency).toBeUndefined();
    expect(caller().concurrency).toBeUndefined();
    expect(caller().permissions).toEqual({ contents: "read" });
  });

  test("fires on pull_request to main, INCLUDING `edited`, with no path filter", () => {
    const doc = caller();
    expect(events(doc.on)).toEqual(["pull_request"]);
    const pr = doc.on.pull_request || {};
    expect(pr.types, "`edited` re-runs pr-tldr when the description changes").toEqual([
      "opened",
      "edited",
      "reopened",
      "synchronize",
    ]);
    expect(pr.branches).toEqual(["main"]);
    expect(pr.paths).toBeUndefined();
    expect(pr["paths-ignore"]).toBeUndefined();
  });

  test("declares a dynamic run-name", () => {
    const runName = caller()["run-name"];
    expect(typeof runName === "string" && runName.includes("${{") && runName.includes("}}")).toBe(true);
  });

  // SEQUENCING (#371): a required context nothing publishes blocks every PR,
  // so this became required only after both consumers reported
  // `agent-checks / agent-checks` from the seeded caller. Its positive twin:
  // the ruleset and the nudge template both name it.
  test("the context is required: in consumer-main and in the nudge template", () => {
    const manifest = parseYaml(fs.readFileSync(MANIFEST_PATH, "utf8")) || {};
    expect(requiredContexts(manifest, "consumer-main")).toContain(CONTEXT);
    const nudge = parseYaml(fs.readFileSync(NUDGE_PATH, "utf8")) || {};
    const listed = Object.values(nudge.jobs || {})
      .map((j) => String(((j && j.with) || {}).required_contexts || ""))
      .join("\n")
      .split("\n")
      .map((l) => l.trim());
    expect(listed).toContain(CONTEXT);
  });
});
