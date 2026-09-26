// @lane: local — pure-fs YAML-shape lint (Group A) plus a real `bash -c`
// execution of the reusable sweep step's own `run:` script (Group B), with
// stub `gh` / `git` first on PATH. No browser, no network, no sleeps.
/*
 * #458: `dependabot-rearm-sweep.yml`'s sweep can never resolve a BEHIND
 * workflow-file Dependabot PR under GITHUB_TOKEN alone — PR #450, sweep runs
 * 35868793028 / 36006683129, is the measured instance. Every GITHUB_TOKEN
 * write that would resolve it (direct merge, branch refresh, auto-merge
 * re-arm) would have to synthesize `.github/workflows/*` content that exists
 * in no commit Dependabot pushed, and GitHub refuses that write to any
 * identity without `workflows` permission — GITHUB_TOKEN can never hold it.
 * The fix mints a short-lived CMS automation App token
 * (scripts/mint-app-token.js, scoped to exactly
 * contents=write,pull_requests=write,workflows=write) and rides it ONLY on
 * the branch refresh (`gh pr update-branch`) — never the merge path, because
 * an App-attributed merge would fire push workflows (including the prod
 * loops) that a branch push cannot reach. See the reusable's own header for
 * the full correction (it used to blame classic branch protection and
 * "EVENT CONTEXT" — both wrong; see docs/CI-INVARIANTS.md too).
 *
 * Group A asserts the SHAPE from the parsed YAML: the new secret input, the
 * mint step's position/permissions, the sweep step's env, and the caller's
 * secrets map — mirrors reusable-platform-script-checkout.test.js's AST-only
 * discipline (AGENTS.md: "AST always, never regex, for code-shape lints").
 *
 * Group B EXECUTES the real sweep step's `run:` script (extracted from the
 * parsed workflow, never re-typed) via `bash -c`, the same technique
 * workflow-loop-branch-cleanup.test.js uses for sweep-stale-cms-prs.yml's
 * retire step (see its header, ~line 328): a stub `gh` and `git` first on
 * PATH, a stub check-dependabot-manifest-paths.sh that exits 0 (its own
 * behavior is exercised elsewhere), and a canned PR #450 — 18 commits behind
 * `main`, all checks green, diff touching `.github/workflows/deploy-
 * preview.yml` — that reproduces the measured #450 shape exactly. The stub
 * `gh pr update-branch` succeeds ONLY when it is invoked with
 * GH_TOKEN=app-token, so these tests discriminate on the one thing #458
 * actually changed: WHICH identity performs the refresh.
 *
 * Deterministic: no network, no sleeps — the stub `gh pr view` never answers
 * mergeable=UNKNOWN, the one condition that would make the real script sleep.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const REUSABLE = "dependabot-rearm-sweep.yml";
const CALLER = "self-dependabot-rearm.yml";
const SWEEP_STEP_NAME = "Sweep stranded Dependabot PRs";

function reusableDoc() {
  return parseYaml(readWorkflow(REUSABLE));
}

function rearmSteps() {
  return reusableDoc().jobs.rearm.steps || [];
}

function sweepStep() {
  const step = rearmSteps().find((s) => s && s.name === SWEEP_STEP_NAME);
  expect(step, `no step named "${SWEEP_STEP_NAME}" in ${REUSABLE}`).toBeTruthy();
  return step;
}

// ── Group A: shape (parsed YAML) ────────────────────────────────────────────

test.describe("dependabot-rearm-sweep.yml — App-token refresh shape (#458)", () => {
  test("on.workflow_call declares secrets.app_private_key, required: false", () => {
    const doc = reusableDoc();
    const secrets = doc.on.workflow_call.secrets;
    expect(secrets, "no on.workflow_call.secrets block").toBeTruthy();
    expect(secrets.app_private_key).toMatchObject({ required: false });
  });

  test("the platform checkout's sparse-checkout lists scripts/mint-app-token.js", () => {
    const steps = rearmSteps();
    const checkoutIdx = steps.findIndex(
      (s) => s && s.uses && /^actions\/checkout@/.test(s.uses) && s.with && s.with.path === ".cms-platform",
    );
    expect(checkoutIdx, "no platform checkout step (with.path: .cms-platform) found").toBeGreaterThanOrEqual(0);
    const sparse = String(steps[checkoutIdx].with["sparse-checkout"] || "");
    expect(sparse).toContain("scripts/mint-app-token.js");
    expect(sparse).toContain("scripts/check-dependabot-manifest-paths.sh");
  });

  test("the mint step (id: app) invokes mint-app-token.js with workflows=write, between the platform checkout and the sweep step", () => {
    const steps = rearmSteps();
    const checkoutIdx = steps.findIndex(
      (s) => s && s.uses && /^actions\/checkout@/.test(s.uses) && s.with && s.with.path === ".cms-platform",
    );
    const mintIdx = steps.findIndex((s) => s && s.id === "app");
    const sweepIdx = steps.findIndex((s) => s && s.name === SWEEP_STEP_NAME);

    expect(mintIdx, "no step with id: app found").toBeGreaterThanOrEqual(0);
    expect(sweepIdx, `no step named "${SWEEP_STEP_NAME}" found`).toBeGreaterThanOrEqual(0);
    expect(mintIdx, "the mint step must come AFTER the platform checkout").toBeGreaterThan(checkoutIdx);
    expect(sweepIdx, "the sweep step must come AFTER the mint step").toBeGreaterThan(mintIdx);

    const mintStep = steps[mintIdx];
    expect(mintStep.run, "the mint step must be a run: script").toMatch(
      /\.cms-platform\/scripts\/mint-app-token\.js/,
    );
    expect(mintStep.run).toMatch(/--permissions[^\n]*workflows=write/);
    // Never any broader than this — the merge path must never see this token.
    expect(mintStep.run).not.toMatch(/administration=write/);
  });

  test("the sweep step's env carries GH_TOKEN=github.token and REFRESH_TOKEN=steps.app.outputs.token", () => {
    const step = sweepStep();
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(step.env.REFRESH_TOKEN).toBe("${{ steps.app.outputs.token }}");
  });

  test("self-dependabot-rearm.yml's rearm job passes secrets.app_private_key from secrets.CMS_AUTOMATION_APP_PRIVATE_KEY", () => {
    const doc = parseYaml(readWorkflow(CALLER));
    const job = doc.jobs.rearm;
    expect(job.secrets, "self-dependabot-rearm.yml's rearm job has no secrets: map").toBeTruthy();
    expect(job.secrets.app_private_key).toBe("${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}");
  });
});

// ── Group B: behaviour (real bash execution of the sweep step) ─────────────

// The exact PR #450 shape from the #458 investigation: MERGEABLE, all checks
// green, mergeStateStatus BLOCKED (logged, never gated on — see the
// reusable's header) — the state that makes the sweep "act on" it rather than
// skip it.
const PR_450_JSON = JSON.stringify({
  number: 450,
  baseRefName: "main",
  headRefOid: "abc",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  statusCheckRollup: [{ name: "actionlint", conclusion: "SUCCESS" }],
});

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

// A `gh` and a `git` stub, both plain node scripts, first on PATH. `gh`
// answers exactly the calls the sweep step makes for PR #450 and logs every
// invocation (argv + the GH_TOKEN it saw) so a test can assert WHICH identity
// called `pr update-branch` / `pr merge`. `git` answers `fetch` (no-op) and
// `diff --name-only` (the workflows-touch check added by #458).
function buildStubs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rearm-458-stub-"));
  const ghLog = path.join(dir, "gh-calls.jsonl");
  const gitLog = path.join(dir, "git-calls.jsonl");

  writeExecutable(
    path.join(dir, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const ghToken = process.env.GH_TOKEN || "";
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ argv, ghToken }) + "\\n");

if (argv[0] === "pr" && argv[1] === "list") {
  process.stdout.write("450\\n");
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "view") {
  process.stdout.write(${JSON.stringify(PR_450_JSON)});
  process.exit(0);
}
if (argv[0] === "api") {
  // repos/o/r/compare/main...abc --jq .behind_by
  process.stdout.write("18\\n");
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "update-branch") {
  if (ghToken === "app-token") {
    process.exit(0);
  }
  process.stderr.write(
    "GraphQL: Pull request refusing to allow a GitHub App to create or update workflow " +
      "\`.github/workflows/deploy-preview.yml\` without \`workflows\` permission (updatePullRequestBranch)\\n",
  );
  process.exit(1);
}
if (argv[0] === "pr" && argv[1] === "merge") {
  // Both --squash (direct) and --auto --squash (re-arm) refuse, per the
  // measured #450 log — neither is a workflows-permission write itself, but
  // GitHub still refuses them while the branch is behind.
  process.exit(1);
}
console.error("gh stub: no route for " + argv.join(" "));
process.exit(1);
`,
  );

  writeExecutable(
    path.join(dir, "git"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(argv) + "\\n");

if (argv[0] === "fetch") {
  process.exit(0);
}
if (argv[0] === "diff" && argv.includes("--name-only")) {
  process.stdout.write(".github/workflows/deploy-preview.yml\\n");
  process.exit(0);
}
console.error("git stub: no route for " + argv.join(" "));
process.exit(1);
`,
  );

  return { dir, ghLog, gitLog };
}

// A working directory carrying a stub .cms-platform/scripts/check-
// dependabot-manifest-paths.sh (exit 0) — the step invokes it by relative
// path, which only resolves against cwd, never PATH.
function buildCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rearm-458-cwd-"));
  const scriptsDir = path.join(dir, ".cms-platform", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  writeExecutable(path.join(scriptsDir, "check-dependabot-manifest-paths.sh"), "#!/usr/bin/env bash\nexit 0\n");
  return dir;
}

function callsOf(log) {
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runSweep({ refreshToken, cwd, stubDir }) {
  const script = String(sweepStep().run || "");
  expect(script, "the sweep step must be a run: script").toBeTruthy();
  const summaryFile = path.join(cwd, "step-summary.txt");
  fs.writeFileSync(summaryFile, "");
  const env = {
    PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
    GH_TOKEN: "gha-token",
    GH_REPO: "o/r",
    DRY_RUN: "false",
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_SERVER_URL: "https://github.com",
  };
  if (refreshToken) env.REFRESH_TOKEN = refreshToken;
  const res = spawnSync("bash", ["-c", script], { encoding: "utf8", cwd, env });
  return {
    code: res.status,
    out: `${res.stdout || ""}${res.stderr || ""}`,
    summary: fs.readFileSync(summaryFile, "utf8"),
  };
}

test.describe("dependabot-rearm-sweep.yml — sweep step run: script, executed (#458 behaviour)", () => {
  test("REFRESH_TOKEN=app-token: refreshes the behind workflow-file PR using the App, exit 0", () => {
    const cwd = buildCwd();
    const { dir: stubDir, ghLog } = buildStubs();
    try {
      const { code, out, summary } = runSweep({ refreshToken: "app-token", cwd, stubDir });
      expect(code, out).toBe(0);
      expect(summary).toContain("| refreshed (was behind base; next sweep merges it) | 1 |");
      expect(summary).toContain("| failed (could not merge, refresh OR re-arm — needs a human) | 0 |");

      const calls = callsOf(ghLog);
      const updateBranchCalls = calls.filter((c) => c.argv[0] === "pr" && c.argv[1] === "update-branch");
      expect(updateBranchCalls.length, `no \`gh pr update-branch\` call:\n${out}`).toBeGreaterThan(0);
      for (const c of updateBranchCalls) {
        expect(c.ghToken, "update-branch must use the App token when one is available").toBe("app-token");
      }

      const mergeCalls = calls.filter((c) => c.argv[0] === "pr" && c.argv[1] === "merge");
      expect(mergeCalls.length, `no \`gh pr merge\` call:\n${out}`).toBeGreaterThan(0);
      for (const c of mergeCalls) {
        expect(c.ghToken, "the merge path must NEVER see the App token — GITHUB_TOKEN only").toBe("gha-token");
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test("REFRESH_TOKEN unset: the GITHUB_TOKEN refresh also fails, and the FAILED warning names the human action", () => {
    const cwd = buildCwd();
    const { dir: stubDir, ghLog } = buildStubs();
    try {
      const { code, out } = runSweep({ refreshToken: "", cwd, stubDir });
      expect(code).toBe(1);
      expect(out).toContain("@dependabot rebase");
      expect(out).toContain("https://github.com/o/r/pull/450");

      // And the refusal really was attempted under GITHUB_TOKEN, not silently
      // skipped — the discriminating behaviour the negative control proves.
      const calls = callsOf(ghLog);
      const updateBranchCalls = calls.filter((c) => c.argv[0] === "pr" && c.argv[1] === "update-branch");
      expect(updateBranchCalls.length, `no \`gh pr update-branch\` attempt:\n${out}`).toBeGreaterThan(0);
      for (const c of updateBranchCalls) expect(c.ghToken).toBe("gha-token");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
