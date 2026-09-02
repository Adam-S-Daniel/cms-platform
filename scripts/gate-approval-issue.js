#!/usr/bin/env node
"use strict";
// Tell a human, in a place they will actually see, that a repo-settings apply
// is parked waiting for their approval — and take it back down the moment it
// is not.
//
// WHY. An `environment:` gate is invisible unless you are looking at the
// Actions tab. Nothing goes red, no PR blocks, no notification arrives that
// distinguishes "a run finished" from "a run is waiting for YOU". #313 is the
// eleven-day version of that: twelve consecutive runs concluded `cancelled`,
// one of them parked at an unapproved gate for ten days, and the alerting the
// repo already had could not see any of it. The classifier next door
// (repo-settings-write-risk.js) removes MOST approvals; this makes the ones
// that remain arrive somewhere.
//
// An issue, rather than a comment or a notification, for three reasons: it is
// assignable (so it reaches the reviewer's inbox), it is stateful (open means
// "still waiting", closed means "dealt with"), and it can be reconciled by a
// later run — so a request that was superseded, approved, rejected or reaped
// does not sit there lying about the present.
//
// LIFECYCLE — two writers, and the second is the backstop for the first:
//   `open`   the plan job, when the plan needs a human. Creates the issue, or
//            updates the existing one in place when a NEWER run supersedes it
//            (the apply job is newest-wins, so yesterday's request is dead the
//            moment today's exists — leaving both open would be two asks for
//            one decision).
//   `close`  (a) the job that runs after the gated apply resolves, whatever it
//            resolved to; and (b) the plan job of any later run that finds
//            nothing needing approval. (b) is what makes a lost (a) — a run
//            cancelled before its cleanup job could start — self-heal within a
//            day instead of leaving a permanent open lie.
//
// Both directions FAIL LOUD. A notifier that fails quietly is worse than no
// notifier: it converts "you were not told" into "you were told there was
// nothing to tell". The exit code is the alarm.
//
// PUBLIC-LOG RULE: this writes into a PUBLIC repo's issues. It emits the plan
// (repo settings and ruleset shapes — not secrets, not personal data) and the
// reviewer LOGINS that GitHub already publishes on the environment. It never
// echoes an API response body.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

// Identifies THE approval issue among the label's issues. Same mechanism as
// audit-repo-settings.js's drift-issue marker, deliberately a DIFFERENT string
// — these two must never adopt each other's issue.
const MARKER = "<!-- repo-settings-apply-approval -->";
const TITLE = "Repo settings apply is waiting for your approval";
// Body cap. GitHub's own limit is 65536; stopping well short leaves room for
// the header and the truncation notice without arithmetic that can be wrong.
const MAX_PLAN_CHARS = 30000;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Repeatable form: `--plan-json a.json --plan-json b.json` (one per owner leg).
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

function gh(endpoint, { method, fields, input } = {}) {
  const args = ["api", endpoint];
  if (method) args.push("-X", method);
  for (const f of fields || []) args.push("-f", f);
  if (input !== undefined) args.push("--input", "-");
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input,
  });
}

// Never let a response body reach the log — it can quote data into a public
// Actions log. Status + method + endpoint is enough to act on.
function ghSafe(endpoint, opts = {}) {
  try {
    return gh(endpoint, opts);
  } catch (e) {
    const status = /HTTP (\d{3})/.exec(`${(e && e.stderr) || ""}`);
    throw new Error(
      `gh api ${(opts && opts.method) || "GET"} ${endpoint} failed` +
        (status ? ` (HTTP ${status[1]})` : ""),
    );
  }
}

