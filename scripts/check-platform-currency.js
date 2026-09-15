#!/usr/bin/env node
"use strict";
/*
 * check-platform-currency — go red when the platform release a caller is
 * pinned to has been superseded for longer than a grace window.
 *
 * ── THE DEFECT (#424) ────────────────────────────────────────────────────
 * scheduled-run-health.yml's self-resolution fix (see that workflow's header)
 * stops a HALF-bumped caller from silently running a new reusable against an
 * old script — but it does nothing for a caller that simply never bumps its
 * `uses:@` ref at all. That caller is internally consistent (nothing to
 * disagree with) and reports green forever, on an ever-older audit script,
 * because nothing was ever asking "is this still current?" GHA-bench sat on
 * cms-platform v0.1.88 while the platform moved to v0.1.106 with no lint or
 * alert noticing — the exact caller-goes-quiet failure mode this closes.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * Given the platform release a caller is pinned to (`--ref`), list the
 * platform's real GitHub releases and find the lowest one that supersedes the
 * pin ("firstNewer"). If none exists, the caller is current. If one exists,
 * measure how long it has been out — from ITS OWN publish date, not from the
 * latest release's — and go red only once that age exceeds `--behind-days`
 * (default 21 = the fleet's 7-day Dependabot cooldown + up to 7 days until
 * the next weekly Dependabot run notices a new release + 7 days to actually
 * merge it, per AGENTS.md). A caller genuinely keeping up never trips this; a
 * caller that has stopped moving does, in its OWN scheduled audit.
 *
 * Draft releases, GitHub-flagged prereleases, and tags with a semver
 * prerelease suffix (`-rc.1`) are never candidates — an RC existing is not a
 * reason to flag a caller pinned to the release before it.
 *
 * A `--ref` that is not itself a `vX.Y.Z` release tag (a branch, a bare
 * commit sha, a `refs/pull/N/merge`) has no currency question to answer —
 * this repo's own self-caller (self-scheduled-run-health.yml) calls the
 * reusable at `./` / `main`, and the script must SKIP it, not fail it.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────
 *   node scripts/check-platform-currency.js \
 *     --platform-repo OWNER/REPO --ref REF \
 *     [--behind-days N] [--releases-file PATH] [--now ISO8601]
 *
 *   --platform-repo   required; OWNER/REPO of the platform whose releases are
 *                     being checked.
 *   --ref             required, non-empty; the ref the CALLER is pinned to
 *                     (a release tag, a branch, or a sha).
 *   --behind-days     optional, default 21, must match ^\d+$.
 *   --releases-file   optional; a JSON array of GitHub release objects, used
 *                     INSTEAD of calling `gh`. Exists so a caller with the
 *                     releases already in hand (or a test) never needs `gh`
 *                     or the network.
 *   --now             optional ISO 8601 timestamp; defaults to the current
 *                     time. Exists so a caller (and every test in this repo)
 *                     is deterministic rather than wall-clock-dependent.
 *
 * ── EXIT CODES ───────────────────────────────────────────────────────────
 *   0  ran: the ref is not a release tag (skipped), the pin is current, or
 *      the pin is behind but still inside the grace window
 *   1  ran: the pin is BEHIND — past the grace window
 *   2  could not run — bad usage, an unreadable/unparseable --releases-file,
 *      a releases listing that could not be fetched, or a fetch that
 *      returned zero releases this script could actually validate. A check
 *      that saw nothing cannot have assessed anything, so this is never
 *      folded into exit 0.
 *
 * ── main(argv, deps) ────────────────────────────────────────────────────
 * `deps` lets a caller (a test, or a future in-process caller) replace every
 * side-effecting seam without touching global state: `fetchReleases(repo)`
 * (defaults to a real `gh api` call), `now` (ms, defaults to `Date.now()`),
 * `env` (defaults to `process.env`), and `out`/`err` writer functions
 * (default to `process.stdout`/`process.stderr`). No test in this repo's
 * suite may call the real `fetchReleases` — every test injects one, so
 * nothing here ever touches the network or the wall clock.
 */

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

