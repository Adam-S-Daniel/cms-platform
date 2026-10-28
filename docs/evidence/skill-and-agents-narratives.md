# Narratives moved out of skills and AGENTS.md (prompt-audit sweep 2026-10-28)

Instruction files state the current rule; the dated incidents and status notes
that used to sit beside those rules live here, so the rule keeps its reason
without the narrative loading every session. Issue:
https://github.com/Adam-S-Daniel/cms-platform/issues/900

## AGENTS.md, "Consumers"

- adamdaniel.ai: the gem-delivered admin (PR #1883 in that repo) went live on
  prod, and the daily editorial-label-audit was adopted. A loop co-arrival fix
  (PR #1892 in that repo) narrowed the host publish-loop's push trigger so it
  stopped evicting prod-mutate from the shared `prod-mutating-loop`
  concurrency group. The pairwise-disjoint trigger rule it implements is in
  `docs/CI-INVARIANTS.md`.

## skills/cms-stuck-pr-triage

- 2026-08-07: a runner's first-minute apt race failed a webkit Playwright
  install and took out the host loop AND prod-mutate in the same hour.
- Logs from before v0.1.76: the old deploy-extender asked only whether the
  deploy lane was idle, which it is before any merge lands, so a merely slow
  auto-merge (well inside the ~30-minute latency) was reported as
  `no-deploy-fired`. On such a log, `no-deploy-fired` is not evidence of a
  trigger problem; check whether the PR had merged at that timestamp and
  triage the queue instead.
- At the time of the verdict work (#215) only 6 of the 15 extender call sites
  were PR-anchored; the delete legs discover their recovered PR inside a poll
  loop without capturing it, and `cms-unpublish-republish` never opens a
  tracked PR. Counts of required contexts then: the harness default was
  `["validate-content"]`, adamdaniel.ai's nudge listed 6, jodidaniel.com's 1,
  and the `examples/site` template still shipped a stale 9-context list.

## skills/browser-testing

- Visual regression (#86): the `toHaveScreenshot()` baselines were deleted
  2026-05-06 and never regenerated, so the suite only stayed green by
  skipping, until the first curated tag un-skipped the tag pages and
  hard-failed on a baseline that had never been committed.
- Delete dispatch: the async-write race was found in v0.1.17 / cms#45; the
  failure surfaced about 900 s later as "URL never 404s / no deploy fired".
  Three `e2e/cms-editor-ui.test.js` lints lock `confirmEditorDelete`.
- Never bypass the UI: the "Delete published entry" click was empirically
  broken on the day the rule was written, which is when swapping it for a
  GitHub API call looked tempting.
- Harness baselines: restore-to-baseline variants landed in PRs #421 and #423;
  the prod loops became ephemeral in #1771 step 4 (they previously mutated a
  persistent `_posts/` canary in place, PR #426).
- Why not Sveltia: Sveltia up to 0.158 silently ignored
  `publish_mode: editorial_workflow`; with branch protection on `main` every
  Save returned "Repository rule violations found." (PR #48 swapped back).

## skills/ci-watcher-loops

- Verified 2026-09-30 on Claude Code 2.1.285: a default-timeout Bash watcher
  (`sleep 7200`) was killed at about 30 minutes with output ending `[killed]`,
  one with `timeout: 7200000` (`sleep 9000`) was killed at 2 hours, and a
  60-minute `Monitor` expired at 30 minutes.
- The chained-capture pitfall surfaced 2026-05-06 while watching
  `cms-publish-loop-host.yml` after fixes #222 and #227 landed; it left an
  agent blind for about 30 minutes.
