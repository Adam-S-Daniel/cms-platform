// @lane: local — pure-fs workflow lint; no browser, no build, no network.
//
// Lint: every workflow step that runs the Playwright harness with a `--project`
// selection must tell the harness which project(s) it is running, via
// `PW_PROJECT`.
//
// WHY THIS EXISTS
// Each of these lanes installs only the engine(s) its selection needs (one
// `npx playwright install --with-deps chromium`, or one engine per matrix job in
// e2e-tests.yml). e2e/install-browsers-on-miss.js's globalSetup then checks
// whether the browser builds this @playwright/test version expects are present —
// and WITHOUT `PW_PROJECT` it checks all three, finds the two it never installed
// "missing", downloads them (~19 s for engines the run never launches), and
// prints the ci-runner-image-drift warning. Measured before the fix:
//
//   canary-prod run 31170994693      "build(s) missing … firefox, webkit" + 2 downloads
//   self-ci node-unit-lints 92855380065  all three downloaded, for pure-fs lints
//
// That is pure waste on lanes that include the REQUIRED `parity / parity` and
// `preview-media / preview-media` per-PR checks, and it makes a real
// PLAYWRIGHT_IMAGE_TAG drift indistinguishable from the permanent false one. A
// new lane is easy to add and easy to forget, so the wiring is asserted here
// rather than left to review.
//
// Platform-internal: reads the platform's own workflow definitions.
const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { parseYaml, listWorkflows } = require("./workflow-yaml-utils");
const fs = require("node:fs");

// Steps that run the harness under a DIFFERENT Playwright config (e.g.
// visual-regression's playwright.regression.config.js, which declares no
// globalSetup) are exempt: the self-heal never runs for them.
function usesOtherConfig(run) {
  return /--config[= ]/.test(run);
}

// `--project=<literal>` flags, and the dynamic form e2e-tests.yml uses
// (`--project="$PW_PROJECT"`), where the value IS the env var under test.
function projectFlags(run) {
  return {
    literals: [...new Set([...run.matchAll(/--project=([A-Za-z0-9._-]+)/g)].map((m) => m[1]))],
    dynamic: /--project="?\$\{?PW_PROJECT\}?"?/.test(run),
  };
}

function harnessSteps() {
  const out = [];
  for (const file of listWorkflows()) {
    const wf = parseYaml(fs.readFileSync(file, "utf8"));
    for (const [jobName, job] of Object.entries(wf.jobs || {})) {
      for (const step of job.steps || []) {
        const run = step.run || "";
        if (!run.includes("playwright test")) continue;
        out.push({
          workflow: path.basename(file),
          job: jobName,
          name: step.name || "(unnamed)",
          run,
          // Job-level env counts: e2e-tests.yml sets PW_PROJECT there so the
          // install step can read it too.
          env: { ...(job.env || {}), ...(step.env || {}) },
        });
      }
    }
  }
  return out;
}

const STEPS = harnessSteps();

test("the lint sees the harness-running steps it is meant to police", () => {
  // A refactor that renames the run command must not turn this lint into a no-op.
  expect(STEPS.length, "no workflow step runs `playwright test` — did the command change?")
    .toBeGreaterThan(8);
});

for (const step of STEPS) {
  const where = `${step.workflow} :: ${step.job} :: ${step.name}`;
  const { literals, dynamic } = projectFlags(step.run);

  if (usesOtherConfig(step.run)) {
    test(`${where} — exempt (runs a different Playwright config)`, () => {
      expect(usesOtherConfig(step.run)).toBe(true);
    });
    continue;
  }

  if (dynamic) {
    test(`${where} — passes its project through PW_PROJECT`, () => {
      expect(
        step.env.PW_PROJECT,
        "the step selects --project=\"$PW_PROJECT\" but nothing sets PW_PROJECT",
      ).toBeTruthy();
    });
    continue;
  }

  if (literals.length === 0) {
    // No project selection at all: every project is in play, so all three
    // engines legitimately need checking (a bare local run).
    continue;
  }

  test(`${where} — PW_PROJECT matches its --project flags`, () => {
    const declared = String(step.env.PW_PROJECT || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    expect(
      declared.length,
      `${where} runs --project=${literals.join(",")} but sets no PW_PROJECT, so the ` +
        `browser self-heal will re-download the engines this job never installed. ` +
        `Add \`PW_PROJECT: "${literals.join(",")}"\` to the step env.`,
    ).toBeGreaterThan(0);

    expect(
      [...declared].sort(),
      `${where}: PW_PROJECT must list exactly the projects the step runs, or the ` +
        `self-heal narrows to the wrong engine set`,
    ).toEqual([...literals].sort());
  });
}