// OWNER/REPO — the same slug shape check-pin-agreement.js and this file's
// neighbours expect, checked BEFORE ever invoking `gh` (a malformed slug is a
// usage error, not something worth a subprocess round-trip to discover).
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// vMAJOR.MINOR.PATCH with an optional dot-separated SemVer prerelease suffix
// (`-rc.1`, `-beta.2`). A tag that doesn't match this is not a release this
// script can reason about at all — see the not-a-release-tag status below.
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parse a tag into { tag, major, minor, patch, prerelease }, or null when it
 * is not `vX.Y.Z` (optionally `-identifiers`) shaped. `prerelease` is an
 * array of dot-separated identifiers (`[]` for a plain release).
 * @param {unknown} tag
 * @returns {{tag: string, major: number, minor: number, patch: number, prerelease: string[]} | null}
 */
function parseVersion(tag) {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  const m = RELEASE_TAG.exec(trimmed);
  if (!m) return null;
  return {
    tag: trimmed,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

// One SemVer prerelease identifier pair: numeric identifiers compare
// numerically (so "10" > "9" — a plain string compare would get this
// backwards), a numeric identifier is always lower than a non-numeric one,
// and two non-numeric identifiers compare lexically.
function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const an = Number(a);
    const bn = Number(b);
    return an === bn ? 0 : an < bn ? -1 : 1;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1; // numeric < non-numeric
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * SemVer precedence between two parseVersion() results: -1, 0, or 1. A
 * release outranks every prerelease of the SAME major.minor.patch; between
 * two prereleases, identifiers compare left-to-right by compareIdentifier(),
 * and if one identifier list is a strict prefix of the other, the SHORTER
 * list is lower precedence (real SemVer's own rule, not this file's
 * invention).
 * @param {{major:number,minor:number,patch:number,prerelease:string[]}} a
 * @param {{major:number,minor:number,patch:number,prerelease:string[]}} b
 */
function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // a is a release, b is a prerelease of it
  if (bp.length === 0) return -1; // a is a prerelease of release b

  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const c = compareIdentifier(ap[i], bp[i]);
    if (c !== 0) return c;
  }
  if (ap.length !== bp.length) return ap.length < bp.length ? -1 : 1;
  return 0;
}

/**
 * Keep only the release objects this script trusts enough to reason about —
 * the TRUST BOUNDARY between whatever `fetchReleases`/`--releases-file`
 * handed back (an external API response, or a file this script did not
 * write) and everything downstream. A malformed entry is dropped, never
 * thrown on: one bad object in a page of a hundred real releases should not
 * sink the whole check.
 * @param {unknown} rawReleases
 * @returns {object[]}
 */
function validateReleases(rawReleases) {
  const out = [];
  for (const r of Array.isArray(rawReleases) ? rawReleases : []) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.tag_name !== "string" || r.tag_name.trim() === "") continue;
    if (typeof r.published_at !== "string" || Number.isNaN(Date.parse(r.published_at))) continue;
    if (typeof r.draft !== "boolean") continue;
    if (typeof r.prerelease !== "boolean") continue;
    out.push(r);
  }
  return out;
}

/**
 * The currency assessment, pure. `releases` should already be
 * validateReleases()-clean; this does not re-validate them.
 * @param {{ref: string, releases: object[], behindDays: number, nowMs: number}} args
 * @returns {{status: "not-a-release-tag"|"current"|"within-window"|"behind",
 *            pinned: object|null, latest: object|null, newer: object[],
 *            firstNewer: object|null, daysSinceFirstNewer: number|null}}
 */
