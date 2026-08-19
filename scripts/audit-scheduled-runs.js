#!/usr/bin/env node
"use strict";
/*
 * audit-scheduled-runs.js — the workflow-run health audit: make silent
 * scheduled-workflow AND default-branch-push failures LOUD.
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
 * DEFAULT-BRANCH PUSH FAILURES ARE THE SAME BLIND SPOT (#279): the
 * `event=schedule` scan does nothing for a `push`-to-default-branch failure,
 * which is exactly as invisible — no PR to go red on, no notification.
 * Live incident, 2026-08: a `.gitleaks.toml` change on adamdaniel.ai passed
 * its PR check (the PR lane scans `base..head`) but broke every `push`-to-
 * `main` run of `secrets-scan.yml` (the push lane scans full history) — 8
 * CONSECUTIVE pushes failed, each one a blocked Decap editorial publish, and
 * no tracking issue was ever filed. The push lane reuses every mechanism
 * above unchanged (same run-id dedupe channel, same runner-starvation
 * suppression, same tracking issue) — only the query narrows to
 * `event=push` on the repo's own default branch (read from the SAME repo-
 * metadata call the dead-workflow check already makes; no hardcoded `main`,
 * no extra API call) instead of `event=schedule`. The two lanes render as
 * separate sections (`secrets-scan.yml` fires on BOTH events, and a merged
 * list would bury exactly the signal the incident needed — "scheduled green,
 * push on fire") but share one close-gate: the issue does not close until
 * scheduled runs, push runs, AND dead workflows are ALL clean.
 *
 * ABSENCE IS NOT HEALTH (#258): a run-only detector cannot see a workflow that
 * emits NO runs. GitHub auto-disables a scheduled workflow after 60 days with
 * no repository activity (PUBLIC repos only), and a disabled workflow
 * contributes nothing to `actions/runs?event=schedule` — so the audit scored it
 * `0 failing scheduled run(s) … All scheduled workflows healthy` and, worse,
 * CLOSED an open tracking issue on the strength of that silence. The signal is
 * one field: `GET /actions/workflows` returns `state` ∈ `active | deleted |
 * disabled_fork | disabled_inactivity | disabled_manually`. Dead cron-bearing
 * workflows now join failing runs in the SAME finding set and the same
 * open/comment/close lifecycle — only the input set widened. Two properties
 * keep this from re-growing the bug it fixes: the check is public-repos-only
 * (the 60-day rule does not apply elsewhere, and a private repo's disabled cron
 * is off by intent), and an UNKNOWN answer — a failed probe, an ambiguous
 * visibility — never counts as "no findings": it suppresses the auto-close and
 * reds the audit, because "we could not tell" is the audit failing at its job.
 *
 * RUNNER STARVATION IS NOT A FAILURE (suppressed): GitHub reports the RUN as
 * `failure` when its job(s) were CANCELLED before a runner was ever assigned —
 * `runner_id: 0`, empty `runner_name`, no steps (observed live on
 * jodidaniel.com runs 31118167966 and 31120011930). That is infrastructure
 * noise, not a broken workflow, and the RUN conclusion alone cannot tell the
 * two apart — so an otherwise-alertable run has its JOBS fetched and is
 * suppressed when every job is cancelled-without-a-runner (or skipped). The
 * suppressed count + workflow names are still emitted as a `::notice::`, so a
 * systemic runner outage stays visible instead of becoming invisible.
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
 *     [--window-hours 48] [--label ci] [--dry-run] [--no-push-scan]
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
const ISSUE_TITLE = "Workflow runs are failing (automated health audit)";
// `cancelled` is deliberately EXCLUDED: the loop workflows cancel superseded
// runs by design (concurrency groups), so a cancelled scheduled run is not a
// health signal. `action_required` never occurs for schedule events. That
// exclusion is RUN-level only — see isRunnerStarvationRun for the case where
// the RUN says `failure` but its only job was cancelled without a runner.
const BAD_CONCLUSIONS = ["failure", "startup_failure", "timed_out"];
// Cap the VISIBLE per-workflow run links (a */5 cron can fail dozens of times
// a day); every run id is still recorded in the hidden run-ids block, so the
// dedupe stays exact even for capped-away runs.
const MAX_LINKS_PER_WORKFLOW = 5;
// Workflow `state` values that mean "this cron cannot fire any more".
// `deleted` and `disabled_fork` are deliberate EXCLUSIONS: a deleted workflow
// was removed on purpose (its file is gone) and disabled_fork is a fork-only
// state, so alerting on either is pure noise. `disabled_inactivity` is the
// target; `disabled_manually` on a cron-bearing workflow is worth reporting
// because it is indistinguishable, from the outside, from a cron someone
// turned off during an incident and forgot to turn back on.
const DEAD_WORKFLOW_STATES = ["disabled_inactivity", "disabled_manually"];
// `disabled_inactivity` is SELF-EVIDENCING: GitHub sets it from exactly one
// mechanism — the 60-day auto-disable, which targets SCHEDULED workflows in
// public repos — so the state already proves the workflow carries a cron.
// THAT PREMISE IS GITHUB'S DOCUMENTED BEHAVIOUR, NOT MEASURED HERE: a 60-day
// auto-disable cannot be induced in a test, and there is no live specimen to
// read it off (measured 2026-08-17, all 111 workflows across cms-platform,
// adamdaniel.ai and jodidaniel.com are `state=active`). If GitHub ever sets
// the state some other way, the blast radius is bounded to one extra reported
// line, once per tracking issue, about a workflow that genuinely IS disabled.
// Re-deriving that from a runs probe can only LOSE information: the probe
// answers "no" identically for "never a cron" and "its run records are gone"
// (runs deleted via DELETE /actions/runs/{id} or the Actions tab), and a "no"
// there silently drops the workflow from the finding set. That is #258
// verbatim, merely deferred. `disabled_manually` gets no such guarantee — any
// workflow can be switched off by hand — so it keeps the probe.
const SELF_EVIDENCING_CRON_STATES = ["disabled_inactivity"];

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

