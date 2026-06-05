// @lane: local — pure-fs lint of every reusable workflow that runs the e2e
// harness from the PLATFORM checkout (`.cms-platform/e2e`).
//
// THE INVARIANT (the realized #1815 / jodidaniel.com host-loop gap):
// the base_collections / single-page guards resolve the site-under-test as
// `process.env.SITE_ROOT || path.resolve(__dirname, "..")`. When a reusable
// checks the platform out into `.cms-platform/` and runs `npx playwright test`
// from `.cms-platform/e2e`, that `__dirname/..` fallback points at the
// PLATFORM checkout — which KEEPS all five base collections — NOT at the
// consuming site. So on a single-page consumer (`base_collections: []`, e.g.
// jodidaniel.com) the guard reads the WRONG _config.yml, never fires, and a
// spec for a collection the bio never renders (Posts / Tags / the `e2e`
// canary) runs anyway and times out 60s loading the live admin. The guard
// "passes" its own fixture meta-test yet silently no-ops in the real loop.
//
// THE RULE (universally correct, enforced here as early as possible — this is
// a pure-fs lint in self-ci `node-unit-lints`, so a missing SITE_ROOT fails at
// PR static-analysis time, before any loop ever runs against a live site):
// EVERY step that runs `playwright test` with `working-directory` under
// `.cms-platform/e2e` MUST export `SITE_ROOT: ${{ github.workspace }}` — the
// consumer's (default-path) checkout root. `github.workspace` is the
// site-under-test root in every lane (it is a no-op on the platform's own
// self-CI, where github.workspace and `.cms-platform` are the same tree, and
// on a full consumer that keeps every collection; it only changes behaviour on
// a single-page consumer, where it makes the guards fire CORRECTLY). There is
// never a reason to resolve site config from the `.cms-platform` harness
// checkout, so an empty (`|| ''`) or platform-pointing value is always a bug.
//
// Sibling guards for the same class: e2e/parity-preview-site-root.test.js
// (the @parity-preview crawl lane). This lint is the GENERAL backstop: it
// auto-covers any NEW reusable that grows a `.cms-platform/e2e` harness run.
const { test, expect } = require("./base");
const { listWorkflows, readWorkflow, parseYaml } = require("./workflow-yaml-utils");
const path = require("node:path");

// A `run:` invokes the Playwright runner (`npx playwright test …`) — NOT the
// browser installer (`npx playwright install …`), which legitimately runs from
// `.cms-platform/e2e` with no SITE_ROOT.
const RUNS_PLAYWRIGHT = /playwright\s+test\b/;
// The harness runs from the PLATFORM checkout. Matches both the literal
// `.cms-platform/e2e` and a conditional expression that includes it (e2e-tests'
// `${{ inputs.target == 'local' && 'e2e' || '.cms-platform/e2e' }}`).
const PLATFORM_HARNESS_WD = /\.cms-platform\/e2e/;

// Collect every { workflow, job, step } where a step runs `playwright test`
// from a `.cms-platform/e2e` working-directory.
function harnessRunSteps() {
  const out = [];
  for (const wfPath of listWorkflows()) {
    const file = path.basename(wfPath);
    const text = readWorkflow(file);
    let root;
    try {
      root = parseYaml(text);
    } catch {
      continue; // actionlint owns YAML-validity; a parse error is its failure to report.
    }
    const jobs = (root && root.jobs) || {};
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of (job && job.steps) || []) {
        const run = typeof step.run === "string" ? step.run : "";
        const wd = step["working-directory"];
        if (RUNS_PLAYWRIGHT.test(run) && wd != null && PLATFORM_HARNESS_WD.test(String(wd))) {
          out.push({ file, jobName, name: step.name || "(unnamed)", env: step.env || {} });
        }
      }
    }
  }
  return out;
}

const STEPS = harnessRunSteps();

test.describe("every .cms-platform/e2e harness run exports SITE_ROOT (github.workspace)", () => {
  // Detector self-check: if this drops toward zero a refactor has broken the
  // scan (renamed `working-directory`, moved the run) and the lint would pass
  // vacuously. The platform ships ~11 such steps today (5 loop reusables +
  // canary-prod + cms-delete-published-preview + preview-media +
  // visual-regression + e2e-tests + parity-preview); 8 is a safe floor.
  test("the scan finds the platform's harness-run steps (detector intact)", () => {
    expect(
      STEPS.length,
      `expected to find several '.cms-platform/e2e' playwright-test steps, found ${STEPS.length} ` +
        "— the working-directory/run detector likely drifted",
    ).toBeGreaterThanOrEqual(8);
  });

  for (const s of STEPS) {
    const id = `${s.file} › ${s.jobName} › "${s.name}"`;

    test(`${id} sets SITE_ROOT to the consumer checkout`, () => {
      const sr = s.env.SITE_ROOT;
      expect(
        sr,
        `${id}: runs the e2e harness from .cms-platform/e2e, so it MUST export ` +
          "SITE_ROOT: ${{ github.workspace }} — otherwise the base_collections / " +
          "single-page guards read the PLATFORM's _config.yml (the __dirname/.. " +
          "fallback) and silently no-op on a single-page consumer.",
      ).toBeTruthy();

      const val = String(sr);
      // Must reference the consumer's default-path checkout.
      expect(val, `${id}: SITE_ROOT must reference github.workspace`).toMatch(/github\.workspace/);
      // Must NOT fall back to '' (the e2e-tests non-local bug: '' → __dirname/..
      // → the platform).
      expect(
        val,
        `${id}: SITE_ROOT must not fall back to an empty string (that resolves to ` +
          "the platform checkout, defeating the guard)",
      ).not.toMatch(/\|\|\s*(['"])\1/);
      // Must NOT point at the platform checkout.
      expect(
        val,
        `${id}: SITE_ROOT must be the consumer root (github.workspace), never the ` +
          ".cms-platform harness checkout",
      ).not.toMatch(/cms-platform/);
    });
  }
});
