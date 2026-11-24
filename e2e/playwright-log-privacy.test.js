// @lane: local — offline workflow lint and stubbed shell execution. No browser or network.
// PLATFORM-INTERNAL: the workflow definitions exist only in cms-platform.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const acorn = require("acorn");
const { test, expect } = require("./base");
const { readWorkflow, listWorkflows, parseYaml } = require("./workflow-yaml-utils");
const { summarize, nothingRan, UNAVAILABLE } = require("./summarize-playwright");

const RUNS = new Map([
  ["e2e-tests.yml", "playwright-output"],
  ["canary-prod.yml", "canary-output"],
  ["cms-delete-published-preview.yml", "preview-delete"],
  ["cms-scheduled-publish-loop.yml", "scheduled-publish-loop"],
  ["cms-publish-loop-host.yml", "host-loop"],
  ["cms-preview-loops.yml", "preview-loops"],
  ["preview-media.yml", "preview-media"],
  ["cms-publish-loop-preview.yml", "preview-loop"],
  ["cms-publish-loop-prod.yml", "prod-mutate"],
  ["parity-preview.yml", "parity-preview"],
  ["page-frame-live.yml", "page-frame-live"],
  ["cms-media-roundtrip.yml", "media-roundtrip"],
  ["visual-regression.yml", "visual-regression"],
  ["self-fixture-e2e.yml", ["fixture-e2e", "decap-caret"]],
]);
// These lanes already attempted an artifact upload when their job was canceled.
const CANCELED_UPLOADS = new Set([
  "cms-delete-published-preview.yml",
  "cms-scheduled-publish-loop.yml",
  "cms-publish-loop-host.yml",
  "cms-preview-loops.yml",
  "cms-publish-loop-preview.yml",
  "cms-publish-loop-prod.yml",
  "cms-media-roundtrip.yml",
]);
const HOSTILE = "page content example.com ::error:: PRIVATE-PAGE-MARKER";
const JSON_REPORT = JSON.stringify({
  stats: { expected: 2, unexpected: 1, flaky: 0, skipped: 3 },
  errors: [{ message: HOSTILE }],
  suites: [{ title: HOSTILE }],
});

function browserAndUpload(workflow, stem) {
  const steps = Object.values(parseYaml(readWorkflow(workflow)).jobs)
    .flatMap((job) => job.steps || []);
  const runs = steps.filter((step) => String(step.run || "").includes("npx playwright test"));
  const uploads = steps.filter((step) =>
    String(step.uses || "").startsWith("actions/upload-artifact@"));
  expect(runs, workflow).toHaveLength([].concat(RUNS.get(workflow)).length);
  expect(uploads, workflow).toHaveLength(1);
  const selected = runs.filter((step) => String(step.run).includes(`/tmp/${stem}.log`));
  expect(selected, `${workflow}: ${stem} must have exactly one captured invocation`).toHaveLength(1);
  return { run: selected[0], upload: uploads[0] };
}

function uploadRunsFor(condition, { canceled, failed }) {
  const source = String(condition).trim();
  expect(source.startsWith("${{") && source.endsWith("}}")).toBe(true);
  const expression = source.slice(3, -2).trim();
  const ast = acorn.parse(expression, { ecmaVersion: "latest" });
  expect(ast.body).toHaveLength(1);
  expect(ast.body[0].type).toBe("ExpressionStatement");
  const context = {
    cancelled: () => canceled,
    always: () => true,
    failure: () => failed,
    success: () => !canceled && !failed,
    vars: { PROD_PLAYGROUND_MODE: "true" },
    steps: {
      salient: { outputs: { salient: "true" }, outcome: "success" },
      select: { outputs: { count: "1" } },
      preview: { outputs: { reachable: "true" } },
      // e2e-tests.yml's content route: a `full` run is the one that has a
      // report to upload.
      route: { outputs: { route: "full" } },
      // The loop reusables' single-page detector (#1068): a full site runs.
      site_kind: { outputs: { single_page: "false" } },
    },
  };
  return Boolean(vm.runInNewContext(expression, context, { timeout: 1000 }));
}

