// @lane: local — pure-fs lint on the regression-reviews dashboard
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Locks the dashboard's pending-run discovery to the workflow PATH.
//
// Consumers set a dynamic `run-name:` on the visual-regression thin caller
// (house convention: every workflow titles its runs per-trigger), and the
// Actions API returns that as the run's `name`. The dashboard's original
// `r.name === 'Visual Regression'` filter therefore matched NOTHING once a
// consumer adopted run-names — it showed "No pending regression reviews"
// while a run sat waiting on the regression-review gate (observed live on
// adamdaniel.ai#2554, the v0.1.59 bump). `path` is immune to run-naming.

const DASHBOARD = path.join(__dirname, "..", "theme", "admin", "reviews", "index.html");

test.describe("reviews dashboard: pending-run discovery", () => {
  test("filters waiting runs by workflow path, never by run name", () => {
    const s = fs.readFileSync(DASHBOARD, "utf8");
    expect(
      s,
      "dashboard must filter runs by r.path === '.github/workflows/visual-regression.yml'",
    ).toMatch(/r\.path === '\.github\/workflows\/visual-regression\.yml'/);
    expect(
      s,
      "run-name filtering is broken by design on consumers with dynamic run-name:",
    ).not.toMatch(/r\.name === 'Visual Regression'/);
  });
});
