#!/usr/bin/env node
"use strict";
/*
 * audit-scheduled-runs.js — the scheduled-run health audit: make silent
 * scheduled-workflow failures LOUD.
 *
 * THE PROBLEM (observed live, 2026-07 audit): scheduled workflows fail
 * silently. Nothing surfaces an `event=schedule` failure beyond the Actions
 * tab — no PR goes red, no notification fires. adamdaniel.ai's daily
 * editorial-label-audit was red 24 of 30 days for three straight weeks
 * unnoticed; jodidaniel.com's sweep-stale-cms-prs failed 30/30 for a month
 * (a `startup_failure` from a dropped `secrets:` map) before anyone looked.
 *
 * THE FIX: scan this repo's workflow runs from the last N hours (default 48)
 * for `event=schedule` conclusions of failure / startup_failure / timed_out,
 * and open-or-update a SINGLE tracking issue (found via a hidden HTML marker
 * + label):
 *   - failures + no open tracking issue  → open it (the issue notification IS
 *     the alert — the repo owner watches their own repo);
 *   - failures + open issue              → comment ONLY the runs not already
 *     reported (dedupe by run id, recorded in a hidden `<!-- run-ids: … -->`
 *     block so the visible report can stay capped);
 *   - no failures in the window + open issue → close it with a "clean window"
 *     comment. The issue lifecycle mirrors reality: open while scheduled runs
 *     are failing, closed once a full window passes clean.
 *
 * WHY A 48h WINDOW FOR A DAILY AUDIT: GitHub throttles crons on these repos —
 * measured, five-minute crons fire every 45-90 min and daily/weekly crons run
 * 4-5 HOURS late. Two consecutive daily audit runs can therefore be up to
 * ~29h apart; a 24-25h window would leave a blind gap. Doubling to 48h means
 * lag can never skip a failure, and the run-id dedupe keeps the double
 * coverage from double-reporting.
 *
 * EXIT CODE CONTRACT: exit 0 when the audit COMPLETED (even when failures
 * were found — the tracking issue is the alert channel); non-zero only when
 * the audit itself could not do its job (API/permission failure). A red
 * audit run therefore means "the alerting layer is broken", not "something
 * it watches is broken" — the same "red means needs a human" contract as
 * audit-editorial-labels.js --fix.
 *
 * Usage:
 *   node scripts/audit-scheduled-runs.js [--repo owner/name] \
 *     [--window-hours 48] [--label ci] [--dry-run]
 *
 * Requires a gh-authenticated environment (GH_TOKEN or gh auth) with
 * actions: read (list runs) + issues: write (open/comment/close).
 * Pure helpers are exported for unit tests (e2e/scheduled-run-health.test.js);
 * the require.main guard keeps the CLI from running on import.
 */
const { execFileSync } = require("node:child_process");

// Hidden marker that identifies THE tracking issue among the label's issues —
// stable across releases; never change it or the audit will open a duplicate.
const MARKER = "<!-- scheduled-run-health-audit -->";
const ISSUE_TITLE = "Scheduled workflow runs are failing (automated health audit)";
// `cancelled` is deliberately EXCLUDED: the loop workflows cancel superseded
// runs by design (concurrency groups), so a cancelled scheduled run is not a
// health signal. `action_required` never occurs for schedule events.
const BAD_CONCLUSIONS = ["failure", "startup_failure", "timed_out"];
// Cap the VISIBLE per-workflow run links (a */5 cron can fail dozens of times
// a day); every run id is still recorded in the hidden run-ids block, so the
// dedupe stays exact even for capped-away runs.
const MAX_LINKS_PER_WORKFLOW = 5;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

