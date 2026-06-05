// @lane: local — pure-fs lint of the parity-preview reusable workflow YAML.
//
// REGRESSION GUARD (jodidaniel.com #35 / single-page consumer): the
// @parity-preview lane probes the DEPLOYED preview surface and builds its
// content-URL list from the CONSUMER's SOURCE tree. The crawl specs
// (console-clean.spec.js, sitemap.spec.js) resolve their repo root as
// `process.env.SITE_ROOT || path.join(__dirname, "..")`. In the parity-preview
// job the harness is checked out into `.cms-platform/`, so `__dirname/..` is
// the PLATFORM checkout — whose fixture `_config.yml` KEEPS all five base
// collections. Without SITE_ROOT the single-page guard (#33,
// cap.keepsBaseCollection) therefore reads the WRONG config and crawls
// `/blog/` + `/tags/`, which a `base_collections: []` consumer (jodidaniel)
// legitimately 404s → console-clean red-fails the parity gate.
//
// FIX: the "Run @parity-preview specs" step MUST export SITE_ROOT pointing at
// the consumer checkout (github.workspace — the site is the FIRST, default-path
// checkout; the platform is the second, into .cms-platform/). Then the crawl
// specs read the consumer's _config.yml and the single-page opt-out engages.
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

test.describe("parity-preview reusable exports SITE_ROOT for the consumer crawl", () => {
  const wf = parseYaml(readWorkflow("parity-preview.yml"));
  const steps = wf.jobs.parity.steps;
  const runStep = steps.find((s) => s.name === "Run @parity-preview specs");

  test("the @parity-preview spec-run step exists", () => {
    expect(runStep, "Run @parity-preview specs step must exist").toBeTruthy();
  });

  test("it sets SITE_ROOT to the consumer checkout root (github.workspace)", () => {
    expect(runStep.env, "spec-run step must define env").toBeTruthy();
    expect(
      runStep.env.SITE_ROOT,
      "SITE_ROOT must be set so console-clean/sitemap read the CONSUMER _config.yml " +
        "(single-page base_collections opt-out), not the platform fixture",
    ).toBeTruthy();
    // Must reference github.workspace — the default-path site checkout — not a
    // literal or the .cms-platform/ platform path.
    expect(String(runStep.env.SITE_ROOT)).toMatch(/github\.workspace/);
    expect(String(runStep.env.SITE_ROOT)).not.toMatch(/cms-platform/);
  });
});