function runWithStub(script, originalLog, mode, exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-log-privacy-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(__dirname, "summarize-playwright.js"),
      path.join(dir, "summarize-playwright.js"));
    const claudeCalls = path.join(dir, "claude-calls");
    fs.writeFileSync(claudeCalls, "");
    fs.writeFileSync(path.join(bin, "claude"), [
      "#!/usr/bin/env bash",
      "printf 'claude invoked\\n' >> \"$PW_STUB_CLAUDE_LOG\"",
      "exit 97",
      "",
    ].join("\n"), { mode: 0o755 });
    const stub = path.join(bin, "npx");
    fs.writeFileSync(stub, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"$PW_STUB_OUT\"",
      "printf '%s\\n' \"$PW_STUB_ERR\" >&2",
      "if [ \"$PW_STUB_JSON\" = valid ]; then",
      "  printf '%s' \"$PW_STUB_REPORT\" > \"$PLAYWRIGHT_JSON_OUTPUT_FILE\"",
      "elif [ \"$PW_STUB_JSON\" = malformed ]; then",
      "  printf '%s' '{invalid-json' > \"$PLAYWRIGHT_JSON_OUTPUT_FILE\"",
      "fi",
      "printf '%s\\0' \"$@\" > \"$PW_STUB_ARGS\"",
      "mkdir -p playwright-report test-results",
      "printf '%s' \"$PW_STUB_OUT\" > playwright-report/index.html",
      "printf '%s' \"$PW_STUB_ERR\" > test-results/trace.txt",
      "exit \"$PW_STUB_EXIT\"",
      "",
    ].join("\n"), { mode: 0o755 });
    const log = path.join(dir, "browser.log");
    // Only the absolute destination changes in memory. The parsed workflow's
    // original log path is asserted separately and never edited on disk.
    const localScript = script.replaceAll(originalLog, log);
    const env = { ...process.env,
      // Both offline npx and the fail-closed claude sentinel live in bin.
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      WORKERS_INPUT: "4", PW_PROJECT: "chromium-light", PW_SHARD: "1/3",
      PW_SPECS: "first.spec.js second.spec.js",
      PW_STUB_OUT: `stdout ${HOSTILE}`,
      PW_STUB_ERR: `stderr ${HOSTILE}`,
      PW_STUB_JSON: mode,
      PW_STUB_REPORT: JSON_REPORT,
      PW_STUB_EXIT: String(exitCode),
      PW_STUB_ARGS: path.join(dir, "args"),
      PW_STUB_CLAUDE_LOG: claudeCalls,
    };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", localScript], {
      cwd: dir, env, encoding: "utf8", timeout: 10000,
    });
    return {
      result,
      raw: fs.readFileSync(log, "utf8"),
      json: fs.existsSync(`${log}.json`) ? fs.readFileSync(`${log}.json`, "utf8") : null,
      args: fs.readFileSync(path.join(dir, "args"), "utf8").split("\0").filter(Boolean),
      report: fs.readFileSync(path.join(dir, "playwright-report/index.html"), "utf8"),
      trace: fs.readFileSync(path.join(dir, "test-results/trace.txt"), "utf8"),
      claudeCalls: fs.readFileSync(claudeCalls, "utf8"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("Playwright summary validates every count and hides root error values", () => {
  expect(summarize(JSON.parse(JSON_REPORT))).toBe(
    "Playwright: 2 passed, 1 failed, 0 flaky, 3 skipped, 1 fatal errors.");
  expect(summarize({ stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [{ message: HOSTILE }] })).toContain("1 fatal errors");
  for (const bad of [
    { expected: "2", unexpected: 0, flaky: 0, skipped: 0 },
    { expected: 2, unexpected: -1, flaky: 0, skipped: 0 },
    { expected: 2, unexpected: 0, flaky: 0, skipped: Number.MAX_SAFE_INTEGER + 1 },
    { expected: 2, unexpected: 0, flaky: 0 },
  ]) expect(summarize({ stats: bad, errors: [] })).toBe(UNAVAILABLE);
  expect(summarize({ stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    errors: HOSTILE })).toBe(UNAVAILABLE);
});

// #1068: jodidaniel.com's loops self-skipped every spec and went green.
test("a loop that executed zero tests is not a pass", () => {
  const stats = (expected, unexpected, flaky, skipped) =>
    ({ stats: { expected, unexpected, flaky, skipped }, errors: [] });
  expect(nothingRan(stats(0, 0, 0, 4))).toContain("executed 0 tests (4 skipped)");
  expect(nothingRan(stats(0, 0, 0, 0))).toContain("executed 0 tests");
  expect(nothingRan({ stats: { expected: "x" }, errors: [] })).toContain("unavailable");
  expect(nothingRan(stats(1, 0, 0, 3))).toBeNull();
  expect(nothingRan(stats(0, 1, 0, 0))).toBeNull();
  expect(nothingRan(stats(0, 0, 1, 0))).toBeNull();
});

test("--require-ran fails the CLI on zero executed tests and names the site", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "require-ran-"));
  try {
    const run = (report) => {
      const file = path.join(dir, "r.json");
      fs.writeFileSync(file, JSON.stringify(report));
      return require("node:child_process").spawnSync(process.execPath,
        [path.join(__dirname, "summarize-playwright.js"), "--require-ran", file],
        { encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "example/site", GITHUB_ACTOR: "someone", CMS_E2E_FORK: "false", CMS_E2E_PAT: pat, ...extra } });
    };
    let pat = "x-present";
    let extra = {};
    const skipped = run({ stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 4 }, errors: [] });
    expect(skipped.status).toBe(1);
    expect(skipped.stdout).toContain("0 passed, 0 failed, 0 flaky, 4 skipped");
    expect(skipped.stdout).toContain("::error title=Loop published nothing::example/site:");
    const ran = run({ stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 3 }, errors: [] });
    expect(ran.status).toBe(0);
    const none = { stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 4 }, errors: [] };
    // Empty secret on a normal run is a missing secret: still a failure, named.
    pat = "";
    const missing = run(none);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("CMS_E2E_PAT is missing or empty");
    // Empty secret is tolerated only for Dependabot or a fork.
    extra = { GITHUB_ACTOR: "dependabot[bot]" };
    const dependabot = run(none);
    expect(dependabot.status).toBe(0);
    expect(dependabot.stdout).toContain("::notice::no CMS_E2E_PAT");
    expect(dependabot.stdout).not.toContain("::error");
    extra = { CMS_E2E_FORK: "true" };
    expect(run(none).status).toBe(0);
    // A fork flag never excuses a present secret that ran nothing.
    pat = "x-present";
    expect(run(none).status).toBe(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every real publish loop workflow passes --require-ran", () => {
  for (const name of ["cms-publish-loop-host", "cms-publish-loop-prod",
    "cms-scheduled-publish-loop", "cms-media-roundtrip"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", `${name}.yml`), "utf8");
    expect(text).toContain("summarize-playwright.js --require-ran");
    // The step that runs --require-ran carries the secret and the fork flag in its own env.
    const steps = Object.values(parseYaml(text).jobs).flatMap((job) => job.steps || []);
    const step = steps.find((st) => String(st.run || "").includes("summarize-playwright.js --require-ran"));
    expect(step, name).toBeTruthy();
    expect(step.env.CMS_E2E_PAT, name).toBe("${{ secrets.CMS_E2E_PAT }}");
    expect(step.env.CMS_E2E_FORK, name).toBe("${{ github.event.repository.fork }}");
  }
});

