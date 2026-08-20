# CI invariants: loops, required checks, and self-healing automation

What this is: hard-won operational rules for the platform's CI machinery —
the Dependabot batch-strand re-arm sweep, the scheduled-run health audit
(silent-failure alerting), the local e2e `webServer` readiness/crash-resilience
rules, why a cancelled required check permanently blocks a merge, the ported
e2e workflow matrix (including the prod-loop deploy-lane diagnostic,
ephemeral canary branch hygiene, and the bump-push recursion-gate tolerance),
and the workflow-interpolation-sink invariant (`run:` + `with.script`).
Read this before touching `dependabot-rearm-sweep.yml`,
`scheduled-run-health.yml`, `e2e/playwright.config.js`'s local `webServer`
config, any job that produces a required status context, any of the three
real-prod loop workflows, or any `run:` / `actions/github-script` body that
wants to read a `${{ … }}` expression. See also the `ci-watcher-loops`,
`cms-stuck-pr-triage`, and `browser-testing` skills.

## Dependabot batch-strand re-arm sweep (#118-122 postmortem)

`self-dependabot-auto-merge.yml` (→ the reusable `dependabot-auto-merge.yml`)
only fires on `pull_request`, so it arms native GitHub auto-merge
(`gh pr merge --auto --squash`) exactly once per PR, the moment Dependabot
opens it. That is enough for a SINGLE Dependabot PR, but not for a BATCH: when
Dependabot opens several PRs against the same base in one run (observed live,
2026-06-30: cms-platform #118-#122), the first PR(s) merge and advance `main`,
and GitHub responds by AUTO-DISABLING auto-merge on every remaining PR in the
batch (PR #121's timeline: `auto_merge_disabled` by `github-actions[bot]` at
19:06:03, 46 seconds after `auto_merge_enabled` fired). Nothing re-arms
them — no further `pull_request` event ever arrives for a PR nobody pushes to
again — so a green, conflict-free, fully-mergeable PR strands indefinitely.
#121 and #122 sat `CLEAN` for 6 days until merged by hand.

**Fix — a scheduled re-arm sweep**, mirroring the `sweep-stale-cms-prs.yml` /
`regression-review-reaper.yml` shape (pure-`gh`-API scheduled job, no
per-PR checkout):

- **`dependabot-rearm-sweep.yml`** (reusable, `workflow_call`) lists every OPEN
  `dependabot[bot]` PR (`gh pr list --author app/dependabot`); for each with
  ALL checks green (`statusCheckRollup` non-empty, no non-SUCCESS/NEUTRAL/
  SKIPPED entry) and `mergeable == MERGEABLE`, it re-validates the SAME
  manifest-path allowlist `dependabot-auto-merge.yml` enforces, then merges
  **directly** (`gh pr merge --squash`, no `--auto`) as the FIRST attempt —
  which also avoids re-entering the auto-disable race — with `--auto --squash`
  kept as recovery only.

  **v0.1.76 correction — the sweep reached NEITHER branch, and the recorded
  reason was wrong.** It used to gate the direct merge on `mergeStateStatus ==
  CLEAN`, which read `BLOCKED` to the sweep's own token while all three required
  contexts (`actionlint`, `ruby-theme-specs`, `node-unit-lints`) were SUCCESS on
  #194 and #179, the `main` ruleset requires 0 approving reviews, and
  `bypass_actors` is empty. So the direct-merge branch was UNREACHABLE and had
  never once executed, and every run fell through to `--auto` — which GitHub
  refuses **from the SCHEDULE context** ("GraphQL: Pull request refusing to allow a GitHub App to create or
  update workflow `.github/workflows/deploy-preview.yml` without `workflows`
  permission (enablePullRequestAutoMerge)", job 93416787884, after that run had
  already passed the mergeable gate, `checks_ok` and the manifest re-check for
  both PRs). **The discriminator is EVENT CONTEXT, not token class.** The old
  header's premise — that `GITHUB_TOKEN` cannot merge workflow-file PRs — is
  **FALSE and must not be re-derived**: PR #182 merged 31 changed files, ALL
  under `.github/workflows/`, by `github-actions[bot]` 3 s after its last
  required check went green (native auto-merge armed from the `pull_request`
  event); PR #193 is a second instance. **Counters + exit code:** a failed merge
  or re-arm used to increment NOTHING, so the 2026-08-10 run printed
  `merged=0 re-armed=0 skipped=0` after failing twice, and a month of
  `skipped=2 / merged=0` read as success. A PR that can be neither merged nor
  re-armed now counts as **FAILED** and the run exits non-zero (a run that
  cannot resolve a PR's state counts as UNDETERMINED rather than a silent skip;
  `mergeable == UNKNOWN` is RETRIED, since job 93223897818 skipped both PRs on
  UNKNOWN and the next day both read MERGEABLE) — the same "red means a human is
  needed" contract as `audit-editorial-labels.js --fix`.

  **The batch strand has TWO compounding causes, and the second one was missed
  for the whole life of this feature.** Beyond GitHub auto-disabling auto-merge,
  every merge ADVANCES the base, so each PR still open in the batch goes OUT OF
  DATE with it — and a stale branch is genuinely un-mergeable here, which
  re-arming auto-merge can never fix. Measured live 2026-08-10: #194
  `behind_by=31` and #179 `behind_by=41`, both `mergeable_state: blocked`, versus
  a fresh PR #228 at `behind_by=0`, `clean`, under identical protection with the
  same checks green. Staleness is the ONLY structural difference, so `BLOCKED`
  was substantively TRUE on those two — **this is a correction: the field was not
  merely viewer-scoped noise.** Gating on it was still wrong, because `BLOCKED`
  conflates "out of date" (fixable) with "unmergeable for any other reason",
  giving the sweep one bit it cannot act on; the sweep now asks the compare API
  the precise question (`.behind_by`) and, when the direct merge is refused on a
  behind branch, runs `gh pr update-branch` — which `allow_update_branch: true`
  exists to permit. A refreshed PR deliberately does NOT then get `--auto`: the
  refresh invalidates the checks this run verified, so it lands on the NEXT
  sweep, and `UPDATED` is a success outcome that never trips the non-zero exit.
  (The ruleset reports `strict_required_status_checks_policy: false` and
  `GET /branches/main/protection` is 403 to these tokens, so classic protection's
  "Require branches to be up to date" is the only remaining explanation —
  enforced, but not readable anywhere the sweep can see.) This also explains the
  ORIGINAL #121/#122 six-day strand better than "auto-merge was disabled" alone
  ever did.

  **Why the sweep deliberately KEEPS `github.token` on the merge path.** A
  `GITHUB_TOKEN`-attributed merge fires **no push workflows** here — verified:
  neither #182's nor #193's merge commit produced a self-ci push run, and 0 of
  the last 40 self-ci push runs carry a `build(deps)` head commit. An App- or
  PAT-attributed merge WOULD, and a Dependabot bump touching
  `cms-publish-loop-prod.yml` + `cms-publish-loop-host.yml` +
  `cms-media-roundtrip.yml` would then fire all three prod loops onto the shared
  `prod-mutating-loop` group, which DROPS a co-arriving sibling. That is the
  recorded trigger-consequence CHOICE: keep `github.token` on the merge path;
  teaching `isBumpOnlyPush` to classify a Dependabot action-SHA-only workflow
  diff was NOT needed and was not implemented.

  **Pin-comment drift is structural, so comment-sync is now dogfooded here
  too.** Dependabot rewrites a pin comment ONLY when the comment matches the
  version it is bumping FROM — #194 bumps 6.2.2 → 6.2.3 while its comment says
  `v6.1.1`, so it can never self-repair and each bump widens the gap; #179
  carries setup-node v7.0.0's SHA behind `# v6.4.0 (2026-04-20)` across 18
  files. Same trap as #220's frozen `platform_ref` (a generic `CUR->LATEST`
  replace cannot match an already-drifted value). `self-dependabot-comment-sync.yml`
  closes it on this repo. Since cms-platform has no `CMS_PLATFORM_PAT` of its own
  (that secret lives in the consumers), `dependabot-comment-sync.yml` gains an
  **App fallback**: the ID is the repo VARIABLE `vars.CMS_AUTOMATION_APP_ID`,
  only the private key is a secret (`CMS_AUTOMATION_APP_PRIVATE_KEY`), and the
  installation token is minted in **pure node + stdlib `crypto`** — no new
  marketplace action, no new SHA to pin. The PAT still wins when present, so the
  consumer path is unchanged, and the bail names all three knobs so "never
  onboarded" and "misconfigured" are distinguishable (it fails SOFT — see
  "Environment gotchas").

  **The standing gate:** repairing this removes the last human gate on
  third-party action SHAs entering 18 reusables both production sites execute,
  so BOTH of cms-platform's ecosystems (`github-actions` AND the `/e2e` `npm`
  harness) carry a **graduated** minimum package age —
  `cooldown: {default-days: 7, semver-major-days: 30}`. `default-days: 7`
  mechanises the repo's existing cooling-off convention (GitHub's own default is
  3 days, so 7 is a deliberate RAISE, not a floor from zero); majors wait 30
  because a major is the class that has actually needed reverting here
  (setup-node 6→7 in #179; the Decap bundle kept revertible on purpose at
  v0.1.66→v0.1.67), and a Playwright major additionally needs a coupled
  `.github/ci-runner/Dockerfile` edit Dependabot cannot make in the same PR.
  `semver-minor` / `semver-patch` are left undefined on purpose — GitHub's
  documented precedence falls an undefined `semver-*-days` back to
  `default-days`, so spelling them out would only invite the three to drift.
  Cooldown applies to **version** updates only: a security advisory bypasses it
  by GitHub's spec and still opens (and auto-merges) immediately.

  **Deliberately NOT applied to a CONSUMER's `github-actions` ecosystem — but
  not for the reason first recorded here.** The original wording said a consumer
  cooldown "would delay the platform-pin bumps and slow release adoption"; that
  mechanism is wrong. Release adoption is landed by `platform-bump.yml`, which
  opens the bump PR itself (the last five releases all arrived as
  `platform/bump-vX.Y.Z`, not as Dependabot PRs), so a Dependabot cooldown is not
  on that path at all. The real reason is simpler and verified: **neither consumer
  pins a single third-party action** — every `uses:` in both repos targets
  `Adam-S-Daniel/cms-platform/.github/workflows/*.yml` — so a consumer's
  `github-actions` cooldown has no supply-chain surface to hold and would be an
  inert setting that reads as policy. (Before #244, Dependabot was still a
  weaker second reason — it could backstop-bump a platform pin when
  `platform-bump` hadn't run, and cooling THAT off would delay our own
  release, which is what the old wording was groping at. #244 closed that:
  Dependabot now `ignore`s every `Adam-S-Daniel/cms-platform/*` ref outright,
  so there is no backstop left to reason about — see `docs/SYNC.md`.)
