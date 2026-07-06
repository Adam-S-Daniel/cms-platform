/*
 * Stuck-PR diagnostic — read-only.
 *
 * Why this exists
 * ---------------
 * Long-running publish-loop / deploy / URL-wait timeouts in this repo die mute:
 * the error message says "Timed out waiting for PR #N to merge" or "Timed out
 * waiting for <url>" but doesn't explain WHY the thing it was waiting on never
 * happened. Most of the time the proximate cause is another PR upstream
 * (`BLOCKED` by failing checks, `DIRTY` with a real conflict, `DIRTY` with a
 * newline-only conflict that the auto-resolver will fix on its next tick, or
 * a queued `deploy-production` run holding the production deploy lane).
 *
 * This script enumerates the suspects, classifies each, and prints a Markdown
 * report. It is invoked from:
 *
 *   1. Inside spec helpers that wrap each long-wait throw (see
 *      `e2e/with-stuck-pr-diagnostic.js`). On a timeout-class throw the
 *      wrapper runs this script and appends stdout to the error message.
 *
 *   2. From long-running workflows in a `if: failure()` post-step. The
 *      step's `if:` is gated on `grep -q 'Timed out waiting'` in the
 *      Playwright log so the diagnostic only fires for the failure
 *      class it can actually help with — keeps signal-to-noise high.
 *
 * Contract
 * --------
 *   - Read-only: never PATCHes, POSTs, or otherwise mutates state.
 *   - Always exits 0: a diagnostic that turns a real failure into a
 *     redder one is worse than no diagnostic. Errors land in stdout
 *     under a `### Diagnostic itself failed` heading.
 *   - Time-boxed: hard 25-s deadline. Partial output on timebox hit.
 *   - Rate-limit-aware: degrades gracefully when X-RateLimit-Remaining
 *     drops below RATE_LIMIT_FLOOR. ~10 calls per run at steady state,
 *     well under any quota.
 *   - Safe under PROD_CANARY=1 (read-only by construction).
 *
 * Required env:
 *   GH_TOKEN              GITHUB_TOKEN or PAT (read access is sufficient).
 *   GH_REPO               the consuming site repo, e.g. `owner/site` (defaults to the current repo).
 *
 * Optional env:
 *   WAITING_FOR           Free-text hint. Used in the heading; biases the
 *                         deploy-production-queue check on/off.
 *   WAIT_PR_NUMBER        PR being waited on, if known. The script will
 *                         classify this PR specifically before scanning
 *                         all open cms/* PRs.
 *   WAITING_FOR_KIND      One of "merge", "url", "workflow", "pr-open",
 *                         "auto-merge-enabled", or omitted. Biases which
 *                         supplemental checks run.
 */

"use strict";

const { canonical, HEAD_REF_ALLOWLIST } = require("./auto-resolve-newline-conflict");

const TIMEBOX_MS = 25_000;
const RATE_LIMIT_FLOOR = 50;
const MAX_PRS = 20;
const MAX_CHECKS_SHOWN = 5;
const MAX_DEPLOY_RUNS_SHOWN = 5;
// Kept in sync with cms-editorial-workflow.yml's `auto-merge-when-ready`
// job `if:` — the three label names that arm auto-merge for a CMS PR.
const READY_LABELS = ["cms/ready", "decap-cms/ready", "decap-cms/pending_publish"];

class RateLimitedError extends Error {
  constructor(remaining, resetAt) {
    super(`rate limit near zero: ${remaining} remaining, resets at ${resetAt}`);
    this.remaining = remaining;
    this.resetAt = resetAt;
  }
}

function nowDeadline(ms = TIMEBOX_MS) {
  return Date.now() + ms;
}

