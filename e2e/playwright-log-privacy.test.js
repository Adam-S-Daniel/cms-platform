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
const { summarize, UNAVAILABLE } = require("./summarize-playwright");

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
  ["cms-media-roundtrip.yml", "media-roundtrip"],
  ["visual-regression.yml", "visual-regression"],
  ["self-fixture-e2e.yml", "fixture-e2e"],
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

function browserAndUpload(workflow) {
  const steps = Object.values(parseYaml(readWorkflow(workflow)).jobs)
    .flatMap((job) => job.steps || []);
  const runs = steps.filter((step) => String(step.run || "").includes("npx playwright test"));
  const uploads = steps.filter((step) =>
    String(step.uses || "").startsWith("actions/upload-artifact@"));
  expect(runs, workflow).toHaveLength(1);
  expect(uploads, workflow).toHaveLength(1);
  return { run: runs[0], upload: uploads[0] };
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
  expect(actual.sort()).toEqual([...RUNS.keys()].sort());
});

for (const [workflow, stem] of RUNS) {
  test(`${workflow} captures browser output and uploads diagnostics on completed runs`, () => {
    const { run, upload } = browserAndUpload(workflow);
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
