/*
 * Lint: the CI matrix (e2e/ci-matrix.js) and the workflow that consumes it must
 * stay in lockstep, and every Playwright project must have exactly one CI job.
 *
 * WHY THIS EXISTS
 * `.github/workflows/e2e-tests.yml` runs one job per project (per SHARD, for
 * an admin project) via a STATIC `matrix.include` list, because a dynamic
 * matrix would cost an extra checkout-and-node job on the critical path.
 * Static means it can drift: add a project (or change ADMIN_SHARDS) and the
 * list doesn't follow — and a project or shard with no job would SILENTLY
 * STOP RUNNING. The list is read from the PARSED workflow (the `yaml` package
 * via workflow-yaml-utils), never a line scan. That is the one failure mode of this design a red test has to
 * catch, so it is asserted here (single source + structural lint, per AGENTS.md).
 *
 * Platform-internal: reads the platform's own reusable workflow definition and
 * playwright.config.js, so it lives in PLATFORM_META_SPECS and runs in
 * self-CI's node-unit-lints lane.
 */
const { test, expect } = require("@playwright/test");

// Share immutable inputs within a worker, with independent test failures.
test.describe.configure({ mode: "default" });
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { parseYaml, readWorkflow } = require("./workflow-yaml-utils");
const {
  CI_WORKERS,
  ADMIN_SHARDS,
  projectNames,
  matrixEntries,
  engineFor,
  workers,
  isAdminProject,
} = require("./ci-matrix");
const config = require("./playwright.config.js");

const WORKFLOW = "e2e-tests.yml";
const CI_MATRIX_JS = path.join(__dirname, "ci-matrix.js");

// The parsed workflow is only read by these assertions; parse it once per worker.
let parsedWorkflow;
function workflow() {
  return (parsedWorkflow ||= parseYaml(readWorkflow(WORKFLOW)));
}

