#!/usr/bin/env node
"use strict";
/*
 * preflight-oauth.js — org-owner go-live preflight for the OAuth-App-restriction
 * failure mode (issue #26).
 *
 *   node scripts/preflight-oauth.js --repo OWNER/REPO
 *
 * THE PROBLEM (jodidaniel/jodidaniel.com#27, resolved): on an ORG-owned
 * consumer, if the org has GitHub's *OAuth App access restrictions* enabled and
 * the CMS OAuth App hasn't been approved for the org, Decap CMS authenticates
 * and reads fine but every SAVE/PUBLISH fails with "OAuth App access
 * restrictions". An org owner approving the app fixes it.
 *
 * WHY THIS IS A CHECKLIST, NOT AN AUTOMATED PROBE (the "if practicable" part):
 *   - There is NO public GitHub API to ask "is OAuth App <client_id> approved
 *     for org <org>?" — org OAuth-App authorizations aren't exposed the way
 *     GitHub App installations are.
 *   - A PAT write to the org repo SUCCEEDS regardless of the OAuth App policy
 *     (the restriction targets the OAuth App's user-token flow, not a PAT), so
 *     a PAT-based "can I write?" probe gives a FALSE GREEN. We deliberately do
 *     not run one.
 * So this script does the practicable thing: detect the owner TYPE (org vs
 * user) and, for an org, print the exact manual approval step + deep-link.
 *
 * Detection uses `gh` (`gh api repos/<owner>/<repo> --jq .owner.type`). It is
 * resilient when gh is unavailable / unauthenticated / the repo is private to
 * the caller: it prints the conservative org-approval guidance anyway (safe by
 * default — the org owner can confirm the type themselves).
 *
 * Pure helpers (parseRepo, messageFor) are exported for unit tests
 * (e2e/preflight-oauth.test.js); the require.main guard keeps the CLI from
 * running on import.
 */
const { spawnSync } = require("node:child_process");

// "OWNER/REPO" → { owner, repo }, or null if malformed. Exactly two non-empty
// segments separated by a single "/".
function parseRepo(slug) {
  if (typeof slug !== "string") return null;
  const parts = slug.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

function orgOAuthPolicyUrl(owner) {
  return "https://github.com/organizations/" + owner + "/settings/oauth_application_policy";
}

// Build the human-facing guidance for a given owner type.
//   ownerType: "Organization" | "User" | null (gh couldn't determine it)
//   repoSlug : "OWNER/REPO"
// Returns a multi-line string ready to print. Falls back to the conservative
// org-approval guidance when the type is unknown.
function messageFor(ownerType, repoSlug) {
  const parsed = parseRepo(repoSlug) || { owner: "<org>", repo: "<repo>" };
  const owner = parsed.owner;

  if (ownerType === "User") {
    return [
      `✓ ${repoSlug} is USER-owned — no org OAuth approval needed.`,
      "",
      "GitHub's OAuth App access restrictions are an ORGANIZATION setting; they",
      "don't apply to a user-owned repo. Editors can log in and save once the",
      "OAuth proxy + GitHub OAuth App credentials are configured. Nothing to do",
      "here for the org-restriction failure mode.",
    ].join("\n");
  }

  // Organization OR unknown → the actionable approval guidance. (Unknown is
  // treated as "could be an org" — the safe default; an org owner can confirm.)
  const lead =
    ownerType === "Organization"
      ? `⚠ ${repoSlug} is ORG-owned — the CMS OAuth App must be approved for the org.`
      : `⚠ Could not confirm the owner type for ${repoSlug} via gh — assuming it MAY be` +
        " an org. If it's an organization, the CMS OAuth App must be approved for it.";

  return [
    lead,
    "",
    "Why: if the organization has OAuth App access restrictions enabled and this",
    "site's CMS OAuth App is NOT approved, editors can LOG IN and browse, but every",
    "SAVE / PUBLISH fails with an \"OAuth App access restrictions\" API error.",
    "(See jodidaniel/jodidaniel.com#27 — resolved by an org owner approving the app.)",
    "",
    "Fix (one-time, an ORG OWNER must do this):",
    `  1. Open: ${orgOAuthPolicyUrl(owner)}`,
    "     (Org Settings → Third-party access → OAuth App policy)",
    "  2. Approve this site's CMS OAuth App (its Client ID is in the site's",
    "     oauth-proxy stack — the GitHub OAuth App backing the Decap login).",
    "",
    "Note: we do NOT run an automated probe. There's no public GitHub API to query",
    "whether an OAuth App is approved for an org, and a PAT write would FALSE-GREEN",
    "(the restriction targets the OAuth App's user-token flow, not a PAT). The only",
    "reliable check is a real editor saving through /admin after approval.",
  ].join("\n");
}

// Best-effort owner-type detection via gh. Returns "Organization" | "User" |
// null (gh missing / unauthenticated / repo not visible / unexpected output).
function detectOwnerType(owner, repo) {
  let res;
  try {
    res = spawnSync("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".owner.type"], {
      encoding: "utf8",
      timeout: 20000,
    });
  } catch {
    return null;
  }
  if (!res || res.status !== 0 || !res.stdout) return null;
  const type = res.stdout.trim();
  if (type === "Organization" || type === "User") return type;
  return null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a.startsWith("--repo=")) out.repo = a.slice("--repo=".length);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const parsed = parseRepo(args.repo);
  if (!parsed) {
    console.error("Usage: node scripts/preflight-oauth.js --repo OWNER/REPO");
    process.exit(2);
  }
  const ownerType = detectOwnerType(parsed.owner, parsed.repo);
  console.log(messageFor(ownerType, `${parsed.owner}/${parsed.repo}`));
  // Exit 0 always: this is advisory go-live guidance, not a pass/fail gate
  // (there's no reliable automated verdict — see the header note).
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseRepo, messageFor, orgOAuthPolicyUrl, detectOwnerType };
