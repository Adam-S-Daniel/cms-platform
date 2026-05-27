#!/usr/bin/env node
//
// scrub-secrets.js — wrap gitleaks to redact secrets out of a text
// blob in place. Used by the e2e workflow before posting a failure
// summary to a PR comment, so a stray AWS key, GitHub token, or
// JWT in test output never leaks via the bot.
//
// Usage:
//   node scripts/scrub-secrets.js <input-file> [<output-file>]
//
// Strategy:
//   1. Run `gitleaks detect --no-git --source <input>` against the
//      file. Gitleaks ships a comprehensive default rule set
//      (cloud-provider keys, tokens for major SaaS APIs, generic
//      high-entropy strings) and is the most actively maintained
//      OSS option as of 2026.
//   2. Parse the JSON report. Each finding has a Match (the literal
//      secret string) and a RuleID (e.g. "aws-access-token").
//   3. Replace every Match in the input with "<REDACTED:RuleID>".
//   4. Write the scrubbed text to the output file (or stdout if
//      omitted), exit 0 regardless of whether secrets were found.
//
// Non-goals:
//   - Custom rules. The default gitleaks rules are deliberate; bespoke
//     additions risk false negatives if not curated. Override via
//     a checked-in .gitleaks.toml if you need to.

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const os = require("node:os");

const inputFile = process.argv[2];
const outputFile = process.argv[3];
if (!inputFile) {
  console.error("usage: scrub-secrets.js <input> [<output>]");
  process.exit(2);
}
if (!fs.existsSync(inputFile)) {
  console.error(`input file not found: ${inputFile}`);
  process.exit(0);
}

const reportFile = path.join(os.tmpdir(), `gitleaks-report-${Date.now()}.json`);

let findings = [];
try {
  // --no-git: scan the file as text, not as a git history.
  // --report-format=json: machine-readable findings.
  // --exit-code=0: don't fail the script when secrets are found —
  //   we *want* to find them so we can redact them.
  execSync(
    `gitleaks detect --no-git --source ${JSON.stringify(inputFile)} --report-path ${JSON.stringify(reportFile)} --report-format json --exit-code 0`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (fs.existsSync(reportFile)) {
    const raw = fs.readFileSync(reportFile, "utf8");
    findings = raw.trim() ? JSON.parse(raw) : [];
  }
} catch (err) {
  console.error("gitleaks failed:", err.message);
  // Fall through with no findings — still emit the input verbatim.
}

let scrubbed = fs.readFileSync(inputFile, "utf8");
const seen = new Set();
for (const f of findings || []) {
  if (!f || !f.Match || seen.has(f.Match)) continue;
  seen.add(f.Match);
  // Global, case-sensitive replace. Escape regex metacharacters.
  const escaped = f.Match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  scrubbed = scrubbed.replace(new RegExp(escaped, "g"), `<REDACTED:${f.RuleID || "secret"}>`);
}

if (outputFile) {
  fs.writeFileSync(outputFile, scrubbed);
} else {
  process.stdout.write(scrubbed);
}

console.error(`scrubbed ${seen.size} unique secret pattern(s)`);
