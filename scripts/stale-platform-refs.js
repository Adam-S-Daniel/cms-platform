#!/usr/bin/env node
"use strict";
/*
 * stale-platform-refs — the ONE implementation of this repo's general
 * "no stale platform version token" rule.
 *
 * ── WHY IT IS ITS OWN FILE ────────────────────────────────────────────────
 * This rule used to live only as an inline `awk` program inside
 * scripts/verify-consumer-pins.sh — the script AGENTS.md names as the
 * definition of done for a consumer pin bump. It is the most GENERAL pin
 * detector in the repo: it does not care which YAML key a version sits under,
 * so it sees the shapes a parse-only walk structurally cannot — a trailing
 * `# vX.Y.Z (date)` comment on a `uses:` or a `platform_ref:` line, a version
 * inside a `run:` string, a Gemfile `tag:`.
 *
 * The scaffold-template guard (e2e/examples-site-pins-current.test.js) needs
 * exactly this rule, applied to examples/site BEFORE a site is scaffolded out
 * of it. Two earlier attempts re-implemented a parse-only approximation of it
 * and both shipped a SPLIT: the guard was green on a drifted template while the
 * scaffolded site's own verify-consumer-pins.sh exited 1 — i.e. the platform PR
 * that introduced the drift passed and the new site was born broken. Each round
 * closed one more spelling; the enumeration kept losing.
 *
 * So the rule now has ONE home and TWO callers — the shell verifier (via this
 * file's CLI) and the template guard (via `require`). They cannot disagree,
 * because there is nothing left to disagree with.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * On any line that MENTIONS the platform — the repo slug, `platform_ref`, the
 * theme gem name, or a bare Gemfile-style `tag:` — every `vX.Y.Z` token must
 * equal the canonical ref. Lines that mention none of those are ignored, which
 * is what keeps an unrelated version string from tripping it: a third-party
 * action's `# v6.0.2 (…)` pin comment, or prose like "the real set as of
 * v0.1.79" in a workflow header, names no platform surface and is skipped.
 * (That benign class is real — it is the 35-vs-34 count difference the v0.1.76
 * delegation incident shrugged off instead of establishing.)
 *
 * ── CLI ───────────────────────────────────────────────────────────────────
 *   node scripts/stale-platform-refs.js --ref vX.Y.Z [--slug OWNER/REPO]
 *                                       [--] FILE...
 * Prints one indented `  FILE:LINE: TOKEN (expected REF)` line per finding —
 * byte-for-byte the format the awk emitted, so the verifier's report is
 * unchanged. Exit codes are three-valued ON PURPOSE, because the caller has to
 * tell "ran, found drift" apart from "could not run":
 *   0  ran, no stale token
 *   1  ran, stale token(s) found (each printed)
 *   2  could not run (bad usage, unreadable file) — never a silent pass
 */

const fs = require("node:fs");

const PLATFORM_SLUG = "Adam-S-Daniel/cms-platform";
// Unanchored and non-overlapping: leftmost-longest, resuming after each match,
// so `v0.1.844` yields one token. (The shape used to be justified by parity with
// an awk implementation; that awk is gone, and the trailing group below has no
// awk counterpart to keep in step.)
//
// The optional suffix is what makes a PRERELEASE one token instead of two.
// Without it `v0.1.89-rc.1` tokenizes as `v0.1.89`, which then does not equal
// the canonical `v0.1.89-rc.1` — so a consumer correctly pinned to an RC had
// EVERY pin reported stale (55 of them, measured on jodidaniel.com), and
// verify-consumer-pins.sh, the gate that defines a bump as done, could never
// pass on one. Same prefix-normalization bug as the parity checker's, in a
// second copy. A version's suffix is part of the version.
const VERSION_TOKEN = /v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

// The awk's mentions_platform(). Kept in this order and this shape so the two
// read as the same predicate. `tag:` is deliberately position-anchored (a
// Gemfile/Gemfile.lock git-source tag) rather than a substring test.
function mentionsPlatform(line, slug) {
  if (line.includes(slug)) return true;
  if (line.includes("platform_ref")) return true;
  if (line.includes("cms-platform-theme")) return true;
  if (/^[ \t\v\f\r]*tag:[ \t\v\f\r]/.test(line)) return true;
  return false;
}

/**
 * Every stale platform version token in `text`.
 * @param {string} text file contents
 * @param {{ref: string, slug?: string, file?: string}} opts
 * @returns {{file: string, line: number, found: string, expected: string}[]}
 */
function scanStalePlatformRefs(text, opts) {
  const ref = opts.ref;
  const slug = opts.slug || PLATFORM_SLUG;
  const file = opts.file === undefined ? "<text>" : opts.file;
  const out = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!mentionsPlatform(line, slug)) continue;
    for (const token of line.match(VERSION_TOKEN) || []) {
      if (token !== ref) out.push({ file, line: i + 1, found: token, expected: ref });
    }
  }
  return out;
}

// The awk's printf, verbatim — two leading spaces, so the verifier's report
// keeps its existing shape.
function formatFinding(f) {
  return `  ${f.file}:${f.line}: ${f.found} (expected ${f.expected})`;
}

function usage(msg) {
  process.stderr.write(`stale-platform-refs: ${msg}\n`);
  process.stderr.write(
    "usage: node scripts/stale-platform-refs.js --ref vX.Y.Z [--slug OWNER/REPO] [--] FILE...\n",
  );
  return 2;
}

function cli(argv) {
  let ref = "";
  let slug = PLATFORM_SLUG;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      files.push(...argv.slice(i + 1));
      break;
    } else if (a === "--ref") ref = argv[++i] || "";
    else if (a === "--slug") slug = argv[++i] || slug;
    else if (a.startsWith("--")) return usage(`unknown flag '${a}'`);
    else files.push(a);
  }
  if (!ref) return usage("--ref <canonical version> is required");
  if (files.length === 0) return usage("no files to scan");

  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      // Unreadable input is exit 2, never "clean": a scan that did not happen
      // must not read as a pass.
      return usage(`cannot read ${file}: ${e.message}`);
    }
    findings.push(...scanStalePlatformRefs(text, { ref, slug, file }));
  }
  if (findings.length === 0) return 0;
  process.stdout.write(`${findings.map(formatFinding).join("\n")}\n`);
  return 1;
}

if (require.main === module) process.exit(cli(process.argv.slice(2)));

module.exports = {
  PLATFORM_SLUG,
  VERSION_TOKEN,
  mentionsPlatform,
  scanStalePlatformRefs,
  formatFinding,
  cli,
};