// A run that must be alerted on: a completed run of `event` whose conclusion
// is one of the silent-failure classes. `event` defaults to "schedule" so
// every existing call site (and every existing test) stays byte-identical;
// the push lane (#279 — default-branch push failures are exactly as silent
// as scheduled ones) passes "push" explicitly. Both filters are applied even
// though the API query already narrows by event — defense in depth against a
// query param being dropped.
function isAlertRun(run, event = "schedule") {
  return !!run && run.event === event && BAD_CONCLUSIONS.includes(run.conclusion);
}

function filterAlertRuns(runs, since, event = "schedule") {
  return (runs || []).filter(
    (r) =>
      isAlertRun(r, event) && (!since || String(r.run_started_at || r.created_at || "") >= since),
  );
}

// A job that was cancelled before a runner ever picked it up: GitHub leaves
// `runner_id: 0` + an empty `runner_name` (and no steps) on such a job. A
// SKIPPED job carries `runner_id: null` instead, which is why the runner test
// applies to cancelled jobs only — see clause (v) in isRunnerStarvationRun.
function isRunnerStarvedJob(job) {
  if (!job || job.conclusion !== "cancelled") return false;
  const name = job.runner_name;
  return job.runner_id === 0 || name === undefined || name === null || name === "";
}

// True when an otherwise-alertable run is really runner starvation, not a
// failure: the RUN reads `failure` while no job of it ever got a runner. All of
//   (i)   the run HAS jobs — FIRST, and never to be dropped: a `startup_failure`
//         run has ZERO jobs, and `[].every()` is vacuously TRUE, so an empty list
//         reaching clause (v) would silence the exact class this audit exists
//         for. Clause (iv)'s `some` also rejects it today, which makes this
//         defence in depth against a future reorder — not dead code;
//   (ii)  the run is not itself a `startup_failure`;
//   (iii) no job failed or timed out;
//   (iv)  at least one job was cancelled without a runner (the starvation mark);
//   (v)   every job is cancelled or skipped (a skipped job needs no runner test).
function isRunnerStarvationRun(run, jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length === 0) return false;
  if (!run || run.conclusion === "startup_failure") return false;
  if (list.some((j) => j && (j.conclusion === "failure" || j.conclusion === "timed_out"))) {
    return false;
  }
  if (!list.some(isRunnerStarvedJob)) return false;
  return list.every((j) => j && (j.conclusion === "cancelled" || j.conclusion === "skipped"));
}

