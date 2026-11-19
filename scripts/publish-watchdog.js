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
 * Two modes. `--watch <n>` (run from a pull_request event) polls ONE PR for up to
 * 25 minutes and alerts as soon as it is stuck; the default sweep (every 6
 * hours) catches anything a watcher missed. No workflow_run trigger: it is
 * privileged and may not hold a write token (contributor trust boundary).
 *
 * THE FIX: classify each armed `cms/` pull request as ignored / in-flight /
 * stuck, and open ONE GitHub issue per stuck PR (the issue notification is the
 * alert; the work label queues it for the fleet worker). An issue closes by
 * itself once its PR is no longer stuck. Everything below `classifyPublish`,
 * `renderIssue` and `planSweep` is pure; the CLI is the only part that talks
 * to GitHub, through the `gh` CLI with argv arrays (never a shell string).
 *
 * The issue deliberately omits the PR title and branch name: anyone who can
 * push a branch chooses them. Only the number, API-built URLs and check names
 * (ours) appear.
 *
 * Usage: node scripts/publish-watchdog.js --repo <owner>/<name> [--dry-run]
 *   [--grace-minutes N] [--issue-label L] [--work-label L] [--now <ISO time>]
 *   [--watch <pr number> [--watch-minutes N] [--poll-seconds N]] [--self-check-prefix P]
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hasE2eSlugSignature } = require("../e2e/public-content.js");

const DEFAULT_GRACE_MINUTES = 15;
const WATCH_GRACE_MINUTES = 3;
// The watcher's own check run is named "publish-watchdog / watch"; counting it
// would make the watcher wait on itself forever.
const DEFAULT_SELF_CHECK_PREFIX = "publish-watchdog";
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