// ISO-8601 Z timestamp (second precision) for `now - windowHours`.
function sinceIso(nowMs, windowHours) {
  return new Date(nowMs - windowHours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// A run that must be alerted on: a completed scheduled run whose conclusion
// is one of the silent-failure classes. Both filters are applied even though
// the API query already narrows by event — defense in depth against a query
// param being dropped.
function isAlertRun(run) {
  return !!run && run.event === "schedule" && BAD_CONCLUSIONS.includes(run.conclusion);
}

function filterAlertRuns(runs, since) {
  return (runs || []).filter(
    (r) => isAlertRun(r) && (!since || String(r.run_started_at || r.created_at || "") >= since),
  );
}

// Map<workflowName, runs[]> — runs newest-first within each workflow, and
// workflows sorted by their newest failure (most recent breakage on top).
function groupByWorkflow(runs) {
  const byName = new Map();
  for (const r of runs || []) {
    const key = r.name || r.path || "(unknown workflow)";
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  for (const list of byName.values()) {
    list.sort((a, b) =>
      String(b.run_started_at || b.created_at || "").localeCompare(
        String(a.run_started_at || a.created_at || ""),
      ),
    );
  }
  return new Map(
    [...byName.entries()].sort((a, b) =>
      String(b[1][0].run_started_at || "").localeCompare(String(a[1][0].run_started_at || "")),
    ),
  );
}

// Every run id already reported in the issue (body + comments): the hidden
// `<!-- run-ids: 1 2 3 -->` blocks are authoritative; run-URL matches are a
// belt-and-braces fallback (covers a hand-written comment linking a run).
function extractReportedRunIds(texts) {
  const ids = new Set();
  for (const t of texts || []) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(/<!--\s*run-ids:([\d\s]+?)-->/g)) {
      for (const id of m[1].trim().split(/\s+/)) if (id) ids.add(id);
    }
    for (const m of t.matchAll(/\/actions\/runs\/(\d+)/g)) ids.add(m[1]);
  }
  return ids;
}

function hiddenRunIdsBlock(runs) {
  return `<!-- run-ids: ${(runs || []).map((r) => r.id).join(" ")} -->`;
}

// Grouped markdown findings: one section per failing workflow, newest runs
// first, links capped at MAX_LINKS_PER_WORKFLOW per workflow.
function renderFindings(runs) {
  const lines = [];
  for (const [name, list] of groupByWorkflow(runs)) {
    lines.push(`**${name}** — ${list.length} failing scheduled run(s):`);
    for (const r of list.slice(0, MAX_LINKS_PER_WORKFLOW)) {
      lines.push(`- [${r.conclusion} — ${r.run_started_at || r.created_at}](${r.html_url})`);
    }
    if (list.length > MAX_LINKS_PER_WORKFLOW) {
      lines.push(`- …and ${list.length - MAX_LINKS_PER_WORKFLOW} more (see the Actions tab)`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildIssueBody({ repo, windowHours, runs, nowIso }) {
  return [
    MARKER,
    hiddenRunIdsBlock(runs),
    "",
    "The daily **scheduled-run health audit** found scheduled workflow runs",
    `(\`event=schedule\`) that ended in \`${BAD_CONCLUSIONS.join("` / `")}\``,
    `in the last ${windowHours}h on \`${repo}\` (scanned at ${nowIso}).`,
    "",
    "Scheduled runs have no PR to go red on — this issue is the alert.",
    "",
    renderFindings(runs),
    "",
    "**What to do:** open the run links, fix the root cause, and leave this",
    "issue open — the audit comments any NEW failing runs here (never a new",
    `issue) and closes it automatically once a full ${windowHours}h window`,
    "passes with no scheduled failures.",
    "",
    "_Filed automatically by the `scheduled-run-health` workflow (cms-platform)._",
  ].join("\n");
}

function buildComment({ windowHours, runs, nowIso }) {
  return [
    hiddenRunIdsBlock(runs),
    "",
    `New failing scheduled run(s) in the last ${windowHours}h (scanned at ${nowIso}):`,
    "",
    renderFindings(runs),
  ].join("\n");
}

function buildCloseComment({ windowHours, nowIso }) {
  return (
    `No failing scheduled runs in the last ${windowHours}h (scanned at ${nowIso}) — ` +
    "closing. The audit will reopen a fresh tracking issue if scheduled runs fail again."
  );
}

// ── gh-backed plumbing ──────────────────────────────────────────────────────

function ghApi(endpoint, { method, fields } = {}) {
  const args = ["api", endpoint];
  if (method) args.push("-X", method);
  for (const f of fields || []) args.push("-f", f);
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// All schedule-event runs created since `since`. Manual page loop (not
// --paginate) so each page is a clean JSON document to parse.
function listScheduledRuns(repo, since) {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const res = JSON.parse(
      ghApi(
        `repos/${repo}/actions/runs?event=schedule&created=${encodeURIComponent(
          ">=" + since,
        )}&per_page=100&page=${page}`,
      ),
    );
    const batch = res.workflow_runs || [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs;
}

// The single open tracking issue: open issues carrying the label whose body
// carries MARKER. The /issues listing includes PRs — filter them out.
function findTrackingIssue(repo, label) {
  const res = JSON.parse(
    ghApi(`repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`),
  );
  return (
    (Array.isArray(res) ? res : []).find(
      (i) => !i.pull_request && typeof i.body === "string" && i.body.includes(MARKER),
    ) || null
  );
}

function listIssueComments(repo, number) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = JSON.parse(
      ghApi(`repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`),
    );
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

// Best-effort: POST the label so issue creation can attach it. 422 (already
// exists) is the normal case after day one — swallow every failure; the issue
// POST auto-creates missing labels anyway when the token has push access.
function ensureLabel(repo, label) {
  try {
    ghApi(`repos/${repo}/labels`, {
      fields: [
        `name=${label}`,
        "color=d93f0b",
        "description=Automated CI health tracking (scheduled-run health audit)",
      ],
    });
  } catch {
    /* already exists / races are fine */
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  // Resolve the target repo: explicit --repo wins; otherwise GITHUB_REPOSITORY
  // (always set in Actions = the caller's repo). The reusable only SPARSE-
  // checks-out this script, so there is never a local git repo to infer from.
  const repo = arg("repo", "") || process.env.GITHUB_REPOSITORY || "";
  if (!repo) {
    console.error("audit-scheduled-runs: no repo — pass --repo owner/name or set GITHUB_REPOSITORY");
    return 2;
  }
  const windowHours = Number.parseInt(arg("window-hours", "48"), 10);
  if (!Number.isInteger(windowHours) || windowHours <= 0) {
    console.error(`audit-scheduled-runs: invalid --window-hours ${arg("window-hours", "48")}`);
    return 2;
  }
  const label = arg("label", "ci");
  const dryRun = flag("dry-run");
  const nowMs = Date.now();
  const since = sinceIso(nowMs, windowHours);
  const nowIso = sinceIso(nowMs, 0);

  let failures, issue;
  try {
    failures = filterAlertRuns(listScheduledRuns(repo, since), since);
    issue = findTrackingIssue(repo, label);
  } catch (e) {
    console.error(`audit-scheduled-runs: failed to scan ${repo}: ${e.message}`);
    return 1;
  }

  const summary = `${failures.length} failing scheduled run(s) in the last ${windowHours}h on ${repo}`;

  if (failures.length === 0) {
    if (issue) {
      console.log(
        `::notice title=Scheduled-run health::Clean window — closing tracking issue #${issue.number}.`,
      );
      if (!dryRun) {
        try {
          ghApi(`repos/${repo}/issues/${issue.number}/comments`, {
            fields: [`body=${buildCloseComment({ windowHours, nowIso })}`],
          });
          ghApi(`repos/${repo}/issues/${issue.number}`, {
            method: "PATCH",
            fields: ["state=closed", "state_reason=completed"],
          });
        } catch (e) {
          console.error(`audit-scheduled-runs: failed to close issue #${issue.number}: ${e.message}`);
          return 1;
        }
      }
    }
    console.log(`OK — ${summary}. All scheduled workflows healthy.`);
    return 0;
  }

  // Failures found: the ISSUE is the alert; this run stays green once it is filed.
  if (!issue) {
    console.log(`::notice title=Scheduled-run health::${summary} — opening the tracking issue.`);
    if (!dryRun) {
      ensureLabel(repo, label);
      try {
        const created = JSON.parse(
          ghApi(`repos/${repo}/issues`, {
            fields: [
              `title=${ISSUE_TITLE}`,
              `body=${buildIssueBody({ repo, windowHours, runs: failures, nowIso })}`,
              `labels[]=${label}`,
            ],
          }),
        );
        console.log(`Opened tracking issue #${created.number}: ${created.html_url}`);
      } catch (e) {
        console.error(`audit-scheduled-runs: failed to open the tracking issue: ${e.message}`);
        return 1;
      }
    } else {
      console.log(`(dry-run) would open "${ISSUE_TITLE}" [${label}] with:\n${renderFindings(failures)}`);
    }
    console.log(`ALERT FILED — ${summary}.`);
    return 0;
  }

  let reported;
  try {
    reported = extractReportedRunIds([
      issue.body,
      ...listIssueComments(repo, issue.number).map((c) => c.body),
    ]);
  } catch (e) {
    console.error(`audit-scheduled-runs: failed to read issue #${issue.number}: ${e.message}`);
    return 1;
  }
  const fresh = failures.filter((r) => !reported.has(String(r.id)));
  if (fresh.length === 0) {
    console.log(
      `OK — ${summary}; all already reported on tracking issue #${issue.number}. Nothing new.`,
    );
    return 0;
  }
  console.log(
    `::notice title=Scheduled-run health::${summary} — ${fresh.length} new; commenting on issue #${issue.number}.`,
  );
  if (!dryRun) {
    try {
      ghApi(`repos/${repo}/issues/${issue.number}/comments`, {
        fields: [`body=${buildComment({ windowHours, runs: fresh, nowIso })}`],
      });
    } catch (e) {
      console.error(`audit-scheduled-runs: failed to comment on issue #${issue.number}: ${e.message}`);
      return 1;
    }
  } else {
    console.log(`(dry-run) would comment:\n${renderFindings(fresh)}`);
  }
  console.log(`ALERT UPDATED — ${summary} (${fresh.length} newly reported).`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  MARKER,
  ISSUE_TITLE,
  BAD_CONCLUSIONS,
  MAX_LINKS_PER_WORKFLOW,
  sinceIso,
  isAlertRun,
  filterAlertRuns,
  groupByWorkflow,
  extractReportedRunIds,
  hiddenRunIdsBlock,
  renderFindings,
  buildIssueBody,
  buildComment,
  buildCloseComment,
};