// Split alertable runs into the ones that still deserve the alert and the ones
// suppressed as runner starvation. `fetchJobs(run)` is injected so the split is
// unit-testable without gh; it FAILS SOFT — a jobs-fetch error keeps the run
// ALERTABLE, because silently dropping a real failure is the worse outcome.
function partitionStarvedRuns(runs, fetchJobs) {
  const alertable = [];
  const suppressed = [];
  for (const r of runs || []) {
    let jobs;
    try {
      jobs = fetchJobs(r);
    } catch (e) {
      console.error(`audit-scheduled-runs: could not read jobs for run ${r && r.id}: ${e.message}`);
      alertable.push(r);
      continue;
    }
    if (isRunnerStarvationRun(r, jobs)) suppressed.push(r);
    else alertable.push(r);
  }
  return { alertable, suppressed };
}

// GitHub auto-disables scheduled workflows for inactivity in PUBLIC repos
// only, so the dead-workflow check is public-only. Both predicates demand a
// STRICT boolean: a missing or non-boolean `private` reads as NEITHER public
// nor private, so an ambiguous visibility answer becomes a probe failure
// rather than a silent skip — the whole point of #258 is that "we could not
// tell" must never be scored as health.
function isPublicRepo(meta) {
  return !!meta && meta.private === false;
}

function isPrivateRepo(meta) {
  return !!meta && meta.private === true;
}

// A workflow whose cron can no longer fire (see DEAD_WORKFLOW_STATES).
function isDeadWorkflow(wf) {
  return !!wf && DEAD_WORKFLOW_STATES.includes(wf.state);
}

// A dead workflow whose STATE alone proves it carried a cron, so the runs
// probe has nothing to add (see SELF_EVIDENCING_CRON_STATES).
function stateImpliesCron(wf) {
  return !!wf && SELF_EVIDENCING_CRON_STATES.includes(wf.state);
}

// Dead workflows that actually carry a cron. `hadScheduledRuns(wf)` is
// injected so the scoping is unit-testable without gh; it FAILS SOFT — a probe
// error keeps the workflow REPORTED, the same direction as
// partitionStarvedRuns, because silently dropping a possibly-dead cron is the
// worse outcome — the catch below deliberately has no `continue`, so a throw
// falls through to `dead.push(wf)`. That catch is now reachable for
// `disabled_manually` only (see below).
//
// WHY A RUNS PROBE AND NOT THE WORKFLOW FILE'S `on:` BLOCK: the reusable
// sparse-checks-out only this script, so no consumer workflow file exists on
// disk to parse; the runtime is bare Node with no YAML parser available
// (regex-scanning YAML is banned house-wide — anchors/aliases silently
// mis-read); and the file on the default branch may no longer carry
// `on: schedule` while the disabled workflow entry persists, so a YAML read
// can answer "no cron" about a workflow GitHub disabled precisely because it
// had one.
//
// WHY THE PROBE NOW SCOPES `disabled_manually` ONLY: for
// `disabled_inactivity` it is redundant AND lossy. Redundant because the state
// is self-evidencing (SELF_EVIDENCING_CRON_STATES). Lossy because it answers
// from run RECORDS, and "no records" is byte-identical for "never a cron" and
// "the records were deleted" — a "no" there removes the workflow from the
// finding set silently, which is #258 deferred rather than fixed. Deleting the
// probe for that state is not a heuristic trade: a strictly weaker signal
// stops overruling a stronger one, and it costs one fewer API call per dead
// workflow. `disabled_manually` implies nothing about a cron, so it keeps the
// probe — reporting every hand-disabled workflow would make `dead.length > 0`
// permanent and, because main()'s close branch is gated on `dead.length === 0`,
// the tracking issue could never auto-close again.
function filterDeadScheduledWorkflows(workflows, hadScheduledRuns) {
  const dead = [];
  for (const wf of workflows || []) {
    if (!isDeadWorkflow(wf)) continue;
    if (stateImpliesCron(wf)) {
      dead.push(wf);
      continue;
    }
    try {
      if (!hadScheduledRuns(wf)) continue;
    } catch (e) {
      console.error(
        `audit-scheduled-runs: could not read scheduled runs for workflow ${wf.path}: ${e.message}`,
      );
    }
    dead.push(wf);
  }
  return dead;
}