function assessCurrency({ ref, releases, behindDays, nowMs }) {
  const pinned = parseVersion(ref);
  if (!pinned) {
    return {
      status: "not-a-release-tag",
      pinned: null,
      latest: null,
      newer: [],
      firstNewer: null,
      daysSinceFirstNewer: null,
    };
  }

  // Candidates: not a draft, not GitHub-flagged prerelease, AND the tag
  // ITSELF carries no SemVer prerelease suffix — three independent signals
  // that must all agree, because a release can carry inconsistent metadata
  // (e.g. `prerelease: false` on a tag that is still `-rc.1`-suffixed).
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter((r) => r.draft !== true && r.prerelease !== true)
    .map((r) => ({ release: r, version: parseVersion(r.tag_name) }))
    .filter((c) => c.version && c.version.prerelease.length === 0);

  let latest = null;
  for (const c of candidates) {
    if (!latest || compareVersions(c.version, latest.version) > 0) latest = c;
  }

  // Sorted ASCENDING regardless of the order releases arrived in — the API
  // (and a hand-built --releases-file) may list newest-first, and firstNewer
  // must be the LOWEST newer release, not whichever happened to sort first.
  const newer = candidates
    .filter((c) => compareVersions(c.version, pinned) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));

  if (newer.length === 0) {
    return {
      status: "current",
      pinned,
      latest: latest ? latest.release : null,
      newer: [],
      firstNewer: null,
      daysSinceFirstNewer: null,
    };
  }

  const firstNewer = newer[0];
  const daysSinceFirstNewer = (nowMs - Date.parse(firstNewer.release.published_at)) / 86400000;
  // Strictly greater: a pin exactly AT the window boundary is not yet behind.
  const status = daysSinceFirstNewer > behindDays ? "behind" : "within-window";

  return {
    status,
    pinned,
    latest: latest ? latest.release : null,
    newer: newer.map((c) => c.release),
    firstNewer: firstNewer.release,
    daysSinceFirstNewer,
  };
}

