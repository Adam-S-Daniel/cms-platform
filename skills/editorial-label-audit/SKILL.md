---
name: editorial-label-audit
description: Diagnose and fix Decap's persistent "Decap CMS is adding labels to N of your Editorial Workflow entries" dialog, which appears (and never clears) on /admin — on prod AND every preview deploy. Use when an editor reports that dialog, when the Workflow tab churns, or when setting up the daily audit that catches the condition. Covers the cause (an open cms/* PR missing its decap-cms/<status> label), the audit script + reusable workflow, the e2e guard, and the manual remediation. Trigger on "adding labels dialog", "editorial workflow dialog stuck", "label migration", "decap-cms/draft label", "editorial-label-audit", or "audit-editorial-labels".
---

# Editorial-workflow label audit

## The condition (added in v0.1.6)

Decap's editorial workflow stores each entry's column as a PR **label**:
`decap-cms/draft | decap-cms/pending_review | decap-cms/pending_publish` (the
prefix defaults to `decap-cms`). On `/admin` load, Decap MIGRATES any open
editorial-workflow PR that is missing that label, showing:

> "Decap CMS is adding labels to N of your Editorial Workflow entries…"

That migration must TERMINATE. But if a PR is stuck so the label can't be
committed (a broken/abandoned canary, a protected branch, an auto-merge that
never fired), Decap re-runs the migration on **every** `/admin` load — the
dialog never clears and the Workflow tab churns. Editorial state is **repo-wide**,
so this shows on production AND on every `preview-*` deploy, for every editor.

An editorial-workflow PR is an open PR whose head branch starts with the CMS
branch prefix (default `cms/`). It is HEALTHY iff it carries exactly one
`decap-cms/<status>` label.

## Tooling shipped here

- **`scripts/audit-editorial-labels.js`** — lists open `cms/*` PRs and flags any
  missing exactly one `decap-cms/<status>` label; exits non-zero with `::error::`
  annotations. Needs a gh-authenticated env (`GH_TOKEN` or `gh auth`).
  ```bash
  node scripts/audit-editorial-labels.js [--repo owner/name] \
    [--branch-prefix cms/] [--label-prefix decap-cms]
  ```
- **`.github/workflows/editorial-label-audit.yml`** — reusable `workflow_call`.
  Sparse-checks out just the audit script from the platform and runs it. A
  consumer wires a **daily-cron caller** under `examples/site/.github/workflows/`
  (inputs: `platform_repo`, `platform_ref`, `branch_prefix`, `label_prefix`).

  > **MUST pass `--repo ${{ github.repository }}` (v0.1.16, cms#44).** The
  > reusable SPARSE-checks-out only the audit script into `.cms-platform/` and
  > never checks out the consumer repo, so `github.workspace` is NOT a git repo.
  > A bare `gh pr list` then fails `fatal: not a git repository → failed to list
  > PRs → exit 2`. The reusable passes the caller's repo explicitly; the script
  > also falls back to `process.env.GITHUB_REPOSITORY`. Locked by
  > `e2e/editorial-label-audit-repo.test.js`.
- **`e2e/cms-editorial-label-migration.spec.js`** — regression guard. Drives the
  in-browser test-repo backend and asserts the dialog is ABSENT — or, if shown,
  gone after dismiss + 30s + reload. The dialog must never survive that cycle.

## Remediation (manual)

When the audit flags a PR (or an editor reports the dialog):

1. Identify the offending open `cms/*` PR(s) — run the audit script, or
   `gh pr list --state open --search "head:cms" --json number,headRefName,labels`.
2. For each flagged PR, either:
   - **close it** if it's a dead/abandoned canary or debris (clears the migration
     target — this is what unstuck adamdaniel.ai's prod dialog), or
   - **add the correct `decap-cms/<status>` label** if the entry is legitimate and
     should stay in the editorial queue, or
   - merge/unblock it so Decap can commit the label itself.
3. Reload `/admin`; the dialog should not reappear.

## Transient red from the prod loops' ephemeral cleanup PRs

The audit scans EVERY open `cms/*` PR, so it also (correctly) flags the prod
loops' **ephemeral fixture-cleanup PRs** — `cms/e2e-fixture/remove-*` /
`cms/e2e-fixture/seed-*` branches that carry `cms/draft`/`cms/ready` labels but
no `decap-cms/<status>` (they're script-created, not Decap editorial entries).
These have auto-merge enabled and self-clear within a loop run, so a daily audit
that happens to fire while one is mid-flight goes transiently red, then green on
the next run. Do NOT add a fixture-branch exclusion to the audit — it would blind
it to a fixture that genuinely gets stuck. The real reduction is fixing the loop
DELETE leg so it stops opening these fallback cleanup PRs (cms#45 dispatch-proof;
see `cms-stuck-pr-triage`).

Related: stuck `cms/*` PRs that won't auto-merge are the upstream cause — see the
`cms-stuck-pr-triage` skill for diagnosing the auto-merge failure itself.
