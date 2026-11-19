#!/usr/bin/env node
"use strict";
/*
 * publish-watchdog.js — alert within minutes when a CMS publish is stuck.
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
 * Everything but `main` is pure or injected; the CLI talks to GitHub through
 * the `gh` CLI with argv arrays (never a shell string).
 *
 * The issue deliberately omits the PR title and branch name: anyone who can
 * push a branch chooses them. Only the number, API-built URLs and check names
 * (ours) appear.
 *
 * Usage: node scripts/publish-watchdog.js --repo <owner>/<name> [--dry-run]
 *   [--grace-minutes N] [--stall-minutes N] [--issue-label L] [--work-label L]
 *   [--now <ISO time>]
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hasE2eSlugSignature } = require("../e2e/public-content.js");

const DEFAULT_GRACE_MINUTES = 15;
const DEFAULT_STALL_MINUTES = 60;
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

  // GitHub updates a pull request's head.sha a moment after its branch moves,
  // so check runs read for the old head describe a commit that is already
  // replaced. An unknown branch tip is not a mismatch.
  if (typeof branchSha === "string" && branchSha !== (pr.head && pr.head.sha)) {
    return { state: "in-flight", reason: "A newer commit is still being picked up.", failing: [] };
  }
  // A partial list of check runs must never read as "every check finished".
  if (incomplete) {
    return { state: "in-flight", reason: "Not every check run could be read.", failing: [] };
  }
  const stall = stallMinutes === undefined || stallMinutes === null ? DEFAULT_STALL_MINUTES : stallMinutes;
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
  if (failing.length > 0) {
    return { state: "stuck", reason: "A required check failed.", failing };
  }
  const unfinished = newest.filter((r) => r.status !== "completed");
  if (unfinished.length > 0) {
    // In flight, but not forever: a check that has been unfinished for the stall
    // window (a hung job, or one parked on an approval) is stuck. An unparseable
    // start time never alerts by itself.
    let oldest = null;
    for (const r of unfinished) {
      const t = ts(r.started_at);
      if (t !== null && (oldest === null || t < oldest)) oldest = t;
    }
    if (oldest !== null && Number.isFinite(nowMs) && nowMs - oldest >= stall * 60 * 1000) {
      return {
        state: "stuck",
        reason: `A check has been waiting for more than ${stall} minutes.`,
        failing: [],
        waiting: unfinished.map((r) => ({ name: r.name, status: r.status, url: r.html_url })),
      };
    }
    return { state: "in-flight", reason: "Checks are still running.", failing: [] };
  }
  let latest = null;
  if (newest.length === 0) {
    latest = ts(pr.updated_at);
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
  return { state: "in-flight", reason: "Waiting for the merge.", failing: [] };
}

function issueMarker(prNumber) {
  return `<!-- publish-watchdog:pr=${prNumber} -->`;
}

function renderIssue({ repo, pr, verdict }) {
  const prUrl = `https://github.com/${repo}/pull/${pr.number}`;
  const failing = (verdict && verdict.failing) || [];
  const waiting = (verdict && verdict.waiting) || [];
  let checks;
  let advice;
  if (waiting.length > 0) {
    checks =
      "A check is waiting for someone to approve or start it:\n\n" +
      waiting.map((w) => `- [${w.name}](${w.url}): ${w.status}`).join("\n");
    advice =
      "What to do: open the pull request, then the waiting check, and approve or start it. " +
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
    issueMarker(pr.number),
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

// Only a marker that opens the body counts, so an issue quoting another pull
// request's marker lower down is not mistaken for that pull request's issue.
const MARKER_RE = /^<!-- publish-watchdog:pr=(\d+) -->/;

// An issue closes when its pull request went live, was closed, or is no longer
// a publish anyone is waiting on (`ignored`). It stays open while the pull
// request is open and armed, stuck or not. A pull request in `skipped` (its
// state could not be read this run) leaves its issue alone.
function planSweep({ prs, openIssues, nowMs, graceMinutes, stallMinutes, skipped }) {
  const skip = new Set([...(skipped || [])].map(Number));
  const stuck = new Map();
  const waiting = new Set();
  for (const entry of prs || []) {
    const verdict = classifyPublish({
      pr: entry.pr,
      checkRuns: entry.checkRuns,
      requiredContexts: entry.requiredContexts,
      files: entry.files,
      branchSha: entry.branchSha,
      incomplete: entry.incomplete,
      nowMs,
      graceMinutes,
      stallMinutes,
    });
    if (verdict.state === "stuck") stuck.set(entry.pr.number, { pr: entry.pr, verdict });
    if (verdict.state !== "ignored") waiting.add(entry.pr.number);
  }
  const marked = new Map();
  for (const issue of openIssues || []) {
    const m = MARKER_RE.exec(issue.body || "");
    if (m) marked.set(Number(m[1]), issue.number);
  }
  const open = [];
  for (const [n, entry] of stuck) if (!marked.has(n) && !skip.has(n)) open.push(entry);
  const close = [];
  for (const [n, issueNumber] of marked) {
    if (!waiting.has(n) && !skip.has(n)) close.push({ issueNumber, prNumber: n });
  }
  return { open, close };
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

function ghApi(what, endpoint, { method, body } = {}) {
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

function createIssue(repo, pr, verdict, issueLabel, workLabel) {
  const { title, body } = renderIssue({ repo, pr, verdict });
  const labels = [issueLabel];
  if (workLabel) labels.push(workLabel);
  let created;
  try {
    created = ghApi(`opening an issue for #${pr.number}`, `repos/${repo}/issues`, {
      method: "POST",
      body: { title, body, labels },
    });
  } catch (err) {
    // Only a validation failure (a missing work label) is retried. Any other
    // failure may follow a create that did happen server-side.
    if (!workLabel || err.status !== "422") throw err;
    created = ghApi(`opening an issue for #${pr.number} (retry)`, `repos/${repo}/issues`, {
      method: "POST",
      body: { title, body, labels: [issueLabel] },
    });
  }
  console.log(`  opened issue #${created && created.number} for pull request #${pr.number}`);
}

function closeWatchdogIssue(repo, issueNumber, prNumber) {
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
    body: { state: "closed", state_reason: "completed" },
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

function main(argv) {
  const repo = flag(argv, "--repo");
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    console.error("::error::publish-watchdog needs --repo <owner>/<name>.");
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  let graceMinutes;
  let stallMinutes;
  try {
    graceMinutes = numberFlag(argv, "--grace-minutes", DEFAULT_GRACE_MINUTES);
    stallMinutes = numberFlag(argv, "--stall-minutes", DEFAULT_STALL_MINUTES);
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 2;
  }
  const issueLabel = flag(argv, "--issue-label") || "publish-stuck";
  const workLabel = flag(argv, "--work-label") === undefined ? "agent-ready" : flag(argv, "--work-label");
  const nowRaw = flag(argv, "--now");
  const nowMs = nowRaw === undefined ? Date.now() : Date.parse(nowRaw);
  if (!Number.isFinite(nowMs)) {
    console.error("::error::--now is not a parseable time.");
    return 1;
  }

  let candidates;
  try {
    const all = listPages("listing open pull requests", `repos/${repo}/pulls?state=open`);
    candidates = all.filter(
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
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
  }

  const armed = candidates.filter((pr) => !pr.draft && isArmed(pr, labelNames(pr)));
  const requiredContexts = armed.length > 0 ? readRequiredContexts(repo) : null;
  const entries = [];
  const skipped = [];
  for (const pr of armed) {
    try {
      const { runs, incomplete } = readCheckRuns(repo, pr.head.sha, pr.number);
      const branchSha = readBranchSha(repo, pr.head.ref);
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
      entries.push({ pr, checkRuns: runs, incomplete, requiredContexts, files, branchSha });
    } catch (err) {
      skipped.push(pr.number);
      console.log(`::warning::skipping pull request #${pr.number}: ${err.message}`);
    }
  }

  let openIssues;
  try {
    openIssues = listPages(
      "listing open issues",
      `repos/${repo}/issues?state=open&labels=${encodeURIComponent(issueLabel)}`,
    ).filter((i) => !i.pull_request);
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
  }

  const plan = planSweep({ prs: entries, openIssues, nowMs, graceMinutes, stallMinutes, skipped });
  console.log(
    `Publish watchdog: ${candidates.length} cms pull request(s), ${armed.length} armed, ` +
      `${skipped.length} skipped, ${plan.open.length} to open, ${plan.close.length} to close.`,
  );
  for (const { pr, verdict } of plan.open) {
    const names = [...verdict.failing, ...(verdict.waiting || [])].map((f) => f.name).join(", ");
    console.log(`  stuck: #${pr.number}${names ? ` (checks: ${names})` : ""}`);
  }
  for (const c of plan.close) console.log(`  close: issue #${c.issueNumber} (pull request #${c.prNumber})`);
  if (dryRun) {
    console.log("Dry run: nothing written.");
    return 0;
  }

  try {
    for (const { pr, verdict } of plan.open) createIssue(repo, pr, verdict, issueLabel, workLabel);
    for (const c of plan.close) closeWatchdogIssue(repo, c.issueNumber, c.prNumber);
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
  }
  if (armed.length > 0 && skipped.length === armed.length) {
    console.error("::error::every armed pull request failed to read.");
    return 1;
  }
  return 0;
}

module.exports = {
  classifyPublish,
  issueMarker,
  renderIssue,
  planSweep,
  isTestFixturePath,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_STALL_MINUTES,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
