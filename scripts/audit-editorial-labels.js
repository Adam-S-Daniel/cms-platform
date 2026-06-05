#!/usr/bin/env node
// Audit open editorial-workflow PRs for the label state that makes Decap's
// "Decap CMS is adding labels to N of your Editorial Workflow entries" dialog
// appear AND PERSIST on /admin — on production and on every preview-* deploy,
// since the editorial state is repo-wide.
//
// WHY: Decap's editorial workflow stores each entry's column as a PR LABEL
// `<prefix>/draft | <prefix>/pending_review | <prefix>/pending_publish`
// (prefix defaults to `decap-cms`). On load, Decap MIGRATES any editorial-
// workflow PR that is missing that label (older entries stored status elsewhere)
// — showing the "adding labels…" dialog while it commits the labels. If a PR is
// stuck so the migration can't commit (a broken/abandoned canary, a protected
// branch, etc.), Decap re-runs the migration on EVERY /admin load: the dialog
// never goes away and the Workflow tab churns. This audit flags exactly those
// PRs so the condition is caught routinely instead of via a confused editor.
//
// An editorial-workflow PR is an open PR whose head branch starts with the CMS
// branch prefix (default `cms/`). It is HEALTHY iff it carries exactly one
// `decap-cms/<status>` label.
//
// Usage:
//   node scripts/audit-editorial-labels.js [--repo owner/name] [--branch-prefix cms/] [--label-prefix decap-cms]
// Requires a gh-authenticated environment (GH_TOKEN or gh auth). Exits non-zero
// (with ::error:: annotations) when any editorial PR is missing its status label.
"use strict";
const { execFileSync } = require("node:child_process");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
// Resolve the target repo: explicit --repo wins; otherwise fall back to
// GITHUB_REPOSITORY (always set in Actions = the caller's repo) so the
// script never depends on a local git checkout the reusable does not make.
const REPO = arg("repo", "") || process.env.GITHUB_REPOSITORY || "";
const BRANCH_PREFIX = arg("branch-prefix", "cms/");
const LABEL_PREFIX = arg("label-prefix", "decap-cms");
const STATUSES = ["draft", "pending_review", "pending_publish"];
const statusRe = new RegExp(`^${LABEL_PREFIX}/(?:${STATUSES.join("|")})$`);

function gh(args) {
  return execFileSync("gh", REPO ? [...args, "--repo", REPO] : args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

let prs;
try {
  prs = JSON.parse(
    gh(["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,labels,title"]),
  );
} catch (e) {
  console.error(`audit-editorial-labels: failed to list PRs: ${e.message}`);
  process.exit(2);
}

const editorial = prs.filter((p) => (p.headRefName || "").startsWith(BRANCH_PREFIX));
const offenders = editorial.filter(
  (p) => !(p.labels || []).some((l) => statusRe.test(l.name)),
);

for (const p of offenders) {
  const labels = (p.labels || []).map((l) => l.name).join(", ") || "none";
  console.log(
    `::error title=Editorial label migration will churn::PR #${p.number} (${p.headRefName}) is in the editorial workflow but has no ${LABEL_PREFIX}/<status> label [labels: ${labels}]. ` +
      `Decap re-runs its label migration on every /admin load (the persistent "adding labels…" dialog on prod + previews). Resolve, label, or close it.`,
  );
}

const summary = `${editorial.length} editorial-workflow PR(s) scanned, ${offenders.length} missing a ${LABEL_PREFIX}/<status> label`;
if (offenders.length > 0) {
  console.log(
    `\nEditorial-workflow label inconsistency — these PRs cause the persistent "adding labels" dialog: ${offenders
      .map((p) => `#${p.number}`)
      .join(", ")}. (${summary}.)`,
  );
  process.exit(1);
}
console.log(`OK — ${summary}. No editorial-workflow migration churn.`);
