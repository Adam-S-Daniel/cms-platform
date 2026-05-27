---
name: cms-stuck-pr-triage
description: Diagnose "stuck" or "repeatedly failing" runs of cms-publish-loop-host.yml, cms-publish-loop-prod.yml, canary-prod.yml, or any workflow that opens a `cms/<col>/<slug>` PR via Decap and waits for it to auto-merge. The workflow itself is rarely the bug — almost always the cause is a long-lived BLOCKED PR whose CI ran on a stale base. Use when the user says a publish-loop is "stuck", cancels & restarts a run, or asks why a daily canary keeps failing.
---

# CMS publish-loop / canary stuck-PR triage

The publish-loop and canary workflows in this repo (`cms-publish-loop-host.yml`, `cms-publish-loop-prod.yml`, `canary-prod.yml`, plus the in-progress `cms-preview-pr-self-contained.spec.js` harness) all follow the same shape: open a `cms/<col>/<slug>` PR via Decap CMS → wait for the editorial-workflow auto-merge to fire → wait for `deploy-production.yml` to finish → assert the live URL.

When a run "gets stuck" it almost never means the workflow is misbehaving. The default failure mode is:

> A *prior* run opened a `cms/<col>/<slug>` PR, that PR's required checks fail or hang, auto-merge can't fire, the spec waits up to 13–40 minutes, and times out with `Timed out waiting for PR #N to merge`. The current run then opens a *new* PR (or pushes onto the same one) — same fate.

Most user-facing symptoms ("stuck for 30 min", "cancelled and restarted three times", "Docker config warning at top of log") are not the bug. The bug is in the open-PR queue.

## When to invoke

- The user says any of: "publish-loop is stuck / failing / not succeeding", "I cancelled a stuck run", "the canary keeps failing", "this workflow has been running for an hour".
- A `gh run view` log ends with `Error: Timed out waiting for PR #N to merge`.
- A workflow run was just cancelled and a new one was kicked off — before suggesting any workflow changes, finish this triage.
- After landing changes that affect e2e spec selection (`select-specs.js`, lane filtering, FANOUT_PATTERNS, the spec set itself), proactively audit open `cms/*` PRs whose CI ran against the pre-fix tree.

## Shortcut: look at the auto-generated diagnostic first

Most of the manual procedure below has been automated. When a publish-loop / preview-loop / prod-mutate workflow times out on a `Timed out waiting` line, two PR comments land on the failing run's PR:

1. `host-loop-failure-summary` (or `preview-loop-failure-summary`, `prod-mutate-failure-summary`) — the scrubbed Playwright failure block. **The wait-helper's error message itself now includes an inline diagnostic** appended by `e2e/with-stuck-pr-diagnostic.js`, so most of the time the answer is right there inside the failure block.
2. `host-loop-stuck-pr-diagnostic` (or `preview-loop-stuck-pr-diagnostic`, `prod-mutate-stuck-pr-diagnostic`) — the **workflow-level catch-all**, posted by a `Diagnose stuck PRs` step that runs only when the log contains `Timed out waiting`. Covers the outer-Playwright-timeout case where the wait helper never got to augment its error.

Both comments are produced by `scripts/diagnose-stuck-pr.js` (read-only, 25-s timebox, always exits 0). The diagnostic enumerates open `cms/*` PRs, classifies each by `mergeable_state`, labels `dirty` PRs as **newline-only → `auto-resolve-newline-conflict.yml` will close on next run** vs **not auto-resolvable; manual rebase needed**, lists failing required checks for `blocked` PRs, and (for URL-class timeouts) reports the `deploy-production` queue depth.

**Read the diagnostic before running the procedure below.** It usually points at the offending PR directly. The procedure remains here as the manual fallback for cases the diagnostic flagged as `indeterminate` or where a human judgement call is needed.

## Procedure

### 1. List the open `cms/*` PRs and their merge state

