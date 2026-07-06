---
name: editorial-label-audit
description: Diagnose and fix Decap's persistent "Decap CMS is adding labels to N of your Editorial Workflow entries" dialog, which appears (and never clears) on /admin — on prod AND every preview deploy. Use when an editor reports that dialog, when the Workflow tab churns, or when setting up the daily audit that catches the condition. Covers the cause (an open cms/* PR missing its decap-cms/<status> label), the audit script + reusable workflow — which SELF-HEALS by applying the missing label since v0.1.48 — the e2e guard, and the manual escalation path for when self-heal fails. Trigger on "adding labels dialog", "editorial workflow dialog stuck", "label migration", "decap-cms/draft label", "editorial-label-audit", or "audit-editorial-labels".
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
  missing exactly one `decap-cms/<status>` label. With `--fix` it SELF-HEALS:
  applies `decap-cms/pending_publish` when the flagged PR carries `cms/ready`,
  else `decap-cms/draft`, and exits non-zero with `::error::` annotations only
  when a fix attempt didn't stick. Without `--fix` it's flag-only (exits
  non-zero on any missing label, no writes attempted). Needs a
  gh-authenticated env (`GH_TOKEN` or `gh auth`); `--fix` additionally needs
  that token to have `pull-requests: write`.
  ```bash
  node scripts/audit-editorial-labels.js [--repo owner/name] \
    [--branch-prefix cms/] [--label-prefix decap-cms] [--fix]
  ```
- **`.github/workflows/editorial-label-audit.yml`** — reusable `workflow_call`.
  Sparse-checks out just the audit script from the platform and runs it with
  `--fix` whenever `inputs.fix` is true (**default: `true`**) — i.e. self-heal
  is on by default. A consumer wires a **daily-cron caller** under
  `examples/site/.github/workflows/` (inputs: `platform_repo`, `platform_ref`,
  `branch_prefix`, `label_prefix`, `fix`).

  > **MUST pass `--repo ${{ github.repository }}` (v0.1.16, cms#44).** The
  > reusable SPARSE-checks-out only the audit script into `.cms-platform/` and
  > never checks out the consumer repo, so `github.workspace` is NOT a git repo.
  > A bare `gh pr list` then fails `fatal: not a git repository → failed to list
  > PRs → exit 2`. The reusable passes the caller's repo explicitly; the script
  > also falls back to `process.env.GITHUB_REPOSITORY`. Locked by
  > `e2e/editorial-label-audit-repo.test.js`.

  > **The CALLER must grant `pull-requests: write` for self-heal to work.** The
  > reusable's own `permissions:` block grants `contents: read` +
  > `pull-requests: write`, but reusable-workflow permissions are capped by the
  > caller's grant — a caller stuck on the default `contents: read` makes the
  > self-heal's label-apply calls 403, and the job falls back to failing loud
  > with a grant-the-permission hint. The example caller
  > `examples/site/.github/workflows/editorial-label-audit.yml` already grants
  > `permissions: contents: read, pull-requests: write` at the job level for
  > this reason.
- **`e2e/cms-editorial-label-migration.spec.js`** — regression guard. Drives the
  in-browser test-repo backend and asserts the dialog is ABSENT — or, if shown,
  gone after dismiss + 30s + reload. The dialog must never survive that cycle.

## Remediation (manual escalation after a failed self-heal)

Since v0.1.48 the audit self-heals by default (see above), so a RED run means
the self-heal already attempted to apply the missing label and it didn't
stick — not that nothing has been tried yet. When that happens (or an editor
reports the dialog):

1. Identify the offending open `cms/*` PR(s) — run the audit script, or
   `gh pr list --state open --search "head:cms" --json number,headRefName,labels`.
2. Figure out why the self-heal's label-apply didn't stick, then either:
   - **close it** if it's a dead/abandoned canary or debris (clears the migration
     target — this is what unstuck adamdaniel.ai's prod dialog), or
   - **add the correct `decap-cms/<status>` label** by hand if the entry is
     legitimate and should stay in the editorial queue but the self-heal
     couldn't write to it (e.g. the caller isn't granting `pull-requests: write`
     — see above), or
   - merge/unblock it so Decap can commit the label itself.
3. Re-run the audit (or wait for the next scheduled run) — self-heal
   automatically re-attempts once the underlying condition is fixed (e.g. once
   the PR is closed, relabeled, or otherwise resolved).
4. Reload `/admin`; the dialog should not reappear.

## Resolved at the source: ephemeral cleanup PRs no longer cause transient red

Pre-v0.1.48, the audit could go transiently red because it scans EVERY open
`cms/*` PR, including the prod loops' **ephemeral fixture-cleanup PRs**
(`cms/e2e-fixture/remove-*` / `cms/e2e-fixture/seed-*` branches) — if a daily
run fired while one was mid-flight, before it picked up a
`decap-cms/<status>` label, the audit flagged it, then went green again once
the PR auto-merged or closed.

Since v0.1.48, every non-Decap `cms/*` PR writer — the publish-via-auto-merge
shim's delete-recovery PRs, `cms-fixture-pr.js` seed/remove fixture PRs, and
`sweep-stale-cms-prs.yml`'s two cleanup PRs — applies
`decap-cms/pending_publish` at PR-creation time, alongside `cms/ready`. They
are correctly labelled from the moment they exist, so they no longer cause
transient reds, and the self-heal above cleans up any straggler regardless. A
red audit run now genuinely means self-heal failed and needs investigation —
see Remediation above.

Related: stuck `cms/*` PRs that won't auto-merge are the upstream cause — see the
`cms-stuck-pr-triage` skill for diagnosing the auto-merge failure itself.
