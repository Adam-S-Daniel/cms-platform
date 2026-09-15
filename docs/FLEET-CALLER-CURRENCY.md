# Fleet caller currency (#424)

What this is: how a repo that calls `scheduled-run-health.yml` stays on a
current platform release without a human, why the mechanism is the one it is,
and what was rejected. Read it before changing that reusable's checkout,
`scripts/check-platform-currency.js`, a fleet caller's `with:` block, or a
fleet repo's Dependabot `ignore` for cms-platform. The pin-agreement lint this
builds on is in `docs/PIN-CONSISTENCY.md` ("Pin AGREEMENT").

## The problem, measured 2026-09-15

Nine repos call `scheduled-run-health.yml`: both consumer sites and seven fleet
repos (`_agent-guidance`, `agentskills`, `claude-memory-map`,
`fastmail-actions`, `GHA-bench`, `repo-settings`, `skills-evals`). The list
came from the remote (`gh repo list` for both owners, then every default
branch's `.github/workflows/*` through the contents API), not from local
clones. `platform-bump.yml` moves the two consumers. Nothing moved the other
seven:

- six sat on `v0.1.87`, 20 releases behind `v0.1.107`, and missed every audit
  change since, including #313's no-recent-success lane;
- GHA-bench was **half-bumped**, with `uses:@v0.1.106` and
  `platform_ref: v0.1.87`. The v0.1.106 workflow passed `--stale-days` and
  `--no-stale-scan` to a v0.1.87 script that silently ignores unknown flags,
  so the #313 lane never ran and the job reported green.

Three defects stack. Each one alone is enough to strand a caller:

1. **A caller names the version twice**, as `uses: …@vX.Y.Z` and
   `with: platform_ref: vX.Y.Z`. Dependabot's `github-actions` ecosystem can
   move only the first. #283 diagnosed this on 2026-08-20.
2. **In most of these repos nothing moves the pin at all.** Three carry an
   unscoped `ignore` for `Adam-S-Daniel/cms-platform/*`, copied from the
   consumers where `platform-bump` owns the version. `agentskills` has no
   `dependabot.yml`. In four repos Dependabot has never run a single update
   job (`claude-memory-map`, `repo-settings`, `_agent-guidance`,
   `fastmail-actions`), which is tracked in
   [claude-memory-map#31](https://github.com/Adam-S-Daniel/claude-memory-map/issues/31).
3. **Nothing goes red when a caller falls behind**, so defects 1 and 2 are
   silent for as long as they last.

A fix has to work regardless of *why* a caller is behind. That rules out any
design whose only moving part is Dependabot, because Dependabot being dead,
ignored or absent is the common case in the measured fleet, not the edge case.

## The decision

### 1. The reusable names its own version — #283's option 3, now reachable

GitHub's job context carries `job.workflow_repository`, `job.workflow_sha` and
`job.workflow_ref`. Inside a reusable workflow they describe the **reusable's**
file, not the caller's
([contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts);
added by [actions/runner#4335](https://github.com/actions/runner/pull/4335),
merged 2026-04-10 and shipped from runner v2.334.0). When #283 was written,
GitHub had "no expression for the ref this reusable was called at". There is
one now.

So `scheduled-run-health.yml` checks its audit script out at
`job.workflow_repository`@`job.workflow_sha`, the exact commit the caller's
`uses:@` ref resolved to. The caller names the version once, and a
Dependabot bump of that one ref is atomic by construction. This **removes the
skew class** rather than detecting it: there is no second value left to
disagree.

Three details carry weight:

- **It reads `toJSON(job)` in shell, not `${{ job.workflow_sha }}`.** actionlint
  types `job` as a strict object without the four `job.workflow_*` properties,
  at the pinned self-CI version 1.7.7 and at the latest 1.7.12
  ([rhysd/actionlint#647](https://github.com/rhysd/actionlint/issues/647),
  open). A direct reference therefore reds the required actionlint lane.
  `toJSON(job)` is fully typed, and the runtime object carries the properties.
  Reading them in shell also lets the step validate each one.
- **An empty or malformed value fails the step loudly.** An old runner shape,
  GHES, or a malformed SHA or repository never falls back to a guessed ref. A
  guess is the silent-green failure this issue is about.
- **`platform_ref` and `platform_repo` are still accepted, but they no longer
  select the tree.** Removing the inputs would make every existing caller
  startup-fail on the very Dependabot bump that delivers this change, and that
  would silence the audit it is meant to repair. A non-empty value that
  disagrees with the resolved one produces a `::warning::` asking for the line
  to be deleted.

### 2. Dependabot moves the one ref, inside the fleet's cooldown

With one ref per caller, the `github-actions` ecosystem is sufficient:

- it honours the fleet's `cooldown: default-days: 7`, so a release is at least
  7 days old before the PR opens;
- the repos that already run a `dependabot-auto-merge` workflow land it
  without a human.

No new credential, workflow or writer is introduced. What each repo needs
before this works is listed under "Rollout" below.

### 3. A currency lane goes red when a caller falls behind

`scripts/check-platform-currency.js` runs as the reusable's last step. It
looks up the platform's releases and finds the first stable release newer than
the one the caller is pinned to. If that release was published more than
`behind_days` ago, the step fails.

- **The default is 21 days**: the 7-day cooldown, plus up to 7 days until
  Dependabot's next weekly run, plus 7 days for the PR to merge.
- **A non-release ref is skipped.** A branch or a SHA, such as cms-platform's
  own self-caller at `main`, has no release to compare against.
- **The red run reaches the existing alert channel.** The step runs after the
  audit, so a stale caller still gets its audit. The next day's audit then
  reports this red scheduled run into the same `ci` tracking issue.

It lives **in the reusable**, not in a central sweep, for three reasons:

- every caller reports on itself, so no one has to maintain a list of callers;
- a private caller's finding stays in that private repo;
- it fires however the caller got stuck: ignore, no `dependabot.yml`,
  Dependabot not running, or a PR nobody merged.

Its one blind spot is structural. A caller pinned to a release **older** than
this lane cannot run it. The rollout below closes that once, by moving every
caller onto a release that has it.

## Rejected options

- **#283's option 1 alone: adopt the pin-agreement lint fleet-wide.** It makes
  a half-bump loud before merge, but it moves nothing. Every Dependabot bump
  PR would then go red and wait for a human to finish the other half, which
  contradicts "without a human". It also does nothing for the repos where no
  bump PR ever opens. The lint stays shipped as a general check; it is not the
  mechanism.
- **#283's option 2: extend `platform-bump.yml` to the fleet repos.** Each
  repo would need a thin caller, a schedule, and the automation App installed
  with `workflows: write`. That includes the private `repo-settings`, which
  widens a writer credential's reach. Most of what the workflow does
  (`platform.lock`, the gem, caller seeding, nudge contexts) has nothing to act
  on there. It is also a second bump writer beside the Dependabot that already
  moves these repos' third-party pins.
- **A bot that copies `uses:@` into `platform_ref` on Dependabot's branch.**
  Dependabot-triggered runs get a read-only token, so this needs a
  workflow-writing credential on Dependabot PRs. It keeps both refs and adds
  privileged automation to maintain the duplication.
- **Deliver the audit as a composite action** (`github.action_path` is the tree
  at one ref). A composite ref is an *action*, so `sha_pinning_required` forces
  a SHA and breaks the cms-platform tag carve-out. The caller also grows
  `runs-on`, `permissions` and steps.
- **Read `job_workflow_sha` from an OIDC token.** Every caller would have to
  grant `id-token: write`, widening every caller's token for a value the job
  context already provides.
- **Write `${{ job.workflow_sha }}` directly and suppress the actionlint
  finding by message.** That depends on a scanner's message text, which the
  fleet rules steer away from. `toJSON(job)` needs no exemption and gives the
  step something to validate.
- **Remove the `platform_ref` input outright.** Every existing caller,
  including both consumers' pin-consistency-checked callers, would
  startup-fail on the bump that delivers the change.
- **A central currency sweep in cms-platform.** A `GITHUB_TOKEN` cannot read
  the private caller, cross-owner read is a new credential, and the findings
  would land in a public issue.

## Rollout

- **Phase 0 — done 2026-09-15, awaiting merge.** Every stale caller moves to
  `v0.1.106` (the newest release past the cooldown), both refs in one commit,
  with GHA-bench's half-bump repaired:
  [GHA-bench#76](https://github.com/Adam-S-Daniel/GHA-bench/pull/76),
  [_agent-guidance#134](https://github.com/Adam-S-Daniel/_agent-guidance/pull/134),
  [skills-evals#158](https://github.com/Adam-S-Daniel/skills-evals/pull/158),
  [fastmail-actions#17](https://github.com/Adam-S-Daniel/fastmail-actions/pull/17),
  [claude-memory-map#32](https://github.com/Adam-S-Daniel/claude-memory-map/pull/32),
  [repo-settings#36](https://github.com/Adam-S-Daniel/repo-settings/pull/36) (private),
  [agentskills#155](https://github.com/Adam-S-Daniel/agentskills/pull/155).
- **Phase 1 — this change**, shipped in the next cms-platform release (call it
  `vN`).
- **Phase 2 — once `vN` has cleared the 7-day cooldown.** One commit per fleet
  caller does four things together:
  - move `uses:@` to `vN`;
  - **delete** the `platform_ref:` line;
  - drop the unscoped `Adam-S-Daniel/cms-platform/*` ignore where present
    (`_agent-guidance`, `skills-evals`, `fastmail-actions`);
  - give `agentskills` a `github-actions` Dependabot entry, or accept the
    currency lane as its only signal. That is a choice for the repo owner.

  The ignore must go in the **same** commit that removes `platform_ref`, never
  before. Dropped earlier, it re-exposes a two-ref caller to the half-bump.
  GHA-bench needs no ignore change, and once Dependabot delivers `vN` its
  leftover `platform_ref` line is inert and only produces the warning.
  Whether Dependabot actually runs in the four zero-run repos is
  [claude-memory-map#31](https://github.com/Adam-S-Daniel/claude-memory-map/issues/31)'s
  to settle. Until it does, the currency lane is what
  makes those four visible.

The consumers need nothing. `platform-bump` keeps their two refs equal,
pin-consistency keeps checking `platform_ref` against `platform.lock`, and the
reusable no longer reading the input is invisible there.

## What this does not cover

- **The other reusables that check the platform out at `inputs.platform_ref`.**
  Only the consumers call them, and `platform-bump` plus
  `check-platform-pin-consistency.js` already hold both refs together there.
  If a fleet repo ever calls one, the same self-resolution applies, and this
  page is the precedent.
- **`pin-agreement.yml`** stays shipped and adopted nowhere. After Phase 2 a
  fleet caller carries no second ref for it to compare.
