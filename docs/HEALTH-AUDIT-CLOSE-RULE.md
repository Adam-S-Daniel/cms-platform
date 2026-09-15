# Health-audit close rule: a full clean window, not a later success

**Status:** Accepted, 2026-09-15. Keeps the rule as shipped; changes no code.

## Context

`scheduled-run-health` keeps one tracking issue per repo. It closes that issue
only when its 48h window holds no failing scheduled run, no failing
default-branch push run, no disabled scheduled workflow and no scheduled
workflow without a recent success
([CI-INVARIANTS.md](CI-INVARIANTS.md#silent-failure-alerting-the-scheduled-run-health-audit-v0157-push-lane-279)).
The window is 48h because GitHub starts daily crons hours late, so two
consecutive audits can be about 29h apart.

The question came from
[skills-evals#150](https://github.com/Adam-S-Daniel/skills-evals/issues/150).
That repo's `propagation.yml` gate failed from 2026-09-09 because an upstream
scheduled job had been paused. The job was re-run at 19:44Z on 2026-09-13, and
every run after that was green. The issue still could not close before the
2026-09-16 audit, because the last failing push run (19:07Z on 09-13) stayed
inside the window.

The proposal: count a failure as healthy once a later successful run of the
same type follows it.

## Decision

Keep the rule. A later success does not clear a failure. An issue closes only
when a full window passes with nothing failing, as
[`audit-scheduled-runs.js`](../scripts/audit-scheduled-runs.js) does today.

## Evidence: a 30-day replay against real runs

[`health-audit-close-rule/simulate.py`](health-audit-close-rule/simulate.py)
replays the tracking-issue lifecycle over every scheduled and default-branch
push run of the audit's callers, from 2026-08-16 to 2026-09-15.
[`runs.json`](health-audit-close-rule/runs.json) beside it is the data.

- **Audit times:** one simulated audit per day, run once at 13:00 UTC and again
  at 15:30 UTC. That week, real audits on skills-evals started between 12:23
  and 15:16 UTC.
- **Callers:** taken from `gh repo list` for both owners plus the contents API,
  not from local clones.
- **Sanity check:** under the current rule, the replay reproduces
  skills-evals#150's real history (filed 09-09, open through 09-15).
  `simulate.py` exits 0 only when that check and every total below match.

A **lane** is one workflow file plus one event. The rules compared:

- **Today:** close when the window holds no failure.
- **Naive:** as today, but also close when every failing lane's latest run
  succeeded. Reporting is unchanged.
- **Recovery hides:** drop a failure from the findings once its lane's latest
  run succeeded.
- **Recovery hides, two in a row:** the same, but the lane's last two runs must
  both succeed.
- **Report all, close on recovery:** report every failure exactly as today;
  close when every failing lane has recovered. Keep reported run ids across a
  close, so nothing is filed twice.
- **Report all, two in a row:** the same, with two successes required.

Totals across the nine public callers (2,846 scheduled and 2,479 push runs):

| Rule | Audit at | Issues filed | Of those, opened and closed in one audit | Median hours, last failure → close | Failures never reported |
|---|---|---|---|---|---|
| Today | 13:00 | 13 | — | 55.0 | 0 |
| Today | 15:30 | 13 | — | 56.4 | 0 |
| Naive | 13:00 | 19 | — | — | — |
| Recovery hides | 13:00 | 13 | 0 | 30.7 | 28 |
| Recovery hides | 15:30 | 11 | 0 | 32.6 | 31 |
| Recovery hides, two in a row | 13:00 | 14 | — | — | 13 † |
| Report all, close on recovery | 13:00 | 16 | 3 | 29.0 | 0 |
| Report all, close on recovery | 15:30 | 15 | 4 | 29.1 | 0 |
| Report all, two in a row | 13:00 | 15 | 1 | 54.1 | 0 |

† 20 counted, less the 7 failures that fell in no audit window (below).

Per repo, with the audit at 13:00:

| Repo | Scheduled / push runs | Filed: today | naive | recovery hides | report all | Median close h: today → recovery hides | Never reported (recovery hides) |
|---|---|---|---|---|---|---|---|
| adamdaniel.ai | 1,060 / 1,411 | 4 | 4 | 4 | 4 | 69.5 → 45.5 | 8 |
| jodidaniel.com | 1,089 / 301 | 1 | 2 | 1 | 2 | 48.6 → 24.6 | 1 |
| _agent-guidance | 125 / 132 | 3 | 5 | 3 | 4 | 53.0 → 29.0 | 14 |
| skills-evals | 125 / 120 | 2 | 4 | 3 | 3 | 55.0 → 31.0 | 4 |
| GHA-bench | 62 / 52 | 1 | 1 | 1 | 1 | 53.9 → 29.9 | 0 |
| cms-platform | 141 / 302 | 2 | 3 | 1 | 2 | 67.7 → 64.3 | 1 |
| fastmail-actions | 96 / 6 | 0 | 0 | 0 | 0 | — | 0 |
| claude-memory-map | 62 / 47 | 0 | 0 | 0 | 0 | — | 0 |
| agentskills | 86 / 108 | 0 | 0 | 0 | 0 | — | 0 |

The 28 failures that "recovery hides" never reports, with the audit at 13:00:

- **_agent-guidance, 14:** `ci.yml` push failures within 30 seconds of each
  other at 10:31Z on 2026-08-29, green 12–18 minutes later.
- **adamdaniel.ai, 8:** five `secrets-scan.yml` push failures (the incident
  below), and three `cms-automerge-nudge.yml` scheduled failures on 08-17,
  green within 40 minutes.
- **skills-evals, 4:** `propagation.yml` push failures. Two on 08-18 stayed red
  about 11 hours. The other two are the 09-13 failures the real audit did
  report on #150.
- **jodidaniel.com, 1:** a `cms-automerge-nudge.yml` scheduled failure on
  08-17, green within half an hour.
- **cms-platform, 1:** a `repo-settings-apply.yml` push failure on 08-16, green
  6 hours later.

Seven more failures fell in no audit window at all, and every count above
excludes them. Five started before the first window opened; two finished too
late for any audit to see them.

### The incident that created the push lane

#279's incident is in the data. `secrets-scan.yml` failed on eight consecutive
pushes to adamdaniel.ai's `main` between 12:27 and 13:56Z on 2026-08-19, and
went green at 15:02Z. The runs are 32252738313, 32253734806, 32254971677,
32256172165, 32256735954, 32257234621, 32257724431 and 32260987609.

- **Recovery hides, audit at 13:00:** reports 3 of the 8.
- **Recovery hides, audit at 15:30:** reports **none**, because the first audit
  to see the failures already sees the recovery.
- **Both "report all" rules:** report 8 of 8 at either time.

## Consequences

- **Issues stay open longer.** The median close comes 55h after the last
  failure, against 29–31h under the recovery rules. On skills-evals#150 that
  means closing on 09-16 instead of 09-14.
- **Nothing is hidden.** Every failure is reported, however quickly its lane
  recovered.
- **Audit start time doesn't matter.** What gets reported is the same whenever
  GitHub happens to start the audit.
- **No new code** goes into a silent-failure detector.

## Alternatives considered

- **Naive: a later success only relaxes the close.** This files duplicates.
  `findTrackingIssue` reads only open issues, so the audit after a recovery
  close still sees the same failures in its window, finds no open issue, and
  files a new one: 19 issues against 13. On #150's own timeline, the issue would
  have closed at the 09-14 audit and been filed again at 09-15.
- **Recovery hides a failure.** It closes a day sooner, but never reports 28
  failures with a 13:00 audit and 31 with a 15:30 audit, including some or all
  of #279's incident. Rejected, because what it reports depends on cron lag,
  the very effect the 48h window exists to remove.
- **Recovery hides, two successes in a row.** Still hides 13 failures and files
  14 issues.
- **Report everything, close on recovery.** The strongest alternative, and not
  adopted. It files 16 issues (3 opened and closed in the same audit), closes
  after a median 29h, and hides nothing at either audit time. Adopting it would
  need:
  - reported run ids read from recently closed tracking issues as well as the
    open one;
  - a success counted only when the jobs that failed actually ran and passed.
    Some workflows end `success` having done nothing; `repo-settings-apply.yml`
    without credentials skips every apply job and still succeeds;
  - #258's rule that an unknown answer never closes, and #313's check still
    blocking the close;
  - new close-comment wording, since "a full window passed clean" would no
    longer be true.

  It also changes one behaviour: an issue closed by hand while failures remain
  in the window would no longer be filed again the next day. Requiring two
  successes in a row wipes out its gain (54.1h).
- **A shorter window.** Brings back the blind gap between late daily audits
  that 48h closes.

## If you revisit this

- **A lane is the workflow file AND the event.** A green push proves nothing
  about a red scheduled run: skills-evals' `propagation.yml` treats the Tier-3
  audit verdict as advisory on push and fatal only on the schedule.
- **Re-run the replay first.** Delete `runs.json` to fetch fresh data, then run
  `python3 docs/health-audit-close-rule/simulate.py`. Exit 0 means its checks
  passed. Do that before relying on these numbers.
- **The runs-list API caps each query at 1,000 results**, even when
  `total_count` says there are more, so the fetch splits its date range to get
  everything. The audit itself pages at most 1,000 runs per 48h window, far
  above the busiest repo's volume.
- **A change reaches only callers that get bumped.** See #424.

## Limits of the replay

- One audit per day at a fixed time; real audits start at varying times.
- Neither runner-starvation suppression nor #313's check is simulated.
- Every caller is treated as having the push lane for the whole period.
- The replay covers 30 days, 2026-08-16 to 2026-09-15.
- One private caller is left out of the published data. Leaving it out changes
  no issue count, close time or hidden-failure count.

## References

- [skills-evals#150](https://github.com/Adam-S-Daniel/skills-evals/issues/150)
  and its
  [root-cause comment](https://github.com/Adam-S-Daniel/skills-evals/issues/150#issuecomment-5684230930)
- #279 (push lane), #258 (an unknown answer never closes), #313 (no-recent-success
  check), #283 and #424 (bumping callers)
- [`scripts/audit-scheduled-runs.js`](../scripts/audit-scheduled-runs.js)
- [`health-audit-close-rule/simulate.py`](health-audit-close-rule/simulate.py)
  and [`runs.json`](health-audit-close-rule/runs.json)