// Run the original CommonJS source with isolated argv/env while retaining
// Node's dependency cache. No CLI dispatch or worker-coercion logic is copied.
function compileModule(filename) {
  const source = fs.readFileSync(filename, "utf8").replace(/^#![^\n]*\n/, "");
  return new vm.Script(
    `(function(require, module, exports, __filename, __dirname, process, console) {${source}\n})`,
    { filename },
  ).runInThisContext();
}

const runMatrixModule = compileModule(CI_MATRIX_JS);
const runConfigModule = compileModule(path.join(__dirname, "playwright.config.js"));

function matrixCli(...args) {
  const module = { exports: {} };
  const moduleRequire = createRequire(CI_MATRIX_JS);
  const cliRequire = (id) => moduleRequire(id);
  cliRequire.main = module;
  const output = [];
  runMatrixModule(
    cliRequire, module, module.exports, CI_MATRIX_JS, __dirname,
    {
      argv: [process.execPath, CI_MATRIX_JS, ...args],
      exit: (status) => { throw new Error(`ci-matrix.js exited ${status}`); },
    },
    { log: (line) => output.push(String(line)), error: (line) => { throw new Error(String(line)); } },
  );
  return output.join("\n") + "\n";
}

test("e2e-tests.yml matrix.include matches node ci-matrix.js --matrix exactly", () => {
  const matrix = workflow().jobs.project.strategy.matrix;
  expect(Object.keys(matrix), "the matrix is ONLY an include list (no cross-product axis)").toEqual(["include"]);
  expect(
    matrix.include,
    "e2e-tests.yml's matrix.include must equal ci-matrix.js's matrixEntries() — a " +
      "project or shard with no matrix entry would silently stop running in CI",
  ).toEqual(matrixEntries());
});

test("every project runs: public ones once, admin ones as ADMIN_SHARDS complete shards", () => {
  const entries = matrixEntries();
  expect([...new Set(entries.map((e) => e.project))]).toEqual(projectNames());
  expect(new Set(entries.map((e) => e.slot)).size, "slots must be unique").toBe(entries.length);
  expect(ADMIN_SHARDS, "a 1-way shard is no shard").toBeGreaterThan(1);
  for (const p of config.projects) {
    const shards = entries.filter((e) => e.project === p.name).map((e) => e.shard);
    if (isAdminProject(p)) {
      // Every shard 1..N exactly once — a missing index drops 1/N of the tests.
      expect(shards).toEqual(Array.from({ length: ADMIN_SHARDS }, (_, i) => `${i + 1}/${ADMIN_SHARDS}`));
    } else {
      expect(shards, `${p.name} is a public project and runs unsharded`).toEqual([""]);
    }
  }
});

test("every project is listed once and declares an engine", () => {
  const names = projectNames();
  expect(new Set(names).size, "duplicate project names").toBe(names.length);
  expect([...names].sort()).toEqual(config.projects.map((p) => p.name).sort());
  for (const name of names) {
    expect(["chromium", "firefox", "webkit"]).toContain(engineFor(name));
  }
});

test("every project job runs at the same measured worker count", () => {
  // Deliberately uniform: a per-project table measured no better and is a thing
  // to maintain. Admin projects still sort FIRST so the long poles start early.
  expect(workers()).toBe(CI_WORKERS);
  expect(CI_WORKERS, "must be a number or a percentage Playwright accepts").toMatch(/^\d+%?$/);
  const admin = config.projects.filter(isAdminProject).map((p) => p.name);
  expect(admin.length, "the matrix ordering assumes at least one admin project").toBeGreaterThan(0);
  expect(projectNames().slice(0, admin.length).sort()).toEqual([...admin].sort());
});

test("each job's check name is keyed on matrix.slot", () => {
  // Without a `name:`, an `include` matrix renders every field into the check
  // name: `project (chromium-laptop, , chromium-laptop)`.
  expect(workflow().jobs.project.name).toBe("project (${{ matrix.slot }})");
});

test("the matrix does not fail fast (a red project must not cancel its siblings)", () => {
  expect(workflow().jobs.project.strategy["fail-fast"]).toBe(false);
});

test("each job derives its engine, workers, and --project from ci-matrix.js", () => {
  const job = workflow().jobs.project;
  expect(job.env.PW_PROJECT).toBe("${{ matrix.project }}");
  expect(job.env.PW_SHARD, "the shard reaches the script via env, never `${{ }}` in run:").toBe(
    "${{ matrix.shard }}",
  );

  // The engine is DERIVED (never a hand-written project→engine map) in its own
  // step, whose output feeds the install. Two steps rather than one because the
  // install itself is the bounded/retried composite — see
  // playwright-install-bounded.test.js for why it can't be a raw `run:`.
  const resolve = job.steps.find((s) => s.id === "engine");
  expect(resolve, "the job must resolve its engine in a step with id 'engine'").toBeTruthy();
  expect(resolve.run, "the engine must come from the config, never a hand-written map").toContain(
    "node ci-matrix.js --engine",
  );
  expect(resolve.run, "the resolved engine must be published as a step output").toContain(
    'echo "engine=$PW_BROWSER" >> "$GITHUB_OUTPUT"',
  );

  const install = job.steps.find((s) => String(s.name).startsWith("Install Playwright browser"));
  expect(
    String(install.uses),
    "the install must go through the bounded composite, not a raw `npx playwright install`",
  ).toContain("install-playwright-browsers");
  expect(install.with.browser, "the install must consume the DERIVED engine").toBe(
    "${{ steps.engine.outputs.engine }}",
  );

  const run = job.steps.find((s) => s.name === "Run Playwright suite");
  expect(run, "the job must still have a 'Run Playwright suite' step").toBeTruthy();
  expect(run.env.WORKERS_INPUT).toBe("${{ inputs.workers }}");
  expect(run.run).toContain("node ci-matrix.js --workers");
  expect(run.run).toContain('--project="$PW_PROJECT"');
  // An empty PW_SHARD must pass NO --shard at all (an unsharded public project).
  expect(run.run).toContain('if [ -n "${PW_SHARD:-}" ]; then shard_args=(--shard="$PW_SHARD"); fi');
  expect(run.run).toContain('"${shard_args[@]}"');
});

test("per-job artifacts and failure-comment markers are slot-scoped", () => {
  const steps = workflow().jobs.project.steps;
  const upload = steps.find((s) => String(s.uses || "").includes("upload-artifact"));
  expect(upload.with.name, "upload-artifact v4+ errors on duplicate names — two shards share a project").toContain(
    "${{ matrix.slot }}",
  );

  const comments = steps.filter((s) => String(s.uses || "").includes("post-failure-comment"));
  expect(comments.length).toBe(2);
  for (const step of comments) {
    expect(step.with.marker, "jobs sharing a marker would clobber each other").toContain(
      "${{ matrix.slot }}",
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

test("ci-matrix.js CLI: --list/--engine/--workers/--matrix, and a loud failure on a typo", () => {
  const cli = (...args) => execFileSync("node", [CI_MATRIX_JS, ...args], { encoding: "utf8" });
  expect(JSON.parse(cli("--matrix"))).toEqual(matrixEntries());

  expect(cli("--list").trim().split("\n")).toEqual(projectNames());
  expect(cli("--workers").trim()).toBe(CI_WORKERS);
  for (const [index, name] of projectNames().entries()) {
    // Keep a real spawn for the successful --engine contract; every other
    // project still runs the original CLI dispatch with cached dependencies.
    const engineCli = index === 0 ? cli : matrixCli;
    expect(engineCli("--engine", name).trim()).toBe(engineFor(name));
  }
  for (const args of [["--engine", "no-such-project"], ["--engine"], ["--bogus"]]) {
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
  // No blanket CI override here: the sibling reusables (parity-preview,
  // canary-prod, the loops) each run a handful of specs pinned to one or two
  // projects in a single job — a shape this worker count was NOT measured on,
  // and often a single serial round trip more workers cannot speed up.
  // e2e-tests.yml passes it per job instead.
  expect(loadWorkers({})).toBe(undefined);
  expect(loadWorkers({ CI: "true" })).toBe(undefined);
  expect(loadWorkers({ CI: "true", PW_WORKERS: CI_WORKERS })).toBe(CI_WORKERS);
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

// Re-evaluate the original config with isolated env and module exports. Keep
// real child-process controls for both successful import and rejected input.
function loadWorkers(env) {
  if (Object.keys(env).length === 0 || env.PW_WORKERS === "0") {
    const script =
      "const c = require(process.argv[1]);" +
      "process.stdout.write(JSON.stringify({ w: c.workers === undefined ? null : c.workers }));";
    const childEnv = { ...process.env };
    delete childEnv.CI;
    delete childEnv.PW_WORKERS;
    const r = spawnSync("node", ["-e", script, path.join(__dirname, "playwright.config.js")], {
      encoding: "utf8",
      env: {
        ...childEnv,
        TARGET: "prod",
        ...env,
      },
    });
    // Preserve the rejected import's actual stderr and exit-status boundary.
    if (r.status !== 0) throw new Error(r.stderr.trim());
    const { w } = JSON.parse(r.stdout);
    return w === null ? undefined : w;
  }
  const filename = path.join(__dirname, "playwright.config.js");
  const module = { exports: {} };
  runConfigModule(
    createRequire(filename), module, module.exports, filename, __dirname,
    { env: { TARGET: "prod", ...env } }, console,
  );
  return module.exports.workers;
}

test("--engines is the de-duplicated engine set the matrix installs (the apt seeder's matrix)", () => {
  const { engines } = require("./ci-matrix");
  const expected = [...new Set(projectNames().map(engineFor))].sort();
  expect(engines()).toEqual(expected);
  const out = execFileSync("node", [CI_MATRIX_JS, "--engines"], { encoding: "utf8" }).trim();
  expect(JSON.parse(out)).toEqual(expected);
});
