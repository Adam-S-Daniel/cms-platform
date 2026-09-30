#!/usr/bin/env node
/*
 * CI matrix — the single source of truth for how `.github/workflows/e2e-tests.yml`
 * splits the Playwright suite across parallel runners.
 *
 * THE RULE: one CI job per Playwright PROJECT, except that each ADMIN project
 * (the two long poles) is split into ADMIN_SHARDS `--shard` jobs.
 *
 * That rule, not a hand-tuned grouping, is what keeps this maintainable: the
 * matrix is the project list, so adding, renaming, or re-tagging a project
 * needs no bookkeeping here, each job installs only the browser engine its
 * project actually uses, and a red job names the project in the CI log.
 *
 * WHY `--shard` ONLY THE ADMIN PROJECTS, AND ONLY 3 WAYS
 * `--shard=i/N` balances by test COUNT, and this suite's per-test durations
 * span 5 ms → 90 s, so sharding the WHOLE suite is useless. Measured on
 * adamdaniel.ai (945 test-seconds of work):
 *
 *     --shard=i/4   →   80 s | 105 s |  88 s | 671 s   (71% in one shard)
 *
 * WITHIN one admin project it is a different shape: 64-116 tests of similar
 * weight (the one outlier is webkit's ~90 s link crawl), and those two projects
 * are the gate's whole critical path once the apt tail is cached (both ~150 s of tests on
 * adamdaniel.ai; every public project is ≤ 50 s). Measured 2026-09-30 on both
 * consumers, 5 cache-hit runs each: a 3-way shard of each admin project ran
 * 40-72 s per shard and cut the `e2e / e2e` wall clock from 218 s to 158 s
 * (adamdaniel.ai) and 165 s to 142 s (jodidaniel.com), for ~28% more runner
 * time. A 2-way shard does not help webkit-iphone16: its 90 s
 * cms-link-crawler test lands in shard 1 either way. Public projects stay
 * unsharded — they are not the pole, and a shard re-pays the ~45 s fixed
 * per-job cost. The rule is derived (isAdminProject × ADMIN_SHARDS), never a
 * per-project table. docs/E2E-PARALLELISM.md has the numbers.
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
 *   node ci-matrix.js --matrix               # JSON: the workflow's matrix `include` entries
 *   node ci-matrix.js --engines              # JSON array of the engines the matrix installs
 *                                            #   (warm-e2e-apt-cache.yml's matrix)
 *
 * Exits non-zero on an unknown project, so a typo in the workflow matrix fails
 * before any test runs instead of silently testing nothing.
 */
const config = require("./playwright.config.js");

// Playwright workers per project job. 150% of a 4-vCPU runner = 6; see the
// header for the measurements. Overridable per run via the reusable's `workers`
// input (→ PW_WORKERS), which is the no-release dial-down.
const CI_WORKERS = "150%";

// How many `--shard` jobs each ADMIN project is split into (public projects run
// unsharded). 3, measured — see the header. e2e-tests.yml's static matrix
// `include` must equal matrixEntries() (e2e/ci-matrix.test.js parses it).
const ADMIN_SHARDS = 3;

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

// The e2e-tests.yml matrix, one entry per JOB: `project` (the Playwright
// project), `shard` (the `--shard` value, "" for an unsharded project) and
// `slot` (the job's unique name — artifact names and failure-comment markers
// key on it, since two shards of one project would otherwise clobber each
// other's). Admin projects first, as in projectNames().
function matrixEntries() {
  const byName = new Map(projects().map((p) => [p.name, p]));
  const entries = [];
  for (const name of projectNames()) {
    if (isAdminProject(byName.get(name))) {
      for (let i = 1; i <= ADMIN_SHARDS; i++) {
        entries.push({ project: name, shard: `${i}/${ADMIN_SHARDS}`, slot: `${name}-shard-${i}-of-${ADMIN_SHARDS}` });
      }
    } else {
      entries.push({ project: name, shard: "", slot: name });
    }
  }
  return entries;
}

// Every engine some project job installs, de-duplicated and sorted. The apt
// cache seeder (warm-e2e-apt-cache.yml) warms exactly this set, so a project on
// a new engine is warmed the day it lands instead of when someone remembers.
function engines() {
  return [...new Set(projectNames().map(engineFor))].sort();
}

module.exports = {
  CI_WORKERS,
  ADMIN_SHARDS,
  isAdminProject,
  projectNames,
  matrixEntries,
  engineFor,
  workers,
  engines,
};

if (require.main === module) {
  const [flag, name] = process.argv.slice(2);
  const actions = {
    "--list": () => projectNames().join("\n"),
    "--engine": () => engineFor(name),
    "--workers": () => workers(),
    "--matrix": () => JSON.stringify(matrixEntries()),
    "--engines": () => JSON.stringify(engines()),
  };
  try {
    if (!actions[flag]) {
      throw new Error("usage: ci-matrix.js --list | --engine <project> | --workers | --matrix | --engines");
    }
    console.log(actions[flag]());
  } catch (e) {
    console.error(`ci-matrix.js: ${e.message}`);
    process.exit(1);
  }
}