function findIssue(repo, label) {
  const res = JSON.parse(
    ghSafe(
      `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    ),
  );
  return (
    (Array.isArray(res) ? res : []).find(
      (i) => !i.pull_request && typeof i.body === "string" && i.body.includes(MARKER),
    ) || null
  );
}

// The people GitHub will actually accept an approval from. Naming them in the
// issue is the difference between "someone must approve" and "you must
// approve"; assigning them is what puts it in an inbox. A failure here is NOT
// fatal — an un-assigned issue still tells the truth, and refusing to file one
// because the reviewer list was unreadable would be the notifier failing shut.
function reviewerLogins(repo, environment) {
  try {
    const env = JSON.parse(ghSafe(`repos/${repo}/environments/${environment}`));
    const logins = [];
    for (const rule of env.protection_rules || []) {
      if (rule.type !== "required_reviewers") continue;
      for (const r of rule.reviewers || []) {
        const login = r && r.reviewer && r.reviewer.login;
        if (login) logins.push(login);
      }
    }
    return [...new Set(logins)];
  } catch (e) {
    console.log(`::warning::could not read ${environment} reviewers: ${e.message}`);
    return [];
  }
}

function ensureLabel(repo, label) {
  try {
    gh(`repos/${repo}/labels`, {
      fields: [
        `name=${label}`,
        "color=d93f0b",
        "description=Automated CI health tracking",
      ],
    });
  } catch {
    /* already exists / races are fine */
  }
}

function truncate(text) {
  if (text.length <= MAX_PLAN_CHARS) return text;
  return (
    text.slice(0, MAX_PLAN_CHARS) +
    "\n…\n[truncated — read the full plan in the run's job summary]"
  );
}

// ── rendering a plan document as a diff ────────────────────────────────────
// The audit's `--plan-json` document: { writes: [{repo, kind, key|name,
// verdict, reason, changes: [{facet, live, desired}]}], unfixables: [] }.
// A reviewer decides on the DELTA, so that is what gets drawn — in a ```diff
// fence, which GitHub colours. #396 is the motivating body: "1 bypass
// actor(s) added" and then two full ruleset bodies to compare by eye.

const canon = (v) => JSON.stringify(v);

// One facet -> diff lines. Arrays diff by ELEMENT (an added bypass actor is
// one `+` line, not a `-` of the old list and a `+` of the new); anything
// else shows both sides. An absent/empty side draws nothing — nothing was
// removed, so there is no `- []` to read.
function renderDiff(change) {
  const lines = [`# ${change.facet}`];
  const { live, desired } = change;
  if (Array.isArray(live) && Array.isArray(desired)) {
    const liveSet = new Set(live.map(canon));
    const desiredSet = new Set(desired.map(canon));
    for (const el of live) if (!desiredSet.has(canon(el))) lines.push(`- ${canon(el)}`);
    for (const el of desired) if (!liveSet.has(canon(el))) lines.push(`+ ${canon(el)}`);
    return lines;
  }
  const absent = (v) => v === null || v === undefined;
  if (!absent(live)) lines.push(`- ${canon(live)}`);
  if (!absent(desired)) lines.push(`+ ${canon(desired)}`);
  return lines;
}

// The classifier's reason already names the ruleset / flag / key it is
// about, so the bullet adds only the repo.
function renderWrite(w) {
  const out = [`- **${w.repo}** — ${w.reason}`];
  if (w.changes && w.changes.length) {
    out.push("");
    out.push("  ```diff");
    for (const c of w.changes) for (const l of renderDiff(c)) out.push(`  ${l}`);
    out.push("  ```");
  }
  return out;
}

// The concise section: gated writes first (the reason a human is here), then
// the safe ones (approval applies the WHOLE plan, so they ride along), then
// what nothing in this workflow can fix.
function renderPlanDocs(docs) {
  const writes = (docs || []).flatMap((d) => (d && d.writes) || []);
  const unfixables = (docs || []).flatMap((d) => (d && d.unfixables) || []);
  const gated = writes.filter((w) => w.verdict === "gated");
  const safe = writes.filter((w) => w.verdict !== "gated");
  const out = [];
  out.push("### Needs review");
  out.push("");
  if (gated.length) for (const w of gated) out.push(...renderWrite(w));
  else out.push("_(no gated write in the plan document)_");
  if (safe.length) {
    out.push("");
    out.push("### Also applied on approval (non-weakening)");
    out.push("");
    for (const w of safe) out.push(...renderWrite(w));
  }
  if (unfixables.length) {
    out.push("");
    out.push("### Not applied by this workflow (reconcile by hand)");
    out.push("");
    for (const u of unfixables) out.push(`- ${u}`);
  }
  return out;
}

function buildBody({ repo, runUrl, runId, reviewers, planText, gatedText, docs }) {
  const mention = reviewers.length
    ? reviewers.map((r) => `@${r}`).join(", ")
    : "_(no required reviewer is configured on the environment — the apply will refuse to run until one is)_";
  return [
    MARKER,
    // Exact, machine-matchable identity of the run this issue is asking about.
    // `close` refuses to close an issue that has been re-pointed at a NEWER
    // run: the apply job is newest-wins, so a superseded run's cleanup job and
    // the superseding run's plan job race, and without this the loser closes
    // the winner's request and nobody is ever asked.
    `<!-- run:${runId} -->`,
    "",
    `A **repo settings convergence** is parked at the \`repo-settings\` environment gate and`,
    `cannot proceed until it is approved.`,
    "",
    `**Approve or reject here:** ${runUrl}`,
    "",
    "From the CLI:",
    "",
    "```bash",
    `gh api repos/${repo}/actions/runs/${runId}/pending_deployments`,
    `# then, with the environment id it returns:`,
    `gh api -X POST repos/${repo}/actions/runs/${runId}/pending_deployments \\`,
    `  -f state=approved -F "environment_ids[]=<id>"`,
    "```",
    "",
    `**Who can approve:** ${mention}`,
    "",
    "## Why this one needs a human",
    "",
    "Most convergences apply unattended: a write that can only ADD protection —",
    "a required status check gained, a merge method disabled, a new ruleset — is",
    "applied without asking. This run planned at least one write that is not in",
    "that category.",
    "",
    ...(docs && docs.length
      ? renderPlanDocs(docs)
      : [gatedText || "_(the plan job reported no per-write detail)_"]),
    "",
    "<details>",
    "<summary>The full plan (audit output, every leg)</summary>",
    "",
    "```",
    truncate(planText || "(no plan captured)"),
    "```",
    "",
    "</details>",
    "",
    "---",
    "_Filed automatically by `repo-settings-apply` (cms-platform). It closes itself when the",
    "gate is resolved — approved, rejected, or superseded by a newer run — so an open issue",
    "here always means something is still waiting._",
  ].join("\n");
}

// FAIL LOUD on an unreadable plan document: the announce step runs only after
// the plan step wrote one, so a missing file is a wiring bug, and an issue
// silently reverting to the prose-only body would hide exactly the regression
// this document exists to end.
function readPlanDocs() {
  return argAll("plan-json").map((f) => {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      throw new Error(`cannot read plan document ${f}: ${e.message}`);
    }
    if (!doc || !Array.isArray(doc.writes))
      throw new Error(`plan document ${f} has no writes[]`);
    return doc;
  });
}

function readFileOr(pathArg, fallback) {
  if (!pathArg) return fallback;
  try {
    return fs.readFileSync(pathArg, "utf8");
  } catch {
    return fallback;
  }
}

function cmdOpen() {
  const repo = arg("repo");
  const runId = arg("run-id");
  const runUrl = arg("run-url");
  const label = arg("label", "ci");
  const environment = arg("environment", "repo-settings");
  if (!repo || !runId || !runUrl) {
    console.error(
      "gate-approval-issue open: --repo, --run-id and --run-url are all required",
    );
    return 1;
  }
  const planText = readFileOr(arg("plan-file"), "(no plan captured)");
  const gatedText = readFileOr(arg("gated-file"), "");
  const docs = readPlanDocs();
  const reviewers = reviewerLogins(repo, environment);
  const body = buildBody({ repo, runUrl, runId, reviewers, planText, gatedText, docs });

  const existing = findIssue(repo, label);
  if (existing) {
    // Supersede in place. The apply job is newest-wins, so the previous run's
    // request is already dead; re-pointing the SAME issue at the live run is
    // the only shape that cannot leave a human approving a run that no longer
    // exists.
    if (existing.body === body) {
      console.log(`approval issue #${existing.number} already current`);
      return 0;
    }
    ghSafe(`repos/${repo}/issues/${existing.number}`, {
      method: "PATCH",
      input: JSON.stringify({ body }),
    });
    ghSafe(`repos/${repo}/issues/${existing.number}/comments`, {
      method: "POST",
      input: JSON.stringify({
        body:
          `Superseded: run [${runId}](${runUrl}) is now the one waiting. Approving an ` +
          "older run does nothing — it was cancelled when this one was created.",
      }),
    });
    console.log(`approval issue #${existing.number} re-pointed at run ${runId}`);
    return 0;
  }

  ensureLabel(repo, label);
  const created = JSON.parse(
    ghSafe(`repos/${repo}/issues`, {
      method: "POST",
      input: JSON.stringify({
        title: TITLE,
        body,
        labels: [label],
        assignees: reviewers,
      }),
    }),
  );
  console.log(`approval issue #${created.number} opened for run ${runId}`);
  return 0;
}

function cmdClose() {
  const repo = arg("repo");
  const label = arg("label", "ci");
  const reason = arg("reason", "the gate is no longer waiting");
  if (!repo) {
    console.error("gate-approval-issue close: --repo is required");
    return 1;
  }
  const runId = arg("run-id");
  const existing = findIssue(repo, label);
  if (!existing) {
    console.log("no open approval issue — nothing to close");
    return 0;
  }
  // See the marker note in buildBody: only the run the issue currently names
  // may close it. A run that has been superseded must leave the live request
  // standing.
  if (runId && !String(existing.body).includes(`<!-- run:${runId} -->`)) {
    console.log(
      `approval issue #${existing.number} now names a different run — leaving it open`,
    );
    return 0;
  }
  ghSafe(`repos/${repo}/issues/${existing.number}/comments`, {
    method: "POST",
    input: JSON.stringify({ body: `Resolved: ${reason}.` }),
  });
  ghSafe(`repos/${repo}/issues/${existing.number}`, {
    method: "PATCH",
    input: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
  console.log(`approval issue #${existing.number} closed (${reason})`);
  return 0;
}

// `render` prints the concise section to stdout and touches nothing — the
// plan job appends it to the job summary so the run URL a reviewer lands on
// shows the same diff the issue does.
function cmdRender() {
  const docs = readPlanDocs();
  if (!docs.length) {
    console.error("gate-approval-issue render: at least one --plan-json is required");
    return 1;
  }
  console.log(renderPlanDocs(docs).join("\n"));
  return 0;
}

function main() {
  const cmd = process.argv[2];
  if (cmd === "open") return cmdOpen();
  if (cmd === "close") return cmdClose();
  if (cmd === "render") return cmdRender();
  console.error(
    "usage: gate-approval-issue.js <open|close|render> --repo <owner/repo> [--run-id N --run-url U]\n" +
      "                                          [--label ci] [--environment repo-settings]\n" +
      "                                          [--plan-file F] [--gated-file F] [--plan-json F]...\n" +
      "                                          [--reason TEXT]",
  );
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    // Loud, deliberately. See the header: a notifier that fails quietly turns
    // "you were not told" into "there was nothing to tell".
    console.error(`::error::gate-approval-issue: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  MARKER,
  TITLE,
  MAX_PLAN_CHARS,
  buildBody,
  truncate,
  renderDiff,
  renderWrite,
  renderPlanDocs,
};
