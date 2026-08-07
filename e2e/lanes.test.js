/*
 * Lint: the e2e LANE split (e2e/lanes.js) and the workflow that consumes it
 * must stay in lockstep, and every Playwright project must run in exactly one
 * lane.
 *
 * WHY THIS EXISTS
 * `.github/workflows/e2e-tests.yml` runs one job per lane via a STATIC
 * `matrix.lane` list, because a dynamic matrix would cost an extra
 * checkout-and-node job on the critical path. Static means it can drift: add a
 * project (or re-tag one) and the derived lane set changes while the matrix
 * doesn't — and a project belonging to no listed lane would SILENTLY STOP
 * RUNNING. That is the one failure mode of the design a red test has to catch,
 * so it is asserted here (single source + structural lint, per AGENTS.md).
 *
 * Platform-internal: reads the platform's own reusable workflow definition and
 * playwright.config.js, so it lives in PLATFORM_META_SPECS and runs in
 * self-CI's node-unit-lints lane.
 */
const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseYaml, readWorkflow } = require("./workflow-yaml-utils");
const { laneNames, lanes, projectFlags, isAdminProject } = require("./lanes");
const config = require("./playwright.config.js");

const WORKFLOW = "e2e-tests.yml";
const LANES_JS = path.join(__dirname, "lanes.js");

function workflow() {
  return parseYaml(readWorkflow(WORKFLOW));
}

test("every Playwright project runs in exactly one lane", () => {
  const assigned = [...lanes().values()].flat();
  const all = config.projects.map((p) => p.name);

  expect([...assigned].sort()).toEqual([...all].sort());
  expect(new Set(assigned).size, "a project must not appear in two lanes").toBe(assigned.length);
  for (const [lane, projects] of lanes()) {
    expect(projects.length, `lane ${lane} must not be empty`).toBeGreaterThan(0);
  }
});

test("each admin project is its own lane; the public projects share one", () => {
  const admin = config.projects.filter(isAdminProject).map((p) => p.name);
  const map = lanes();

  expect(admin.length, "the lane split assumes at least one admin project").toBeGreaterThan(0);
  for (const name of admin) {
    expect(map.get(name), `admin project ${name} must be its own lane`).toEqual([name]);
  }
  expect(map.get("public").length, "the public lane holds every non-admin project").toBe(
    config.projects.length - admin.length,
  );
});

test("e2e-tests.yml matrix.lane matches node lanes.js --list exactly", () => {
  expect(
    workflow().jobs.lane.strategy.matrix.lane,
    "e2e-tests.yml's matrix.lane must equal the derived lane names — a project " +
      "assigned to an unlisted lane would silently stop running in CI",
  ).toEqual(laneNames());
});

test("the lane matrix does not fail fast (a red lane must not cancel its siblings)", () => {
  expect(workflow().jobs.lane.strategy["fail-fast"]).toBe(false);
});

test("the lane job passes its lane + workers through to the suite", () => {
  const step = workflow().jobs.lane.steps.find((s) => s.name === "Run Playwright suite");
  expect(step, "the lane job must still have a 'Run Playwright suite' step").toBeTruthy();

  expect(step.env.LANE).toBe("${{ matrix.lane }}");
  expect(step.env.PW_WORKERS).toBe("${{ inputs.workers }}");
  // The project flags must come from lanes.js, never be hand-listed in YAML.
  expect(step.run).toContain("node lanes.js --projects");
});

test("per-lane artifacts and failure-comment markers are lane-scoped", () => {
  const steps = workflow().jobs.lane.steps;
  const upload = steps.find((s) => String(s.uses || "").includes("upload-artifact"));
  expect(upload.with.name, "upload-artifact v4+ errors on duplicate names").toContain(
    "${{ matrix.lane }}",
  );

  const comments = steps.filter((s) => String(s.uses || "").includes("post-failure-comment"));
  expect(comments.length).toBe(2);
  for (const step of comments) {
    expect(step.with.marker, "lanes sharing a marker would clobber each other").toContain(
      "${{ matrix.lane }}",
    );
  }
});

test("the required `e2e` context is a gate over every lane", () => {
  const gate = workflow().jobs.e2e;

  expect(gate, "`e2e` is the required status context — do not rename it").toBeTruthy();
  expect(gate.needs).toBe("lane");
  // always() so a red or cancelled lane still REPORTS (never leaves the
  // required check pending — the missing-check trap).
  expect(String(gate.if)).toContain("always()");
  const run = gate.steps.map((s) => s.run || "").join("\n");
  expect(run, "the gate must fail on any non-success matrix result").toContain("exit 1");
  // The rolled-up matrix result reaches the script as env (never interpolated
  // into the `run:` body — the script-injection rule in AGENTS.md).
  const env = Object.assign({}, ...gate.steps.map((s) => s.env || {}));
  expect(env.LANE_RESULT).toBe("${{ needs.lane.result }}");
});

test("lanes.js CLI: --list, --projects, and a loud failure on an unknown lane", () => {
  const list = execFileSync("node", [LANES_JS, "--list"], { encoding: "utf8" }).trim().split("\n");
  expect(list).toEqual(laneNames());

  for (const lane of laneNames()) {
    const flags = execFileSync("node", [LANES_JS, "--projects", lane], { encoding: "utf8" })
      .trim()
      .split("\n");
    expect(flags).toEqual(projectFlags(lane));
    expect(flags.every((f) => f.startsWith("--project="))).toBe(true);
  }

  expect(() =>
    execFileSync("node", [LANES_JS, "--projects", "no-such-lane"], { stdio: "pipe" }),
  ).toThrow();
});

test("CI runs one worker per vCPU by default, overridable without a release", () => {
  const src = fs.readFileSync(path.join(__dirname, "playwright.config.js"), "utf8");
  expect(src).toContain('workers: process.env.PW_WORKERS || (process.env.CI ? "100%" : undefined)');
  // The config is evaluated at require-time; assert the resolved value for this
  // process too (self-CI's node-unit-lints lane runs with CI=true).
  if (process.env.CI && !process.env.PW_WORKERS) {
    expect(config.workers).toBe("100%");
  }
});
