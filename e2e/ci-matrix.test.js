/*
 * Lint: the CI matrix (e2e/ci-matrix.js) and the workflow that consumes it must
 * stay in lockstep, and every Playwright project must have exactly one CI job.
 *
 * WHY THIS EXISTS
 * `.github/workflows/e2e-tests.yml` runs one job per project via a STATIC
 * `matrix.project` list, because a dynamic matrix would cost an extra
 * checkout-and-node job on the critical path. Static means it can drift: add a
 * project and the list doesn't grow — and a project with no job would SILENTLY
 * STOP RUNNING. That is the one failure mode of this design a red test has to
 * catch, so it is asserted here (single source + structural lint, per AGENTS.md).
 *
 * Platform-internal: reads the platform's own reusable workflow definition and
 * playwright.config.js, so it lives in PLATFORM_META_SPECS and runs in
 * self-CI's node-unit-lints lane.
 */
const { test, expect } = require("@playwright/test");
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const { parseYaml, readWorkflow } = require("./workflow-yaml-utils");
const {
  ADMIN_WORKERS,
  projectNames,
  engineFor,
  workersFor,
  isAdminProject,
} = require("./ci-matrix");
const config = require("./playwright.config.js");

const WORKFLOW = "e2e-tests.yml";
const CI_MATRIX_JS = path.join(__dirname, "ci-matrix.js");

function workflow() {
  return parseYaml(readWorkflow(WORKFLOW));
}

test("e2e-tests.yml matrix.project matches node ci-matrix.js --list exactly", () => {
  expect(
    workflow().jobs.project.strategy.matrix.project,
    "e2e-tests.yml's matrix.project must equal the Playwright project list — a " +
      "project with no matrix entry would silently stop running in CI",
  ).toEqual(projectNames());
});

test("every project is listed once and declares an engine", () => {
  const names = projectNames();
  expect(new Set(names).size, "duplicate project names").toBe(names.length);
  expect([...names].sort()).toEqual(config.projects.map((p) => p.name).sort());
  for (const name of names) {
    expect(["chromium", "firefox", "webkit"]).toContain(engineFor(name));
  }
});

test("only the wait-bound admin projects go wide on workers", () => {
  const admin = config.projects.filter(isAdminProject).map((p) => p.name);
  expect(admin.length, "the worker policy assumes at least one admin project").toBeGreaterThan(0);
  for (const name of projectNames()) {
    expect(workersFor(name)).toBe(admin.includes(name) ? ADMIN_WORKERS : "");
  }
});

test("the matrix does not fail fast (a red project must not cancel its siblings)", () => {
  expect(workflow().jobs.project.strategy["fail-fast"]).toBe(false);
});

test("each job derives its engine, workers, and --project from ci-matrix.js", () => {
  const job = workflow().jobs.project;
  expect(job.env.PW_PROJECT).toBe("${{ matrix.project }}");

  const install = job.steps.find((s) => String(s.name).startsWith("Install Playwright browser"));
  expect(install.run, "the engine must come from the config, never a hand-written map").toContain(
    "node ci-matrix.js --engine",
  );

  const run = job.steps.find((s) => s.name === "Run Playwright suite");
  expect(run, "the job must still have a 'Run Playwright suite' step").toBeTruthy();
  expect(run.env.WORKERS_INPUT).toBe("${{ inputs.workers }}");
  expect(run.run).toContain("node ci-matrix.js --workers");
  expect(run.run).toContain('--project="$PW_PROJECT"');
});

test("per-project artifacts and failure-comment markers are project-scoped", () => {
  const steps = workflow().jobs.project.steps;
  const upload = steps.find((s) => String(s.uses || "").includes("upload-artifact"));
  expect(upload.with.name, "upload-artifact v4+ errors on duplicate names").toContain(
    "${{ matrix.project }}",
  );

  const comments = steps.filter((s) => String(s.uses || "").includes("post-failure-comment"));
  expect(comments.length).toBe(2);
  for (const step of comments) {
    expect(step.with.marker, "jobs sharing a marker would clobber each other").toContain(
      "${{ matrix.project }}",
    );
  }
});

test("the required `e2e` context is a gate over the whole matrix", () => {
  const gate = workflow().jobs.e2e;

  expect(gate, "`e2e` is the required status context — do not rename it").toBeTruthy();
  expect(gate.needs).toBe("project");
  // always() so a red or cancelled job still REPORTS (never leaves the required
  // check pending — the missing-check trap).
  expect(String(gate.if)).toContain("always()");
  const run = gate.steps.map((s) => s.run || "").join("\n");
  expect(run, "the gate must fail on any non-success matrix result").toContain("exit 1");
  // The rolled-up matrix result reaches the script as env, never interpolated
  // into the `run:` body (the script-injection rule in AGENTS.md).
  const env = Object.assign({}, ...gate.steps.map((s) => s.env || {}));
  expect(env.MATRIX_RESULT).toBe("${{ needs.project.result }}");
});