async function gh(endpoint, { headers = {}, deadline } = {}) {
  if (deadline && Date.now() > deadline) {
    const e = new Error("timebox exceeded");
    e.timebox = true;
    throw e;
  }
  const url = endpoint.startsWith("https://") ? endpoint : `https://api.github.com${endpoint}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "diagnose-stuck-pr",
      ...headers,
    },
  });
  const remaining = parseInt(res.headers.get("x-ratelimit-remaining") || "9999", 10);
  if (remaining < RATE_LIMIT_FLOOR) {
    throw new RateLimitedError(remaining, res.headers.get("x-ratelimit-reset"));
  }
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`GH API ${endpoint} → ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function tryCanonicalCollapse(repo, pr, deadline) {
  // For a DIRTY PR, fetch the conflicting file(s)' base + head bytes and
  // test whether canonical-collapse equates them. Returns:
  //   "newline-only"   — the auto-resolver would close this PR
  //   "real-conflict"  — manual rebase or content fix needed
  //   "indeterminate"  — couldn't decide (binary, timebox, etc.)
  try {
    const files = await gh(`/repos/${repo}/pulls/${pr.number}/files?per_page=50`, { deadline });
    if (!files || files.length === 0) return "indeterminate";
    for (const f of files.slice(0, 5)) {
      if (f.status !== "modified") return "real-conflict";
      if (typeof f.patch !== "string" && f.changes > 0) return "real-conflict"; // binary
      const baseRes = await gh(
        `/repos/${repo}/contents/${encodeURI(f.filename)}?ref=${encodeURIComponent(pr.base.ref)}`,
        { deadline },
      );
      const headRes = await gh(
        `/repos/${repo}/contents/${encodeURI(f.filename)}?ref=${encodeURIComponent(pr.head.ref)}`,
        { deadline },
      );
      if (!baseRes || !headRes || baseRes.type !== "file" || headRes.type !== "file") {
        return "indeterminate";
      }
      const base = Buffer.from(baseRes.content, "base64").toString("utf8");
      const head = Buffer.from(headRes.content, "base64").toString("utf8");
      if (canonical(base) !== canonical(head)) return "real-conflict";
    }
    return "newline-only";
  } catch {
    return "indeterminate";
  }
}

async function classifyPr(repo, pr, deadline) {
  const out = [];
  const summary = `**PR #${pr.number}** \`${pr.head.ref}\` → \`${pr.base.ref}\` — state=${pr.mergeable_state || "?"} — ${(pr.title || "").slice(0, 70)}`;
  out.push(`- ${summary}`);
  out.push(`  - <${pr.html_url}>`);
  if (pr.mergeable_state === "dirty") {
    const verdict = await tryCanonicalCollapse(repo, pr, deadline);
    if (verdict === "newline-only") {
      out.push(
        "  - merge conflict — **newline-only**; `auto-resolve-newline-conflict.yml` would close this on its next run " +
          "(trigger via `workflow_dispatch` with `pr_number=" +
          pr.number +
          "` to resolve now)",
      );
    } else if (verdict === "real-conflict") {
      out.push(
        `  - merge conflict — **not auto-resolvable** (non-newline diff); needs manual rebase`,
      );
    } else {
      out.push(
        `  - merge conflict — auto-resolver shape unverifiable (timebox or binary diff); inspect manually`,
      );
    }
  } else if (pr.mergeable_state === "blocked") {
    try {
      const checks = await gh(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=50`, {
        deadline,
      });
      const runs = (checks && checks.check_runs) || [];
      const failing = runs.filter(
        (c) =>
          c.conclusion === "failure" ||
          c.conclusion === "cancelled" ||
          c.conclusion === "timed_out",
      );
      const pending = runs.filter((c) => c.status === "in_progress" || c.status === "queued");
      out.push(`  - blocked: ${failing.length} failing, ${pending.length} pending check(s)`);
      for (const c of failing.slice(0, MAX_CHECKS_SHOWN)) {
        out.push(`    - ⛔ ${c.name} (${c.conclusion}) → <${c.html_url || c.details_url || ""}>`);
      }
      for (const c of pending.slice(0, MAX_CHECKS_SHOWN)) {
        out.push(`    - ⏳ ${c.name} (${c.status}) → <${c.html_url || c.details_url || ""}>`);
      }
    } catch (e) {
      out.push(`  - blocked: couldn't fetch check details (${e.message.slice(0, 100)})`);
    }
  } else if (pr.mergeable_state === "unstable") {
    out.push(`  - unstable: a non-required check failed; auto-merge holding`);
  } else if (pr.mergeable_state === "behind") {
    out.push(`  - behind: PR head is behind its base; needs a base-update or rebase to merge`);
  } else if (pr.auto_merge && pr.auto_merge.enabled_by) {
    out.push(
      `  - auto-merge enabled by @${pr.auto_merge.enabled_by.login}; merging when checks pass`,
    );
  } else if (pr.mergeable_state === "clean") {
    // Run 28761772021 / PR #2469: this branch used to assert "no
    // cms/ready-class label" WITHOUT ever looking at pr.labels — a false
    // claim ("label-race candidate") that sent an entire investigation
    // chasing a label race that never existed. Ground truth for #2469:
    // `cms/ready` was applied ONCE at PR creation and never removed (every
    // label writer in this repo — theme/admin/publish-via-auto-merge.js,
    // cms-editorial-workflow.yml, the e2e helpers — POSTs additively; a
    // repo-wide grep finds zero unlabel/setLabels/replace calls). The real
    // story was auto-merge-when-ready's 10-minute "unstable status" poll
    // (unprotected preview-only base, see that job's own comments) running
    // out before the PR's checks settled, deferring to cms-automerge-
    // nudge.yml's cron backstop (~45-90 min in practice) — outside the
    // spec's 25-min waitForMerge budget. Check labels for real instead of
    // assuming, so this report says what's actually true.
    const readyLabel = READY_LABELS.find(
      (name) => Array.isArray(pr.labels) && pr.labels.some((l) => (l && l.name) === name),
    );
    if (readyLabel) {
      out.push(
        `  - clean: \`${readyLabel}\` IS present but auto-merge never armed — NOT a ` +
          `label race. Likely auto-merge-when-ready's unprotected-base "unstable ` +
          `status" poll exhausted its 10-min budget before checks settled; check ` +
          `cms-automerge-nudge.yml's cron backstop (throttled ~45-90 min) or whether ` +
          `\`${pr.base && pr.base.ref}\` has branch protection at all.`,
      );
    } else {
      out.push(
        `  - clean: no merge conflict, and genuinely no \`cms/ready\`-class label ` +
          `(checked ${READY_LABELS.map((n) => `\`${n}\``).join(", ")}) or auto-merge ` +
          `intent — add one of those labels to arm auto-merge-when-ready.`,
      );
    }
  } else if (pr.mergeable_state === "unknown") {
    out.push(
      `  - unknown: GitHub still computing mergeability; this run started too soon after a push`,
    );
  }
  return out;
}

async function diagnoseSpecificPr(repo, prNumber, deadline) {
  const lines = [];
  try {
    const pr = await gh(`/repos/${repo}/pulls/${prNumber}`, { deadline });
    lines.push(`#### Target PR #${prNumber}`);
    lines.push(``);
    lines.push(...(await classifyPr(repo, pr, deadline)));
    lines.push(``);
  } catch (e) {
    lines.push(`#### Target PR #${prNumber}`);
    lines.push(``);
    lines.push(`_couldn't fetch: ${e.message.slice(0, 200)}_`);
    lines.push(``);
  }
  return lines;
}

async function diagnoseOpenCmsPrs(repo, deadline) {
  const lines = [];
  try {
    const prs = await gh(`/repos/${repo}/pulls?state=open&per_page=100`, {
      deadline,
    });
    const candidates = (prs || []).filter((p) =>
      HEAD_REF_ALLOWLIST.some((r) => r.test(p.head.ref)),
    );
    lines.push(`#### Open CMS PRs (${candidates.length})`);
    lines.push(``);
    if (candidates.length === 0) {
      lines.push(`_None. Whatever blocked the wait is not a CMS PR._`);
      return lines;
    }
    const shown = candidates.slice(0, MAX_PRS);
    for (const pr of shown) {
      if (Date.now() > deadline) {
        lines.push(`  _(timebox exceeded; ${candidates.length - shown.indexOf(pr)} PRs elided)_`);
        break;
      }
      lines.push(...(await classifyPr(repo, pr, deadline)));
    }
    if (candidates.length > shown.length) {
      lines.push(`  _… (${candidates.length - shown.length} more elided)_`);
    }
  } catch (e) {
    lines.push(`_couldn't list open PRs: ${e.message.slice(0, 200)}_`);
  }
  return lines;
}

async function diagnoseDeployQueue(repo, deadline) {
  const lines = [];
  try {
    const data = await gh(
      `/repos/${repo}/actions/workflows/deploy-production.yml/runs?per_page=15`,
      { deadline },
    );
    const runs = (data && data.workflow_runs) || [];
    const inflight = runs.filter((r) => r.status === "in_progress");
    const queued = runs.filter((r) => r.status === "queued");
    const recentFailed = runs
      .filter((r) => r.status === "completed" && r.conclusion !== "success")
      .slice(0, 3);
    lines.push(`#### \`deploy-production.yml\` queue`);
    lines.push(``);
    lines.push(
      `- in-flight: ${inflight.length}, queued: ${queued.length}, recent-failed: ${recentFailed.length}`,
    );
    for (const r of [...inflight, ...queued].slice(0, MAX_DEPLOY_RUNS_SHOWN)) {
      lines.push(
        `  - ${r.status === "in_progress" ? "🏃" : "🧊"} run #${r.id} — ${r.head_branch}@${r.head_sha.slice(0, 7)} → <${r.html_url}>`,
      );
    }
    for (const r of recentFailed) {
      lines.push(
        `  - 💥 run #${r.id} (${r.conclusion}) — ${r.head_branch}@${r.head_sha.slice(0, 7)} → <${r.html_url}>`,
      );
    }
  } catch (e) {
    lines.push(`_couldn't fetch deploy-production runs: ${e.message.slice(0, 200)}_`);
  }
  return lines;
}

// Bias decision: when the wait was URL-related (fetchPublicUrl,
// waitForChangeReflected, "live on the production canary URL"), the
// deploy-production queue is highly relevant. When the wait was a
// specific PR's merge or auto-merge-enablement, the queue is less
// directly relevant but still useful context.
function shouldCheckDeployQueue(waitingFor, kind) {
  if (kind === "url") return true;
  if (kind === "merge") return true; // merging blocked on required checks blocked on deploy
  if (!waitingFor) return true; // default-on; one extra API call
  return /url|public|deploy|fetchPublicUrl|reflected|live|baseline/i.test(waitingFor);
}

async function buildReport({ repo, waitingFor, waitPrNumber, kind }) {
  const deadline = nowDeadline();
  const lines = [];
  lines.push(`### Stuck-PR diagnostic`);
  lines.push(``);
  lines.push(`**Was waiting for:** ${waitingFor || "(unspecified)"}`);
  if (kind) lines.push(`**Wait kind:** ${kind}`);
  lines.push(``);
  lines.push(
    `_This is a HEURISTIC summary. Each "verdict" cites the underlying \`mergeable_state\` and check list — audit those, not the verdict._`,
  );
  lines.push(``);
  if (waitPrNumber) {
    lines.push(...(await diagnoseSpecificPr(repo, waitPrNumber, deadline)));
  }
  lines.push(...(await diagnoseOpenCmsPrs(repo, deadline)));
  if (shouldCheckDeployQueue(waitingFor, kind)) {
    lines.push(``);
    lines.push(...(await diagnoseDeployQueue(repo, deadline)));
  }
  return lines.join("\n");
}

async function main() {
  const repo = process.env.GH_REPO;
  if (!repo) {
    process.stdout.write(`### Stuck-PR diagnostic\n\n_GH_REPO unavailable; diagnostic skipped._\n`);
    process.exit(0);
  }
  if (!process.env.GH_TOKEN) {
    process.stdout.write(
      `### Stuck-PR diagnostic\n\n_GH_TOKEN unavailable; diagnostic skipped (read-only mode)._\n`,
    );
    process.exit(0);
  }
  const waitingFor = process.env.WAITING_FOR || "";
  const waitPrNumber = process.env.WAIT_PR_NUMBER || null;
  const kind = process.env.WAITING_FOR_KIND || "";
  try {
    const md = await buildReport({
      repo,
      waitingFor,
      waitPrNumber,
      kind,
    });
    process.stdout.write(md + "\n");
  } catch (e) {
    process.stdout.write(
      [
        `### Stuck-PR diagnostic`,
        ``,
        `**Was waiting for:** ${waitingFor || "(unspecified)"}`,
        ``,
        `### Diagnostic itself failed`,
        ``,
        "```",
        String((e && e.message) || e).slice(0, 500),
        "```",
      ].join("\n") + "\n",
    );
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  TIMEBOX_MS,
  RATE_LIMIT_FLOOR,
  MAX_PRS,
  buildReport,
  classifyPr,
  tryCanonicalCollapse,
  diagnoseSpecificPr,
  diagnoseOpenCmsPrs,
  diagnoseDeployQueue,
  shouldCheckDeployQueue,
};
