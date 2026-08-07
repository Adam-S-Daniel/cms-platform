#!/usr/bin/env node
/*
 * CI matrix — the single source of truth for how `.github/workflows/e2e-tests.yml`
 * splits the Playwright suite across parallel runners.
 *
 * THE RULE: one CI job per Playwright PROJECT. Nothing more.
 *
 * That rule, not a hand-tuned grouping, is what keeps this maintainable: the
 * matrix is the project list, so adding, renaming, or re-tagging a project
 * needs no bookkeeping here, each job installs only the browser engine its
 * project actually uses, and a red job names the project in the CI log.
 *
 * WHY NOT `--shard`
 * `--shard=i/N` balances by test COUNT, and this suite's per-test durations
 * span 5 ms → 49 s. Measured on adamdaniel.ai (945 test-seconds of work):
 *
 *     --shard=i/4   →   80 s | 105 s |  88 s | 671 s   (71% in one shard)
 *     per project   →  166 s | 161 s |  52 s | 39 s | 35 s | 34 s | 31 s |
 *                       24 s | 22 s | 13 s               (no tuning at all)
 *
 * WHY 150% WORKERS (measured — docs/E2E-PARALLELISM.md)
 * Playwright's default is 50% of cores: 2 workers on a 4-vCPU GitHub runner.
 * That is too few ONCE each job runs a single project, because a project's tests
 * are a mix of browser work and pure-fs lints and much of the browser time is
 * spent WAITING (Decap boot, editor mount, API polls, page loads). Measured per
 * project: `webkit-iphone16` 165 s at 4 workers → 130 s at 6, and the
 * public-page projects were no worse at 6 than at 2. 150% of a 4-vCPU runner is
 * 6 workers, and it scales if the runner ever grows.
 *
 * It is deliberately ONE number for every project rather than a per-project
 * table: uniform measured no worse than tuned, and a table is a thing to
 * maintain. The reusable's `workers` input still overrides it per run.
 *
 * CLI (used by the workflow)
 *   node ci-matrix.js --list                 # one project name per line
 *   node ci-matrix.js --engine   <project>   # chromium | firefox | webkit
 *   node ci-matrix.js --workers              # the CI worker count
 *
 * Exits non-zero on an unknown project, so a typo in the workflow matrix fails
 * before any test runs instead of silently testing nothing.
 */
const config = require("./playwright.config.js");

// Playwright workers per project job. 150% of a 4-vCPU runner = 6; see the
// header for the measurements. Overridable per run via the reusable's `workers`
// input (→ PW_WORKERS), which is the no-release dial-down.
const CI_WORKERS = "150%";

// A project is an ADMIN project iff its `grep` selects the @admin-* tags
// (playwright.config.js's ADMIN_TAGS_ALL / ADMIN_TAGS_READ). Public-page
// projects carry `grepInvert` on those same tags instead, so keying on `grep`
// alone is unambiguous.
function isAdminProject(project) {
  return project.grep != null && /@admin-/.test(String(project.grep));
}

function projects() {
  return config.projects || [];
}

// Admin projects first: they are the long poles, so a `fail-fast: false` matrix
// gets them onto runners before the cheap ones.
function projectNames() {
  const all = projects();
  return [...all.filter(isAdminProject), ...all.filter((p) => !isAdminProject(p))].map(
    (p) => p.name,
  );
}

function find(name) {
  const project = projects().find((p) => p.name === name);
  if (!project) {
    throw new Error(
      `unknown Playwright project ${JSON.stringify(name)} — known projects: ` +
        `${projectNames().join(", ")}. The workflow's matrix and playwright.config.js ` +
        `must agree (see e2e/ci-matrix.test.js).`,
    );
  }
  return project;
}

// The one browser engine this project needs installed. Every project sets
// `use.browserName` explicitly; there is no Playwright default worth guessing.
function engineFor(name) {
  const engine = (find(name).use || {}).browserName;
  if (!engine) {
    throw new Error(
      `project ${JSON.stringify(name)} declares no use.browserName — the CI job ` +
        `cannot tell which browser engine to install.`,
    );
  }
  return engine;
}

function workers() {
  return CI_WORKERS;
}

module.exports = { CI_WORKERS, isAdminProject, projectNames, engineFor, workers };

if (require.main === module) {
  const [flag, name] = process.argv.slice(2);
  const actions = {
    "--list": () => projectNames().join("\n"),
    "--engine": () => engineFor(name),
    "--workers": () => workers(),
  };
  try {
    if (!actions[flag]) {
      throw new Error("usage: ci-matrix.js --list | --engine <project> | --workers");
    }
    console.log(actions[flag]());
  } catch (e) {
    console.error(`ci-matrix.js: ${e.message}`);
    process.exit(1);
  }
}
