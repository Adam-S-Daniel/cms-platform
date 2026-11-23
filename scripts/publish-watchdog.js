#!/usr/bin/env node
"use strict";
/*
 * publish-watchdog.js — raise an issue when a CMS publish is stuck.
 *
 * THE PROBLEM (adamdaniel.ai PR 5001, 2026-11-18): every Decap Save/Publish is
 * a pull request on a same-repository `cms/...` branch that auto-merges when
 * its required checks pass. A real post's required check failed and nothing
 * told anyone; the post sat unpublished for a day. The only net was the daily
 * scheduled-run-health audit, which reports a PR left red for 24 hours.
 *
 * THE FIX: a sweep. It classifies each open `cms/` pull request as ignored /
 * in-flight / stuck and opens ONE GitHub issue per stuck PR (the issue
 * notification is the alert; the work label queues it for the fleet worker).
 * An issue stays open while its PR is open and armed (someone pressed Publish),
 * stuck or not, and closes when the PR went live, was closed, or is no longer
 * marked for publishing. The sweep runs on a `repository_dispatch` knock sent
 * by publish-watchdog-signal.yml (after a gating check fails or a production
 * deploy succeeds) and every 6 hours as a catch-all. There is no pull_request
 * trigger on purpose: a job there would be a check run on the pull request,
 * and the editor counts a cancelled or pending check run against the publish.
 * While an armed publish is still in flight after a pass, it looks again at the
 * follow-up minutes (default 5 and 16) so a green-but-unmerged pull request is
 * caught without the cron (a pass is also scheduled when the grace for the newest
 * finished check elapses, up to 25 minutes in); the 60-minute stall rule is not
 * covered by that.
 * Everything but `main` is pure or injected; the CLI talks to GitHub through
 * the `gh` CLI with argv arrays (never a shell string).
 *
 * The issue deliberately omits the PR title and branch name: anyone who can
 * push a branch chooses them. Only the number, API-built URLs and check names
 * (ours) appear.
 *
 * Usage: node scripts/publish-watchdog.js --repo <owner>/<name> [--dry-run]
 *   [--grace-minutes N] [--stall-minutes N] [--issue-label L] [--work-label L]
 *   [--follow-up-minutes "5,16"] [--assignees login,login] [--now <ISO time>]
 *
 * Environment (optional, all three or none): SELF_ALERT_APP_ID,
 * SELF_ALERT_APP_PRIVATE_KEY and SELF_ALERT_REPO. With all three, each newly
 * opened issue also asks <SELF_ALERT_REPO>'s send-self-alert.yml workflow to
 * email its owner, as a GitHub App installed on that repository. The key comes
 * in by environment only, never argv (argv shows in `ps`).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hasE2eSlugSignature } = require("../e2e/public-content.js");

// How long "every check finished" (or a cancelled run with no replacement)
// must hold before it counts. Three minutes, the editor's own STALL_GRACE_MIN:
// native auto-merge fires seconds after the last check, so three settled
// minutes means the merge is not coming. It was 15 at first, and then the
// follow-up passes (5 and 16 minutes after the first) usually ran BEFORE the
// grace had elapsed and the publish waited for an unrelated later sweep.
const DEFAULT_GRACE_MINUTES = 3;
const DEFAULT_STALL_MINUTES = 60;
const DEFAULT_FOLLOW_UPS = [5, 16];
// The latest a follow-up pass may be scheduled, minutes after the first pass
// (the same bound --follow-up-minutes enforces, inside the job's 30-minute budget).
const FOLLOW_UP_CAP_MINUTES = 25;
// How long a required context with no check run at all counts as "GitHub has not
// created it yet", aged from the pull request's last update. GitHub can take
// several minutes to start a workflow run; after this the context is treated as
// missing for good and the publish is stuck.
const MISSING_CONTEXT_WAIT_MINUTES = 10;
const GH_TIMEOUT_MS = 30000;
const MAX_CHECK_RUN_PAGES = 10;
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);
const SKIP_LABELS = new Set(["on-hold", "automated-test"]);
const ARMED_LABELS = new Set(["cms/ready", "decap-cms/pending_publish"]);

function labelNames(pr) {
  return ((pr && pr.labels) || []).map((l) => (typeof l === "string" ? l : l && l.name));
}

function isTestFixturePath(file) {
  const p = String(file);
  const base = path.posix.basename(p);
  if (p.startsWith("_e2e/") || p.includes("/_e2e/")) return true;
  if (base.startsWith("e2e-")) return true;
  if ((p.startsWith("_posts/") || p.includes("/_posts/")) && hasE2eSlugSignature({ filename: base })) {
    return true;
  }
  return false;
}

function isArmed(pr, labels) {
  if (pr.auto_merge) return true;
  return labels.some((l) => ARMED_LABELS.has(l));
}

function ts(value) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

// Newest run per check name: the larger id is the newer run (ids grow with
// creation, and a queued re-run has no started_at yet).
function newestPerName(checkRuns) {
  const best = new Map();
  for (const run of checkRuns || []) {
    const cur = best.get(run.name);
    if (!cur || Number(run.id) > Number(cur.id)) best.set(run.name, run);
  }
  return [...best.values()];
}

function classifyPublish({
  pr,
  checkRuns,
  requiredContexts,
  statusContexts,
  files,
  nowMs,
  graceMinutes,
  stallMinutes,
  branchSha,
  incomplete,
} = {}) {
  const grace = graceMinutes === undefined || graceMinutes === null ? DEFAULT_GRACE_MINUTES : graceMinutes;
  const ignored = (reason) => ({ state: "ignored", reason, failing: [] });
  const labels = labelNames(pr);

  if (pr.state !== "open") return ignored("The pull request is not open.");
  if (pr.draft) return ignored("The pull request is a draft.");
  const headRepo = pr.head && pr.head.repo && pr.head.repo.full_name;
  const baseRepo = pr.base && pr.base.repo && pr.base.repo.full_name;
  if (!headRepo || headRepo !== baseRepo) return ignored("The branch lives in a fork.");
  const ref = (pr.head && pr.head.ref) || "";
  if (!ref.startsWith("cms/")) return ignored("Not a CMS publish branch.");
  if (labels.some((l) => SKIP_LABELS.has(l))) return ignored("Held or marked as an automated test.");
  if (Array.isArray(files) && files.length > 0 && files.every(isTestFixturePath)) {
    return ignored("Only test fixtures changed.");
  }
  if (!isArmed(pr, labels)) return ignored("Nobody has pressed Publish yet.");

  const stall = stallMinutes === undefined || stallMinutes === null ? DEFAULT_STALL_MINUTES : stallMinutes;
  const updatedAt = ts(pr.updated_at);

  // GitHub updates a pull request's head.sha a moment after its branch moves,
  // so check runs read for the old head describe a commit that is already
  // replaced; and a partial list of check runs must never read as "every check
  // finished". Both are in flight while the pull request is young, stuck once
  // GitHub has not caught up for the stall window. An unknown branch tip is
  // not a mismatch.
  const lagging =
    (typeof branchSha === "string" && branchSha !== (pr.head && pr.head.sha)) || !!incomplete;
  if (lagging) {
    if (updatedAt !== null && Number.isFinite(nowMs) && nowMs - updatedAt >= stall * 60 * 1000) {
      return {
        state: "stuck",
        reason: `GitHub has not caught up with this pull request for more than ${stall} minutes.`,
        failing: [],
        lagging: true,
        stallMinutes: stall,
      };
    }
    return { state: "in-flight", reason: "GitHub is still catching up with this pull request.", failing: [] };
  }
  const newest = newestPerName(checkRuns);
  // An empty list of required contexts is as unknown as a missing one.
  const required = Array.isArray(requiredContexts) && requiredContexts.length > 0 ? requiredContexts : null;
  // A `cancelled` run is usually a concurrency group replacing it with a newer
  // run that has not registered yet (the editorial workflow does this on every
  // label), so by itself it is not a failure until it has stayed the newest
  // run of its name for the grace window. Every other bad conclusion is final
  // the moment it lands.
  const settled = (r) => {
    if (r.conclusion !== "cancelled") return true;
    const t = ts(r.completed_at);
    return t !== null && Number.isFinite(nowMs) && nowMs - t >= grace * 60 * 1000;
  };
  const failing = newest
    .filter(
      (r) =>
        r.status === "completed" &&
        FAILING_CONCLUSIONS.has(r.conclusion) &&
        settled(r) &&
        (required === null || required.includes(r.name)),
    )
    .map((r) => ({ name: r.name, conclusion: r.conclusion, url: r.html_url }));
  const unfinished = newest.filter((r) => r.status !== "completed");
  // With a readable required list a required failure alerts at once. Without one
  // every failure counts, but only once nothing is still running, so a failing
  // optional check on a pull request about to merge does not alert.
  if (failing.length > 0 && (required !== null || unfinished.length === 0)) {
    return { state: "stuck", reason: "A required check failed.", failing };
  }
  if (unfinished.length > 0) {
    // In flight, but not forever: a check unfinished for the stall window (a
    // hung job, or one parked on an approval) is stuck. A run with no usable
    // start time is aged from the pull request's last update; with neither, no
    // alert.
    let oldest = null;
    for (const r of unfinished) {
      const t = ts(r.started_at) !== null ? ts(r.started_at) : updatedAt;
      if (t !== null && (oldest === null || t < oldest)) oldest = t;
    }
    if (oldest !== null && Number.isFinite(nowMs) && nowMs - oldest >= stall * 60 * 1000) {
      return {
        state: "stuck",
        reason: `A check has been waiting for more than ${stall} minutes.`,
        failing: [],
        stallMinutes: stall,
        waiting: unfinished.map((r) => ({ name: r.name, status: r.status, url: r.html_url })),
      };
    }
    return { state: "in-flight", reason: "Checks are still running.", failing: [] };
  }
  // A required context that has no check run at all is not "finished": GitHub
  // may not have created its run yet. It is in flight for a bounded time aged
  // from the pull request's last update; after that the issue names it.
  // A context can also be reported as a commit status (the statuses API), not
  // a check run; one that has a status is not missing.
  const statuses = Array.isArray(statusContexts) ? statusContexts : [];
  const missing =
    required === null
      ? []
      : required.filter((c) => !newest.some((r) => r.name === c) && !statuses.includes(c));
  if (missing.length > 0 && updatedAt !== null && Number.isFinite(nowMs)) {
    const due = updatedAt + MISSING_CONTEXT_WAIT_MINUTES * 60 * 1000;
    if (nowMs >= due) {
      return { state: "stuck", reason: "A required check never started.", failing: [], missing };
    }
    return {
      state: "in-flight",
      reason: "A required check has not started yet.",
      failing: [],
      nextPassAtMs: due,
    };
  }
  let latest = null;
  if (newest.length === 0) {
    latest = updatedAt;
  } else {
    for (const r of newest) {
      const t = ts(r.completed_at);
      if (t !== null && (latest === null || t > latest)) latest = t;
    }
  }
  if (latest !== null && Number.isFinite(nowMs) && nowMs - latest >= grace * 60 * 1000) {
    return {
      state: "stuck",
      reason: "Every check finished but the pull request has not merged.",
      failing: [],
    };
  }
  // The pass that will see the grace elapse, so a caller can schedule it.
  return {
    state: "in-flight",
    reason: "Waiting for the merge.",
    failing: [],
    ...(latest !== null ? { nextPassAtMs: latest + grace * 60 * 1000 } : {}),
  };
}

// The marker is the first line of the body. With a head sha it also records
// which commit the alert was raised for, so a human closing the issue is
// respected until the pull request gets a new commit.
function issueMarker(prNumber, sha) {
  return /^[0-9a-f]{40}$/.test(String(sha || ""))
    ? `<!-- publish-watchdog:pr=${prNumber} sha=${sha} -->`
    : `<!-- publish-watchdog:pr=${prNumber} -->`;
}

const ISSUE_AUTHOR = "github-actions[bot]";
const MARKER_RE = /<!-- publish-watchdog:pr=(\d+)(?: sha=([0-9a-f]{40}))? -->/;
// When the SWEEP closes an issue it rewrites the marker to this form, which
// MARKER_RE does not match. So only an issue a person closed (marker intact)
// keeps suppressing a new alert for the same commit; one the watchdog closed
// itself (the pull request was put on hold, say, then released still stuck)
// does not.
const RESOLVED_MARKER_RE = /<!-- publish-watchdog-resolved:pr=(\d+)(?: sha=([0-9a-f]{40}))? -->/;
// The inverse, for a person who reopened an issue the sweep had closed.
function restoreMarker(body) {
  return String(body || "").replace(/<!-- publish-watchdog-resolved:pr=/g, "<!-- publish-watchdog:pr=");
}

function resolveMarker(body) {
  return String(body || "").replace(/<!-- publish-watchdog:pr=/g, "<!-- publish-watchdog-resolved:pr=");
}

function stallPhrase(w, stall) {
  if (w.status === "waiting") return "waiting for someone to approve it";
  if (["queued", "pending", "requested"].includes(w.status)) return "has not started";
  return `has been running for more than ${stall} minutes`;
}

function renderIssue({ repo, pr, verdict }) {
  const prUrl = `https://github.com/${repo}/pull/${pr.number}`;
  const failing = (verdict && verdict.failing) || [];
  const waiting = (verdict && verdict.waiting) || [];
  const stall = (verdict && verdict.stallMinutes) || DEFAULT_STALL_MINUTES;
  let checks;
  let advice;
  if (waiting.length > 0) {
    checks =
      "These checks have not finished:\n\n" +
      waiting.map((w) => `- [${w.name}](${w.url}): ${stallPhrase(w, stall)}`).join("\n");
    advice =
      "What to do: open the pull request, then each check above, and approve or start it " +
      "(or cancel and re-run it if it is hung). Nothing was lost; the content is still in the editor.";
  } else if (verdict && Array.isArray(verdict.missing) && verdict.missing.length > 0) {
    checks = "These required checks never started:\n\n" + verdict.missing.map((n) => `- ${n}`).join("\n");
    advice =
      "What to do: open the pull request and check why those workflows did not run " +
      "(push an empty commit or re-run them). Nothing was lost; the content is still in the editor.";
  } else if (verdict && verdict.lagging) {
    checks = `GitHub has not caught up with this pull request for more than ${stall} minutes.`;
    advice =
      "What to do: open the pull request and check that its latest commit has started its checks. " +
      "Nothing was lost; the content is still in the editor.";
  } else {
    checks =
      failing.length > 0
        ? "These checks failed:\n\n" + failing.map((f) => `- [${f.name}](${f.url}): ${f.conclusion}`).join("\n")
        : "Every check finished, but the pull request did not merge.";
    advice =
      "What to do: open the pull request. A red check names the problem. " +
      "Nothing was lost; the content is still in the editor.";
  }
  const body = [
    issueMarker(pr.number, pr.head && pr.head.sha),
    "",
    "A change that someone published from the editor has not gone live.",
    "",
    `Pull request: ${prUrl}`,
    "",
    checks,
    "",
    advice,
    "",
    "This issue closes by itself when the change goes live.",
  ].join("\n");
  return { title: `Publish stuck: pull request #${pr.number} has not gone live`, body };
}

// Our own issues only: authored by the Actions bot and carrying a marker.
function parseMarker(issue) {
  if (!issue || !issue.user || issue.user.login !== ISSUE_AUTHOR) return null;
  const m = MARKER_RE.exec(issue.body || "");
  return m ? { pr: Number(m[1]), sha: m[2] || null } : null;
}

// Our own issue the sweep closed (marker rewritten to the resolved form).
function parseResolvedMarker(issue) {
  if (!issue || !issue.user || issue.user.login !== ISSUE_AUTHOR) return null;
  const m = RESOLVED_MARKER_RE.exec(issue.body || "");
  return m ? { pr: Number(m[1]), sha: m[2] || null } : null;
}

// `issues` are the watchdog's issues in ANY state. An issue closes when its pull
// request went live, was closed, or is no longer a publish anyone is waiting on
// (`ignored`); it stays open while the pull request is open and armed, stuck or
// not. Only open issues close. No new issue opens for a pull request and head
// commit that already has one in any state (a human closing the alert is
// respected until the pull request gets a new commit; a marker without a sha
// matches any commit). A pull request in `skipped` (its state could not be read
// this run) leaves its issues alone. `pending` counts armed pull requests still
// in flight.
function planSweep({ prs, issues, nowMs, graceMinutes, stallMinutes, skipped }) {
  const skip = new Set([...(skipped || [])].map(Number));
  const stuck = new Map();
  const waiting = new Set();
  let pending = 0;
  let retryAtMs = null;
  for (const entry of prs || []) {
    const verdict = classifyPublish({
      pr: entry.pr,
      checkRuns: entry.checkRuns,
      requiredContexts: entry.requiredContexts,
      statusContexts: entry.statusContexts,
      files: entry.files,
      branchSha: entry.branchSha,
      incomplete: entry.incomplete,
      nowMs,
      graceMinutes,
      stallMinutes,
    });
    if (verdict.state === "stuck") stuck.set(entry.pr.number, { pr: entry.pr, verdict });
    if (verdict.state !== "ignored") waiting.add(entry.pr.number);
    if (verdict.state === "in-flight") {
      pending++;
      if (Number.isFinite(verdict.nextPassAtMs) && (retryAtMs === null || verdict.nextPassAtMs < retryAtMs)) {
        retryAtMs = verdict.nextPassAtMs;
      }
    }
  }
  const parsed = [];
  for (const issue of issues || []) {
    const mk = parseMarker(issue);
    if (mk) parsed.push({ ...mk, number: issue.number, open: !issue.state || issue.state === "open" });
  }
  // An issue the sweep closed and a person reopened: its marker is in the
  // resolved form, so it is recognized only while open.
  const reopened = [];
  for (const issue of issues || []) {
    const mk = parseResolvedMarker(issue);
    if (mk && (!issue.state || issue.state === "open")) reopened.push({ ...mk, number: issue.number });
  }
  const open = [];
  const restore = [];
  for (const [n, entry] of stuck) {
    if (skip.has(n)) continue;
    const sha = entry.pr.head && entry.pr.head.sha;
    const fits = (x) => x.pr === n && (x.sha === null || x.sha === sha);
    const back = reopened.filter(fits);
    // Its pull request is stuck: make a reopened issue a live alert again (so
    // it closes by itself later) instead of opening a second issue beside it.
    // Exactly one alert stays live: a live issue already there wins, and among
    // several reopened ones the lowest number does; the rest are left alone.
    if (back.length > 0 && !parsed.some(fits)) {
      const keep = back.reduce((a, b) => (b.number < a.number ? b : a));
      restore.push({ issueNumber: keep.number, prNumber: n });
    }
    if (!parsed.some(fits) && back.length === 0) open.push(entry);
  }
  const close = [];
  for (const x of parsed) {
    if (x.open && !waiting.has(x.pr) && !skip.has(x.pr)) close.push({ issueNumber: x.number, prNumber: x.pr });
  }
  return { open, close, restore, pending, retryAtMs };
}

// Run `runOnce` (one full sweep) and, while armed publishes are still in flight,
// again at each follow-up (minutes since the first pass). Bounded: it stops
// after the last follow-up whatever the state. A pass that throws does not
// cancel the remaining follow-ups. All time and sleeping are injected.
//
// `runOnce` may also resolve `retryAtMs`: the moment the grace for the newest
// finished check elapses. A pass is then scheduled at that moment when it comes
// before the next fixed follow-up (or after the last one), but never later than
// FOLLOW_UP_CAP_MINUTES after the first pass, so a slow publish that goes green
// late is still judged without waiting for the next sweep.
async function sweepWithFollowUps({ runOnce, sleep, now, followUpMinutes = [5, 16] }) {
  const start = now();
  const cap = start + FOLLOW_UP_CAP_MINUTES * 60000;
  let passes = 0;
  let failures = 0;
  let next = 0;
  let extra = 0;
  for (;;) {
    passes++;
    let pending = null;
    let retryAt = null;
    try {
      const res = await runOnce();
      pending = res.pending;
      retryAt = Number.isFinite(res.retryAtMs) ? res.retryAtMs : null;
    } catch (err) {
      failures++;
    }
    if (pending === 0 || followUpMinutes.length === 0) break;
    const fixedAt = next < followUpMinutes.length ? start + followUpMinutes[next] * 60000 : null;
    const retryOk = retryAt !== null && retryAt > now() && retryAt <= cap && extra < 3;
    if (retryOk && (fixedAt === null || retryAt < fixedAt)) {
      extra++;
      await sleep(retryAt - now());
    } else if (fixedAt !== null) {
      next++;
      await sleep(Math.max(0, fixedAt - now()));
    } else {
      break;
    }
  }
  return { passes, failures };
}

// ── gh-backed plumbing ──────────────────────────────────────────────────────

function ghError(what, err) {
  const stderr = err && err.stderr ? String(err.stderr) : "";
  const m = /HTTP (\d{3})/.exec(stderr);
  const timedOut = !!(err && err.code === "ETIMEDOUT");
  const e = new Error(
    `${what} failed (status ${m ? m[1] : "unknown"}, ${timedOut ? "timeout" : (err && err.name) || "Error"})`,
  );
  e.status = m ? m[1] : null;
  return e;
}

// `token` replaces the credential for this ONE call (the self-alert dispatch,
// which goes to another repository); every other call uses the job's own.
function ghApi(what, endpoint, { method, body, token } = {}) {
  const args = ["api", endpoint];
  if (method) args.push("-X", method);
  if (body !== undefined) args.push("--input", "-");
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: GH_TIMEOUT_MS,
      input: body !== undefined ? JSON.stringify(body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      ...(token ? { env: { ...process.env, GH_TOKEN: token } } : {}),
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    throw ghError(what, err);
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// A numeric flag: absent gives the default; present but empty or non-numeric
// is a usage error.
function numberFlag(argv, name, fallback) {
  if (!argv.includes(name)) return fallback;
  const raw = flag(argv, name);
  if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw)) {
    const e = new Error(`${name} needs a non-negative number.`);
    e.usage = true;
    throw e;
  }
  return Number(raw);
}

// A comma-separated list of non-negative numbers. Absent gives the default; an
// empty value is an empty list (disabled); anything non-numeric is a usage error.
function listFlag(argv, name, fallback) {
  if (!argv.includes(name)) return fallback;
  const raw = flag(argv, name);
  if (raw === undefined) {
    const e = new Error(`${name} needs a value (use "" to disable).`);
    e.usage = true;
    throw e;
  }
  if (raw === "") return [];
  const parts = raw.split(",");
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    const e = new Error(`${name} needs comma-separated non-negative numbers.`);
    e.usage = true;
    throw e;
  }
  const values = parts.map(Number);
  // Bounded, so a caller's value cannot outlast the job's timeout (which
  // would end the run `cancelled`): at most four follow-ups, none later than
  // 25 minutes after the first pass.
  if (name === "--follow-up-minutes" && (values.length > 4 || values.some((v) => v > 25))) {
    const e = new Error(`${name} takes at most four values, none above 25.`);
    e.usage = true;
    throw e;
  }
  return values;
}

function listPages(what, endpointBase, maxPages = 20) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = endpointBase.includes("?") ? "&" : "?";
    const items = ghApi(what, `${endpointBase}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(items)) break;
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

// Every check run of a commit. `incomplete` is true when more exist than were
// read (page cap reached, or fewer than the reported total came back).
function readCheckRuns(repo, sha, prNumber) {
  const runs = [];
  let total = null;
  let lastFull = false;
  for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page++) {
    const res = ghApi(
      `reading check runs for #${prNumber}`,
      `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    const items = (res && Array.isArray(res.check_runs) && res.check_runs) || [];
    if (res && typeof res.total_count === "number") total = Math.max(total === null ? 0 : total, res.total_count);
    runs.push(...items);
    lastFull = items.length >= 100;
    if (items.length === 0 || (total !== null && runs.length >= total) || (total === null && !lastFull)) break;
  }
  const incomplete = total !== null ? runs.length < total : lastFull;
  return { runs, incomplete };
}

// The contexts reported as commit statuses (not check runs) on a commit, or
// null when they cannot be read.
function readStatusContexts(repo, sha, prNumber) {
  try {
    const res = ghApi(`reading commit statuses for #${prNumber}`, `repos/${repo}/commits/${sha}/status?per_page=100`);
    const list = (res && Array.isArray(res.statuses) && res.statuses) || [];
    return list.map((st) => st && st.context).filter((c) => typeof c === "string");
  } catch (err) {
    console.log(`::warning::${err.message}`);
    return null;
  }
}

function readBranchSha(repo, ref) {
  try {
    const encoded = String(ref).split("/").map(encodeURIComponent).join("/");
    const res = ghApi("reading the branch", `repos/${repo}/git/ref/heads/${encoded}`);
    const sha = res && res.object && res.object.sha;
    return typeof sha === "string" ? sha : null;
  } catch (err) {
    return null;
  }
}

function createIssue(repo, pr, verdict, issueLabel, workLabel, assignees) {
  const { title, body } = renderIssue({ repo, pr, verdict });
  const labels = [issueLabel];
  if (workLabel) labels.push(workLabel);
  const first = { title, body, labels };
  if (assignees && assignees.length > 0) first.assignees = assignees;
  // Only a validation failure (a missing work label, an assignee who cannot be
  // assigned) is retried, and only when there is an optional part to drop; any
  // other failure may follow a create that did happen server-side. The
  // assignees go first (the likelier culprit), so a bad assignee does not also
  // cost the work label; the label is dropped only if that retry is a 422 too.
  const attempts = [first];
  if (first.assignees) attempts.push({ title, body, labels });
  if (workLabel) attempts.push({ title, body, labels: [issueLabel] });
  let created;
  for (let i = 0; i < attempts.length; i++) {
    try {
      created = ghApi(`opening an issue for #${pr.number}${i === 0 ? "" : " (retry)"}`, `repos/${repo}/issues`, {
        method: "POST",
        body: attempts[i],
      });
      break;
    } catch (err) {
      if (err.status !== "422" || i === attempts.length - 1) throw err;
    }
  }
  console.log(`  opened issue #${created && created.number} for pull request #${pr.number}`);
  return created && Number.isInteger(created.number) ? created.number : null;
}

// ---- Self-alert email ----
//
// The issue is the alert of record; this asks a second repository's
// `send-self-alert.yml` workflow to email its owner about it. That repository
// is PUBLIC, so the subject and body below are public too: they carry the
// site repository's name, two numbers and two links, and nothing a pull
// request author controls (no title, branch or check name).
//
// The credential is a GitHub App installed on that repository only. A token is
// minted when the first email of a run is needed (most runs open no issue and
// mint nothing), narrowed to that one repository and `actions: write`, which is
// what starting a workflow needs.
const SELF_ALERT_WORKFLOW = "send-self-alert.yml";
const SELF_ALERT_SUBJECT_MAX = 200;
// An owner login and a repository name, as GitHub allows them (a managed
// user's login may carry `_`). The value is placed in an API path, so `.` and
// `..` segments are refused.
const SELF_ALERT_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

function renderSelfAlert({ repo, prNumber, issueNumber }) {
  const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
  const tail = `, via "Publish watchdog" ${issueUrl}`;
  // The longest form that fits the workflow's 200-character cap. The last one
  // always does; the body carries both links either way.
  const subject = [
    `Publish stuck on ${repo}: pull request #${prNumber} has not gone live${tail}`,
    `Publish stuck: pull request #${prNumber}${tail}`,
    `Publish stuck: pull request #${prNumber}, via "Publish watchdog"`,
  ].find((candidate, at, all) => candidate.length <= SELF_ALERT_SUBJECT_MAX || at === all.length - 1);
  const body = [
    `A change published from the editor on ${repo} has not gone live.`,
    "",
    `What was found: ${issueUrl}`,
    `Pull request: https://github.com/${repo}/pull/${prNumber}`,
    "",
    "What to do: open the issue. It lists the checks that failed or are still waiting. " +
      "Nothing was lost; the content is still in the editor. " +
      "The issue closes by itself when the change goes live.",
  ].join("\n");
  return { subject, body };
}

// Runs scripts/mint-app-token.js (the platform's one App-token minter) as a
// child and returns the token. The child writes the token to the file named by
// GITHUB_OUTPUT, so it gets a private file of its own here, removed afterwards;
// its log is not forwarded (a failure reports the HTTP status only). The
// outcome is kept on `selfAlert` for the rest of the run, success or failure:
// a token lasts an hour and a job 30 minutes, and a mint that failed once is
// not tried again for the next issue (each try can wait out a 30-second
// timeout, inside a job with a fixed budget).
function mintSelfAlertToken(selfAlert) {
  if (selfAlert.token) return selfAlert.token;
  if (selfAlert.mintError) throw new Error(selfAlert.mintError);
  try {
    selfAlert.token = runSelfAlertMint(selfAlert);
  } catch (err) {
    selfAlert.mintError = err.message;
    throw err;
  }
  return selfAlert.token;
}

function runSelfAlertMint(selfAlert) {
  const [owner, name] = selfAlert.repo.split("/");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-watchdog-"));
  const out = path.join(dir, "output");
  try {
    fs.writeFileSync(out, "", { mode: 0o600 });
    try {
      execFileSync(
        process.execPath,
        [
          path.join(__dirname, "mint-app-token.js"),
          "--owner", owner,
          "--repo", name,
          "--repositories", name,
          "--permissions", "actions=write",
        ],
        {
          encoding: "utf8",
          timeout: GH_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            APP_CLIENT_ID: selfAlert.appId,
            APP_ID: "",
            APP_PRIVATE_KEY: selfAlert.privateKey,
            GITHUB_OUTPUT: out,
          },
        },
      );
    } catch (err) {
      const m = /HTTP (\d{3})/.exec(String((err && err.stdout) || ""));
      throw new Error(`minting the email token failed (status ${m ? m[1] : "unknown"})`);
    }
    const m = /^token=(\S+)$/m.exec(fs.readFileSync(out, "utf8"));
    if (!m) throw new Error("minting the email token returned no token");
    // The runner hides this value in every later log line.
    console.log(`::add-mask::${m[1]}`);
    return m[1];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Never throws: a failed email must not fail the sweep or hide the issue. The
// failure is a warning on the run AND a comment on the issue, so a broken
// credential is seen by whoever opens the alert.
function sendSelfAlert(selfAlert, { repo, prNumber, issueNumber }) {
  if (!selfAlert || !Number.isInteger(issueNumber)) return;
  try {
    const { subject, body } = renderSelfAlert({ repo, prNumber, issueNumber });
    const token = mintSelfAlertToken(selfAlert);
    const target = ghApi("reading the self-alert repository", `repos/${selfAlert.repo}`, { token });
    const ref = target && target.default_branch;
    if (typeof ref !== "string" || ref === "") throw new Error("the self-alert repository has no default branch");
    ghApi(
      "requesting the self-alert email",
      `repos/${selfAlert.repo}/actions/workflows/${SELF_ALERT_WORKFLOW}/dispatches`,
      { method: "POST", body: { ref, inputs: { subject, body } }, token },
    );
    console.log(`  self-alert email requested for pull request #${prNumber}`);
  } catch (err) {
    console.log(`::warning::The self-alert email for pull request #${prNumber} was not sent: ${err.message}.`);
    try {
      ghApi(`noting the unsent email on issue #${issueNumber}`, `repos/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: {
          body:
            `The alert email for this issue was not sent (${err.message}). ` +
            "See \"Stuck-publish email\" in the platform's docs/CONSUMER-PROVISIONING.md.",
        },
      });
    } catch (noteErr) {
      console.log(`::warning::${noteErr.message}.`);
    }
  }
}

// The email is on only when ALL THREE values are present. The key is read here
// once and removed from the environment, so no other child process inherits
// it; only the minting child is handed it.
function readSelfAlertConfig(env) {
  const appId = (env.SELF_ALERT_APP_ID || "").trim();
  const privateKey = env.SELF_ALERT_APP_PRIVATE_KEY || "";
  const repo = (env.SELF_ALERT_REPO || "").trim();
  delete env.SELF_ALERT_APP_PRIVATE_KEY;
  const present = [appId, privateKey, repo].filter((v) => v !== "").length;
  if (present === 0) return { selfAlert: null, note: null };
  if (present < 3) {
    return {
      selfAlert: null,
      note:
        "::notice::Self-alert email is off: it needs the SELF_ALERT_APP_PRIVATE_KEY secret and the " +
        "SELF_ALERT_APP_ID and SELF_ALERT_REPO variables, all three. Issues are still opened.",
    };
  }
  if (!SELF_ALERT_REPO_RE.test(repo)) {
    return {
      selfAlert: null,
      note: "::warning::SELF_ALERT_REPO is not an <owner>/<name> repository; self-alert email is off.",
    };
  }
  return { selfAlert: { appId, privateKey, repo }, note: null };
}

function closeWatchdogIssue(repo, issueNumber, prNumber, body) {
  ghApi(`commenting on issue #${issueNumber}`, `repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: {
      body:
        `Pull request #${prNumber} is no longer waiting to publish ` +
        "(it went live, was closed, or is no longer marked for publishing). Closing.",
    },
  });
  ghApi(`closing issue #${issueNumber}`, `repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    body:
      typeof body === "string" && body !== ""
        ? { state: "closed", state_reason: "completed", body: resolveMarker(body) }
        : { state: "closed", state_reason: "completed" },
  });
}

function readRequiredContexts(repo) {
  try {
    const meta = ghApi("reading the default branch", `repos/${repo}`);
    const rules = ghApi(
      "reading branch rules",
      `repos/${repo}/rules/branches/${encodeURIComponent(meta.default_branch)}`,
    );
    const out = [];
    for (const rule of rules || []) {
      if (rule.type !== "required_status_checks") continue;
      for (const c of (rule.parameters && rule.parameters.required_status_checks) || []) out.push(c.context);
    }
    return out;
  } catch (err) {
    console.log(`::warning::${err.message}; treating every failing check as required.`);
    return null;
  }
}

const ASSIGNEES_RE = /^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$/;
const SINCE_DAYS = 14;

// One full sweep: read, plan, act. Resolves { pending }; throws on a failure that
// stops the pass (listing pull requests or issues, an issue write, or every
// armed pull request unreadable).
function sweepOnce({ repo, dryRun, issueLabel, workLabel, assignees, graceMinutes, stallMinutes, nowMs, selfAlert }) {
  const all = listPages("listing open pull requests", `repos/${repo}/pulls?state=open`);
  const candidates = all.filter(
    (pr) =>
      pr &&
      pr.head &&
      typeof pr.head.ref === "string" &&
      pr.head.ref.startsWith("cms/") &&
      pr.head.repo &&
      pr.base &&
      pr.base.repo &&
      pr.head.repo.full_name === pr.base.repo.full_name,
  );
  // Drafts, held, test and unarmed pull requests cost no further API call.
  const armed = candidates.filter(
    (pr) => !pr.draft && !labelNames(pr).some((l) => SKIP_LABELS.has(l)) && isArmed(pr, labelNames(pr)),
  );
  const requiredContexts = armed.length > 0 ? readRequiredContexts(repo) : null;
  const entries = [];
  const skipped = [];
  for (const pr of armed) {
    try {
      const { runs, incomplete } = readCheckRuns(repo, pr.head.sha, pr.number);
      const branchSha = readBranchSha(repo, pr.head.ref);
      const statusContexts =
        Array.isArray(requiredContexts) && requiredContexts.length > 0
          ? readStatusContexts(repo, pr.head.sha, pr.number)
          : null;
      let files = null;
      try {
        const list = ghApi(
          `reading files for #${pr.number}`,
          `repos/${repo}/pulls/${pr.number}/files?per_page=100`,
        );
        // A full page may be truncated; unknown is safer than a wrong "all fixtures".
        files = Array.isArray(list) && list.length < 100 ? list.map((f) => f.filename) : null;
      } catch (err) {
        console.log(`::warning::${err.message}`);
      }
      entries.push({ pr, checkRuns: runs, incomplete, requiredContexts, statusContexts, files, branchSha });
    } catch (err) {
      skipped.push(pr.number);
      console.log(`::warning::skipping pull request #${pr.number}: ${err.message}`);
    }
  }

  // Every OPEN issue, however old (an alert on a pull request stuck for weeks
  // must still be found, or the sweep opens a duplicate and never closes the
  // original), and the CLOSED ones of the last SINCE_DAYS days (a person's
  // close suppresses a new alert for the same commit).
  const since = new Date(nowMs - SINCE_DAYS * 86400000).toISOString();
  const label = encodeURIComponent(issueLabel);
  const issues = [
    ...listPages("listing open issues", `repos/${repo}/issues?state=open&labels=${label}`),
    ...listPages(
      "listing closed issues",
      `repos/${repo}/issues?state=closed&labels=${label}&since=${encodeURIComponent(since)}`,
    ),
  ]
    .filter((i) => !i.pull_request)
    // One entry per issue, whatever the two listings returned.
    .filter((i, at, all) => all.findIndex((j) => j.number === i.number) === at);

  const plan = planSweep({ prs: entries, issues, nowMs, graceMinutes, stallMinutes, skipped });
  console.log(
    `Publish watchdog: ${candidates.length} cms pull request(s), ${armed.length} armed, ` +
      `${skipped.length} skipped, ${plan.open.length} to open, ${plan.close.length} to close, ` +
      `${plan.pending} in flight.`,
  );
  for (const { pr, verdict } of plan.open) {
    const names = [...verdict.failing, ...(verdict.waiting || [])].map((f) => f.name).join(", ");
    console.log(`  stuck: #${pr.number}${names ? ` (checks: ${names})` : ""}`);
  }
  for (const c of plan.close) console.log(`  close: issue #${c.issueNumber} (pull request #${c.prNumber})`);
  for (const c of plan.restore) console.log(`  reopened: issue #${c.issueNumber} (pull request #${c.prNumber}) is a live alert again`);
  if (dryRun) {
    console.log("Dry run: nothing written.");
    return { pending: plan.pending, retryAtMs: plan.retryAtMs };
  }
  for (const { pr, verdict } of plan.open) {
    const issueNumber = createIssue(repo, pr, verdict, issueLabel, workLabel, assignees);
    sendSelfAlert(selfAlert, { repo, prNumber: pr.number, issueNumber });
  }
  const bodyOf = new Map(issues.map((i) => [i.number, i.body]));
  for (const c of plan.restore) {
    ghApi(`restoring the marker on issue #${c.issueNumber}`, `repos/${repo}/issues/${c.issueNumber}`, {
      method: "PATCH",
      body: { body: restoreMarker(bodyOf.get(c.issueNumber)) },
    });
  }
  for (const c of plan.close) closeWatchdogIssue(repo, c.issueNumber, c.prNumber, bodyOf.get(c.issueNumber));
  if (armed.length > 0 && skipped.length === armed.length) {
    throw new Error("every armed pull request failed to read");
  }
  return { pending: plan.pending, retryAtMs: plan.retryAtMs };
}

async function main(argv) {
  // Read (and drop from the environment) before anything else runs.
  const { selfAlert, note: selfAlertNote } = readSelfAlertConfig(process.env);
  const repo = flag(argv, "--repo");
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    console.error("::error::publish-watchdog needs --repo <owner>/<name>.");
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  let graceMinutes;
  let stallMinutes;
  let followUps;
  try {
    graceMinutes = numberFlag(argv, "--grace-minutes", DEFAULT_GRACE_MINUTES);
    stallMinutes = numberFlag(argv, "--stall-minutes", DEFAULT_STALL_MINUTES);
    followUps = listFlag(argv, "--follow-up-minutes", DEFAULT_FOLLOW_UPS);
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 2;
  }
  const issueLabel = flag(argv, "--issue-label") || "publish-stuck";
  const workLabel = flag(argv, "--work-label") === undefined ? "agent-ready" : flag(argv, "--work-label");
  let assignees = [];
  const assigneesRaw = flag(argv, "--assignees");
  if (assigneesRaw) {
    // "alice, bob" is how a person types a list: spaces around a login are
    // dropped before the value is checked.
    const cleaned = assigneesRaw.split(",").map((a) => a.trim()).join(",");
    if (ASSIGNEES_RE.test(cleaned)) assignees = cleaned.split(",");
    else console.log("::warning::--assignees is not a comma-separated list of logins; creating issues without assignees.");
  }
  const nowRaw = flag(argv, "--now");
  const fixedNow = nowRaw === undefined ? null : Date.parse(nowRaw);
  if (nowRaw !== undefined && !Number.isFinite(fixedNow)) {
    console.error("::error::--now is not a parseable time.");
    return 1;
  }
  const now = () => (fixedNow === null ? Date.now() : fixedNow);
  if (selfAlertNote) console.log(selfAlertNote);

  const result = await sweepWithFollowUps({
    runOnce: async () => {
      try {
        return sweepOnce({
          repo,
          dryRun,
          issueLabel,
          workLabel,
          assignees,
          graceMinutes,
          stallMinutes,
          nowMs: now(),
          selfAlert,
        });
      } catch (err) {
        console.error(`::error::${err.message}`);
        throw err;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now,
    // A dry run never sleeps: one pass.
    followUpMinutes: dryRun ? [] : followUps,
  });
  return result.failures === result.passes ? 1 : 0;
}

module.exports = {
  classifyPublish,
  issueMarker,
  renderIssue,
  planSweep,
  sweepWithFollowUps,
  renderSelfAlert,
  readSelfAlertConfig,
  isTestFixturePath,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_STALL_MINUTES,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