test("workflow inventory covers every browser Playwright invocation", () => {
  const actual = [];
  for (const file of listWorkflows()) {
    const workflow = path.basename(file);
    const steps = Object.values(parseYaml(fs.readFileSync(file, "utf8")).jobs || {})
      .flatMap((job) => job.steps || []);
    for (const step of steps) {
      if (String(step.run || "").includes("npx playwright test")) {
        if (workflow === "self-ci.yml") {
          expect(step.name).toBe("Run pure-fs harness lints");
        } else actual.push(workflow);
      }
    }
  }
  const expected = [...RUNS].flatMap(([workflow, stems]) => [].concat(stems).map(() => workflow));
  expect(actual.sort()).toEqual(expected.sort());
});

const CAPTURES = [...RUNS].flatMap(([workflow, stems]) => [].concat(stems).map((stem) => [workflow, stem]));
for (const [workflow, stem] of CAPTURES) {
  test(`${workflow} (${stem}) captures browser output and uploads diagnostics on completed runs`, () => {
    const { run, upload } = browserAndUpload(workflow, stem);
    const log = `/tmp/${stem}.log`;
    const script = run.run;
    const paths = String(upload.with.path).split("\n").map((item) => item.trim());
    expect(paths).toContain(log);
    expect(paths).toContain(`${log}.json`);
    expect(paths.some((item) => item.includes("playwright-report"))).toBe(true);
    expect(paths.some((item) => item.includes("test-results"))).toBe(true);
    expect(uploadRunsFor(upload.if, { canceled: false, failed: false })).toBe(true);
    expect(uploadRunsFor(upload.if, { canceled: false, failed: true })).toBe(true);
    expect(uploadRunsFor(upload.if, { canceled: true, failed: false })).toBe(
      CANCELED_UPLOADS.has(workflow));

    for (const [mode, code] of [["valid", 0], ["valid", 7], ["missing", 9], ["malformed", 11]]) {
      const out = runWithStub(script, log, mode, code);
      expect(out.result.error).toBeUndefined();
      expect(out.claudeCalls).toBe("");
      expect(out.result.status).toBe(code);
      expect(out.result.stdout).not.toContain(HOSTILE);
      expect(out.result.stderr).not.toContain(HOSTILE);
      expect(out.raw).toContain(`stdout ${HOSTILE}`);
      expect(out.raw).toContain(`stderr ${HOSTILE}`);
      expect(out.report).toContain(HOSTILE);
      expect(out.trace).toContain(HOSTILE);
      expect(out.args).toContain("--reporter=list,html,json");
      if (mode === "valid") {
        expect(out.json).toBe(JSON_REPORT);
        expect(out.result.stdout).toContain("1 fatal errors");
      } else {
        if (mode === "missing") expect(out.json).toBeNull();
        else expect(out.json).toBe("{invalid-json");
        expect(out.result.stdout).toContain(UNAVAILABLE);
      }
    }
  });
}
