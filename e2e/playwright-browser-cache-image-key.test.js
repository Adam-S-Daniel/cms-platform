// @lane: local — pure-fs workflow lint; no browser, no build, no network.
//
// Lint: every actions/cache step that caches Playwright's browsers
// (~/.cache/ms-playwright) keys on the runner image's OS release.
//
// WHY THIS EXISTS: Playwright downloads a separate browser build per OS release
// (webkit-ubuntu-24.04 vs webkit-ubuntu-26.04), but the directory it installs
// into carries only the revision (`webkit-<rev>`). A cache keyed on
// `runner.os` + the lockfile alone ("Linux") is shared across images, so when
// ubuntu-latest moved from 24.04 to 26.04 on 2026-11-15 the 26.04 runners
// restored the 24.04 WebKit build, `playwright install` saw it present and
// skipped the download, and every webkit-iphone16 test failed at launch
// (self-fixture-e2e runs 43752616657 and 43755499612; passing run 43711522558
// was on 24.04, same Playwright 1.64.1).
//
// The key must interpolate an earlier step's output whose `run:` reads the
// runner's `ImageOS` variable. `runner.os` is not enough, and `env.ImageOS` is
// empty in expressions (it is a runner variable, not workflow `env`).
//
// Platform-internal: reads the platform's own workflow definitions.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { listWorkflows, parseYaml } = require("./workflow-yaml-utils");

const STEP_OUTPUT_RE = /steps\.([A-Za-z0-9_-]+)\.outputs\.[A-Za-z0-9_-]+/g;

function browserCacheSteps() {
  const found = [];
  for (const file of listWorkflows()) {
    const wf = parseYaml(fs.readFileSync(file, "utf8")) || {};
    for (const [jobName, job] of Object.entries(wf.jobs || {})) {
      const steps = (job && job.steps) || [];
      steps.forEach((step, index) => {
        const uses = String((step && step.uses) || "");
        const cachePath = String((step && step.with && step.with.path) || "");
        if (/^actions\/cache(\/restore|\/save)?@/.test(uses) && cachePath.includes("ms-playwright")) {
          found.push({ file: path.basename(file), jobName, steps, index, step });
        }
      });
    }
  }
  return found;
}

test("at least one workflow caches Playwright browsers (the lint has targets)", () => {
  expect(browserCacheSteps().length).toBeGreaterThan(0);
});

test("every Playwright browser cache key names the runner image", () => {
  const offenders = [];
  for (const { file, jobName, steps, index, step } of browserCacheSteps()) {
    const key = String(step.with.key || "");
    const earlierImageSteps = new Set(
      steps
        .slice(0, index)
        .filter((s) => s && s.id && /\bImageOS\b/.test(String(s.run || "")))
        .map((s) => s.id),
    );
    const referenced = [...key.matchAll(STEP_OUTPUT_RE)].map((m) => m[1]);
    if (!referenced.some((id) => earlierImageSteps.has(id))) {
      offenders.push(`${file} job ${jobName} step "${step.name || index}": key ${key}`);
    }
  }
  expect(offenders, "browser cache keys without the runner image's OS release").toEqual([]);
});