test("ci-matrix.js CLI: --list/--engine/--workers, and a loud failure on a typo", () => {
  const cli = (...args) => execFileSync("node", [CI_MATRIX_JS, ...args], { encoding: "utf8" });

  expect(cli("--list").trim().split("\n")).toEqual(projectNames());
  for (const name of projectNames()) {
    expect(cli("--engine", name).trim()).toBe(engineFor(name));
    expect(cli("--workers", name).trim()).toBe(workersFor(name));
  }
  for (const args of [["--engine", "no-such-project"], ["--workers", "nope"], ["--bogus"]]) {
    expect(() => execFileSync("node", [CI_MATRIX_JS, ...args], { stdio: "pipe" })).toThrow();
  }
});

test("the browser self-heal only checks the engine a project job installs", () => {
  // Otherwise globalSetup would re-download the two engines the scoped install
  // deliberately skipped — on every single job.
  const { neededEngines } = require("./install-browsers-on-miss.js");
  const withProject = (name) => {
    const prev = process.env.PW_PROJECT;
    if (name === undefined) delete process.env.PW_PROJECT;
    else process.env.PW_PROJECT = name;
    try {
      return [...neededEngines()].sort();
    } finally {
      if (prev === undefined) delete process.env.PW_PROJECT;
      else process.env.PW_PROJECT = prev;
    }
  };

  for (const name of projectNames()) {
    expect(withProject(name)).toEqual([engineFor(name)]);
  }
  // No project (a full local run, or another reusable running every project) —
  // check all three, exactly as before.
  expect(withProject(undefined)).toEqual(["chromium", "firefox", "webkit"]);
  // An unknown project is the workflow's problem to report; the self-heal must
  // degrade to checking everything rather than throwing inside globalSetup.
  expect(withProject("no-such-project")).toEqual(["chromium", "firefox", "webkit"]);
});

test("CI leaves workers to Playwright unless PW_WORKERS says otherwise", () => {
  // 4 workers on a 4-vCPU runner measured SLOWER for the CPU-bound public
  // projects, so there is deliberately no blanket CI override here — only
  // ci-matrix.js's per-project value, applied by the workflow.
  expect(loadWorkers({})).toBe(undefined);
  expect(loadWorkers({ CI: "true" })).toBe(undefined);
  expect(loadWorkers({ CI: "true", PW_WORKERS: ADMIN_WORKERS })).toBe(ADMIN_WORKERS);
});

// PW_WORKERS arrives from the workflow as a STRING, and Playwright rejects
// `workers: "4"` outright ("must be a number or percentage") — every job died at
// config load on this feature's first CI run. Lock the coercion.
test("PW_WORKERS is coerced to what Playwright accepts, and garbage fails loud", () => {
  expect(loadWorkers({ CI: "true", PW_WORKERS: "4" })).toBe(4);
  expect(loadWorkers({ CI: "true", PW_WORKERS: " 2 " })).toBe(2);
  expect(loadWorkers({ CI: "true", PW_WORKERS: "50%" })).toBe("50%");
  // Empty / whitespace-only = "not set" (the workflow passes "" for a project
  // that takes Playwright's default).
  expect(loadWorkers({ CI: "true", PW_WORKERS: "" })).toBe(undefined);
  expect(loadWorkers({ CI: "true", PW_WORKERS: "   " })).toBe(undefined);

  for (const bad of ["0", "-1", "2.5", "lots", "100 %"]) {
    expect(
      () => loadWorkers({ CI: "true", PW_WORKERS: bad }),
      `PW_WORKERS=${bad} must fail loudly, not be silently ignored`,
    ).toThrow(/PW_WORKERS/);
  }
});

// Re-evaluate playwright.config.js in a child process with a given env and
// report the `workers` value it resolves to. A child process is the only way to
// test a require-time value without poisoning this process's module cache.
function loadWorkers(env) {
  const script =
    "const c = require(process.argv[1]);" +
    "process.stdout.write(JSON.stringify({ w: c.workers === undefined ? null : c.workers }));";
  const r = spawnSync("node", ["-e", script, path.join(__dirname, "playwright.config.js")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, TARGET: "prod", ...env },
  });
  // A rejected value throws at require-time; surface the whole stderr so the
  // assertion can match the message (the stack tail alone would not carry it).
  if (r.status !== 0) throw new Error(r.stderr.trim());
  const { w } = JSON.parse(r.stdout);
  return w === null ? undefined : w;
}
