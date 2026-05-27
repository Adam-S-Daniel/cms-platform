/*
 * In-spec hook for `scripts/diagnose-stuck-pr.js`. This is Layer 1 of the
 * two-layer stuck-PR diagnostic — see
 * `docs/decisions/0002-stuck-pr-diagnostic-two-layer.md` for the
 * always-exit-0 / read-only / why-two-layers rationale.
 *
 * Long-wait helpers in this codebase (`waitForMerge`, `fetchPublicUrl`,
 * `waitForChangeReflected`, `waitForCmsPullRequest`, `waitForWorkflowRun`,
 * `waitForAutoMergeEnabled`) all die with a clear `Timed out waiting for …`
 * message but no context on WHY the thing they were waiting on never
 * happened. Most of the time the proximate cause is another PR upstream
 * (BLOCKED by failing checks, DIRTY with a real conflict, DIRTY with a
 * newline-only conflict the auto-resolver would close, or a queued
 * deploy-production run holding the production deploy lane).
 *
 * `augmentTimeoutError(err, hint)` invokes the diagnostic script (read-only,
 * 25-s internal timebox, always exits 0) and appends its Markdown output to
 * `err.message`. Re-throw the returned error. Falls through silently if
 * spawning the script fails or the 30-s budget elapses — a diagnostic that
 * turns a real failure into a redder one is worse than no diagnostic.
 *
 * Usage at each throw site:
 *
 *   throw await augmentTimeoutError(
 *     new Error(`Timed out waiting for PR #${prNumber} to merge.`),
 *     { waitingFor: `PR #${prNumber} to merge`, kind: "merge", waitPrNumber: prNumber },
 *   );
 *
 * Disable via `NO_STUCK_PR_DIAGNOSTIC=1` (useful for unit tests of the
 * wait helpers themselves, where the GitHub API isn't actually reachable).
 */

"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const DIAGNOSTIC_SCRIPT = path.resolve(__dirname, "..", "scripts", "diagnose-stuck-pr.js");
const BUDGET_MS = 30_000;

function shouldRunDiagnostic() {
  if (process.env.NO_STUCK_PR_DIAGNOSTIC === "1") return false;
  // The diagnostic needs SOME GitHub token to read PR state. Prefer the
  // PAT the test was already using (CMS_E2E_PAT), fall back to
  // GITHUB_TOKEN. If neither is available the diagnostic is a no-op
  // anyway, so skip the spawn cost.
  if (!process.env.CMS_E2E_PAT && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    return false;
  }
  return true;
}

function spawnDiagnosticAndCollect({ waitingFor, kind, waitPrNumber }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      GH_TOKEN: process.env.CMS_E2E_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
      GH_REPO: process.env.GH_REPO || "Adam-S-Daniel/adamdaniel.ai",
      WAITING_FOR: waitingFor || "",
      WAITING_FOR_KIND: kind || "",
      WAIT_PR_NUMBER: waitPrNumber == null ? "" : String(waitPrNumber),
    };
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const child = spawn(process.execPath, [DIAGNOSTIC_SCRIPT], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (md) => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill("SIGTERM");
      } catch (_) {
        /* already exited */
      }
      resolve(md);
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      finish(`_(diagnostic spawn failed: ${e.message.slice(0, 120)})_`);
    });
    child.on("exit", () => {
      if (stdout.trim()) finish(stdout.trim());
      else if (stderr.trim())
        finish(`_(diagnostic emitted only stderr — first 300 chars)_\n\n${stderr.slice(0, 300)}`);
      else finish(`_(diagnostic produced no output)_`);
    });
    setTimeout(() => {
      finish(
        `_(diagnostic exceeded ${BUDGET_MS / 1000}s budget — partial output)_\n\n${stdout.trim()}`,
      );
    }, BUDGET_MS).unref();
  });
}

async function augmentTimeoutError(err, hint = {}) {
  if (!shouldRunDiagnostic()) return err;
  try {
    const md = await spawnDiagnosticAndCollect(hint);
    if (md && md.trim()) {
      err.message = `${err.message}\n\n${md}`;
    }
  } catch (e) {
    err.message = `${err.message}\n\n_(diagnostic wrapper crashed: ${e.message.slice(0, 120)})_`;
  }
  return err;
}

module.exports = {
  augmentTimeoutError,
  shouldRunDiagnostic,
  spawnDiagnosticAndCollect,
  DIAGNOSTIC_SCRIPT,
  BUDGET_MS,
};
