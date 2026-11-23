#!/usr/bin/env node
// Only aggregate Playwright counts belong in the public Actions log. The JSON
// report and raw output can contain rendered page content and stay in artifacts.
const fs = require("node:fs");

const UNAVAILABLE = "Playwright summary unavailable; inspect artifacts.";
const FIELDS = ["expected", "unexpected", "flaky", "skipped"];

function summarize(report) {
  const stats = report && report.stats;
  if (!stats || typeof stats !== "object" || Array.isArray(stats) ||
      !Array.isArray(report.errors)) return UNAVAILABLE;
  if (!FIELDS.every((field) => Number.isSafeInteger(stats[field]) && stats[field] >= 0)) {
    return UNAVAILABLE;
  }
  return `Playwright: ${stats.expected} passed, ${stats.unexpected} failed, ` +
    `${stats.flaky} flaky, ${stats.skipped} skipped, ` +
    `${report.errors.length} fatal errors.`;
}

function summarizeFile(file) {
  try {
    return summarize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (_) {
    // Do not print the parse error or its input: either may contain page data.
    return UNAVAILABLE;
  }
}

// A loop that ran no test proved nothing. Playwright counts a self-skipped
// spec as "skipped" and exits 0, so a site whose cms.base_collections is []
// (jodidaniel.com) read as a green publish loop that published nothing (#1068).
// Returns null when something ran, else the reason, aggregate counts only.
function nothingRan(report) {
  if (summarize(report) === UNAVAILABLE) {
    return "the Playwright report is unavailable, so it cannot show a test ran";
  }
  const { expected, unexpected, flaky, skipped } = report.stats;
  if (expected + unexpected + flaky > 0) return null;
  return `executed 0 tests (${skipped} skipped); the specs self-skip when the ` +
    "site has no collection they publish through (cms.base_collections: []), " +
    "so this loop did not exercise a real publish";
}

function nothingRanFile(file) {
  try {
    return nothingRan(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (_) {
    return "the Playwright report is unavailable, so it cannot show a test ran";
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const requireRan = args[0] === "--require-ran";
  const file = requireRan ? args[1] : args[0];
  process.stdout.write(summarizeFile(file) + "\n");
  if (requireRan) {
    const reason = nothingRanFile(file);
    // An empty CMS_E2E_PAT is the specs' documented self-skip only for Dependabot
    // and fork runs. Anywhere else it is a missing secret, and green with nothing
    // run is exactly what --require-ran exists to refuse (#1068).
    const noSecretOk = !process.env.CMS_E2E_PAT &&
      (process.env.GITHUB_ACTOR === "dependabot[bot]" || process.env.CMS_E2E_FORK === "true");
    if (reason && noSecretOk) {
      process.stdout.write("::notice::no CMS_E2E_PAT on a fork or Dependabot run; the loop specs self-skip by design, so --require-ran is not enforced\n");
    } else if (reason) {
      const site = String(process.env.GITHUB_REPOSITORY || "this site")
        .replace(/[^A-Za-z0-9._\/-]/g, "");
      const hint = process.env.CMS_E2E_PAT ? "" : " (CMS_E2E_PAT is missing or empty)";
      process.stdout.write(`::error title=Loop published nothing::${site}: ${reason}${hint}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { summarize, nothingRan, UNAVAILABLE };
