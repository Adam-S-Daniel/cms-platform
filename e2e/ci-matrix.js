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
 * WHY THE WORKER COUNTS DIFFER PER PROJECT (measured, docs/E2E-PARALLELISM.md)
 * A 4-vCPU GitHub runner saturates at ~2 browser workers, because a Playwright
 * browser test burns more than one core (renderer + browser + raster threads).
 * Pushing the public-page projects to 4 workers made the SAME tests report 2.1x
 * longer and the wall clock slightly WORSE (263 s → 284 s). The admin projects
 * behave the opposite way — Decap specs spend their time waiting on the editor
 * to mount and on API polls, not on CPU — so 4 workers cut them 161 s → 128 s
 * and 166 s → 132 s. Hence: admin projects go wide, public projects keep
 * Playwright's own default (50% of cores).
 *
 * CLI (used by the workflow)
 *   node ci-matrix.js --list                 # one project name per line
 *   node ci-matrix.js --engine   <project>   # chromium | firefox | webkit
 *   node ci-matrix.js --workers  <project>   # "100%" | "" (= Playwright default)
 *
 * Exits non-zero on an unknown project, so a typo in the workflow matrix fails
 * before any test runs instead of silently testing nothing.
 */
const config = require("./playwright.config.js");

// Admin projects are wait-bound (Decap boot, API polls) rather than CPU-bound,
// so they are the ones that benefit from one worker per vCPU.
const ADMIN_WORKERS = "100%";

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

// "" means "leave it to Playwright" (50% of cores), which is what the
// CPU-bound public-page projects measured fastest at.
function workersFor(name) {
  return isAdminProject(find(name)) ? ADMIN_WORKERS : "";
}

module.exports = { ADMIN_WORKERS, isAdminProject, projectNames, engineFor, workersFor };

if (require.main === module) {
  const [flag, name] = process.argv.slice(2);
  const actions = {
    "--list": () => projectNames().join("\n"),
    "--engine": () => engineFor(name),
    "--workers": () => workersFor(name),
  };
  try {
    if (!actions[flag]) {
      throw new Error("usage: ci-matrix.js --list | --engine <project> | --workers <project>");
    }
    console.log(actions[flag]());
  } catch (e) {
    console.error(`ci-matrix.js: ${e.message}`);
    process.exit(1);
  }
}
