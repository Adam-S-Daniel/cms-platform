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
const { createSandbox } = require("./git-fixture");
const MANIFEST_SCRIPT = path.resolve(__dirname, "..", "scripts", "check-dependabot-manifest-paths.sh");
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const REUSABLE = "dependabot-rearm-sweep.yml";
const CALLER = "self-dependabot-rearm.yml";
const CONSUMER_TEMPLATE = path.resolve(
  __dirname,
  "..",
  "examples",
  "site",
  ".github",
  "workflows",
  "dependabot-rearm-sweep.yml",
);
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

  test("the consumer template's rearm job passes secrets.app_private_key from secrets.CMS_AUTOMATION_APP_PRIVATE_KEY, a key the reusable declares", () => {
    const doc = parseYaml(fs.readFileSync(CONSUMER_TEMPLATE, "utf8"));
    const job = doc.jobs.rearm;
    expect(job.secrets, "the consumer template's rearm job has no secrets: map").toBeTruthy();
    expect(job.secrets.app_private_key).toBe("${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}");
    const declared = Object.keys(reusableDoc().on.workflow_call.secrets || {});
    for (const key of Object.keys(job.secrets)) {
      expect(declared, `the reusable declares no secret "${key}"`).toContain(key);
    }
  });
});

// ── Group B: behavior (real bash execution of the sweep step) ─────────────

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
function buildStubs({ realDiff = false, failDiffAt = 0, partialDiff = false, diffStderr = "", behindBy = 18, mergeSucceeds = false } = {}) {
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
  process.stdout.write(${JSON.stringify(String(behindBy) + "\n")});
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
  process.exit(${mergeSucceeds ? 0 : 1});
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
  const diffCount = fs.readFileSync(${JSON.stringify(gitLog)}, "utf8").trim().split("\\n")
    .map((line) => JSON.parse(line)).filter((args) => args[0] === "diff").length;
  if (diffCount === ${failDiffAt}) {
    if (${partialDiff}) process.stdout.write("package.json\\0");
    process.stderr.write(${JSON.stringify(diffStderr)});
    process.exit(17);
  }
  if (${realDiff}) {
    const result = require("node:child_process").spawnSync(${JSON.stringify(REAL_GIT)}, argv);
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status === null ? 1 : result.status);
  }
  process.stdout.write(".github/workflows/deploy-preview.yml" + (argv.includes("-z") ? "\\0" : "\\n"));
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
function buildCwd({ dir = fs.mkdtempSync(path.join(os.tmpdir(), "rearm-458-cwd-")), realManifest = false } = {}) {
  const scriptsDir = path.join(dir, ".cms-platform", "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  writeExecutable(path.join(scriptsDir, "check-dependabot-manifest-paths.sh"),
    realManifest ? fs.readFileSync(MANIFEST_SCRIPT, "utf8") : "#!/usr/bin/env bash\nexit 0\n");
  return dir;
}

