// @lane: local — pure-fs lint on the reusable visual-regression workflow
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");

// Locks the generate job's step order: "Build Jekyll site" MUST precede
// "Detect changed pages". detect-changed-pages.js takes its canonical page
// universe from a scan of the built _site — the only discovery mode that
// sees SITE-OWNED collections (e.g. adamdaniel.ai's /tools/ pages). When
// detect ran before the build, the scan found no _site and fell back to a
// hardcoded collection list, silently dropping those pages from the
// regression gate on every PR (the gap that let the Tools-section PR
// auto-pass without its new pages ever being screenshotted).

const WORKFLOW = path.join(__dirname, "..", ".github", "workflows", "visual-regression.yml");

test.describe("visual-regression workflow: generate-job step order", () => {
  test("Jekyll build runs before page detection (the _site scan needs the build)", () => {
    const wf = parseYaml(fs.readFileSync(WORKFLOW, "utf8"));
    const steps = (wf.jobs.generate.steps || []).map((s) => s.name || "");
    const build = steps.findIndex((n) => /build jekyll site/i.test(n));
    const detect = steps.findIndex((n) => /detect changed pages/i.test(n));
    expect(build, 'generate must have a "Build Jekyll site" step').toBeGreaterThanOrEqual(0);
    expect(detect, 'generate must have a "Detect changed pages" step').toBeGreaterThanOrEqual(0);
    expect(
      build,
      "Build Jekyll site must run BEFORE Detect changed pages — the detector's " +
        "_site scan is the canonical page universe (site-owned collections are " +
        "invisible to the fallback list)",
    ).toBeLessThan(detect);
  });
});
