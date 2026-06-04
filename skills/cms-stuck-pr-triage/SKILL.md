---
name: cms-stuck-pr-triage
description: Diagnose "stuck" or "repeatedly failing" runs of cms-publish-loop-host.yml, cms-publish-loop-prod.yml, canary-prod.yml, or any workflow that opens a `cms/<col>/<slug>` PR via Decap and waits for it to auto-merge. The workflow itself is rarely the bug — almost always the cause is a long-lived BLOCKED PR whose CI ran on a stale base, or a PR stuck BLOCKED with all checks green. Use when the user says a publish-loop is "stuck", cancels & restarts a run, or asks why a daily canary keeps failing.
---

# CMS publish-loop / canary stuck-PR triage

The publish-loop and canary workflows in this platform (`cms-publish-loop-host.yml`, `cms-publish-loop-prod.yml`, `canary-prod.yml`, plus the preview loops in `cms-preview-loops.yml`) all follow the same shape: open a `cms/<col>/<slug>` PR via Decap CMS → wait for the editorial-workflow auto-merge to fire → wait for `deploy-production.yml` to finish → assert the live URL.

When a run "gets stuck" it almost never means the workflow is misbehaving. The default failure mode is:

> A *prior* run opened a `cms/<col>/<slug>` PR, that PR's required checks fail or hang, auto-merge can't fire, the spec waits up to 13–40 minutes, and times out with `Timed out waiting for PR #N to merge`. The current run then opens a *new* PR (or pushes onto the same one) — same fate.

Most user-facing symptoms ("stuck for 30 min", "cancelled and restarted three times", "Docker config warning at top of log") are not the bug. The bug is in the open-PR queue.

## When to invoke

- The user says any of: "publish-loop is stuck / failing / not succeeding", "I cancelled a stuck run", "the canary keeps failing", "this workflow has been running for an hour".
- A `gh run view` log ends with `Error: Timed out waiting for PR #N to merge`.
- A workflow run was just cancelled and a new one was kicked off — before suggesting any workflow changes, finish this triage.
- After landing changes that affect e2e spec selection (lane filtering, the spec set itself), proactively audit open `cms/*` PRs whose CI ran against the pre-fix tree.

## This is a manual / agent procedure — there is no diagnostic script

The platform deliberately ships **no** `scripts/diagnose-stuck-pr.js` (and no `Diagnose stuck PRs` workflow step). Earlier prose described an auto-generated `*-stuck-pr-diagnostic` PR comment produced by that script; that machinery is **not** part of the platform. Do not look for it. Run the `gh`-CLI procedure below by hand (or have an agent run it).

The platform *does* ship a smaller helper, `e2e/with-stuck-pr-diagnostic.js`, which the wait-helper uses to **append an inline diagnostic to its own error message** when it times out. So when a publish-loop spec times out, the scrubbed failure block surfaced by `post-failure-comment` (markers `host-loop-failure-summary`, `prod-mutate-failure-summary`, `preview-loop-failure-summary`) often already contains the offending PR number and its merge state. Read that comment first — but the enumeration / classification / remediation below is all manual.

## Procedure

### 1. List the open `cms/*` PRs and their merge state

```bash
gh pr list --state open --search "head:cms" --limit 1000 \
  --json number,title,mergeStateStatus,createdAt \
  --jq '.[] | [.createdAt, .number, .mergeStateStatus, .title] | @tsv'
```

A PR with `mergeStateStatus: BLOCKED` is the prime suspect, especially if it's been open for more than an hour. `UNKNOWN` is also worth checking — GitHub sometimes returns that when checks are pending or the cached status is stale.

### 2. For each BLOCKED PR, find the failing checks and the base it ran against

```bash
gh pr view <N> --json mergeStateStatus,statusCheckRollup,baseRefOid,autoMergeRequest \
  --jq '.mergeStateStatus, .baseRefOid, .autoMergeRequest, [.statusCheckRollup[] | select(.conclusion=="FAILURE" or .status=="IN_PROGRESS") | {name, conclusion, status}]'
```

Two diagnostic questions the output answers:

- **Is the failure a current bug or a stale-base artefact?** Compare `baseRefOid` to current `origin/main` (`git log origin/main --oneline -1`). If the PR was opened against an older base than a recent fix that landed on main, its CI ran against the pre-fix tree. Re-running the same checks against current main would likely pass.
- **Is auto-merge enabled?** If `autoMergeRequest` is null, the spec failed to enable auto-merge in the first place — that's a different bug (look at the spec's `gh api PUT pull/N/merge` shim error). If it's set, the PR is waiting on its required checks to pass before GitHub fires the merge.

### 3. The "BLOCKED but every check is green" case