function newestPerName(checkRuns) {
  const best = new Map();
  for (const run of checkRuns || []) {
    const cur = best.get(run.name);
    if (!cur) {
      best.set(run.name, run);
      continue;
    }
    const a = ts(run.started_at);
    const b = ts(cur.started_at);
    const aa = a === null ? -Infinity : a;
    const bb = b === null ? -Infinity : b;
    if (aa > bb || (aa === bb && Number(run.id) > Number(cur.id))) best.set(run.name, run);
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
  selfCheckPrefix = DEFAULT_SELF_CHECK_PREFIX,
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

  const others = (checkRuns || []).filter(
    (r) => !(selfCheckPrefix && String(r.name).startsWith(selfCheckPrefix)),
  );
  const newest = newestPerName(others);
  const failing = newest
    .filter(
      (r) =>
        r.status === "completed" &&
        FAILING_CONCLUSIONS.has(r.conclusion) &&
        (requiredContexts === null || requiredContexts === undefined || requiredContexts.includes(r.name)),
    )
    .map((r) => ({ name: r.name, conclusion: r.conclusion, url: r.html_url }));
  if (failing.length > 0) {
    return { state: "stuck", reason: "A required check failed.", failing };
  }
  if (newest.some((r) => r.status !== "completed")) {
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
  const checks =
    verdict && verdict.waitedMinutes !== undefined
      ? `It has not gone live after ${verdict.waitedMinutes} minutes of waiting.`
      : failing.length > 0
      ? "These checks failed:\n\n" +
        failing.map((f) => `- [${f.name}](${f.url}): ${f.conclusion}`).join("\n")
      : "Every check finished, but the pull request did not merge.";
  const body = [
    issueMarker(pr.number),
    "",
    "A change that someone published from the editor has not gone live.",
    "",
    `Pull request: ${prUrl}`,
    "",
    checks,
    "",
    "What to do: open the pull request. A red check names the problem. " +
      "Nothing was lost; the content is still in the editor.",
    "",
    "This issue closes by itself when the change goes live.",
  ].join("\n");
  return { title: `Publish stuck: pull request #${pr.number} has not gone live`, body };
}

function planSweep({ prs, openIssues, nowMs, graceMinutes, selfCheckPrefix }) {
  const stuck = new Map();
  for (const entry of prs || []) {
    const verdict = classifyPublish({
      pr: entry.pr,
      checkRuns: entry.checkRuns,
      requiredContexts: entry.requiredContexts,
      files: entry.files,
      nowMs,
      graceMinutes,
      selfCheckPrefix,
    });
    if (verdict.state === "stuck") stuck.set(entry.pr.number, { pr: entry.pr, verdict });
  }
  const marked = new Map();
  for (const issue of openIssues || []) {
    const m = /<!-- publish-watchdog:pr=(\d+) -->/.exec(issue.body || "");
    if (m) marked.set(Number(m[1]), issue.number);
  }
  const open = [];
  for (const [n, entry] of stuck) if (!marked.has(n)) open.push(entry);
  const close = [];
  for (const [n, issueNumber] of marked) {
    if (!stuck.has(n)) close.push({ issueNumber, prNumber: n });
  }
  return { open, close };
}

function markedIssue(openIssues, prNumber) {
  for (const issue of openIssues || []) {
    const m = /<!-- publish-watchdog:pr=(\d+) -->/.exec(issue.body || "");
    if (m && Number(m[1]) === Number(prNumber)) return issue;
  }
  return null;
}

// Poll one pull request until it resolves, is ignored, is stuck, or the watch
// time runs out. All I/O and time are injected. It sleeps only while the PR is
// in flight and the deadline has not passed, so it can neither spin nor sleep
// past the deadline.
async function watchPublish({
  prNumber,
  fetchState,
  act,
  sleep,
  now,
  watchMinutes = 25,
  pollSeconds = 20,
  graceMinutes = WATCH_GRACE_MINUTES,
  selfCheckPrefix = DEFAULT_SELF_CHECK_PREFIX,
}) {
  const deadline = now() + watchMinutes * 60000;
  let polls = 0;
  let failures = 0;
  let last = null;
  for (;;) {
    let state = null;
    polls++;
    try {
      state = await fetchState();
      last = state;
    } catch (err) {
      failures++;
    }
    if (state) {
      const { pr, openIssues } = state;
      const marked = markedIssue(openIssues, prNumber);
      if (pr.state !== "open") {
        if (marked) await act.closeIssue(marked.number, prNumber);
        return { outcome: "resolved", polls, failures };
      }
      const verdict = classifyPublish({
        pr,
        checkRuns: state.checkRuns,
        requiredContexts: state.requiredContexts,
        files: state.files,
        nowMs: now(),
        graceMinutes,
        selfCheckPrefix,
      });
      if (verdict.state === "ignored") return { outcome: "ignored", polls, failures };
      if (verdict.state === "stuck") {
        if (!marked) await act.openIssue(pr, verdict);
        return { outcome: "stuck", polls, failures };
      }
    }
    if (now() >= deadline) {
      if (!last) return { outcome: "unknown", polls, failures };
      const verdict = {
        state: "stuck",
        reason: `It has not gone live after ${watchMinutes} minutes.`,
        failing: [],
        waitedMinutes: watchMinutes,
      };
      if (!markedIssue(last.openIssues, prNumber)) await act.openIssue(last.pr, verdict);
      return { outcome: "timeout", polls, failures };
    }
    await sleep(pollSeconds * 1000);
  }
}

// ── gh-backed plumbing ──────────────────────────────────────────────────────

function ghError(what, err) {
  const stderr = err && err.stderr ? String(err.stderr) : "";
  const m = /HTTP (\d{3})/.exec(stderr);
  const e = new Error(`${what} failed (status ${m ? m[1] : "unknown"}, ${(err && err.name) || "Error"})`);
  e.sanitized = true;
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
    if (!workLabel) throw err;
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
    body: { body: `Pull request #${prNumber} is no longer stuck (it went live or was closed). Closing.` },
  });
  ghApi(`closing issue #${issueNumber}`, `repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    body: { state: "closed", state_reason: "completed" },
  });
}

function listOpenIssues(repo, issueLabel) {
  return listPages(
    "listing open issues",
    `repos/${repo}/issues?state=open&labels=${encodeURIComponent(issueLabel)}`,
  ).filter((i) => !i.pull_request);
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

async function watchMain({ repo, prNumber, dryRun, issueLabel, workLabel, opts, nowFn }) {
  let requiredContexts;
  let haveRequired = false;
  const fetchState = async () => {
    const pr = ghApi(`reading pull request #${prNumber}`, `repos/${repo}/pulls/${prNumber}`);
    if (pr.state !== "open") {
      return { pr, checkRuns: [], requiredContexts: null, files: null, openIssues: listOpenIssues(repo, issueLabel) };
    }
    if (!haveRequired) {
      requiredContexts = readRequiredContexts(repo);
      haveRequired = true;
    }
    const runs = ghApi(
      `reading check runs for #${prNumber}`,
      `repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
    );
    let files = null;
    try {
      const list = ghApi(`reading files for #${prNumber}`, `repos/${repo}/pulls/${prNumber}/files?per_page=100`);
      files = Array.isArray(list) && list.length < 100 ? list.map((f) => f.filename) : null;
    } catch (err) {
      console.log(`::warning::${err.message}`);
    }
    return {
      pr,
      checkRuns: (runs && runs.check_runs) || [],
      requiredContexts,
      files,
      openIssues: listOpenIssues(repo, issueLabel),
    };
  };
  const act = dryRun
    ? {
        openIssue: async (pr) => console.log(`  would open an issue for pull request #${pr.number}`),
        closeIssue: async (n, p) => console.log(`  would close issue #${n} (pull request #${p})`),
      }
    : {
        openIssue: async (pr, verdict) => createIssue(repo, pr, verdict, issueLabel, workLabel),
        closeIssue: async (n, p) => closeWatchdogIssue(repo, n, p),
      };
  try {
    const result = await watchPublish({
      prNumber,
      fetchState,
      act,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: nowFn,
      ...opts,
    });
    console.log(
      `Publish watchdog: pull request #${prNumber} outcome ${result.outcome} ` +
        `(${result.polls} poll(s), ${result.failures} failed).`,
    );
    if (result.failures > 0 && result.failures === result.polls) {
      console.error(`::error::every poll of the watch failed for pull request #${prNumber}.`);
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
  }
}

async function main(argv) {
  const repo = flag(argv, "--repo");
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    console.error("::error::publish-watchdog needs --repo <owner>/<name>.");
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  const watchRaw = flag(argv, "--watch");
  const graceRaw = flag(argv, "--grace-minutes");
  const defaultGrace = watchRaw === undefined ? DEFAULT_GRACE_MINUTES : WATCH_GRACE_MINUTES;
  const graceMinutes = graceRaw === undefined ? defaultGrace : Number(graceRaw);
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
    console.error("::error::--grace-minutes must be a non-negative number.");
    return 1;
  }
  const issueLabel = flag(argv, "--issue-label") || "publish-stuck";
  const workLabel = flag(argv, "--work-label") === undefined ? "agent-ready" : flag(argv, "--work-label");
  const nowRaw = flag(argv, "--now");
  const nowMs = nowRaw === undefined ? Date.now() : Date.parse(nowRaw);
  if (!Number.isFinite(nowMs)) {
    console.error("::error::--now is not a parseable time.");
    return 1;
  }

  if (watchRaw !== undefined) {
    const prNumber = Number(watchRaw);
    const watchMinutes = flag(argv, "--watch-minutes") === undefined ? 25 : Number(flag(argv, "--watch-minutes"));
    const pollSeconds = flag(argv, "--poll-seconds") === undefined ? 20 : Number(flag(argv, "--poll-seconds"));
    if (!Number.isInteger(prNumber) || prNumber < 1) {
      console.error("::error::--watch needs a pull request number.");
      return 1;
    }
    if (!Number.isFinite(watchMinutes) || watchMinutes < 0 || !Number.isFinite(pollSeconds) || pollSeconds < 1) {
      console.error("::error::--watch-minutes must be >= 0 and --poll-seconds >= 1.");
      return 1;
    }
    const selfCheckPrefix = flag(argv, "--self-check-prefix");
    return watchMain({
      repo,
      prNumber,
      dryRun,
      issueLabel,
      workLabel,
      opts: {
        watchMinutes,
        pollSeconds,
        graceMinutes,
        ...(selfCheckPrefix === undefined ? {} : { selfCheckPrefix }),
      },
      nowFn: nowRaw === undefined ? () => Date.now() : () => nowMs,
    });
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
  let requiredContexts = null;
  const entries = [];
  try {
    if (armed.length > 0) {
      try {
        const meta = ghApi("reading the default branch", `repos/${repo}`);
        const rules = ghApi(
          "reading branch rules",
          `repos/${repo}/rules/branches/${encodeURIComponent(meta.default_branch)}`,
        );
        requiredContexts = [];
        for (const rule of rules || []) {
          if (rule.type !== "required_status_checks") continue;
          for (const c of (rule.parameters && rule.parameters.required_status_checks) || []) {
            requiredContexts.push(c.context);
          }
        }
      } catch (err) {
        requiredContexts = null;
        console.log(`::warning::${err.message}; treating every failing check as required.`);
      }
    }
    for (const pr of armed) {
      const runs = ghApi(
        `reading check runs for #${pr.number}`,
        `repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
      );
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
      entries.push({ pr, checkRuns: (runs && runs.check_runs) || [], requiredContexts, files });
    }
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
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

  const selfRaw = flag(argv, "--self-check-prefix");
  const plan = planSweep({
    prs: entries,
    openIssues,
    nowMs,
    graceMinutes,
    ...(selfRaw === undefined ? {} : { selfCheckPrefix: selfRaw }),
  });
  console.log(
    `Publish watchdog: ${candidates.length} cms pull request(s), ${armed.length} armed, ` +
      `${plan.open.length} to open, ${plan.close.length} to close.`,
  );
  for (const { pr, verdict } of plan.open) {
    const names = verdict.failing.map((f) => f.name).join(", ");
    console.log(`  stuck: #${pr.number}${names ? ` (failing: ${names})` : ""}`);
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
  return 0;
}

module.exports = {
  classifyPublish,
  issueMarker,
  renderIssue,
  planSweep,
  watchPublish,
  isTestFixturePath,
  DEFAULT_GRACE_MINUTES,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
