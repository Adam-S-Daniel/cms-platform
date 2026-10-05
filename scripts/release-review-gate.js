#!/usr/bin/env node
"use strict";
// The enforced independent review of a release-bearing PR (cms-platform#526,
// acceptance criterion 3; owner decision 2026-10-05, "option 2").
//
// A release-bearing PR merges only when its body carries the line
//
//     Independent review: CLEAN at <sha>
//
// and <sha> is the PR's CURRENT head commit, all 40 hex characters. The line
// is written by a reviewer independent of the change's author, after reviewing
// that exact revision. No owner approval and no bot identity are involved: the
// REQUIRED `release-review-gate` check (.github/workflows/
// self-release-review-gate.yml) is the enforcement. What this check cannot
// verify is WHO wrote the line; independence is the reviewer's attestation.
//
// FULL SHA ONLY. A 7+ character prefix is rejected, not accepted: a prefix is
// what a quick reviewer copies from a UI that abbreviates, which is exactly the
// moment a stale review slips through, and `gh pr view <n> --json headRefOid`
// prints the full head in one command. A stamp naming a shorter hex string is
// reported as such, so the fix is obvious.
//
// RELEASE-BEARING means the PR carries a release: it changes the `version` of
// `plugin.json` or `.claude-plugin/plugin.json` relative to the merge base
// (release.yml refuses a STABLE tag that disagrees with the manifests, so every
// stable release needs such a PR), or its head branch is `release/*` (the
// release PR convention, e.g. release/v0.1.133). A PRERELEASE is cut from main
// as-is with no PR (release.yml skips the manifest guard for it), so this check
// does not gate it; that belongs to #526 criterion 4's release gate, which does
// not exist yet. Comparing
// against the MERGE BASE, not the base tip, keeps a stale feature branch that
// predates a release from reading as one.
//
// What counts as a stamp is the rendered body, so a stamp the reader cannot
// see as a statement does not count: lines inside a fenced code block, inside
// an HTML comment, in a block quote, or indented as code are ignored. The line
// must otherwise be exactly the stamp (surrounding whitespace aside).
//
// Usage (the workflow's only call):
//   node scripts/release-review-gate.js --event <event.json> \
//     --base-dir <merge-base manifests> --head-dir <head manifests>
// Each dir holds `plugin.json` and `.claude-plugin/plugin.json` as fetched at
// that revision. Exit 0 = pass (or not release-bearing), 1 = fail, 2 = usage.
// PUBLIC LOG: prints only commit SHAs, versions and the branch name, never the
// PR body.

const fs = require("node:fs");
const path = require("node:path");

const MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json"];
const STAMP_RE = /^Independent review: CLEAN at ([0-9A-Fa-f]+)$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// Every stamp the rendered body states, in order: [{ sha, line }] with `sha`
// lower-cased and `line` 1-based.
function findStamps(body) {
  if (typeof body !== "string") return [];
  const out = [];
  let fence = null; // the opening fence's character run while inside one
  let inComment = false;
  body.split(/\r?\n/).forEach((raw, i) => {
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      return;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return;
    }
    if (/^ {0,3}<!--/.test(raw)) {
      if (!raw.slice(raw.indexOf("<!--") + 4).includes("-->")) inComment = true;
      return;
    }
    if (/^ {4,}|^\t/.test(raw)) return; // indented code block
    const line = raw.trim();
    if (line.startsWith(">")) return; // block quote
    const m = STAMP_RE.exec(line);
    if (m) out.push({ sha: m[1].toLowerCase(), line: i + 1 });
  });
  return out;
}

// { ok, reason } for a release-bearing PR's body against its head.
function checkStamp(body, headSha) {
  const head = String(headSha || "").toLowerCase();
  if (!FULL_SHA_RE.test(head)) {
    return { ok: false, reason: `the PR head "${headSha}" is not a 40-character commit SHA` };
  }
  const stamps = findStamps(body);
  if (stamps.some((s) => s.sha === head)) {
    return { ok: true, reason: `Independent review: CLEAN at ${head} found` };
  }
  if (stamps.length === 0) {
    return {
      ok: false,
      reason:
        `no "Independent review: CLEAN at <sha>" line in the PR body; an independent ` +
        `reviewer adds "Independent review: CLEAN at ${head}" after reviewing this head`,
    };
  }
  const described = stamps
    .map((s) =>
      FULL_SHA_RE.test(s.sha)
        ? `${s.sha} (line ${s.line}, a stale head)`
        : `${s.sha} (line ${s.line}, not a full 40-character SHA)`,
    )
    .join(", ");
  return {
    ok: false,
    reason:
      `the body's review stamp names ${described}, not the current head ${head}; the ` +
      `review must be repeated on the current head and the stamp updated`,
  };
}

function versionOf(dir, rel) {
  const file = path.join(dir, rel);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!doc || typeof doc.version !== "string" || doc.version === "") {
    throw new Error(`${rel} has no string "version"`);
  }
  return doc.version;
}

// { releaseBearing, reasons } from the head branch and the two manifests'
// versions at the merge base and the head: [{ file, base, head }].
function classify({ headRef, versions }) {
  const reasons = [];
  if (typeof headRef === "string" && headRef.startsWith("release/")) {
    reasons.push(`head branch ${headRef} is a release branch`);
  }
  for (const v of versions) {
    if (v.base !== v.head) reasons.push(`${v.file} version ${v.base} -> ${v.head}`);
  }
  return { releaseBearing: reasons.length > 0, reasons };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!["--event", "--base-dir", "--head-dir"].includes(key) || argv[i + 1] == null) {
      return null;
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args.event && args["base-dir"] && args["head-dir"] ? args : null;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error("usage: release-review-gate.js --event <file> --base-dir <dir> --head-dir <dir>");
    return 2;
  }
  let event;
  let versions;
  try {
    event = JSON.parse(fs.readFileSync(args.event, "utf8"));
    versions = MANIFESTS.map((file) => ({
      file,
      base: versionOf(args["base-dir"], file),
      head: versionOf(args["head-dir"], file),
    }));
  } catch (err) {
    console.log(`::error::release-review-gate: cannot read its inputs (${err.message})`);
    return 1;
  }
  const pr = event && event.pull_request;
  if (!pr || !pr.head) {
    console.log("::error::release-review-gate: the event carries no pull_request");
    return 1;
  }
  const { releaseBearing, reasons } = classify({ headRef: pr.head.ref, versions });
  if (!releaseBearing) {
    console.log(
      `::notice::release-review-gate: not release-bearing (no manifest version change, ` +
        `not a release/* branch); nothing to enforce`,
    );
    return 0;
  }
  console.log(`release-bearing: ${reasons.join("; ")}`);
  const verdict = checkStamp(pr.body, pr.head.sha);
  if (verdict.ok) {
    console.log(`::notice::release-review-gate: ${verdict.reason}`);
    return 0;
  }
  console.log(`::error::release-review-gate: ${verdict.reason}`);
  return 1;
}

module.exports = { findStamps, checkStamp, classify, versionOf, parseArgs, main, MANIFESTS };

if (require.main === module) process.exit(main(process.argv.slice(2)));