- **The manifest-path allowlist is factored into `scripts/check-dependabot-
  manifest-paths.sh`**, the single source both `dependabot-auto-merge.yml`
  (the per-PR `pull_request` gate) and `dependabot-rearm-sweep.yml` (the
  sweep) call — keep the two call sites in lockstep; a change to the
  allowlist changes behaviour identically for both.
- **`self-dependabot-rearm.yml`** dogfoods the sweep on cms-platform's own
  Dependabot PRs (daily cron + `workflow_dispatch`), same pattern as
  `self-secrets-scan.yml` / `self-dependabot-auto-merge.yml`. A consuming site
  adopts it via the thin caller
  `examples/site/.github/workflows/dependabot-rearm-sweep.yml` — the same
  batch-strand exposure applies to every consumer that calls
  `dependabot-auto-merge.yml`.

## Silent-failure alerting: the scheduled-run health audit (v0.1.57, push lane #279)

Two lanes fail SILENTLY — neither an `event=schedule` failure nor a
default-branch `event=push` failure has a PR to go red on, and neither fires a
notification. Observed live (the 2026-07 audit that
motivated this): adamdaniel.ai's daily editorial-label-audit was red 24/30
days for three weeks unnoticed; jodidaniel.com's sweep-stale-cms-prs
startup-failed 30/30 for a month (a dropped `secrets:` map). The alerting
layer:

- **`.github/workflows/scheduled-run-health.yml`** (reusable) — daily scan of
  the CALLER repo's last `window_hours` (default **48h**) of BOTH
  schedule-event runs AND default-branch push-event runs, for `failure` /
  `startup_failure` / `timed_out` (NOT `cancelled` — the loops cancel
  superseded runs by design, and push runs are cancelled by concurrency groups
  the same way). The push lane is on by default and opts out with
  `push_scan: false`; it was added after a `.gitleaks.toml` change passed its
  PR check and then failed EIGHT consecutive pushes to adamdaniel.ai's `main`
  — each one a blocked editorial publish — with nothing surfacing it (#279).
  The two lanes render as SEPARATE sections rather than one merged list,
  because `secrets-scan.yml` fires on both and the signal that mattered was
  "scheduled green, push on fire". Findings land on **one** tracking
  issue (label `ci`, found via a hidden `<!-- scheduled-run-health-audit -->`
  marker): opened on first failure (the issue notification IS the alert),
  NEW runs commented with run-id dedupe (a hidden `<!-- run-ids: … -->`
  block keeps the dedupe exact past the 5-links-per-workflow display cap),
  auto-closed once a full window passes clean. Zero changes to the existing
  scheduled callers — it watches them all from the outside. Logic lives in
  `scripts/audit-scheduled-runs.js` (requireable; pure helpers exported),
  sparse-checked-out by the reusable, which passes
  `--repo ${{ github.repository }}` explicitly (no git repo in the workspace
  — the editorial-label-audit v0.1.16 trap).
- **Why 48h for a daily audit:** GitHub throttles crons on these repos
  (measured: `*/5` fires every 45-90 min; daily crons run 4-5h late), so two
  consecutive daily audit runs can be ~29h apart — a 24-25h window would
  leave a blind gap. The overlap can't double-report thanks to the run-id
  dedupe.
- **Runner-starvation carve-out (v0.1.76).** GitHub reports the RUN as
  `failure` when its job(s) were **cancelled before a runner was ever
  assigned**, and `filterAlertRuns` only ever tested the RUN conclusion — so
  pure infrastructure noise opened the tracking issue. `BAD_CONCLUSIONS`
  already excludes `cancelled`, but that exclusion is RUN-level and could not
  see this shape. A run is now suppressed only when ALL five hold: (1) it HAS
  jobs, (2) it is not itself a `startup_failure`, (3) no job failed or timed
  out, (4) at least one job was cancelled WITHOUT a runner, and (5) every job
  is `cancelled` or `skipped`. **Clause (1) is first and load-bearing:** a
  `startup_failure` run has ZERO jobs and `[].every()` is vacuously TRUE, so
  without it the audit would silence the exact class it exists for. The
  starvation test applies to **cancelled jobs only** — a SKIPPED job carries
  `runner_id: null` while a starved cancelled job carries `runner_id: 0` (and
  `runner_name: ""`), an asymmetry the fixtures pin. The jobs fetch paginates
  at an explicit `per_page=100`, is issued only for runs that are ALREADY
  alertable, and **fails SOFT** — a fetch error keeps the run alertable,
  because silently dropping a real failure is the worse outcome. A `::notice::`
  tallies the suppressed runs and names their workflows, so a systemic runner
  outage stays visible instead of becoming invisible. **Verified live over a
  168h window with the real module, on BOTH consumers — the class was never
  jodidaniel-only:** jodidaniel.com 5 alertable → 1 (the genuine #220
  `cms-scheduled-publish-loop` failure still alerts), adamdaniel.ai 6 → 2 (both
  real `cms-publish-loop-host` failures, the ones #215 addresses, still alert).
- **Absence is not health — dead scheduled workflows (#258).** The audit
  alerted only on runs that EXIST and concluded badly, so a workflow GitHub
  auto-disabled for inactivity — which emits **no runs at all** — was
  indistinguishable from a repo with no schedules: `filterAlertRuns([])` is
  `[]`, the `failures.length === 0` branch printed *"All scheduled workflows
  healthy"*, and if a tracking issue was open it posted a "clean window"
  comment and `PATCH state=closed`. A repo whose crons went dark mid-incident
  had its own alert **actively closed**. The signal is one field:
  `GET /repos/{repo}/actions/workflows` returns `state` ∈ `active | deleted |
  disabled_fork | disabled_inactivity | disabled_manually`. Dead cron-bearing
  workflows now feed the SAME finding set and the SAME open/comment/close
  lifecycle — only the *input set* widened (bad runs → bad runs + dead
  workflows). Four things are load-bearing and must not be undone:
  - **`DEAD_WORKFLOW_STATES` is `disabled_inactivity` + `disabled_manually`
    only.** `deleted` (file removed on purpose) and `disabled_fork` (a
    fork-only state) are deliberate exclusions — alerting on either is noise.
  - **Public repos only.** GitHub's 60-day auto-disable applies to public
    repos; `repo-settings` is private and carries crons that are off by
    intent. `isPublicRepo` / `isPrivateRepo` both demand a STRICT boolean
    `private`, so an ambiguous answer is neither — it becomes a probe failure,
    never a silent skip.
  - **An UNKNOWN answer never reads as "no findings."** A failed
    visibility/workflows probe sets `deadProbeFailed`, which **suppresses the
    auto-close** (the issue stays open with a `::notice::` saying a clean
    window is unproven) and reds the run. That is the #258 bug's exact shape,
    so it is guarded rather than trusted. The per-workflow schedule probe
    itself **fails SOFT** in the other direction — an unreadable workflow
    stays REPORTED, matching `partitionStarvedRuns`. That fail-soft path is
    now reachable for `disabled_manually` only (see the next bullet), which is
    why `e2e/scheduled-run-health.test.js`'s "the schedule probe fails SOFT"
    fixtures are `disabled_manually`: measured, with `disabled_inactivity`
    fixtures that test passes having called the probe **zero** times — a
    vacuous green. Do not change them back.
  - **Scoped by a runs probe for `disabled_manually` ONLY;
    `disabled_inactivity` short-circuits it.** The YAML route is still
    rejected — the reusable sparse-checks-out only the audit script, so no
    consumer workflow file exists on disk; the runtime is bare Node with no
    YAML parser (regex-scanning YAML is banned house-wide); and the file on
    the default branch may no longer carry `on: schedule` while the disabled
    workflow entry persists, so a YAML read can answer "no cron" about a
    workflow GitHub disabled precisely *because* it had one. But
    `workflowScheduledRunsEndpoint`
    (`…/workflows/{id}/runs?event=schedule&per_page=1`) answers from run
    RECORDS, and **"no records" is byte-identical for "never a cron" and "the
    records are gone"** — so a "no" there drops the workflow from the finding
    set silently. That is #258 deferred, not fixed. For `disabled_inactivity`
    the probe is therefore redundant *and* lossy: GitHub sets that state from
    exactly one mechanism, the 60-day auto-disable, which targets scheduled
    workflows in public repos — the state already proves the cron. **That
    premise is GitHub's documented behaviour, not measured here** — a 60-day
    auto-disable cannot be induced in a test and there is no live specimen
    (measured 2026-08-17: all 111 workflows across cms-platform 44/44,
    adamdaniel.ai 34/34 and jodidaniel.com 33/33 are `state=active`) — so if
    it is ever wrong the blast radius is one extra reported line, once per
    tracking issue, about a workflow that genuinely IS disabled.
    `SELF_EVIDENCING_CRON_STATES` short-circuits the probe for it (one fewer
    API call per dead workflow). Earlier text here called "did this ever fire
    on a cron?" *the sharper question for this detector*; that is now false
    for `disabled_inactivity`, where `state` is the sharper signal and the
    probe could only overrule it with a weaker one. **This is NOT a
    retention race** — measured 2026-08-17 on adamdaniel.ai, 531 schedule-event
    run records survive from >90 days ago and 241 from >124 days (none before
    the repo's own creation), so run RECORDS are not pruned on the documented
    90-day clock, which governs artifacts and logs. The reachable path is
    manual run deletion (`DELETE /actions/runs/{id}` or the Actions tab); the
    fix is justified by the probe being redundant and lossy on a
    silent-failure-detection path, not by a clock. `disabled_manually` KEEPS
    the probe: nothing about that state implies a cron, and reporting every
    hand-disabled workflow would make `dead.length > 0` permanent — the close
    branch is gated on `dead.length === 0`, so the tracking issue could never
    auto-close again. Dead workflows dedupe on a parallel hidden
    `<!-- dead-workflows: … -->` block keyed by file basename, kept strictly
    separate from `<!-- run-ids: … -->` so the two channels cannot clobber
    each other; each is reported **once** per tracking issue.
- **Exit-code contract:** the audit run stays GREEN when it successfully
  files/updates the alert (the issue is the channel); red means the audit
  ITSELF is broken (API/permission failure) — same "red needs a human"
  contract as `audit-editorial-labels.js --fix`. The audit is itself a
  scheduled workflow, so its own failed run is reported by the NEXT day's run.
  The starvation carve-out does NOT change this contract. The dead-workflow
  probe does not change it either — it OBEYS it: a probe that could not answer
  is the audit failing at its job, so it reds the run (while the run-based
  alert it already filed still stands, the probe having its own try/catch).
- **Callers:** `self-scheduled-run-health.yml` dogfoods it on cms-platform
  (cron `47 8 * * *` + dispatch); consumers get
  `examples/site/.github/workflows/scheduled-run-health.yml` (auto-seeded by
  `platform-bump` since v0.1.55). Callers must grant `actions: read` +
  `issues: write`, and declare the dispatch `dry_run` as `type: string` +
  `fromJSON`-coerced (typed booleans startup-fail the handoff — the exact
  failure class this audit exists to catch). Lint-locked by
  `e2e/scheduled-run-health.test.js` (workflow shapes + the script's pure
  helpers; registered in `PLATFORM_META_SPECS`).

## E2E local webServer: decap readiness + :4000 crash resilience

`e2e/playwright.config.js`'s local lane (`TARGET=local`) starts two webServers;
both are lint-locked by `e2e/webserver-readiness.test.js` (AST, not regex).

- **decap-server (:8081) waits on `port: 8081` (TCP), NOT a `url:` probe.** A
  `url: "http://localhost:8081/"` probe can never go ready — decap-server
  returns 404 for every GET route (/, /api/v1, /health) and Playwright's
  webServer readiness only accepts HTTP 200-403, so the whole local lane times
  out at the 60s webServer budget. (An earlier note here claimed the opposite;
  the `url:` form was tried and reverted — TCP is the only mechanism that works.)
- **The :4000 static server is `e2e/static-serve.js`, NOT bare `serve` (#1815).**
  Bare `serve@14`/`serve-handler` pipes the file ReadStream to the response with
  no `'error'` listener, so a racy post-open ENOENT (a TOCTOU on a `_site/admin/*`
  gem asset under the write-heavy admin lane) emits an UNHANDLED `'error'`,
  crashes the single shared :4000 process, and ERR_CONNECTION_REFUSED-es every
  later `@admin` spec — an 85-failure cascade that fails the canary cms/* PR's
  required `e2e / e2e`, blocks auto-merge, and wedges the prod loops. `static-
  serve.js` uses the SAME engine (serve-handler) + serve@14 config but overrides
  `createReadStream` to attach an `'error'` listener (so a post-open read error
  is handled, not fatal) plus an `uncaughtException` backstop. Never reintroduce
  bare `serve … -l 4000`.

## A cancelled required check blocks the merge (#1815)

If a canary cms/* PR shows every required check green + auto-merge armed yet sits
`mergeStateStatus: BLOCKED` and never lands — and an explicit
`gh api -X PUT repos/<r>/pulls/<n>/merge` returns
`405: Required status check "<ctx>" is cancelled` — the cause is a **cancelled
check-run for a required context shadowing the success on the same head sha**. No
merge mechanism (native auto-merge, explicit `pulls.merge`, or the nudge) can
override a cancelled required check, and GitHub picks **non-deterministically**
between a cancelled and a success run for the same context+sha (so the loop is
flaky, not consistently broken).

The source on these repos is a job with a `concurrency` group that fires
**multiple runs on the SAME head sha** — the canary loop flips labels
(`cms/draft`→`cms/ready`→`decap-cms/*`) without changing the sha, so an `on:
[opened, synchronize, labeled]` workflow fires a same-sha BURST of runs. The fix
is to give the required-check job **NO `concurrency` block at all** so every
same-sha run completes success. **Beware:** `cancel-in-progress: false` is NOT
enough — GitHub keeps the running run + only the LATEST pending run and CANCELS
the other pending dups in the group (documented behaviour), so a 4-run burst
still leaves ~2 cancelled (this defeated the first fix attempt at v0.1.27; the
real fix removed the concurrency entirely at v0.1.28). `cms-editorial-workflow.yml`'s
`validate-content` was the offender. **Rule:** any job that produces a REQUIRED
status context AND can be triggered more than once on the same sha
(label/multi-event triggers) must have NO `concurrency` group — a cancelled
required run is a hard, non-deterministic merge block. Locked by
`workflow-graph.test.js` for `validate-content`, and, since #285, for EVERY
required context by `e2e/required-context-concurrency.test.js` (platform tree +
the `examples/site` templates) and its CONSUMER-mode sibling
`e2e/consumer-required-context-concurrency.test.js` (a consumer's own callers
plus the reusables in its `.cms-platform/` checkout).

**The `push`/`synchronize` carve-out was withdrawn at #285.** This paragraph used
to end "(Workflows triggered only by `push`/`synchronize` — each a new sha — are
safe to cancel; `secrets-scan` + `visual-regression` keep `cancel-in-progress:
true` for that reason.)" Its premise is false, measured on adamdaniel.ai PR #3006
(2026-08-09): the PR opened at 01:57:10Z, a force-push moved the head at
01:57:38Z, and visual-regression runs 31289327061 (cancelled) and 31289327099
(skipped) were BOTH created at 01:57:41Z carrying head_sha `68d7c777` — webhook
delivery latency dispatches the `opened` run after the force-push has already
advanced the ref, so the two land on one sha. That time the cancelled check-run
was the non-required `visual-regression / generate`, so it was a near-miss. And
`opened`/`synchronize` cannot be narrowed away — without them the required
context never reports — so **no trigger set makes a shared key collision-free**.

`secrets-scan.yml`, `visual-regression.yml` and `self-ci.yml` therefore carry NO
`concurrency:` block at all as of #285. The cost is accepted knowingly:
superseded runs finish instead of being cancelled, so a rapidly-pushed PR burns
several full runs of each lane. Runner minutes are recoverable; a wedged required
check has no operator remedy.

Note also **where** each half of the fix can travel. `concurrency` lives in the
PLATFORM reusable, so a `platform_ref` bump carries its removal to both consumers
automatically. A `pull_request.types` narrowing would NOT have: `platform-bump.yml`
seeds only a wholly-MISSING caller and leaves an existing one alone even when it
has drifted, and `check-platform-pin-consistency.js`'s `structuralShape()`
compares `permissions` + `jobs.*` with `on:` deliberately excluded. A
template-only trigger change reaches neither live site, while a lint reading
`examples/site/` reports green forever.

## E2E workflow matrix (ported)

The full e2e/Playwright matrix is ported. Two shapes:

- **Reusable + thin caller** (caller in `examples/site/.github/workflows/`):
  `e2e-tests`, `cms-publish-loop-preview`, `cms-delete-published-preview`,
  `cms-preview-loops` (workflow_dispatch); `canary-prod` (schedule + dispatch);
  `parity-preview`, `preview-media` (pull_request, always-run + early-skip — the
  reusable's selector/salient-detector IS the skip, so the caller has NO `paths:`
  to avoid the required-check missing-check trap). Each checks the platform out
  into `.cms-platform/` and references composites by `./.cms-platform/.github/actions/`.
- **Full workflow in `.github/workflows/`** (pinned to that shape by platform
  lints, run in the platform's dogfooding context, reference composites by local
  `./.github/actions/`): the three real-prod loops `cms-publish-loop-prod` /
  `cms-media-roundtrip` / `cms-publish-loop-host` (lint:
  `e2e/workflow-prod-loop-serialized.test.js` — shared `prod-mutating-loop`
  concurrency lane on each loop job, byte-identical [HARD mutual exclusion];
  `recursion-gate` job + `await-prod-deploy` gate; PLUS the three example
  callers' push triggers are PAIRWISE-DISJOINT — prod OWNS the shared infra
  paths (`admin/**`, `playwright.config.js`, `package*.json`, `_config.yml`,
  `_layouts/post.html`) on push, media/host cover them via their daily cron — so
  a single push can't fire two loops and co-arrival-evict one in the shared lane
  (#70). The shared concurrency group still serializes any cron/dispatch/push
  TIME-overlap by queuing; disjoint triggers remove the same-push co-arrival.
  **The lane is REPOSITORY-scoped — it serialises the three loops WITHIN one
  consumer and does NOT serialise two consumers against each other.** That is a
  GitHub fact, not a choice: Actions has no cross-repo concurrency, and the group
  is evaluated in the CALLER's repository even though the reusable lives here. So
  adamdaniel.ai and jodidaniel.com CAN run their prod loops simultaneously, and
  should — separate buckets, distributions and canaries, nothing to serialise.
  Verified rather than assumed: adamdaniel.ai host-loop run 31179432081 and
  jodidaniel.com host-loop run 31181497216 overlapped 2026-08-07
  13:11:48-13:13:08Z and both succeeded, one of 4 such cross-consumer overlaps in
  4 days. Do NOT "fix" the bare literal group by adding
  `${{ github.repository }}` — it would be a no-op that only makes the
  byte-identity lint harder to satisfy.)
  and `visual-regression` (lints:
  `e2e/visual-regression-content-skip.test.js` + `-skip-review.test.js` — the
  `paths:` content-skip list, the `visually-different` output, the conditional
  `regression-review` environment).

Composites ported: `.github/actions/await-prod-deploy` (commit-json-url now
derives from a `prod-url` input; no hardcoded site URL), `.github/actions/cms-recursion-gate`
(resolves `cms-recursion-churn.js` from the workspace or `.cms-platform/`).

**Deliberately NOT ported / simplified** (adamdaniel-only infra — see each
workflow's "PLATFORM PORT NOTES" header): the GHCR `ci-runner-image` prebaked
Jekyll/Ruby image + the `build-image` jobs + `container:` blocks (deps install
inline instead); the preview-loop `if: ${{ false }}` operational disable (an
adamdaniel dispatcher incident, not a platform invariant). (The stuck-PR
diagnostic and the newline auto-resolver ARE both shipped — see "Remaining
work" below: `scripts/diagnose-stuck-pr.js`, wired via
`e2e/with-stuck-pr-diagnostic.js`, and `scripts/auto-resolve-newline-conflict.js`;
also see the `cms-stuck-pr-triage` skill.) The prod-loop serialization lint was
updated to expect the two-job (no build-image) inline-deps shape while keeping
every load-bearing invariant. `visual-regression` still needs the consuming repo
to ship a buildable Jekyll site + Gemfile, AWS OIDC/S3/CloudFront, and a
`regression-review` Environment; baselines regenerate per-site.

### Prod-loop deploy-lane diagnostic — judge on the spec's OWN deploy (#21)

The prod-mutate / media-roundtrip loops watch the chain
**Decap → cms PR → auto-merge → deploy-production → URL reflects**. When the
URL never reflects, `e2e/deploy-pill.js#waitForChangeReflected` asks the
`makeDeployQueueExtender` callback (`e2e/github-actions-poll.js`) whether to keep
waiting (backlog draining) or give up (real miss).

**The DELETE leg (v0.1.17, #45):** the loops also DELETE the canary via the
editor and wait for `/blog/<slug>/` to 404. A "Delete published entry" commits
DIRECT to main via the git data API (`POST …/git/trees`), but the old call site
had no proof the dispatch fired, so a silent no-op surfaced 900s later as the
SAME "no deploy fired" symptom as a reflect miss. `confirmEditorDelete`
(`e2e/cms-editor-ui.js`) now arms + awaits that `POST /git/trees` as
dispatch-proof. Distinguish the two: a CREATE/reflect miss vs a DELETE no-op —
see the `browser-testing` skill ("Native window.confirm()" → dispatch proof).

**The #21 finding (triple-verified — trust it):** the 2099 e2e canary's OWN
`/blog/<slug>/` page **builds correctly** and is correctly excluded from public
aggregations — the `exclude_e2e_posts` theme plugin only stamps
`sitemap:false`/`feed_exclude:true`, it NEVER suppresses the page. So #21 ("URL
never reflects") is **NOT a theme/build defect** — do not touch
`exclude_e2e_posts`. The failure is in the deploy → serve → poll chain (S3 sync /
CloudFront / cache), and the **diagnostic itself mis-reported it**: the extender
judged the lane on a sliding ~5-min wall-clock window anchored to "now"
(`recentWindowMs`), so once the per-spec URL-reflect budget elapsed >5 min after
the spec's own deploy completed, the lane read "quiescent" and the extender
declared a REAL MISS ("deploy-production lane is QUIESCENT") even though the
deploy DID fire + complete — a **false negative**.

**The fix (shipped):** `deployLaneActivity` + `makeDeployQueueExtender` now anchor
on the create PR's `merged_at` (threaded from the specs via
`getMergedAt: () => getPullRequest(...).merged_at`, since the merge lands DURING
the reflect wait). They count `deploy-production` runs with
`run.created_at >= mergedAt`. A **completed** such run is CONCLUSIVE — the deploy
fired + finished, so the chain is healthy and the failure is **URL-not-served**;
the extender stops with `verdict.kind = 'deploy-completed-url-missing'`
(`realMiss:false`). **No** run `created_at>=mergedAt` + an idle lane is the
genuine miss (`verdict.kind = 'no-deploy-fired'`, `realMiss:true`). A prior
unrelated deploy (`created_at<mergedAt`) does NOT count. `deploy-pill.js` reads
`onBudgetExhausted.verdict` and self-reports the true leg: *"your deploy run DID
complete but the URL never served the marker (S3 sync / CloudFront / cache)"* vs
*"NO deploy-production run fired for your merge (trigger problem)"*. Without a
`mergedAt` the legacy wall-clock heuristic still drives the verdict (back-compat).
This makes the loop **self-diagnosing**; the actual URL-reflection fix is
downstream and needs a live run with the new output. Locked by
`e2e/github-actions-poll.test.js` (mergedAt-anchored cases) +
`e2e/deploy-pill.test.js` (the two self-reporting messages).

**The #1815 budget alignment (media-roundtrip):** the diagnosis above is only
trustworthy if the per-leg URL-REFLECT budget is WIDE enough to span the real
auto-merge latency BEFORE the extender's idle/give-up logic can fire. A live
media-roundtrip run failed at ~907s/15min reporting *"NO deploy-production run
fired"* while the canary auto-merge was simply SLOW — the merge hadn't landed
yet, so `getMergedAt` returned null (unanchored), the lane was legitimately
quiescent (nothing can deploy before the merge), and the extender mis-called it a
real miss. The prod-mutate twin failed the SAME way on its delete leg (run
26989348549). **The fix:** `cms-media-roundtrip.spec.js` raises each
`waitForChangeReflected` leg's `urlTimeoutMs` from 15 → **30 min**
(`REFLECT_TIMEOUT_MS`), matching its `waitForMerge` 30-min budget
(`MERGE_TIMEOUT_MS`), so the INITIAL reflect window alone spans the ~30-min
auto-merge latency; `TEST_TIMEOUT_MS` 100 → **130 min** and the
`cms-media-roundtrip.yml` job `timeout-minutes` 110 → **150** to fit. **Do NOT
shrink these back under the auto-merge latency** — `e2e/cms-loop-budget-alignment.test.js`
(a PLATFORM_META_SPEC pure-fs lint) locks: media's MIN reflect leg `>=`
prod-mutate's AND `>=` the 30-min floor, media's `waitForMerge` `>=` prod-mutate's,
media's `TEST_TIMEOUT_MS` `>=` prod-mutate's, and the spec timeout fits the job
`timeout-minutes`. The publish mechanism + canaries are unchanged — only budgets.

**Ask whether the PR MERGED before blaming the chain (#215, v0.1.76).** The
#1815 budget widening bought time, but the verdict itself was still wrong in the
same window: before the merge lands the deploy lane is idle for a **completely
innocent** reason — nothing can deploy yet — and the extender read that as "the
chain never fired". Observed live, not hypothetical: adamdaniel.ai run
31107474927 (2026-08-06 host-loop) killed `cms-tags-lifecycle` at *"Waited 908s
and NO deploy-production run fired for your merge — the chain never fired"* with
in-flight 0 / queued 0, while the auto-merge was merely PENDING (908 s is well
inside the documented ~30-min latency). Same class in runs 30915982319 and
30822288078; the other two host-loop specs passed in that run, so the diagnostic
— not the chain — failed the third.

**The scope was wider than the issue:** **13 of the 15**
`makeDeployQueueExtender` call sites called it BARE, hence unanchored, hence
could never reach the conclusive `deploy-completed-url-missing` verdict at all —
the #21 fix only ever applied to **2** legs. The extender now takes an optional
`getPr`, and where `no-deploy-fired` would be emitted it first asks whether the
PR has merged. Unmerged ⇒ `pr-awaiting-required-check` or
`pr-required-check-red` (both `realMiss:false`, naming the check; check-run STATE
alone separates awaiting from red), plus a bounded extension so the loop waits
the merge out. **`no-deploy-fired` stays REACHABLE and remains `realMiss:true`**
when the PR IS merged, or when no PR info was supplied — a unit test locks that
reachability, because making a real miss unreachable would turn a failure into
silence, the opposite of what #215 asks for. The extension is **double-bounded**:
`maxTotalExtendMs` inside the extender and `maxExtensions` in
`waitForChangeReflected`.

**Six forward/create legs are threaded** (including the exact one that failed
live); **nine stay BARE on purpose**, each because no PR for that leg is in scope
— the delete legs discover their recovered PR inside a poll loop without
capturing it, and `cms-unpublish-republish` never opens a tracked PR at all. Bare
is the unchanged pre-#215 path, so those legs keep today's behaviour. **Deliberate
deviation from the issue text** (recorded in-comment): it proposes threading a
`requiredContexts` list, and there is **no single source** of those in this repo —
the harness default is the bare `["validate-content"]`, adamdaniel's nudge caller
lists 6, jodidaniel's 1, and `examples/site`'s template still ships a stale
9-context list matching no real check-run name. Importing that divergence would
make the verdict wrong in a NEW way, and `headChecksTrulyGreen` throws on an
empty list — while the list-free question "has the PR merged?" needs none of it.

### Ephemeral canary branch hygiene (#22)

The prod loops force-push EPHEMERAL per-run branches that orphan when a cycle
cancels/fails (~35 piled up on adamdaniel): `cms/posts/2099-12-31-e2e-prod-mutate-<runId>`,
`cms/posts/2099-12-31-e2e-media-roundtrip-<runId>` (Decap, runId = `Date.now()`),
and the host loop's `cms/e2e/canary-*` + `cms/e2e-fixture/*`. Two defences:

- **Per-loop `if: always()` cleanup step** in each loop reusable
  (`cms-publish-loop-prod.yml`, `cms-media-roundtrip.yml`,
  `cms-publish-loop-host.yml`): runs on success/failure/cancel,
  `continue-on-error: true` + every delete `|| echo`-guarded (**FAIL-OPEN** — a
  cleanup hiccup never fails the loop). Since runId is `Date.now()`, it
  **pattern-deletes** every branch on the loop's OWN prefix that has **no open
  PR** (a live cycle's branch always carries its in-flight cms/* PR). Auth via
  `CMS_E2E_PAT` (the workflow grants only `contents:read`).
- **`sweep-stale-cms-prs.yml`** extends `TEST_ONLY_PATTERNS` with the two
  `cms/posts/2099-12-31-e2e-{prod-mutate,media-roundtrip}-` prefixes so the daily
  age-gated, no-open-PR, `[sweep-keep]`-opt-out Tier 1 close + Tier 3 branch prune
  now reaps those orphans too. Safe to safelist because the 2099 + `e2e-` loop
  signature is NEVER human-authored (unlike a bare `cms/posts/<slug>` draft).

Locked by `e2e/workflow-loop-branch-cleanup.test.js` (parses with the `yaml`
lib). If you add a new ephemeral loop branch prefix, add its cleanup step AND
extend that lint + the sweep safelist.

### A bump push fires ALL THREE loops, so the bump-skip must not be brittle

The `recursion-gate`'s bump-skip (#57) is what stops a platform-version bump from
re-firing the prod loops, and it is load-bearing for a reason #70's
disjoint-push-triggers fix cannot cover: **a bump rewrites the `uses:@<ref>` pin
in EVERY loop's own workflow file**, which is each loop's own trigger path — so a
bump always fires all three at once. They share the `prod-mutating-loop`
concurrency group, which holds an in-flight run but **drops a co-arriving
sibling**, so without the skip a bump costs you a CANCELLED loop.

Observed live on adamdaniel.ai (2026-08-07): the gate required EVERY changed path
to be a version pin, and a single `AGENTS.md` commit landed on the bump PR — the
natural place for a doc correction that goes with the bump — was enough to fail
that test. All three loops fired; `media-roundtrip`'s heavy job was cancelled
outright (run 31185014802) while `host-loop`'s survived. So `isBumpOnlyPush` now
also tolerates paths that **cannot change the built site** (`AGENTS.md`,
`CLAUDE.md`, `README.md`, `LICENSE`, `docs/**` — exactly what the deploy
workflows already `paths-ignore`). A bump carrying real content, a script, a
config, or CSS still fails it and correctly RUNS. Both directions are locked by
`e2e/cms-recursion-churn.test.js`.

## Workflow interpolation sinks: `run:` AND `with.script` (#261)

`e2e/workflow-injection-lint.test.js` is the standing guard. The invariant:
**a `${{ … }}` expression must never be expanded into text that is later
PARSED as code** — neither a `run:` shell body nor an `actions/github-script`
`with.script` JS body. The runner substitutes the value into the command text
*before* bash (or the github-script eval) parses it, so the value arrives as
source, not data. `env:` binding (`"$NAME"`) and `process.env.NAME` are the
fix, and they work because they leave the command text byte-identical
whatever the value is.

This generalises #259, which fixed exactly one expression (the cms slug) at
its six call sites. The lint fixes the *shape*.

### Two corrections to the permanent record

Issue #261's body carried two claims that a parser scan refutes. Both are
recorded here because the issue text will outlive anyone's memory of it:

1. **"the lint also does not cover `with.script` on `actions/github-script`,
   the same substitution sink (no such use exists today, verified by
   parser)" — REFUTED.** Two such uses existed when #261 was written:
   `deploy-preview.yml`'s "Post preview URL comment" (`head.sha`) and
   `deploy-production.yml`'s "Update GitHub Deployment status"
   (`deployment_id`). The "verified by parser" was true only of the *slug*
   expression — `e2e/deploy-preview-cms-slug.test.js` checks
   `steps.cms_slug.outputs.slug` and nothing else. Generalised to "no such
   use exists", it was wrong.
2. **"six residual `${{ github.event.* }}` in `run:` bodies" is scoped, not
   repo-wide.** Six is `deploy-preview.yml`'s own deploy + teardown jobs
   (`number` ×5 + `head.sha` ×1). Repo-wide the run-body count was **11**,
   and the full category (run + `with.script`) was **13**. All 13 are now
   bound; the lint holds the tree at zero.

### What the lint scans, and what it deliberately does not

**Arm 1 — `run:` bodies.** Red on any interpolation that REFERENCES
`github.event`, `github.head_ref` or `github.base_ref` — in **any spelling**.
The match is on lexed expression **paths**, not on expression text (see "A
regex over expression TEXT is blind to a RESPELLING" below).
`github.event_name` is a closed enum the runner sets, used today in
`dependabot-comment-sync.yml` and `repo-settings-audit.yml`, and must stay
unflagged; comparing SEGMENTS is what keeps it unflagged in every spelling —
`github['event_name']` and `GITHUB.EVENT_NAME` included — rather than the
trailing dot of a substring match.

**Arm 2 — `with.script` bodies.** Red on ANY interpolation, with no
allowlist. A github-script body is JS handed to an eval and every dynamic
value it needs is already reachable through `process.env` or `context` —
which is how 18 of the repo's 20 github-script steps, and all of the
composite actions, already read theirs. No value class needs to arrive as
source text, so the shape itself is the defect.

**Scope stops at `run:` and `with.script`.** `if:`, `env:`, and every other
`with:` key are runner-EXPRESSION contexts where the value never becomes
code. Binding a value there is the fix, not the bug — scanning them would
make the fix un-expressible. `deploy-production.yml`'s
`if: always() && steps.deploy-start.outputs.deployment_id` gate is the
standing example: it reads the output directly and must stay that way.

**`steps.*.outputs.*` and `inputs.*` are excluded from arm 1 — per-site, not
categorically.** This is NOT a claim that either class is inherently safe: a
step output is only ever as closed as the step that produced it, and
`e2e/select-specs.js` demonstrably does `specs.add(f)` on a changed *file
name*. Each current site was traced to a closed value space individually
(`parity-preview.yml`'s `steps.select.outputs.specs` draws from the closed
`PARITY_PREVIEW_SPECS` constant; `cms-preview-slug.sh` sanitises to
`[a-z0-9-]` since #259). A new step-output site owes that trace again.
**`e2e/deploy-preview-cms-slug.test.js` is NOT subsumed by this lint** — it
is the only coverage for the slug-output class, and deleting it as
"redundant" would silently re-open #259.

### The waiver, and why it matches ABSOLUTE file lines

Default-deny with an inline escape hatch: an occurrence is permitted only
when `# injection-allow: <reason>` sits on its own source line or the line
immediately above. A bare marker with no reason does not grant.

The window is matched against **absolute file lines, not the extracted body
array** — measured, and not a detail. A one-line plain `run:` scalar puts its
interpolation at body offset 0, so a body-relative "line above" check cannot
see a comment at the only place it fits (above the `run:` key), and the
waiver silently fails to apply. An `env:` binding **read back as a shell
variable** needs no waiver at all: `"$NAME"` removes the `${{ }}` from the
body entirely, into a map this lint does not scan. Reading it back as an
**expression** — `"${{ env.NAME }}"` — does *not*, and is flagged; see "the
root set is a NAME SET" below. This sentence previously said a binding needs
no waiver full stop, which was **false** whenever the body read it back.

**The waiver has no split-across-lines evasion of its own** — checked when
the split-expression hole below was closed, because a permission that could
be smuggled would have re-opened it by another route. Two properties hold it
shut, both locked by the canary. The window anchors to the line the `${{`
OPENS on, so a marker sitting above the closing `}}` — an interior line of
the span, the tempting placement — grants nothing. And a marker cannot
itself be split: a YAML (or shell) comment does not span lines, and `WAIVER`
is matched per raw source line, so `# injection-` / `# allow: …` on two
lines grants nothing either. Splitting can only ever LOSE a waiver, never
gain one.

### Where the guarantee ends: the root set is a NAME SET, not dataflow

Read this before trusting arm 1. The runner's real danger property is *"an
expression result is substituted into text that is then parsed as code"* —
a **dataflow** question. This lint does not do dataflow and is not going to.
Four adversarial rounds closed *where* the expression sits (parsed bodies),
*how* it is spelled (lexed path segments) and *where* it ends (a lexed
occurrence boundary); each of those three is now general by construction.
**The root set is the one axis that stays an approximation** — it is a list
of names, and it stays a list of names however many are added.

So, plainly: **a dangerous value laundered through a root outside the set
will not be caught.** Deliberately outside it: `github.run_id`,
`github.repository`, `needs.*`, `inputs.*`, `steps.*.outputs.*`. Those have
live, individually-traced sites (see the `steps.*.outputs.*` paragraph
above); a *new* site under any of them owes that trace again, and this lint
will not ask for it.

**`env.*` and `matrix.*` ARE in the set (#264 round 5)** — the two
laundering contexts. `env` is there because it is **the fix this lint
recommends**, and the fix is the `env:` *key*, not the `env` *context*:

```yaml
env:
  BASE: ${{ github.event.pull_request.base.ref }}
run: git fetch --no-tags origin "$BASE"          # the fix — silent
run: git fetch --no-tags origin "${{ env.BASE }}" # the sink again — flagged
```

Both halves of the second form look individually blessed (the binding is the
HOWTO; reading it back is "just a variable"), and the runner substitutes the
branch name into the command TEXT either way. Measured in
`visual-regression.yml`'s `Fetch base ref`: before this change the second
form passed this lint (`hits: []`) **and** actionlint v1.7.7, both **exit
0**. And actionlint is no backstop here either, measured on a field on its
*own* untrusted-input list in that same step — direct
`${{ github.event.pull_request.title }}` in `run:` exits **1** (*"is
potentially untrusted"*), while binding it and reading `${{ env.T }}` exits
**0** and says nothing. It models `env` as a live resolvable context
(`${{ env.ANY }}` type-checks at exit 0); it simply has no dataflow rule.
`matrix` is the same laundering shape without the irony (a dynamic
`fromJSON(needs.…)` matrix can carry anything) and is the weaker of the two
additions — included because it is free, not because a sink exists.

**Free, measured, not assumed:** 42 files, 149 code bodies, 21
interpolations, root heads `github.event_name` ×2, `github.repository` ×2,
`github.run_id` ×2, `inputs.*` ×7, `needs.generate` ×4, `steps.*` ×5 —
**zero** `env.*`, **zero** `matrix.*`; and 0 of the 30 pre-existing canary
cases change verdict. Both contexts *do* appear elsewhere in the tree
(`e2e-tests.yml`'s `PW_PROJECT: ${{ matrix.project }}`,
`repo-settings-apply.yml`'s `OWNER: ${{ matrix.owner }}`) but only under
`env:` / `with:` / `name:`, which this lint does not scan — so the fix stays
expressible. Every `env.` inside a code body is JavaScript `process.env.X`,
never a `${{ }}` span.

Why these two and not the other five is a **cost call, not a principle**:
these cost nothing today and `env` is where the file's own HOWTO puts the
dangerous value. Widening further is legitimate. Claiming the list is
complete is not.

### Five shapes that made the lint itself fail

- **One `test()` per FILE, never one per OFFENDER.** A test-per-offender
  design emits ZERO tests once the tree is clean, and Playwright exits 1 on
  `No tests found` — so the lint's own success state fails its own verifier
  (measured: `EXIT = 1`). It exits 0 only when co-run with a sibling that
  emits tests, so the self-CI glob would mask it while a targeted run of just
  this spec went red. Per-file keeps file+line in the failure message and
  always emits one test per workflow (42 today), plus the canary below.
- **A per-line scan is BLIND to a SPLIT expression.** `${{` and `}}` may sit
  on different source lines. The runner reads that span as one expression and
  substitutes it exactly as if it had been written on one line — actionlint's
  expression parser agrees, resolving contexts *inside* the span — but the
  first version of this lint matched per body line and so saw neither half.
  Measured: `base.ref` reinstated into `visual-regression.yml`'s
  `Fetch base ref` as

  ```yaml
  run: |
    git fetch --no-tags origin "${{
      github.event.pull_request.base.ref
    }}"
  ```

  passed this lint **and** actionlint, both **exit 0** — the repo's one
  charset-injectable sink straight back through the gate, with nothing going
  red. `scan()` therefore matches over the WHOLE parsed body, where the
  parser has handed the expression back contiguous and where the runner does
  its substituting, and anchors each hit to the line its `${{` OPENS on. Do
  not "optimise" it back to a per-line loop.
- **A regex over expression TEXT is blind to a RESPELLING.** Closing the
  split-expression hole above fixed *where* the expression sits and left *how
  it is spelled* untouched: `scan()` read the parsed body, but arm 1 still
  substring-tested the expression with `/github\.event\./`. An Actions
  expression has its own grammar — index syntax is interchangeable with
  property dereference, whitespace (spaces **and tabs**) is insignificant, and
  names are **case-insensitive** — so all five of

  ```text
  github.event.pull_request.base.ref
  github['event']['pull_request']['base']['ref']
  github.event['pull_request'].base['ref']
  github . event . pull_request . base . ref
  GitHub.Event.Pull_Request.Base.Ref
  ```

  read the same branch name at runtime, and that regex saw only the first.
  Measured: the index form reinstated into the same `Fetch base ref` step
  passed this lint **and** actionlint, both **exit 0** — the identical
  charset-injectable sink through the gate again, respelled. Verified against
  actionlint v1.7.7's own expression parser, which normalises every spelling
  above back to the dot path.

  **actionlint is no backstop for this value.** It does normalise the
  spellings, but `base.ref` is not on its untrusted-input list in *any* of
  them: all five, plus `toJSON(github.event)` and `toJSON(github['event'])`,
  pass it at **exit 0** in a `run:` body (measured on all 42 workflows). For
  the repo's one charset-injectable value, this lint is the only net.

  Arm 1 therefore LEXES each interpolation into context paths
  (`contextPaths()`) and compares folded SEGMENTS (`onUnsafeBranch()`) — the
  house "parser, not regex, for code structure" rule applied one layer below
  the YAML, since an expression path *is* code structure. Four properties are
  load-bearing, and each has a canary case that goes RED when it is removed
  (measured, one mutation at a time):

  - **Segments are compared, and folded to lower case.** Folding is what
    catches `GitHub.Event.…`; a draft that closed only index/mixed/spaced
    still passed it. Comparing segments rather than substrings is what keeps
    `github.event_name` unflagged in *every* spelling without a special case
    (`event_name` is simply not the segment `event`). Index literals are
    folded too — one step beyond what is provable here, because actionlint
    treats them as case-*sensitive* (it rejects `github['EVENT']`) and the
    runner's behaviour cannot be measured offline. Folding can only add hits,
    never drop one, so the conservative branch is the right one.
  - **Both directions on the branch count.** A reference to an *ancestor* of
    an unsafe root is unsafe too: `toJSON(github.event)`, `toJSON(github)` and
    a bare `${{ github }}` serialise the whole attacker payload into the body,
    and the old trailing dot passed all three at exit 0. A deliberate
    widening, not a side effect — and free: it changes the verdict on none of
    the tree's 21 live `run:` interpolations (measured, old matcher vs new,
    zero disagreements).
  - **An unresolvable segment matches any name.** A dynamic index
    (`github[inputs.k]`), a function-computed one (`github[format(…)]`) and a
    star filter all become `ANY` and flag. A star's *position* matters and is
    why this cannot be left to a text prefix: `github.event.…*.ref` keeps the
    literal `github.event.` in front of it and the old regex caught it by
    accident, while `github.*.pull_request.base.ref` erased the only thing
    that regex could see. Zero such forms exist in the tree (measured: 149
    code bodies, 21 interpolations), so closing the shape costs nothing.
  - **`-` is a name character, and `'` is the only string delimiter.** The
    grammar has no subtraction operator, so `a-b` lexes as one segment —
    actionlint reports `github.event-name` as *property "event-name" is not
    defined* and rejects `github.run_number - 1` as a lex error. Dropping `-`
    from the name charset would split `github.base_ref-ish` into a FALSE
    POSITIVE on `github.base_ref`. A *double*-quoted index is a lexer error,
    not a second spelling (actionlint rejects `github["event"]`, and its error
    enumerates the legal charset with `"` absent); it lexes as `ANY` here and
    flags, harmlessly, since it can never run.

  The **tempting shortcut is text-rewriting** `['x']` to `.x` and then
  substring-testing. Do not: measured, it closes only the index spelling and
  still passes both `GitHub.Event.Pull_Request.Base.Ref` and
  `toJSON(github.event)`. (A related claim — that the rewrite would red
  `dependabot-comment-sync.yml` and `repo-settings-audit.yml` — is **false**
  as long as the substring keeps its trailing dot: `github.event_name` does
  not contain `github.event.`. The shortcut's real defect is the spellings it
  misses, not a false positive it creates.)
- **A regex over expression text is also blind to where the expression
  ENDS.** Fixing *where* the expression sits and *how it is spelled* still
  left the OCCURRENCE BOUNDARY as a regex, `/\$\{\{[\s\S]*?\}\}/g`, which
  stops at the first `}}`. The runner's lexer does not: a `}}` inside a
  single-quoted literal is **data**, so writing one first hides everything
  behind it. Measured, reinstated into the same `Fetch base ref` step:

  ```yaml
  run: git fetch --no-tags origin "${{ '}}' != '' && github.event.pull_request.base.ref }}"
  ```

  the regex extracted `"${{ '}}"`, which lexes to **no paths at all**, so
  arm 1 saw nothing and the spec passed at **exit 0** — the same
  charset-injectable sink through the gate a third time, alongside
  `${{ format('{1}', '}}', …) }}` and `${{ '}}' == '' && 'x' || … }}`, and
  composing with the line-break split. actionlint passed the first and third
  at exit 0. (**Correction, re-measured:** it exits **1** on the `format`
  one — but on an unrelated *arity* finding, *format string "{1}" does not
  contain placeholder {0}*, not on the injection. The well-formed respelling
  `format('{0}{1}', '}}', …)` exits **0**, so the evasion class is real and
  only the old blanket sentence was wrong.) The span is genuinely readable,
  not a lex error: swapping in
  the untrusted-listed `.title` makes actionlint report at **column 50**,
  *past* the in-literal `}}`, and on a truly unterminated literal it says
  `unexpected EOF while lexing end of string literal` — which it does not
  say here.

  `interpolations()` therefore finds a span's end by **lexing**, skipping
  `'…'` literals (and their `''` escape) via the same `endOfString()` the
  path lexer uses, and resumes scanning at the END of each span so a `${{`
  written inside a literal opens nothing. Two properties are load-bearing
  beyond the literal-skip itself, each with its own canary witness: a
  truncated span does not merely under-report but can vanish entirely (the
  regex's resync lands mid-expression), and resuming at `open + 3` instead
  of at the span end FALSE-POSITIVES on a quoted `${{`.

  **Default-deny extends to the boundary**, on **three** counts. A span
  whose literal never closes, one that never reaches `}}` at all, and one
  that steps over a character the expression lexer cannot lex are all spans
  the grammar cannot read — so `interpolations()` marks each UNREADABLE
  *itself*, in both arms, without consulting the path matcher. The old
  regex emitted no occurrence at all for the second shape, which is
  silent-skip in its purest form. Verdict-neutral on the tree: 149 code
  bodies, 21 interpolations, **zero** unterminated spans and **zero**
  old-vs-new disagreements.

  The third count (`LEXABLE`) closes the last boundary residual, and the
  reason it is done locally rather than left to actionlint is the point. A
  span terminating at a `}}` sitting inside a construct the lexer does NOT
  model — `"…"`, backticks, a nested `${{` — comes back SHORT, with no
  paths and nothing unterminated, and was silently skipped:

  ```yaml
  run: echo "${{ "}}" && github.event.pull_request.base.ref }}"
  #                ^^ span cut here; everything behind it invisible
  ```

  That was benign only because those characters are actionlint lex errors —
  an **external dependency** on a tool this same section proves twice over
  is no backstop (it is silent on `base.ref` in every spelling, and silent
  on `pull_request.title` one `env:` hop away — a field on its *own*
  untrusted list). `LEXABLE` is read off the reference lexer's own error,
  which enumerates the legal token-start charset verbatim: *expecting
  'a'..'z', 'A'..'Z', '_', '0'..'9', ''', '}', '(', ')', '[', ']', '.',
  '!', '<', '>', '=', '&', '|', '*', ',', ' '*. Two members are added, each
  measured: `-`, a name *continuation* rather than a token start
  (`github.event-name` lexes as ONE token), and `\t`/`\n`/`\r`, which that
  message's `' '` stands in for (a tab inside a span and a span straddling
  a line break both exit 0). It cannot false-positive on a workflow that
  parses — by the grammar, and literal *content* is skipped before the
  test — and it does not on this tree: across all 21 live spans the
  distinct characters stepped over outside literals are
  `" &()-.=JNOS_a-z|"`, of which **zero** are out of charset. This is
  deliberately **not** "flag any span containing a quote"; `'` is legal and
  its contents are data, and the canary's safe-brace control pins that
  direction shut.
- **The `with.script` extractor is STRUCTURAL** (`githubScriptBlocks()` in
  `e2e/workflow-yaml-utils.js`): it walks to a step mapping carrying a
  `uses:`, matches it against an **anchored** `/^actions\/github-script@/`
  so a lookalike fork is not trusted, and only then reads `with.script` off
  that same mapping. Matching bodies by content would misattribute two
  github-script steps that share a body.

### What this bought, stated honestly

**Zero of the 13 were anonymously exploitable.** A PR `number` is a
GitHub-assigned integer; a `head.sha` is 40 hex; a `deployment_id` comes from
the workflow's own prior API call; a `user.login` is `[A-Za-z0-9-]` (plus
`[bot]`) and carries no shell metacharacter. The one charset-injectable sink
was `github.event.pull_request.base.ref` — `git check-ref-format` permits
`$( )`, backticks, `;`, `|` and `&` in a branch name, and `${IFS}`
substitutes for the space that IS rejected — but poisoning it needs a branch
in the base repo, i.e. write access, which already lets the attacker edit the
workflow. Every current caller also triggers on `pull_request` with
`branches: [main]`, which pins `base.ref` to `main`; that is a property of
the CONSUMER's caller, not of the reusable, so a future permissive caller
restores reachability.

So the value is in the **lint** — blocking the next sink, which may not be a
hex string — plus defense-in-depth on `user.login`, the one genuinely
adversary-supplied value reaching a body under the privileged
`pull_request_target` trigger. Treat the `deploy-preview.yml` /
`deploy-production.yml` edits as live-deploy-chain changes and validate them
with the prod-mutate loop, not with the lint's exit code.

### Two things the lint cannot see

- **It cannot tell a complete fix from a half-applied one.** Dropping a
  `${{ }}` *without* adding the `env:` key leaves `$BASE_REF` undefined and
  the lint stays green. That is why `dependabot-comment-sync.yml`'s skip
  block gained `set -euo pipefail` — without `set -u` it would emit an empty
  author forever, silently. Any new binding in a block lacking `set -u` owes
  the same hardening, or an explicit non-empty assertion.
- **Consumers get no enforcement from it.** The spec is registered in
  `PLATFORM_META_SPECS`, which `testIgnore`s it on every CONSUMER e2e lane —
  the same posture as `workflow-shell-glob-lint.test.js`. Registration is
  mandatory (the #16 recurrence guard reds otherwise, measured), and it costs
  nothing today: `adamdaniel.ai`, `jodidaniel.com` and `examples/site` scan
  **0 sinks each** across 32 workflows apiece. A consumer thin caller that
  grows one is not caught here.