// The stable identity of the failing WORKFLOW: the workflow file's basename.
// NOT `run.name` — the runs API's `name` is the run's DISPLAY TITLE, which
// for this repo family is the evaluated dynamic `run-name:` (observed live:
// grouping by name produced a "scheduled — 0 12 * * *" header that never
// said WHICH workflow failed — the one thing the alert must say).
function workflowKey(r) {
  const base = String((r && r.path) || "")
    .split("/")
    .pop();
  return base || (r && r.name) || "(unknown workflow)";
}

// Map<workflowFileBasename, runs[]> — runs newest-first within each workflow,
// and workflows sorted by their newest failure (most recent breakage on top).
function groupByWorkflow(runs) {
  const byName = new Map();
  for (const r of runs || []) {
    const key = workflowKey(r);
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

// A dead workflow has no run id to dedupe on, so it gets its own hidden block,
// keyed by workflow FILE BASENAME (workflowKey — stable across renames of the
// display `name:`). Without it every daily audit re-comments the same corpse.
function hiddenDeadWorkflowsBlock(workflows) {
  return `<!-- dead-workflows: ${(workflows || []).map(workflowKey).join(" ")} -->`;
}

// Every dead-workflow key already reported (issue body + comments). Kept
// strictly separate from extractReportedRunIds so the two dedupe channels can
// never clobber each other.
function extractReportedDeadWorkflows(texts) {
  const names = new Set();
  for (const t of texts || []) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(/<!--\s*dead-workflows:([^\n]*?)-->/g)) {
      for (const name of m[1].trim().split(/\s+/)) if (name) names.add(name);
    }
  }
  return names;
}