function callsOf(log) {
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runSweep({ refreshToken, cwd, stubDir, fixtureEnv = {} }) {
  const script = String(sweepStep().run || "");
  expect(script, "the sweep step must be a run: script").toBeTruthy();
  const summaryFile = path.join(cwd, "step-summary.txt");
  fs.writeFileSync(summaryFile, "");
  const tempDir = path.join(cwd, "temp");
  fs.mkdirSync(tempDir, { recursive: true });
  const env = {
    ...fixtureEnv,
    TMPDIR: tempDir,
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
    temporaryFiles: fs.readdirSync(tempDir),
  };
}

test.describe("dependabot-rearm-sweep.yml — sweep step run: script, executed (#458 behavior)", () => {
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
      // skipped — the discriminating behavior the negative control proves.
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

// Group C executes both path readers over init-only, offline repositories.
// Git's default quoting must not change either the allowlist or the sweep's
// workflow-specific diagnostic. Each path is the only changed record.
test.describe("Dependabot path readers preserve NUL-delimited git paths (#539)", () => {
  let sb;
  const stubDirs = [];
  test.afterEach(() => {
    for (const dir of stubDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (sb) sb.cleanup();
    sb = undefined;
  });

  function fixture(files = {}) {
    sb = createSandbox("dependabot-paths-");
    const repo = sb.initRepo("site");
    const base = sb.commit(repo, { "README.md": "base\n" }, "base");
    const head = sb.commit(repo, files, "change");
    sb.git(repo, ["update-ref", "refs/remotes/origin/main", base]);
    sb.git(repo, ["update-ref", "refs/remotes/dependabot-sweep/pr-450", head]);
    return { repo, base, head };
  }

  function stubs(options) {
    const result = buildStubs(options);
    stubDirs.push(result.dir);
    return result;
  }

  function manifest({ repo, base, head }, stubDir) {
    const tempDir = path.join(repo, "temp");
    fs.mkdirSync(tempDir, { recursive: true });
    const result = spawnSync("bash", [MANIFEST_SCRIPT, base, head], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...sb.env,
        TMPDIR: tempDir,
        PATH: stubDir ? `${stubDir}${path.delimiter}${sb.env.PATH}` : sb.env.PATH,
      },
    });
    expect(fs.readdirSync(tempDir), "manifest check removes its temporary diff on exit").toEqual([]);
    return { code: result.status, out: `${result.stdout || ""}${result.stderr || ""}` };
  }

  const ALLOWED = [
    "new\nline/package.json",
    "café/package.json",
    "with space/Gemfile",
    'quote"d/Gemfile',
    ".github/workflows/new\nline.yml",
    ".github/workflows/café.yml",
    ".github/workflows/with space.yaml",
    '.github/workflows/quote"d.yml',
  ];
  for (const file of ALLOWED) {
    test(`manifest allows ${JSON.stringify(file)} from real git`, () => {
      const result = manifest(fixture({ [file]: "manifest\n" }));
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("safe=true");
    });
  }

  for (const file of ["new\nline/source.js", "café/source.js", "with space/source.js", 'quote"d/source.js']) {
    test(`manifest rejects ${JSON.stringify(file)} from real git`, () => {
      const result = manifest(fixture({ [file]: "source\n" }));
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("safe=false");
      expect(result.out).not.toContain("safe=true");
    });
  }

  test("manifest allows a valid empty diff", () => {
    const result = manifest(fixture());
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("safe=true");
  });

  test("manifest rejects a renamed forbidden source even when its destination is allowed", () => {
    const setup = fixture({ "notes.md": "same content\n" });
    setup.base = setup.head;
    setup.head = sb.commit(setup.repo, { "notes.md": null, "package.json": "same content\n" }, "rename");
    const result = manifest(setup);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("safe=false");
  });

  test("allowed path with a newline command-looking suffix prints no workflow command", () => {
    const file = "safe\n::error::injected/package.json";
    const result = manifest(fixture({ [file]: "manifest\n" }));
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain("\r");
    expect(result.out.split("\n").filter((line) => line.startsWith("::"))).toEqual([]);
  });

  for (const file of ["::error::x", "::error::x/package.json"]) {
    test(`command-looking path ${JSON.stringify(file)} has a safe listing prefix`, () => {
      const allowed = file.endsWith("/package.json");
      const result = manifest(fixture({ [file]: "content\n" }));
      expect(result.code, result.out).toBe(allowed ? 0 : 1);
      expect(result.out).toContain(`  - ${file}\n`);
      expect(result.out.split("\n").filter((line) => line.trimStart().startsWith("::"))).toEqual(
        allowed ? [] : [
          "::error file=%3A%3Aerror%3A%3Ax::Dependabot PR touches non-manifest path: ::error::x",
        ],
      );
    });
  }

  test("forbidden control characters are escaped in the listing and annotation", () => {
    const file = "bad%\r:field,part\n::error::injected/source.js";
    const result = manifest(fixture({ [file]: "source\n" }));
    const property = "bad%25%0D%3Afield%2Cpart%0A%3A%3Aerror%3A%3Ainjected/source.js";
    const message = "bad%25%0D:field,part%0A::error::injected/source.js";
    expect(result.code, result.out).toBe(1);
    expect(result.out).not.toContain("\r");
    expect(result.out).toContain("  - bad%25%0D:field\\,part%0A::error::injected/source.js\n");
    expect(result.out.split("\n").filter((line) => line.startsWith("::"))).toEqual([
      `::error file=${property}::Dependabot PR touches non-manifest path: ${message}`,
    ]);
  });

  test("a trailing newline in a path stays on one output line", () => {
    const result = manifest(fixture({ ["package.json\n"]: "manifest\n" }));
    expect(result.code, result.out).toBe(1);
    expect(result.out).not.toContain("\r");
    expect(result.out.split("\n").filter((line) => line.startsWith("::"))).toHaveLength(1);
    expect(result.out).toContain("package.json%0A");
  });

  test("a leading-dash directory can contain an allowed manifest", () => {
    const allowed = manifest(fixture({ "-vendor/package.json": "manifest\n" }));
    expect(allowed.code, allowed.out).toBe(0);
  });

  test("a leading-dash non-manifest file is rejected", () => {
    const rejected = manifest(fixture({ "-notes.md": "notes\n" }));
    expect(rejected.code, rejected.out).toBe(1);
    expect(rejected.out).toContain("safe=false");
  });

  test("manifest rejects a real git diff failure instead of treating it as empty", () => {
    const setup = fixture();
    setup.head = "missing-ref";
    const result = manifest(setup);
    expect(result.code, result.out).toBe(2);
    expect(result.out).toContain("safe=false");
    expect(result.out).not.toContain("safe=true");
  });

  for (const partialDiff of [false, true]) {
    test(`manifest preserves escaped git failure diagnostics (partial=${partialDiff})`, () => {
      const setup = fixture();
      const diffStderr = "fatal: invalid%ref\r\n::error::injected\nlast diagnostic\n";
      const { dir } = stubs({ failDiffAt: 1, partialDiff, diffStderr });
      const result = manifest(setup, dir);
      expect(result.code, result.out).toBe(2);
      expect(result.out).toContain("safe=false");
      expect(result.out).not.toContain("safe=true");
      expect(result.out).not.toContain("package.json");
      expect(result.out).not.toContain("Files changed");
      expect(result.out).not.toContain("\r");
      expect(result.out).toContain(
        "Git diff diagnostic: fatal: invalid%25ref%0D%0A::error::injected%0Alast diagnostic\n",
      );
      expect(result.out.split("\n").filter((line) => line.trimStart().startsWith("::"))).toEqual([
        "::error::Could not read the Dependabot PR diff; refusing the manifest check.",
      ]);
    });
  }

  for (const file of ALLOWED) {
    test(`sweep classifies ${JSON.stringify(file)} from real git`, () => {
      const { repo } = fixture({ [file]: "manifest\n" });
      const cwd = buildCwd({ dir: repo, realManifest: true });
      const { dir, gitLog } = stubs({ realDiff: true });
      const result = runSweep({ cwd, stubDir: dir, fixtureEnv: sb.env });
      expect(result.code, result.out).toBe(1);
      expect(result.summary).toContain("| failed (could not merge, refresh OR re-arm — needs a human) | 1 |");
      expect(result.out.includes("changes .github/workflows/")).toBe(file.startsWith(".github/workflows/"));
      expect(result.temporaryFiles).toEqual([]);
      expect(callsOf(gitLog).filter((args) => args[0] === "diff")).toHaveLength(2);
    });
  }

  for (const partialDiff of [false, true]) {
    test(`sweep refuses all writes when its diagnostic diff fails (partial=${partialDiff})`, () => {
      const { repo } = fixture({ ".github/workflows/café.yml": "manifest\n" });
      const cwd = buildCwd({ dir: repo, realManifest: true });
      const diffStderr = "fatal: invalid%ref\r\n::error::injected\nlast diagnostic\n";
      const { dir, ghLog } = stubs({ realDiff: true, failDiffAt: 2, partialDiff, diffStderr, mergeSucceeds: true });
      const result = runSweep({ cwd, stubDir: dir, fixtureEnv: sb.env });
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("could not read the workflow-path diff");
      expect(result.out.split("\n").filter((line) => line.startsWith("Git diff diagnostic: "))).toEqual([
        "Git diff diagnostic: fatal: invalid%25ref%0D%0A::error::injected%0Alast diagnostic",
      ]);
      expect(result.out).not.toContain("\r");
      expect(result.out.split("\n").filter((line) => line.trimStart().startsWith("::error::injected"))).toEqual([]);
      expect(result.summary).toContain("| failed (could not merge, refresh OR re-arm — needs a human) | 1 |");
      expect(callsOf(ghLog).filter((call) => call.argv[0] === "pr" && ["merge", "update-branch"].includes(call.argv[1]))).toEqual([]);
      expect(result.temporaryFiles).toEqual([]);
    });
  }

  for (const partialDiff of [false, true]) {
    test(`sweep reports manifest diff failure as FAILED without writes (partial=${partialDiff})`, () => {
      const { repo } = fixture({ ".github/workflows/café.yml": "manifest\n" });
      const cwd = buildCwd({ dir: repo, realManifest: true });
      const { dir, gitLog, ghLog } = stubs({ realDiff: true, failDiffAt: 1, partialDiff, mergeSucceeds: true });
      const result = runSweep({ cwd, stubDir: dir, fixtureEnv: sb.env });
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("manifest diff failed on re-check");
      expect(result.out).not.toContain("diff touches a non-manifest path");
      expect(result.summary).toContain("| skipped (conflict / not green / non-manifest diff) | 0 |");
      expect(result.summary).toContain("| failed (could not merge, refresh OR re-arm — needs a human) | 1 |");
      expect(callsOf(gitLog).filter((args) => args[0] === "diff")).toHaveLength(1);
      expect(callsOf(ghLog).filter((call) => call.argv[0] === "pr" && ["merge", "update-branch"].includes(call.argv[1]))).toEqual([]);
      expect(result.temporaryFiles).toEqual([]);
    });
  }

  test("sweep still skips an ordinary forbidden manifest path", () => {
    const { repo } = fixture({ "README.md": "forbidden\n" });
    const cwd = buildCwd({ dir: repo, realManifest: true });
    const { dir, ghLog } = stubs({ realDiff: true, mergeSucceeds: true });
    const result = runSweep({ cwd, stubDir: dir, fixtureEnv: sb.env });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("diff touches a non-manifest path on re-check");
    expect(result.out).not.toContain("manifest diff failed");
    expect(result.summary).toContain("| skipped (conflict / not green / non-manifest diff) | 1 |");
    expect(result.summary).toContain("| failed (could not merge, refresh OR re-arm — needs a human) | 0 |");
    expect(callsOf(ghLog).filter((call) => call.argv[0] === "pr" && ["merge", "update-branch"].includes(call.argv[1]))).toEqual([]);
  });

  for (const files of [{ "café/package.json": "manifest\n" }, {}]) {
    test(`sweep succeeds and cleans up a valid ${Object.keys(files).length ? "manifest" : "empty"} diff`, () => {
      const { repo } = fixture(files);
      const cwd = buildCwd({ dir: repo, realManifest: true });
      const { dir, ghLog } = stubs({ realDiff: true, behindBy: 0, mergeSucceeds: true });
      const result = runSweep({ cwd, stubDir: dir, fixtureEnv: sb.env });
      expect(result.code, result.out).toBe(0);
      expect(result.summary).toContain("| merged | 1 |");
      expect(callsOf(ghLog).filter((call) => call.argv[0] === "pr" && call.argv[1] === "merge")).toHaveLength(1);
      expect(result.temporaryFiles).toEqual([]);
    });
  }
});
