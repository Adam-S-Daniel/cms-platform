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

if (require.main === module) {
  process.stdout.write(summarizeFile(process.argv[2]) + "\n");
}

module.exports = { summarize, summarizeFile, UNAVAILABLE };