// The real release listing, via `gh api`. `--paginate --slurp` wraps every
// page gh walks into an outer array (one element per page — each element
// itself the page's own release-object array, since GitHub's
// `/releases` endpoint returns an array), so the result is flattened one
// level to a single flat list regardless of how many pages existed.
function defaultFetchReleases(repo) {
  const raw = execFileSync(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const pages = JSON.parse(raw);
  return [].concat(...(Array.isArray(pages) ? pages : []));
}

function argFrom(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
}

/**
 * @param {string[]} argv
 * @param {{fetchReleases?: (repo: string) => object[], now?: number,
 *           env?: object, out?: (s: string) => void, err?: (s: string) => void}} deps
 * @returns {number} exit code
 */
function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const out = deps.out || ((s) => process.stdout.write(s));
  const err = deps.err || ((s) => process.stderr.write(s));
  const fetchReleases = deps.fetchReleases || defaultFetchReleases;

  // A single choke point for every "could not run" exit — never 0, never
  // folded into the behind/current report, always a ONE-LINE message.
  function cannotRun(msg) {
    err(`check-platform-currency: ${msg}\n`);
    return 2;
  }

  const platformRepo = argFrom(argv, "platform-repo");
  const ref = argFrom(argv, "ref");
  const behindDaysRaw = argFrom(argv, "behind-days");
  const releasesFile = argFrom(argv, "releases-file");
  const nowArg = argFrom(argv, "now");

  if (!platformRepo) return cannotRun("--platform-repo OWNER/REPO is required");
  if (!REPO_SLUG.test(platformRepo)) {
    return cannotRun(`--platform-repo "${platformRepo}" must look like OWNER/REPO`);
  }
  if (!ref) return cannotRun("--ref REF is required and must be non-empty");

  let behindDays = 21;
  if (behindDaysRaw !== undefined) {
    if (!/^\d+$/.test(behindDaysRaw)) {
      return cannotRun(`--behind-days "${behindDaysRaw}" must match ^\\d+$`);
    }
    behindDays = Number(behindDaysRaw);
  }

  let nowMs;
  if (nowArg !== undefined) {
    const parsed = Date.parse(nowArg);
    if (Number.isNaN(parsed)) {
      return cannotRun(`--now "${nowArg}" is not a parseable ISO 8601 timestamp`);
    }
    nowMs = parsed;
  } else if (typeof deps.now === "number") {
    nowMs = deps.now;
  } else {
    nowMs = Date.now();
  }

  // Cheap pre-check, BEFORE fetching anything: a ref that isn't a release tag
  // has no currency question to answer, so a branch/sha caller (this repo's
  // own self-caller, pinned at "main") never needs a releases listing — or a
  // `gh` invocation — at all.
  if (!parseVersion(ref)) {
    out(
      `check-platform-currency: "${ref}" is not a vX.Y.Z release tag — the currency check does ` +
        `not apply here (a branch or commit-sha caller, e.g. this repo's own self-caller pinned ` +
        `at "main", is skipped, not failed).\n`,
    );
    return 0;
  }

  let rawReleases;
  if (releasesFile !== undefined) {
    let text;
    try {
      text = fs.readFileSync(releasesFile, "utf8");
    } catch (e) {
      return cannotRun(`cannot read --releases-file "${releasesFile}": ${e.code || "read failed"}`);
    }
    try {
      rawReleases = JSON.parse(text);
    } catch {
      return cannotRun(`--releases-file "${releasesFile}" is not valid JSON`);
    }
    if (!Array.isArray(rawReleases)) {
      return cannotRun(`--releases-file "${releasesFile}" must contain a JSON array of release objects`);
    }
  } else {
    try {
      rawReleases = fetchReleases(platformRepo);
    } catch (e) {
      // NEVER forward e.message/e.stderr — either can quote a raw API
      // response body (AGENTS.md: "sanitize error output"). `.status` is the
      // exit code `execFileSync` attaches when the child process actually
      // ran, which is safe to print because it is just a small integer, not
      // arbitrary text — including from an injected fetchReleases (a test
      // double) that throws something else entirely, since it carries no
      // `.status` either and falls back to "unknown" the same way a missing
      // `gh` binary (ENOENT, also no `.status`) would.
      const status = e && typeof e.status === "number" ? e.status : "unknown";
      err(`check-platform-currency: could not list releases for ${platformRepo}: gh exited ${status}\n`);
      return 2;
    }
  }

  const releases = validateReleases(rawReleases);
  if (releases.length === 0) {
    return cannotRun(
      `no valid releases found for ${platformRepo} (received ${
        Array.isArray(rawReleases) ? rawReleases.length : 0
      } entr${Array.isArray(rawReleases) && rawReleases.length === 1 ? "y" : "ies"}) — a check ` +
        "that saw nothing cannot have assessed anything",
    );
  }

  const assessment = assessCurrency({ ref, releases, behindDays, nowMs });
  const callerName = env.GITHUB_REPOSITORY ? String(env.GITHUB_REPOSITORY) : "this caller";

  if (assessment.status === "current") {
    out(
      `check-platform-currency: OK — ${callerName} is pinned to ${ref}, the latest release of ` +
        `${platformRepo}.\n`,
    );
    return 0;
  }

  const latestTag = assessment.latest ? assessment.latest.tag_name : "(none found)";
  const firstNewerTag = assessment.firstNewer.tag_name;
  const daysFloor = Math.floor(assessment.daysSinceFirstNewer);

  if (assessment.status === "within-window") {
    out(
      `check-platform-currency: OK — ${callerName} pins ${platformRepo} at ${ref}; ` +
        `${assessment.newer.length} release(s) newer (latest ${latestTag}); first newer release ` +
        `${firstNewerTag} is ${daysFloor} day(s) old, within the ${behindDays}-day window.\n`,
    );
    return 0;
  }

  // status === "behind"
  const behindText =
    `${callerName} pins ${platformRepo} at ${ref}; ${assessment.newer.length} release(s) newer ` +
    `(latest ${latestTag}); first newer release ${firstNewerTag} has been available for ` +
    `${daysFloor} day(s), past the ${behindDays}-day window. Move the caller's uses:@ ref to a ` +
    "current release.";
  out(`check-platform-currency: BEHIND — ${behindText}\n`);
  if (env.GITHUB_ACTIONS === "true") {
    out(`::error title=cms-platform caller behind::${behindText}\n`);
  }
  return 1;
}

module.exports = {
  parseVersion,
  compareVersions,
  validateReleases,
  assessCurrency,
  defaultFetchReleases,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