A distinct failure mode: `mergeStateStatus: BLOCKED`, `autoMergeRequest` already populated, yet **every** required check's latest run is SUCCESS / NEUTRAL / SKIPPED. This is a GitHub merge-state-evaluator caching bug — two auto-merge-enabling label events landed in the same second, GitHub cached the BLOCKED snapshot taken mid-mutation, and no later event re-triggers evaluation. The PR sits green-but-BLOCKED until the nightly sweep closes it.

```bash
# Confirm the pattern: BLOCKED + auto-merge on + no non-green required check
gh pr view <N> --json mergeStateStatus,autoMergeRequest,statusCheckRollup \
  --jq '{state: .mergeStateStatus, automerge: (.autoMergeRequest != null),
         non_green: [.statusCheckRollup[] | select(.conclusion=="FAILURE" or .conclusion=="CANCELLED" or .status=="IN_PROGRESS") | .name]}'
```

If `cms-automerge-nudge.yml` has been ported into the platform, it handles this automatically: it runs every 5 minutes and re-calls `enablePullRequestAutoMerge` (a no-op that re-triggers GitHub's merge-state evaluation) against any `automated-test`-labelled PR matching exactly this pattern, dropping worst-case time-to-merge from "until the sweep closes it" to ~5 min. It only touches PRs that (1) carry `automated-test`, (2) already have auto-merge enabled, (3) are BLOCKED, and (4) have all required checks green — so it never re-enables auto-merge a human disabled and never touches a real editor's draft.

If that workflow is **not** yet present (or you don't want to wait for its cron), nudge the stuck PR by hand — re-enabling auto-merge re-evaluates the merge state:

```bash
gh pr merge <N> --auto --merge   # no-op re-enable; re-triggers GitHub's merge-state eval
```

### 4. Decide: rebase, close, nudge, or wait

- **Stale-base, fix is on main**: the cleanest move is to *close* the stale PR (Decap will open a fresh one on the next workflow run, on top of current main):
  ```bash
  gh pr close <N> --delete-branch --comment "closing stale CMS PR; CI ran on pre-fix tree, next workflow run opens a fresh one"
  ```
  Rebase + force-push also works but is more fragile — if the spec used a content-based slug, the next run rewrites the same branch and races with the rebase.

- **BLOCKED with all checks green**: nudge auto-merge (§3) rather than closing — the PR is mergeable, GitHub just didn't notice.

- **Real failure, fix not yet on main**: investigate the failing check. `e2e`/`parity` failures on a CMS PR are usually content-spec drift (a spec hardcodes a fixture that was deleted from main); see `e2e/content-fixtures.js`'s discovery helpers for the dynamic-discovery pattern.

- **Pending checks, recent PR**: if the PR was opened in the last few minutes and `statusCheckRollup` shows `IN_PROGRESS`, just wait — the publish-loop run that's currently watching it should succeed when the checks settle.

- **Stale Decap workflow state on a fixed-branch PR (`decap-cms/pending_publish` etc.)**: Decap reuses a fixed branch per entry — `cms/e2e/canary-post` for the e2e canary, `cms/posts/<slug>` for posts. When a prior run leaves the PR open in a non-Draft editorial-workflow state (e.g. `decap-cms/pending_publish` or `decap-cms/pending_review`), the next run's spec edits the entry, Decap pushes onto the SAME branch, the existing PR's labels stick around, and Decap's UI shows "Status: Ready" (or "In Review") rather than "Status: Draft". The publish-loop spec waits for Status: Draft and times out. Symptom in the test log:

  ```
  Error: locator.click: Test timeout of 1200000ms exceeded.
  Call log:
    - waiting for getByRole('button', { name: /^Status:\s*Draft$/i })
  ```

  Fix: close the stale PR with `gh pr close <N> --delete-branch`. Decap will create a fresh branch on the next Save, with `cms/draft` from `cms-editorial-workflow.yml`'s opened-event handler, and the spec sees Status: Draft. To check if a Decap PR is in this state:

  ```bash
  gh pr view <N> --json labels --jq '[.labels[].name]'
  # Look for any of: decap-cms/pending_publish, decap-cms/pending_review,
  # decap-cms/ready  →  next run's Status:Draft wait will block
  # cms/draft, decap-cms/draft  →  fine; spec will see Status:Draft
  ```

- **`dirty` (merge conflict)**: a `cms/*` PR can go `dirty` when its branch and main both touched the same trailing newline. `auto-resolve-newline-conflict.yml` re-resolves newline-only conflicts on the next run and lets the PR merge; if the conflict is more than whitespace, a manual rebase is needed. Check the diff before assuming it's auto-resolvable.

### 5. After cleaning the queue, re-trigger the workflow

```bash
gh workflow run cms-publish-loop-host.yml         # or cms-publish-loop-prod.yml / canary-prod.yml
gh run watch                                       # follow the new run live
```

The new run opens a fresh `cms/<col>/<slug>` PR on top of current main; with the queue clean it should auto-merge cleanly.

### 6. Delete-spec specific: `delete:` flag on the collection

`cms-delete-published-preview.yml`'s delete spec clicks the Decap UI's "Delete published entry" menuitem. Decap renders that menuitem ONLY when the entry's collection has `delete: true` in `admin/config.yml`. If the collection is `delete: false` the status menu opens but renders an empty list, the menuitem never appears, and `getByRole("menuitem", { name: /delete (published )?entry/i }).click()` times out at the action-timeout.

When triaging a stuck delete-spec, before chasing infrastructure, check the `delete:` flag for the relevant collection: `grep -A1 "name: e2e\|name: posts\|name: <collection>" admin/config.yml`. NOTE (v0.1.4+): the live `config.yml` is **rendered** by the theme gem at build time — there is no hand-authored source `admin/config.yml` in a consuming site. Grep the **rendered** output `_site/admin/config.yml` (or fetch the served `/admin/config.yml`), or the platform's template `theme/admin/config.base.yml`.

### 7. Empty status-menu pattern (Published button opens, nothing inside)

The artifact's `error-context.md` snapshot looks like:

```yaml
- button "Published" [expanded] [active] [ref=...]
  - menu:
    - list      # ← empty, no items
```

This is the same `delete: false` symptom from §6 — the menu rendered, but Decap had no items to put in it because the collection's capability flags forbade them. Could also indicate the spec's selector matched a non-clickable element (rare; check the UI's actual structure for the entry state).

## What ISN'T the bug (red herrings to ignore unless you've ruled out the above)

- **`WARNING: Error loading config file: open /root/.docker/config.json: permission denied`** at the top of a job log. A benign GHA quirk. Ignore.
- **Workflow run dispatched against `main` rather than a feature branch.** The cron trigger fires from `main` daily; `workflow_dispatch` from `main` is identical. The user's intuition that "running it from main caused this" is a mis-attribution; the cause is in the open-PR queue regardless of which ref dispatched the run.
- **Concurrency cancellation.** The publish-loop workflows use `cancel-in-progress: false`, so cron + dispatch + PR runs queue rather than killing each other. A run of "cancelled" runs in the run-list is almost always user-cancellations of stuck runs, not concurrency interference.

## Why this matters

The publish-loop is the only test that exercises the live Decap → editorial-workflow → auto-merge → deploy-production chain. When it's broken, the only pre-prod safety net for the actual publish flow is broken. Every minute spent restarting cancelled runs without diagnosing the open PR queue is a minute the canary is silently red. The first action when one of these workflows looks "stuck" is *always* `gh pr list --state open --search "head:cms"`.

## Cleanup vs triage

Don't manually close every orphan PR you find — `.github/workflows/sweep-stale-cms-prs.yml` runs nightly and handles the routine cases. Triage that finds the *root cause* of why the sweep alone isn't enough is the goal; if you're just closing leftovers, use the workflow's `workflow_dispatch` with `dry_run: false` instead.

The sweep has three tiers: branch-prefix safelist (closes + deletes), `automated-test` label (closes only — Decap reuses branches), and orphaned branches with no open PR (deletes). Per-PR opt-out via the `keep` label; per-branch opt-out via `[sweep-keep]` in the tip commit message. See `sweep-stale-cms-prs.yml`'s header for the full table.

**Pagination rule** (applies to any future addition): `gh pr list` defaults to `--limit 30` and silently truncates above that. `--paginate` is NOT a flag for `gh pr list` — that's gh-api-only. Always `--limit 1000` for top-level listings, `--limit 1` for existence checks. The sweep workflow's comments document this inline; mirror it in any new sweep tier or related cleanup script.

## Reference

- Triage workflows the platform ships: `.github/workflows/sweep-stale-cms-prs.yml` (nightly cleanup), `.github/workflows/auto-resolve-newline-conflict.yml` (re-resolves newline-only `cms/*` conflicts), `.github/workflows/cms-automerge-nudge.yml` (re-evaluates green-but-BLOCKED CMS PRs every 5 min — *once ported*).
- Loop workflows: `.github/workflows/cms-publish-loop-host.yml`, `cms-publish-loop-prod.yml`, `canary-prod.yml`, `cms-preview-loops.yml`.
- Failure surfacing: `post-failure-comment` composite action (markers `host-loop-failure-summary`, `prod-mutate-failure-summary`, `preview-loop-failure-summary`); inline error augmentation by `e2e/with-stuck-pr-diagnostic.js`.
- Spec-helper that owns the timeout: `e2e/github-actions-poll.js` (the `Timed out waiting for PR #N to merge` error originates in its `waitForMerge`).
- Content-fixture discovery (the de-coupled pattern that prevents PR-CI failures when fixtures change): `e2e/content-fixtures.js`.