// One line per dead workflow: which file, and which `state` killed it (the
// state is the actionable half — `disabled_inactivity` needs a re-enable plus
// a keep-alive story, `disabled_manually` needs someone to say whether it was
// deliberate).
function renderDeadWorkflows(workflows) {
  const lines = [];
  for (const wf of workflows || []) {
    lines.push(`- **${workflowKey(wf)}** — \`${wf.state}\` (emits no scheduled runs at all)`);
  }
  return lines.join("\n");
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

// The full finding set. Each section appears only when it has content, so a
// runs-only report reads as it always did and a dead-workflow-only (or
// push-only) report does not claim findings it never saw. `pushRuns` defaults
// to `[]` and `defaultBranch` is only read when a push section is actually
// rendered, so every existing call site stays byte-identical.
function renderSections(runs, dead, pushRuns, defaultBranch) {
  const out = [];
  if ((runs || []).length > 0) {
    out.push(
      `**Failing scheduled runs** (\`event=schedule\` ending in ` +
        `\`${BAD_CONCLUSIONS.join("` / `")}\`):`,
      "",
      renderFindings(runs),
    );
  }
  if ((pushRuns || []).length > 0) {
    if (out.length > 0) out.push("");
    out.push(
      `**Failing default-branch push runs** (\`event=push\` on \`${defaultBranch}\` ending in ` +
        `\`${BAD_CONCLUSIONS.join("` / `")}\`):`,
      "",
      renderFindings(pushRuns),
    );
  }
  if ((dead || []).length > 0) {
    if (out.length > 0) out.push("");
    out.push(
      "**Scheduled workflows that can no longer fire.** These emit NO runs at",
      "all, so no run-level check can see them — GitHub auto-disables a cron",
      "after 60 days without repository activity (public repos only):",
      "",
      renderDeadWorkflows(dead),
    );
  }
  return out;
}

function buildIssueBody({ repo, windowHours, runs, dead, pushRuns, defaultBranch, nowIso }) {
  const deadList = dead || [];
  const pushList = pushRuns || [];
  const lines = [MARKER, hiddenRunIdsBlock([...(runs || []), ...pushList])];
  if (deadList.length > 0) lines.push(hiddenDeadWorkflowsBlock(deadList));
  lines.push(
    "",
    "The daily **scheduled-run health audit** found workflow runs needing",
    `attention on \`${repo}\` (last ${windowHours}h, scanned at ${nowIso}).`,
    "",
    "Neither a scheduled run nor a default-branch push run has a PR to go red",
    "on — this issue is the alert.",
    "",
    ...renderSections(runs, deadList, pushList, defaultBranch),
    "",
    "**What to do:** open the links, fix the root cause, and leave this issue",
    "open — the audit comments any NEW findings here (never a new issue) and",
    `closes it automatically once a full ${windowHours}h window passes clean.`,
    "",
    "_Filed automatically by the `scheduled-run-health` workflow (cms-platform)._",
  );
  return lines.join("\n");
}

function buildComment({ windowHours, runs, dead, pushRuns, defaultBranch, nowIso }) {
  const deadList = dead || [];
  const pushList = pushRuns || [];
  const lines = [hiddenRunIdsBlock([...(runs || []), ...pushList])];
  if (deadList.length > 0) lines.push(hiddenDeadWorkflowsBlock(deadList));
  lines.push(
    "",
    `New findings in the last ${windowHours}h (scanned at ${nowIso}):`,
    "",
    ...renderSections(runs, deadList, pushList, defaultBranch),
  );
  return lines.join("\n");
}

function buildCloseComment({ windowHours, nowIso }) {
  return (
    `No failing scheduled runs, no failing default-branch push runs, and no ` +
    `disabled scheduled workflows in the last ${windowHours}h (scanned at ${nowIso}) ` +
    "— closing. The audit will reopen a fresh tracking issue if any returns."
  );
}

// ── gh-backed plumbing ──────────────────────────────────────────────────────

function ghApi(endpoint, { method, fields } = {}) {
  const args = ["api", endpoint];
  if (method) args.push("-X", method);
  for (const f of fields || []) args.push("-f", f);
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// One page of the runs-for-an-event listing. `extraQuery` is an already-`&`-
// prefixed fragment (e.g. `&branch=main` for the push lane) — kept as a
// separate exported function, like runJobsEndpoint below, so the shape stays
// unit-assertable without shelling out to gh.
function runsForEventEndpoint(repo, event, since, page, extraQuery = "") {
  return (
    `repos/${repo}/actions/runs?event=${encodeURIComponent(event)}&created=` +
    `${encodeURIComponent(">=" + since)}${extraQuery}&per_page=100&page=${page}`
  );
}

// All runs of `event` created since `since` (optionally narrowed by
// `extraQuery`, e.g. `&branch=<default_branch>`). Manual page loop (not
// --paginate) so each page is a clean JSON document to parse. Both the
// scheduled lane and the default-branch push lane (#279) go through this one
// paginator.
function listRunsForEvent(repo, event, since, extraQuery = "") {
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const res = JSON.parse(ghApi(runsForEventEndpoint(repo, event, since, page, extraQuery)));
    const batch = res.workflow_runs || [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs;
}

// All schedule-event runs created since `since`.
function listScheduledRuns(repo, since) {
  return listRunsForEvent(repo, "schedule", since);
}

// All push-event runs on the repo's DEFAULT branch created since `since` —
// the OTHER silent-failure lane (#279, see file header): a push-triggered
// workflow has no PR to go red on either, and GitHub throws nothing beyond
// the Actions tab when one fails. Scoped to the default branch only — a
// push to a feature branch already has a human watching it via the PR.
function listPushRuns(repo, defaultBranch, since) {
  return listRunsForEvent(repo, "push", since, `&branch=${encodeURIComponent(defaultBranch)}`);
}

// One page of a run's jobs. EXPLICITLY paginated like every other list call
// here: a bare /jobs returns 30, so a big matrix would have the starvation
// predicate evaluated on a PARTIAL job set — silently wrong. Exported so the
// pagination shape stays unit-assertable without shelling out to gh.
function runJobsEndpoint(repo, runId, page) {
  return `repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
}

// All jobs of one run (latest attempt — the API default). Only called for runs
// that are ALREADY alertable, so the API cost stays proportional to failures,
// not to the whole window.
function listRunJobs(repo, runId) {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const batch = JSON.parse(ghApi(runJobsEndpoint(repo, runId, page))).jobs || [];
    jobs.push(...batch);
    if (batch.length < 100) break;
  }
  return jobs;
}

// Repo metadata — read for `private` only. Needs no extra permission beyond
// the reusable's existing `contents: read`.
function getRepoMeta(repo) {
  return JSON.parse(ghApi(`repos/${repo}`));
}

// Every workflow known to the repo, with its `state`. Needs `actions: read`,
// which the reusable already grants for the runs listing.
function listWorkflows(repo) {
  const workflows = [];
  for (let page = 1; page <= 10; page++) {
    const endpoint = `repos/${repo}/actions/workflows?per_page=100&page=${page}`;
    const batch = JSON.parse(ghApi(endpoint)).workflows || [];
    workflows.push(...batch);
    if (batch.length < 100) break;
  }
  return workflows;
}

// "Has this workflow ever fired on a cron?" — one run is enough to answer, so
// per_page=1. Exported so the shape stays unit-assertable without gh.
function workflowScheduledRunsEndpoint(repo, workflowId) {
  return `repos/${repo}/actions/workflows/${workflowId}/runs?event=schedule&per_page=1`;
}

function hasScheduledRuns(repo, workflowId) {
  const res = JSON.parse(ghApi(workflowScheduledRunsEndpoint(repo, workflowId)));
  return (res.workflow_runs || []).length > 0;
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
  // Opt-out only — the reusable's `push_scan` input defaults to TRUE (see its
  // header), so the CLI's default is "scan". A deliberate opt-out is not an
  // unknown answer: it never sets pushProbeFailed, unlike every other reason
  // the push lane can come up empty.
  const pushScanDisabled = flag("no-push-scan");
  const nowMs = Date.now();
  const since = sinceIso(nowMs, windowHours);
  const nowIso = sinceIso(nowMs, 0);

  // Repo metadata — needed for BOTH the push lane's default branch and the
  // dead-workflow probe's private/public check further down. Read via its
  // OWN inner try, INSIDE the same top-level try as the schedule listing, so
  // a metadata hiccup skips only the lanes that depend on it (push here,
  // dead-workflow below) and never loses the schedule-run alert this block
  // has already computed by the time it runs.
  let meta = null;
  let metaProbeFailed = false;
  // A missing/non-string default_branch is as ambiguous as the dead-workflow
  // probe's missing/non-boolean `private` — treated as "could not tell",
  // never as "no push runs to report".
  let defaultBranch = null;

  let failures, starved, pushFailures, pushStarved, issue;
  try {
    const candidates = filterAlertRuns(listScheduledRuns(repo, since), since);
    const split = partitionStarvedRuns(candidates, (r) => listRunJobs(repo, r.id));
    failures = split.alertable;
    starved = split.suppressed;

    try {
      meta = getRepoMeta(repo);
    } catch (e) {
      metaProbeFailed = true;
      console.error(`audit-scheduled-runs: could not read repo metadata for ${repo}: ${e.message}`);
    }
    if (meta && typeof meta.default_branch === "string" && meta.default_branch) {
      defaultBranch = meta.default_branch;
    }
    if (!pushScanDisabled && defaultBranch) {
      const pushCandidates = filterAlertRuns(listPushRuns(repo, defaultBranch, since), since, "push");
      const pushSplit = partitionStarvedRuns(pushCandidates, (r) => listRunJobs(repo, r.id));
      pushFailures = pushSplit.alertable;
      pushStarved = pushSplit.suppressed;
    } else {
      pushFailures = [];
      pushStarved = [];
    }

    issue = findTrackingIssue(repo, label);
  } catch (e) {
    console.error(`audit-scheduled-runs: failed to scan ${repo}: ${e.message}`);
    return 1;
  }
  // UNKNOWN, not "zero push failures" — a probe that never ran must not read
  // as a clean push lane (same #258 principle the dead-workflow check uses).
  // A deliberate `--no-push-scan` is the one exception: skipped ON PURPOSE
  // is not "could not tell".
  const pushProbeFailed = !pushScanDisabled && (metaProbeFailed || !defaultBranch);

  // Dead cron-bearing workflows — the runs query cannot see these (they emit
  // nothing). Reuses the SAME repo-metadata read above (no extra API call);
  // `deadProbeFailed` suppresses the auto-close and reds the run, because an
  // unknown answer is not "no findings".
  let dead = [];
  let deadProbeFailed = false;
  if (metaProbeFailed) {
    deadProbeFailed = true;
    console.error(
      `::error title=Scheduled-run health::Could not check ${repo} for disabled scheduled ` +
        "workflows: repo metadata probe failed. Treating the result as UNKNOWN, not as healthy.",
    );
  } else if (isPrivateRepo(meta)) {
    console.log(
      "::notice title=Scheduled-run health::Private repo — GitHub's 60-day cron " +
        "auto-disable applies to public repos only; skipping the dead-workflow check.",
    );
  } else if (isPublicRepo(meta)) {
    try {
      dead = filterDeadScheduledWorkflows(listWorkflows(repo), (wf) => hasScheduledRuns(repo, wf.id));
    } catch (e) {
      deadProbeFailed = true;
      console.error(
        `::error title=Scheduled-run health::Could not check ${repo} for disabled scheduled ` +
          `workflows: ${e.message}. Treating the result as UNKNOWN, not as healthy.`,
      );
    }
  } else {
    deadProbeFailed = true;
    console.error(
      `::error title=Scheduled-run health::Could not check ${repo} for disabled scheduled ` +
        "workflows: repo metadata carried no boolean `private` field. Treating the result as " +
        "UNKNOWN, not as healthy.",
    );
  }

  // An UNKNOWN dead-workflow OR push-lane answer must not read as success:
  // the audit could not do its job, which is exactly the "red means needs a
  // human" case. Applied to the success paths only — a real error already
  // returns its own code.
  const done = (code) => (code === 0 && (deadProbeFailed || pushProbeFailed) ? 1 : code);

  // Suppressed runs are not alerted on, but a systemic runner outage must not
  // become invisible — say how many, and which workflows they belong to.
  if (starved.length > 0) {
    const workflows = [...new Set(starved.map(workflowKey))].join(", ");
    console.log(
      `::notice title=Scheduled-run health::Suppressed ${starved.length} scheduled run(s) that never got a runner (cancelled before assignment): ${workflows}.`,
    );
  }

  if (pushStarved.length > 0) {
    const workflows = [...new Set(pushStarved.map(workflowKey))].join(", ");
    console.log(
      `::notice title=Scheduled-run health::Suppressed ${pushStarved.length} push run(s) that never got a runner (cancelled before assignment): ${workflows}.`,
    );
  }

  if (dead.length > 0) {
    console.log(
      `::notice title=Scheduled-run health::${dead.length} scheduled workflow(s) can no longer ` +
        `fire: ${dead.map((w) => `${workflowKey(w)} (${w.state})`).join(", ")}.`,
    );
  }

  // Defensive early warning only — NOT a display cap. Measured volume is
  // ~96 push runs/48h on the busiest repo, well under MAX_LINKS_PER_WORKFLOW's
  // existing "…and N more" cap; this just flags if that measurement is ever
  // wrong by an order of magnitude.
  if (pushFailures.length > 100) {
    console.log(
      `::notice title=Scheduled-run health::${pushFailures.length} failing push run(s) in one ` +
        `scan on ${repo} — high enough that a display cap may become necessary.`,
    );
  }

  const summary =
    `${failures.length} failing scheduled run(s) + ${pushFailures.length} failing push run(s) ` +
    `in the last ${windowHours}h on ${repo}` +
    (dead.length > 0 ? ` + ${dead.length} disabled scheduled workflow(s)` : "");

  if (failures.length === 0 && dead.length === 0 && pushFailures.length === 0) {
    // NEVER close on an unknown answer — that is the #258 bug exactly: the
    // audit closed a live alert because it could not see the dead workflows
    // (or, now, the push lane).
    if (issue && (deadProbeFailed || pushProbeFailed)) {
      const unknownParts = [];
      if (deadProbeFailed) unknownParts.push("the dead-workflow check");
      if (pushProbeFailed) unknownParts.push("the push-run check");
      console.log(
        `::notice title=Scheduled-run health::Leaving tracking issue #${issue.number} OPEN — ` +
          `no failing runs, but ${unknownParts.join(" and ")} did not complete, so a clean ` +
          "window is unproven.",
      );
      return done(0);
    }
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
    console.log(`OK — ${summary}. All scheduled and push workflows healthy.`);
    return done(0);
  }

  // Findings: the ISSUE is the alert; this run stays green once it is filed.
  if (!issue) {
    console.log(`::notice title=Scheduled-run health::${summary} — opening the tracking issue.`);
    if (!dryRun) {
      ensureLabel(repo, label);
      try {
        const created = JSON.parse(
          ghApi(`repos/${repo}/issues`, {
            fields: [
              `title=${ISSUE_TITLE}`,
              `body=${buildIssueBody({
                repo,
                windowHours,
                runs: failures,
                dead,
                pushRuns: pushFailures,
                defaultBranch,
                nowIso,
              })}`,
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
      console.log(
        `(dry-run) would open "${ISSUE_TITLE}" [${label}] with:\n` +
          renderSections(failures, dead, pushFailures, defaultBranch).join("\n"),
      );
    }
    console.log(`ALERT FILED — ${summary}.`);
    return done(0);
  }

  let reported, reportedDead;
  try {
    const texts = [issue.body, ...listIssueComments(repo, issue.number).map((c) => c.body)];
    reported = extractReportedRunIds(texts);
    reportedDead = extractReportedDeadWorkflows(texts);
  } catch (e) {
    console.error(`audit-scheduled-runs: failed to read issue #${issue.number}: ${e.message}`);
    return 1;
  }
  // Both lanes' runs dedupe through the SAME reported-run-id set (push runs
  // carry real run ids, unlike dead workflows, so there is no need for a
  // second hidden channel — see hiddenRunIdsBlock).
  const fresh = failures.filter((r) => !reported.has(String(r.id)));
  const freshPush = pushFailures.filter((r) => !reported.has(String(r.id)));
  // A dead workflow stays dead for as long as nobody re-enables it, so it is
  // reported ONCE per tracking issue — re-comment it daily and the alert
  // becomes the noise it exists to cut through.
  const freshDead = dead.filter((w) => !reportedDead.has(workflowKey(w)));
  if (fresh.length === 0 && freshDead.length === 0 && freshPush.length === 0) {
    console.log(
      `OK — ${summary}; all already reported on tracking issue #${issue.number}. Nothing new.`,
    );
    return done(0);
  }
  const newCount = fresh.length + freshDead.length + freshPush.length;
  console.log(
    `::notice title=Scheduled-run health::${summary} — ${newCount} new; ` +
      `commenting on issue #${issue.number}.`,
  );
  if (!dryRun) {
    try {
      ghApi(`repos/${repo}/issues/${issue.number}/comments`, {
        fields: [
          `body=${buildComment({
            windowHours,
            runs: fresh,
            dead: freshDead,
            pushRuns: freshPush,
            defaultBranch,
            nowIso,
          })}`,
        ],
      });
    } catch (e) {
      console.error(`audit-scheduled-runs: failed to comment on issue #${issue.number}: ${e.message}`);
      return 1;
    }
  } else {
    console.log(
      `(dry-run) would comment:\n${renderSections(fresh, freshDead, freshPush, defaultBranch).join("\n")}`,
    );
  }
  console.log(
    `ALERT UPDATED — ${summary} (${newCount} newly reported).`,
  );
  return done(0);
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  MARKER,
  ISSUE_TITLE,
  BAD_CONCLUSIONS,
  MAX_LINKS_PER_WORKFLOW,
  DEAD_WORKFLOW_STATES,
  SELF_EVIDENCING_CRON_STATES,
  sinceIso,
  isAlertRun,
  filterAlertRuns,
  isPublicRepo,
  isPrivateRepo,
  isDeadWorkflow,
  stateImpliesCron,
  filterDeadScheduledWorkflows,
  workflowScheduledRunsEndpoint,
  runsForEventEndpoint,
  listRunsForEvent,
  listScheduledRuns,
  listPushRuns,
  hiddenDeadWorkflowsBlock,
  extractReportedDeadWorkflows,
  renderDeadWorkflows,
  renderSections,
  isRunnerStarvedJob,
  isRunnerStarvationRun,
  partitionStarvedRuns,
  runJobsEndpoint,
  workflowKey,
  groupByWorkflow,
  extractReportedRunIds,
  hiddenRunIdsBlock,
  renderFindings,
  buildIssueBody,
  buildComment,
  buildCloseComment,
};
