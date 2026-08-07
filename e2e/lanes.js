#!/usr/bin/env node
/*
 * CI lane split — the single source of truth for how the Playwright suite is
 * divided across PARALLEL CI jobs (`.github/workflows/e2e-tests.yml`).
 *
 * WHY LANES INSTEAD OF `--shard`
 * Playwright's `--shard=i/N` balances shards by TEST COUNT. This suite's
 * durations are extremely skewed — the two admin projects hold ~65% of the
 * wall-clock in ~20% of the tests (a single WebKit admin link-crawl is ~49 s;
 * a pure-fs lint is ~5 ms) — so count-based sharding piles the slow work into
 * one shard. Measured on adamdaniel.ai (945 test-seconds total, per-test
 * durations from a real run):
 *
 *     --shard=i/4  →  80 s | 105 s | 88 s | 671 s   (shard 4 = 71% of the work)
 *     lanes        → 307 s | 308 s | 330 s          (±4% of each other)
 *
 * Splitting by PROJECT is balanced by construction here, needs no duration
 * bookkeeping, and names itself in the CI log ("which lane went red?").
 *
 * THE SPLIT (derived, never hand-listed)
 *   - each ADMIN project gets its own lane. They are the two heaviest
 *     projects and a project cannot be split further by `--project`.
 *   - every remaining (public-page) project shares the `public` lane; the 8
 *     of them together cost about as much as one admin project.
 *
 * "Admin project" is read off playwright.config.js itself (a project whose
 * `grep` selects the `@admin-*` tags), so adding, renaming, or re-tagging a
 * project cannot silently drift the lane map. `e2e/lanes.test.js` locks the
 * derived lane names against the workflow's `matrix.lane` list, so a project
 * change that alters the lane SET fails the platform's own CI instead of
 * silently dropping a project from the run.
 *
 * CLI (used by .github/workflows/e2e-tests.yml)
 *   node lanes.js --list                # one lane name per line
 *   node lanes.js --projects <lane>     # one `--project=<name>` flag per line
 *
 * Exits non-zero on an unknown lane — a typo in the workflow matrix fails
 * loudly rather than silently running the whole suite (or nothing).
 */
const config = require("./playwright.config.js");

// The lane that holds every non-admin (public-page) project.
const PUBLIC_LANE = "public";

// A project is an ADMIN project iff its `grep` filter selects the @admin-*
// tags (playwright.config.js's ADMIN_TAGS_ALL / ADMIN_TAGS_READ). Public-lane
// projects carry `grepInvert` on those same tags instead, so keying on `grep`
// alone is unambiguous.
function isAdminProject(project) {
  return project.grep != null && /@admin-/.test(String(project.grep));
}

// Ordered map of lane name → project names. Admin lanes come first: they are
// the long poles, so a `fail-fast: false` matrix starts them without waiting
// on the runner queue behind the cheaper public lane.
function lanes() {
  const projects = config.projects || [];
  const map = new Map();
  for (const p of projects.filter(isAdminProject)) map.set(p.name, [p.name]);
  const pub = projects.filter((p) => !isAdminProject(p)).map((p) => p.name);
  if (pub.length) map.set(PUBLIC_LANE, pub);
  return map;
}

function laneNames() {
  return [...lanes().keys()];
}

// `--project=<name>` flags for one lane, one per line (the workflow reads them
// with `mapfile`, so no shell word-splitting is involved).
function projectFlags(lane) {
  const map = lanes();
  if (!map.has(lane)) {
    throw new Error(
      `unknown e2e lane ${JSON.stringify(lane)} — known lanes: ${laneNames().join(", ")}. ` +
        `The workflow's matrix.lane list and e2e/lanes.js must agree (see e2e/lanes.test.js).`,
    );
  }
  return map.get(lane).map((name) => `--project=${name}`);
}

module.exports = { PUBLIC_LANE, isAdminProject, lanes, laneNames, projectFlags };

if (require.main === module) {
  const [flag, lane] = process.argv.slice(2);
  try {
    if (flag === "--list") {
      console.log(laneNames().join("\n"));
    } else if (flag === "--projects") {
      console.log(projectFlags(lane).join("\n"));
    } else {
      throw new Error("usage: lanes.js --list | --projects <lane>");
    }
  } catch (e) {
    console.error(`lanes.js: ${e.message}`);
    process.exit(1);
  }
}