```bash
gh pr list --state open --search "head:cms" \
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

### 3. Decide: rebase, close, or wait

- **Stale-base, fix is on main**: the cleanest move is to *close* the stale PR (Decap will open a fresh one on the next workflow run, on top of current main):
  ```bash
  gh pr close <N> --delete-branch --comment "closing stale CMS PR; CI ran on pre-fix tree, next workflow run opens a fresh one"
  ```
  Rebase + force-push also works but is more fragile — if the spec used a content-based slug, the next run rewrites the same branch and races with the rebase.

- **Real failure, fix not yet on main**: investigate the failing check. The `e2e (1)`, `parity`, `finalize` failures on a CMS PR are usually content-spec drift (a spec hardcodes a fixture that was deleted from main); see `e2e/content-fixtures.js`'s `discoverPost` / `discoverTags` for the dynamic-discovery pattern.

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

### 4. After cleaning the queue, re-trigger the workflow

```bash
gh workflow run cms-publish-loop-host.yml         # or cms-publish-loop-prod.yml / canary-prod.yml
gh run watch                                       # follow the new run live
```

The new run opens a fresh `cms/<col>/<slug>` PR on top of current main; with the queue clean it should auto-merge cleanly.

### 5. Delete-spec specific: `delete:` flag on the collection

`cms-delete-published.spec.js` clicks the Decap UI's "Delete published entry" menuitem. Decap renders that menuitem ONLY when the entry's collection has `delete: true` in `admin/config.yml`. If the collection is `delete: false` the status menu opens but renders an empty list, the menuitem never appears, and `getByRole("menuitem", { name: /delete (published )?entry/i }).click()` times out at the action-timeout (run #25491225206 hit exactly this on the e2e collection until PR #302 set `delete: true`).

When triaging a stuck delete-spec, before chasing infrastructure: `grep -A1 "name: e2e\|name: posts\|name: <collection>" admin/config.yml` and check the `delete:` flag for the relevant collection.

### 6. Empty status-menu pattern (Published button opens, nothing inside)

The artifact's `error-context.md` snapshot looks like:

```yaml
- button "Published" [expanded] [active] [ref=...]
  - menu:
    - list      # ← empty, no items
```

This is the same `delete: false` symptom from §5 — the menu rendered, but Decap had no items to put in it because the collection's capability flags forbade them. Could also indicate the spec's selector matched a non-clickable element (rare; check the UI's actual structure for the entry state).

## What ISN'T the bug (red herrings to ignore unless you've ruled out the above)

- **`WARNING: Error loading config file: open /root/.docker/config.json: permission denied`** at the top of a job log. This is a benign GHA quirk — every container job emits it because Docker tries to read a config that doesn't exist in the playwright image. Ignore.
- **Workflow run dispatched against `main` rather than a feature branch.** The cron trigger fires from `main` daily; `workflow_dispatch` from `main` is identical. There's no reason to gate this. The user's intuition that "running it from main caused this" is a mis-attribution; the cause is in the open-PR queue regardless of which ref dispatched the run.
- **Concurrency cancellation.** The publish-loop workflows use `cancel-in-progress: false`, so cron + dispatch + PR runs queue rather than killing each other. Six "cancelled" runs in a row in the run-list are almost always user-cancellations of stuck runs, not concurrency interference.

## Why this matters

The publish-loop is the only test that exercises the live Decap → editorial-workflow → auto-merge → deploy-production chain. When it's broken, the only pre-prod safety net for the actual publish flow is broken. Every minute the user spends restarting cancelled runs without diagnosing the open PR queue is a minute the canary is silently red. The first action when one of these workflows looks "stuck" is *always* `gh pr list --state open --search "head:cms"`.

## Cleanup vs triage

Don't manually close every orphan PR you find — `.github/workflows/sweep-stale-cms-prs.yml` runs nightly at 04:00 UTC and handles the routine cases. Triage that finds the *root cause* of why the sweep alone isn't enough is the goal; if you're just closing leftovers, use the workflow's `workflow_dispatch` with `dry_run: false` instead.

The sweep has three tiers: branch-prefix safelist (closes + deletes), `automated-test` label (closes only — Decap reuses branches), and orphaned branches with no open PR (deletes). Per-PR opt-out via the `keep` label; per-branch opt-out via `[sweep-keep]` in the tip commit message. See AGENTS.md "`sweep-stale-cms-prs.yml`" for the full table.

**Pagination rule** (applies to any future addition): `gh pr list` defaults to `--limit 30` and silently truncates above that. `--paginate` is NOT a flag for `gh pr list` — that's gh-api-only. Always `--limit 1000` for top-level listings, `--limit 1` for existence checks. The sweep workflow's comments document this inline; mirror it in any new sweep tier or related cleanup script.

## Reference

- Workflows: `.github/workflows/cms-publish-loop-host.yml`, `cms-publish-loop-prod.yml`, `canary-prod.yml`, `sweep-stale-cms-prs.yml`
- Specs: `e2e/cms-publish-loop.spec.js`, `e2e/cms-publish-loop-prod-mutate.spec.js`, `e2e/cms-publish-loop-preview.spec.js`, `e2e/cms-delete-published.spec.js`, `e2e/cms-preview-pr-self-contained.spec.js`
- Spec-helper that owns the timeout: `e2e/github-actions-poll.js#waitForMerge` (the `Timed out waiting for PR #N to merge` error originates here)
- Content-fixture discovery (the de-coupled pattern that prevents PR-CI failures when fixtures change): `e2e/content-fixtures.js`
