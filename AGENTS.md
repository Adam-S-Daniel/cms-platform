<!-- BEGIN MANAGED SECTION — DO NOT EDIT ABOVE "## Repo-specific additions" -->
<!-- Source: _agent-guidance -->
<!-- Sections: none -->
<!-- Mode: stub -->

# AGENTS.md

> **Managed by [`_agent-guidance`].**
> Edit only below the `## Repo-specific additions` header.
> Everything above it will be overwritten on the next sync.

## Fleet guidance is delivered once per session — not by this file

The account's full guidance — incidents, fleet policy, machine layout, the
traps that cost real outages — is installed into **user memory**
(`~/.claude/CLAUDE.md`) by the `fleet-memory` SessionStart hook, so it is
loaded **once per session** no matter how many repos are attached. It used to
be inlined here in every repo, which meant a session with 19 repos open
carried 19 identical copies: 332.3k tokens of a 1M window, measured
2026-08-29.

**Check the session-start verdict before you rely on it.** The hook prints one
line:

- `fleet-guidance: installed (v<id>, <n> bytes)` or `fleet-guidance: current` —
  the full guidance is in context. Use it.
- `fleet-guidance: DEGRADED — <reason>` — it is **not** in context. You have
  only what is below. Read `agents-md/base.md` in the `_agent-guidance`
  checkout (or on GitHub) before non-trivial work, and say in your reply that
  you were running degraded.
- `fleet-guidance: skipped (FLEET_GUIDANCE_SKIP set)` — also not in context,
  but by the machine owner's deliberate choice, not a fault. User memory is
  GLOBAL on a durable machine, so the guidance would otherwise load in every
  unrelated project on that box; `FLEET_GUIDANCE_SKIP` opts out and removes any
  block an earlier session installed. Read `agents-md/base.md` the same way you
  would when degraded — just don't report it as a problem or try to "fix" it.

No verdict at all means the hook never ran — treat that as DEGRADED.

## Codex reads the same block, from `~/.codex/AGENTS.md`

The hook writes the same block to `~/.codex/AGENTS.md` whenever `~/.codex`
exists — Codex's global **user** instructions, outside its 32 KiB
`project_doc_max_bytes` project-doc budget. Register it once per machine with
`scripts/register-codex-hook.sh` from an `_agent-guidance` checkout, then
trust it in `/hooks`. `codex debug prompt-input` shows exactly what a session
loaded; no `fleet-guidance:` line there means DEGRADED.

For Codex Cloud, use **Manual** environment setup with persistent
`CODEX_HOME=/opt/codex`. Preserve the repository's dependency setup and run
`bash .claude/hooks/fleet-memory.sh --codex-cloud` in both setup and
maintenance; reset the cache for the first verification. Fresh setup and
cached maintenance were verified in the `_agent-guidance` environment. See
[`docs/codex-cloud.md`](https://github.com/Adam-S-Daniel/_agent-guidance/blob/main/docs/codex-cloud.md).
If the Cloud shell has no `codex debug prompt-input`, the saved task response's
raw initial instruction envelope is the echo-free proof of model-visible
delivery.

## The floor: rules that hold even when the guidance did not load

These are the ones with teeth. They are restated here, deliberately, because a
session that lost the guidance must not also lose these.

- **Branch protection is real.** Fleet repos are PR-only on their default
  branch; a direct push is rejected (GH013), even from the repo's own
  workflows. Never design a bot that pushes to a protected default branch.
- **Every `uses:` is pinned to a full 40-character commit SHA, with no
  trailing version comment.** The one carve-out is a ref into this account's
  own `cms-platform`, which stays on its release tag.
- **Never commit secrets or `.env` files, and never print personal data to a
  CI log** — logs, artifacts and git history on a public repo are public.
- **A successful `git push` does not mean your commit exists.** A refused
  pre-commit hook still lets the push report success. Verify with
  `git merge-base --is-ancestor <sha> origin/<branch>` — it is the only check
  that names both the commit and the ref.
- **"The watch finished" is not "CI passed."** Read the parsed conclusions;
  never infer pass/fail from a watch command's exit code.
- **A GitHub 404 means "not authorized", not "not there."** Never report a
  repo, PR or branch as gone on a 404 alone.
- **The fleet spans TWO owners** — `Adam-S-Daniel` and `jodidaniel`. A query
  scoped to one returns a plausible, complete-shaped, wrong answer.
- **Anything you name gets its link** — what you hand over, what you are
  waiting on, and what you cite as already done.
- **Merge with a merge commit** (`gh pr merge --merge`); do not amend
  published commits or force-push shared branches.
- **Keep this file under 32 KiB.** Codex truncates project instructions at
  that byte silently; the sync warns and the drift report flags
  `codex-truncated`.

<!-- END MANAGED SECTION -->
## Repo-specific additions

# AGENTS.md — working in cms-platform

Reusable CMS machinery extracted from **adamdaniel.ai**, so new sites get the
same Jekyll + Decap + AWS stack and improvements sync **both ways**. Design:
`docs/ARCHITECTURE.md`; sync model: `docs/SYNC.md`. Consumers: **adamdaniel.ai**
(consumer 1, the dogfood) and **jodidaniel.com** (consumer 2, a single-page
bio).

**Current release: `v0.1.108`** (`v0.1.0`–`v0.1.108` are tagged; cut one with
`gh workflow run release.yml -f version=vX.Y.Z`). The bump is ONE atomic edit in
the release PR, before the dispatch: this line, both plugin manifests
(`plugin.json` + `.claude-plugin/plugin.json`), the `docs/VERSION-HISTORY.md`
entry, **every platform pin under `examples/site/.github/workflows`** (each
`uses:@ref` and each `with: platform_ref:`), and **`scaffold/create-site.js`'s
`PLATFORM_VERSION`**. `release.yml` refuses a tag disagreeing with the
manifests; `e2e/examples-site-pins-current.test.js` enforces the last two in the
REQUIRED node-unit-lints lane, from in-repo values only — which is what lets the
release PR go green *before* the tag exists.

## The model

Two repos. **This repo owns all machinery** (versioned, semver tags); a **site
repo** holds only content + identity (`_config.yml`) + thin callers. Site
content/branding/docs **never** sync; platform/infra/CI/tooling do (skills not
at all); collection types are opt-in via the SITE-owned seam
`admin/collections.site.yml`, and the Decap admin UI ships inside the theme gem
(v0.1.4+), so a consumer keeps the seam, not a copy of `admin/`.

## Deeper references

Each section below keeps the rule and its incident; `docs/` has the long form.

| Doc | Read it when… |
|---|---|
| `docs/ARCHITECTURE.md` | the two-repo design, end to end. |
| `docs/SYNC.md` | what syncs to a consumer, or drift. |
| `docs/ADMIN-DELIVERY.md` | `theme/admin/`, a render path, `base_collections`, `field_library` `$ref`, the logo / `preview.md` / 404 seeds. |
| `docs/CONSUMER-COMPATIBILITY.md` | an e2e spec, an org OAuth save failure, bundle parity, a nudge's contexts. |
| `docs/PIN-CONSISTENCY.md` | pin consistency, the pin-comment lint, `platform-bump.yml`. |
| `docs/FLEET-CALLER-CURRENCY.md` | how a fleet repo's `scheduled-run-health` caller stays current: the self-resolving checkout, the currency lane, a fleet repo's cms-platform Dependabot `ignore`. |
| `docs/CI-INVARIANTS.md` | a required check, a scheduled workflow, the label audit, `site-verify.yml`, the webServer, a loop. |
| `docs/E2E-PARALLELISM.md` | e2e workers, sharding, the browser install. |
| `docs/PUBLISHING-UX.md` | what an editor sees of publish/status, or a spec that publishes. |
| `docs/CROSS-POSTING.md` | `cross-post.yml`, `scripts/cross_post/cross_post.py`, Mastodon dedupe, the Substack paste-by-hand leg. |
| `docs/CONTRIBUTING.md` | the definition of done, self-CI lanes, porting a workflow, the AST-lint rule. |
| `docs/OPERATIONS.md` | approving a gate, dispatching a loop, reading a failed run, verifying and linting locally. |
| `docs/VERSION-HISTORY.md` | whether something was already fixed. |

## Layout

Self-explanatory by name: `.github/workflows/`, `scripts/`, `infrastructure/`,
`oauth-proxy/`, `skills/`, `examples/site/`, `scaffold/`. The three that aren't:

| Path | Layer |
|---|---|
| `theme/` | the `cms-platform-theme` Jekyll **gem** (gemspec at `theme/`, so the gem root is `theme/`): layouts/includes/assets/plugins, the Decap render hook (`lib/cms-platform-theme/decap_config_hook.rb`), the `admin/` UI |
| `theme/admin/` | Decap base config (`*.base.yml`) + admin JS/HTML/CSS (read `window.CMS_*`) + `reviews/` dashboards; ships INSIDE the gem (v0.1.4+). Sites own only `admin/collections.site.yml`. |
| `theme/spec/` | plain-ruby theme unit tests (`ruby theme/spec/<name>_test.rb`, stdlib `minitest/autorun`), excluded from `spec.files` |

## Conventions (do not break)

- **Port from `adamdaniel.ai@main`** — the source of truth; lift and
  parameterize, don't invent. **Branch + PR, never push to `main`** (the
  auto-mode classifier enforces it).
- **Never hardcode `adamdaniel` identity.** Values come from `_config.yml`
  (`cms.*`, `url`), workflow inputs, CFN params (`ResourcePrefix`,
  `ProductionDomainName`), `github.repository`, or injected `window.CMS_*`.
- **The /admin logo is SITE-OWNED; the gem ships only a NEUTRAL placeholder**
  (#25), locked by `theme/spec/neutral_logo_test.rb` +
  `e2e/scaffold-seeds-neutral-logo.test.js`; **the scaffolder seeds `preview.md`
  + `404.html` (#23)**, because a site MUST expose `/preview/` (the admin "Live
  Preview" target) and a graceful 404 or the admin button dead-ends on a raw S3
  404 (lint `e2e/scaffold-preview-and-404.test.js`). Both →
  `docs/ADMIN-DELIVERY.md`.
- **Repo settings/rulesets change ONLY via a `repo-settings.yml` PR plus a human
  `node scripts/audit-repo-settings.js --fix --yes`** — an emergency flip is
  ratified (PR it in with a `# why:`) or reverted the same day; the daily
  `repo-settings-audit` files a `ci` issue on drift. Its read-only token cannot
  see ruleset `bypass_actors`, so an `UNVERIFIABLE` result is not empty drift —
  read `docs/CI-INVARIANTS.md` § "Read-only ruleset plans cannot verify bypass
  actors" before interpreting one or changing planner permissions.
- **Verify before claiming done** — run both generators against throwaway inputs
  and syntax-check what you touched (commands: `docs/OPERATIONS.md` §Verify);
  **record knowledge in AGENTS.md, `docs/` or `skills/`, not agent memory**.
- **Two render paths stay in lockstep** — `scripts/render-decap-config.rb`
  (deploy-time) and the gem hook
  `theme/lib/cms-platform-theme/decap_config_hook.rb` (build-time) inject the
  same `window.CMS_*` globals into the same shells (`admin/index*.html`,
  `admin/reviews/*.html`); `e2e/decap-config-render-parity.test.js` fails on
  drift.
- **`GITHUB_SCOPE` is lockstepped across `oauth-proxy/lambda.py`,
  `oauth-proxy/template.yaml` and `oauth-proxy/deploy.sh`**
  (`repo,user,workflow`); de-identified prose uses `<apex>`, `*.<apex>`,
  `<prefix>`, `<owner>/<repo>`, `<your-site>`.
- **`e2e/` deps install via `cd e2e && npm ci`** (`e2e/package-lock.json` is
  tracked); CloudFront-Function specs simulate `Fn::Sub` with a synthetic
  `example.test` apex. **AST always, never regex, for code-shape lints** —
  `e2e/spec-ast.js` for JS, `e2e/workflow-yaml-utils.js` for workflows. →
  `docs/CONTRIBUTING.md`.

## Admin delivery (gem-shipped, v0.1.4+)

A build-time hook copies `theme/admin/` into `_site/admin`, renders `config.yml`
from the site-owned seam, and a `base_collections` keep-list can hide the
built-in collections entirely. Two consumer traps: a `base_collections: []`
single-page consumer has none of the collections most specs assume, so a spec
reading one (or driving `/admin/index-local.html`) must self-skip precisely or
it permanently red-fails that consumer (#33); and an unapproved org OAuth App
lets Decap authenticate and read but silently fails every persist (#26). →
`docs/ADMIN-DELIVERY.md` (and the `admin-config-render` skill).

## Publishing is presented as nine overlapping statuses (#329 follow-on)

An editor meets nine notions of "published" across four systems, two invisible:
six required checks and a MANUAL `regression-review` gate that parks a publish
with no error in `/admin`. All five phases shipped in **v0.1.96**
(`one-door-publish.js`, `publish-button.js`, `publish-progress.js`, and the one
derivation `entry-status-model.js`). Rules that outlive them:
no shim paints a `position: fixed` overlay over the editor toolbar
(`publish-step-hint.js` covered 68% of the button it pointed at), and a banner
surviving the editor route needs `cms-notice-band` on `<body>` (#412); a lint
forbidding a token must not read comments; an `auto-merge-when-ready` re-arm
needs the label REMOVED first; hiding a control RETARGETS every selector
matching it by ROLE AND NAME (`publishViaUi()` drove the platform's own button —
v0.1.97, run 33439336337), and `mergeable` is absent from the `/pulls` LIST
response; every GitHub GET under `theme/admin/` passes `cache: "no-cache"`
because the API is cached 60 s (#386, run 33580693718); and a spec publishes ONE
entry per page, since Decap 3.15.1 breaks the next publish after an entry→entry
hash navigation (#342). → `docs/PUBLISHING-UX.md`.

### A required status check nobody publishes blocks forever, silently (#371)

`cms-feature-branches` required `validate-content` while the consumer publishes
`editorial / validate-content`, so every PR onto `cms/**`, `claude/**` and
`feat/**` on BOTH consumers sat permanently `mergeable_state: blocked` —
unnoticed, since `bypass_actors` let admins merge by hand. **Lock a required
context to what would EMIT it** (`ruleset-context-publishable.test.js`). →
`docs/PUBLISHING-UX.md` §2.10.

### A consumer's own post-build verifier runs through `site-verify.yml` (#377)

jodidaniel.com's `scripts/verify-build-artifacts.rb` was cited as a guard in six
places and run by nothing — how a `pdf_public: true` with no file in `_site`
reached prod. Parity forbids a consumer-owned caller, so it is a platform seam:
a `site-verify.yml` reusable plus a dictated thin caller `platform-bump` seeds
(#315), required only once both consumers published it (v0.1.98,
jodidaniel.com#236 / adamdaniel.ai#3464). → `docs/CI-INVARIANTS.md`.

## Skills ship as a marketplace bundle, not a file sync (v0.1.83)

`skills/` is where a platform skill is authored, and **nothing copies it into a
consumer**: the repo is a federated bundle in the `agentskills` marketplace
(`/plugin install cms-platform@agentskills`, invoked `/cms-platform:<skill>`),
reaching an ephemeral surface only once the consuming repo's own `skills.lock`
declares it a source (adamdaniel.ai PR #3109 pinning `679fb614`; jodidaniel.com
PR #134). The `skills-sync.yml` transport, its `platform-drift-guard.yml`
companion, the issue #83 destination-presence gate and the `.repo-local`
carve-out were **deleted** in v0.1.83; an adopting consumer deletes both thin
callers in the bump commit. → `docs/SYNC.md`.

## Single-version pin consistency guard (anti-skew, #29)

A consumer names the platform version in many places (`uses:@ref` pins,
`Gemfile`/`Gemfile.lock` tags, `platform.lock`, each caller's `platform_ref:`)
that drift piecemeal — a stale `platform_ref` once silently ran a
14-release-old tree. → read `docs/PIN-CONSISTENCY.md` (and the
`platform-release-and-bump` skill) before changing
`check-platform-pin-consistency.js` or `platform-bump.yml`'s seeding.

### A caller naming the version twice must name it the same twice (#283)

The eight other fleet repos calling a reusable name the version twice
(`uses: …@vX.Y.Z` and `platform_ref:`) and Dependabot moves only the first, so
the NEW reusable runs the OLD sparse-checked-out script and reports **green**
having detected nothing (2026-08-20: seven of eight a release behind, one with
fourteen unreported failing push runs). `scripts/check-pin-agreement.js` asserts
the two agree, via the reusable `.github/workflows/pin-agreement.yml` — **not**
via a caller in `examples/site/.github/workflows/`. No fleet repo adopted it,
and #283 was closed without a fix. **#424 removed the second reference
instead**, for `scheduled-run-health.yml`. It checks its script out at
`job.workflow_repository`@`job.workflow_sha`, read from `toJSON(job)` because
actionlint does not type those yet. So `platform_ref` no longer selects the
tree, and a currency step goes red once a caller's release has been superseded
for more than `behind_days`. Never put `inputs.platform_ref` back into that
checkout. Never drop a fleet repo's cms-platform Dependabot `ignore` before its
caller deletes `platform_ref`. → `docs/FLEET-CALLER-CURRENCY.md`.

### Dependabot must not bump ANY cms-platform reference (#242, #244)

`platform-bump` owns the version atomically in ONE PR, which is what lets
`check-platform-pin-consistency.js --require-canonical` pass on that PR alone;
either ecosystem sees one slice only, so its bump is redundant or skewing
(adamdaniel.ai PR #3076 tried to downgrade the gem `v0.1.80` → `v0.1.75`;
jodidaniel.com #8–#22 produced fifteen piecemeal PRs). Both consumers and
`examples/site` carry an UNSCOPED `ignore` — `cms-platform-theme` under
`bundler` (#242), `Adam-S-Daniel/cms-platform/*` under `github-actions` (#244) —
locked by `e2e/dependabot-theme-gem-ignored.test.js` and
`e2e/scaffold-seeds-dependabot-ignore.test.js`. → `docs/SYNC.md`.

### A pin carries no version comment - lint-locked (2026-08-20)

The managed half of this file states the rule;
`e2e/action-pin-comment-lint.test.js` (platform, in `PLATFORM_META_SPECS`) and
`e2e/consumer-action-pin-comment-lint.test.js` (consumer, deliberately NOT
registered — the #244 lesson) stop it drifting back, both driving
`e2e/pin-comment-rules.js`, which PARSES.

## Consumer-context spec rule (v0.1.5)

A spec running in CONSUMER mode (`SITE_ROOT` set) must never read `theme/admin`
or the platform's own workflow definitions: consumers don't have them, so an
unregistered platform-internal spec ships green here and red-fails on the next
consumer. → `docs/CONSUMER-COMPATIBILITY.md` before writing an e2e spec or
touching `PLATFORM_META_SPECS`.

### A consumer's nudge `required_contexts` is bound to its OWN ruleset (#284)

That list is the nudge's entire notion of "green", so one SHORTER than the
repo's real required set asks for a merge it has not established —
jodidaniel.com passed ONE of six for months (jodidaniel.com#156), safe only
because `pulls.merge()` answered 405 for it.
`e2e/consumer-automerge-nudge-contexts.test.js` closes it on the site whose
branch protection does the waiting; **a site absent from `repos:` FAILS**.

## Editorial-workflow label audit (v0.1.6; self-heal + label-at-creation v0.1.48)

Decap re-runs its label migration — the persistent "adding labels to N of your
Editorial Workflow entries" dialog — on **every** `/admin` load while an open
`cms/*` PR is missing its `decap-cms/<status>` label.
`scripts/audit-editorial-labels.js --fix` (the reusable's default since v0.1.48)
SELF-HEALS and fails only when a fix didn't stick: detect-only went red daily
for a week (PR #2387) with the dialog on prod. The caller MUST pass `--repo
${{ github.repository }}` (v0.1.16) and `pull-requests: write`. →
`docs/CI-INVARIANTS.md`.

## Dependabot batch-strand re-arm sweep (#118-122 postmortem)

A batch of Dependabot PRs opened together can strand indefinitely: GitHub
auto-disables auto-merge once the first merges, and every later merge leaves the
rest behind `main`, which re-arming alone can't fix. → `docs/CI-INVARIANTS.md`
before touching `dependabot-rearm-sweep.yml`.

## Scheduled-run health audit (silent-failure alerting, v0.1.57)

Scheduled workflows fail silently, so a broken daily audit can run red for
weeks. → `docs/CI-INVARIANTS.md` before changing `scheduled-run-health.yml` or
`audit-scheduled-runs.js`.

## E2E parallelism — one CI job per Playwright project (v0.1.68-v0.1.70)

`e2e-tests.yml` runs one CI job per Playwright project, backed by
counter-intuitive worker-count and browser-install measurements that are easy to
undo. → `docs/E2E-PARALLELISM.md`.

## E2E local webServer: decap readiness + :4000 crash resilience

decap-server is probed by open TCP port, not a `url:` check, and the `:4000`
static server must not be bare `serve` (a racy ENOENT once cascaded into an
85-test failure). → `docs/CI-INVARIANTS.md` before touching
`e2e/playwright.config.js`'s local `webServer`.

## A cancelled required check blocks the merge (#1815, #285, #289)

A required-check job that can fire twice on one head sha will eventually leave a
cancelled run shadowing a success, and nothing overrides it. **The invariant is
the OUTCOME: NO REQUIRED CONTEXT MAY END `cancelled`.** #285 removed every
`concurrency` group from required-context publishers, and four days later
`parity / parity` and `preview-media / preview-media` still concluded
`cancelled` on adamdaniel.ai #3202/#3217 — on a `timeout-minutes` wall, because
**GitHub reports a job killed at its wall as `cancelled`, not `timed_out`**. Put
the wall on a work job no ruleset names and publish the context from a
`needs:` + `if: always()` gate (`e2e/required-context-cancellable.test.js`,
renamed at #289).

## An unapproved gate holds its concurrency group, silently (#313)

`repo-settings-apply.yml` applied NOTHING for eleven days, twelve runs
`cancelled`, nothing alerted: a run parked at an unapproved `environment:` gate
holds its group. **Read the JOBS, not the run conclusion** (`total_count: 0`
means cancelled while PENDING). **A job that can wait on a human gets no
workflow-level group**, and its name is PER INDEPENDENT UNIT OF WORK — a
job-level block applies per MATRIX LEG, so `apply`'s two owner legs killed each
other until the group interpolated the axis. A gate firing every morning also
trains the reviewer to click, so it now gates only protection-REDUCING writes
(`scripts/repo-settings-write-risk.js`, `--refuse-weakening`). →
`docs/CI-INVARIANTS.md`.

## platform-bump moves files and one dictated input, not just pins (#315)

`platform-bump` re-pins, SEEDS a newly-dictated thin caller, RETIRES one that
left the canonical set, and RECONCILES `cms-automerge-nudge.yml`'s
`required_contexts`. Retire and reconcile must ride the bump commit —
pin-consistency compares the consumer's workflow set against the platform at
that consumer's OWN pinned ref, so splitting either off fails in the
mirror-image direction (`MISSING` instead of `EXTRA`). The check reporting
`workflow-set: EXTRA` is `platform-pin-consistency / pin-consistency`, NOT
`parity / parity`. → `docs/PIN-CONSISTENCY.md`.

## Admin-bundle parity is bump-aware (#14)

The parity check must tell a legitimate gem-bump lag (prod still serving the old
bundle) from real drift, and the `window.CMS_*` injection must be normalized out
of the byte compare. → `docs/CONSUMER-COMPATIBILITY.md` before changing
`e2e/admin-bundle-parity.js`.

## Self-CI lanes

`.github/workflows/self-ci.yml` is this repo's merge gate; with
`self-secrets-scan.yml` (#126) it is one of only two workflows here that run on
a plain PR. Five lanes: **actionlint**, **ruby-theme-specs**
(`theme/spec/*_test.rb`), **node-unit-lints** (the pure-fs `e2e/*.test.js`
lints, chosen by a DENY list), **plugin-validate** (NON-STRICT deliberately) and
**cfn-lint** (advisory); the browser matrix runs in CONSUMER e2e. →
`docs/CONTRIBUTING.md`.

## Adding / porting a workflow

Make it `on: workflow_call` with site identity as `inputs`/`secrets`; the site's
trigger + `paths-ignore` + `run-name` live in a **thin caller** under
`examples/site/.github/workflows/`, and platform scripts are checked out into
`.cms-platform/` at `inputs.platform_ref`. → `docs/CONTRIBUTING.md`.

## Definition of done (non-trivial changes)

A merged PR with green unit-lints is **NOT** "done" for a non-trivial change:
green lints routinely ship a LIVE regression (the double-`dialog.accept()` crash
on loop run 27013147945). Done also requires:

1. **Drive the prod-mutate validation loop to GREEN** — dispatch
   `cms-publish-loop-prod.yml` (and `cms-media-roundtrip.yml` where relevant)
   and ITERATE until one succeeds end-to-end (create → reflect → delete → 404).
   A bump-skip-SKIPPED run is green and is NOT a validation.
2. **Survey + drive every workflow green in ALL THREE repos** — each needs a run
   AFTER the last non-CI-generated push, and its latest must SUCCEED; most here
   are `workflow_call`-only, so the bar is **Self CI green**.
3. **No OPTIONAL check may fail either** — drive `UNSTABLE` → clean; a genuine
   credential / go-live blocker (jodidaniel `CMS_E2E_PAT`, #26) is surfaced, not
   left silently red.

Apply it after the consumer bump, not before. → `docs/CONTRIBUTING.md`.

### Delegated mechanical work is done when a VERIFIER exits 0

From the v0.1.76 consumer bump, delegated to two small-model subagents: **done
means an exit code, not prose** — name the verifier in the spec and require its
exit code back. Neither ran it; one stopped after 3 of 5 edit categories, left
58 stale `v0.1.75` refs, and read as near-done. A subagent that cannot run the
verifier reports **BLOCKED**, and a count disagreeing with the spec is
STOP-AND-REPORT. Prefer a verifier that cannot silently degrade
(`check-platform-pin-consistency.js` once fell from 96 checks to 61 and still
printed "Pins are consistent" — hence `--require-canonical`); for a consumer
bump it is **`scripts/verify-consumer-pins.sh`**.

## E2E workflow matrix (ported)

The real-prod loops (`cms-publish-loop-prod`/`-host`, `cms-media-roundtrip`)
share a hard-mutual-exclusion concurrency lane, a recursion gate that tolerates
a bump-only push, and a deploy-lane diagnostic that asks whether the PR merged
before blaming the deploy chain. → `docs/CI-INVARIANTS.md` (and the
`ci-watcher-loops` / `cms-stuck-pr-triage` skills).

## Remaining work

Shipped, so no longer tracked: the reusable-workflow port, the e2e meta-lints,
the PR #1 completeness pass, the `e2e-required-stub.yml` port,
pixel-regression baseline retirement, and the four roadmap items — issue #5
GOAL 1 (v0.1.4), issue #5 GOAL 2 (the v0.1.9–v0.1.12 sweep, `field_library` +
`$ref`), #21 (v0.1.13, `ErrorCachingMinTTL`) and #22 (canary-branch cleanup).
Still true: `code-quality` and `ci-runner-image` are **deliberate skips, never
ported**, and `playwright-image-drift`'s "real repo is drift-free" subtest
cannot self-check here (no root `package-lock.json` or
`.github/ci-runner/Dockerfile`), so it exercises fully only against the
synthetic `scaffold()` fixtures.

## Consumers

- **adamdaniel.ai** — consumer 1, user-owned, the dogfood: gem-delivered admin
  (PR #1883) live on prod, daily editorial-label-audit adopted; a loop
  co-arrival fix (#1892) narrowed the host publish-loop's push trigger so it
  stops evicting prod-mutate from `prod-mutating-loop`.
- **jodidaniel.com** — consumer 2, org-owned, a SINGLE-PAGE bio: 9 per-section
  collections (5 folder ones ordered by `weight`, `output:false`; 4 file ones
  reading `_data/*.yml`), `cms.base_collections: []`, and `_data/settings.yml`
  `site_live` (default `false`) keeping prod coming-soon; go-live is jodidaniel
  #26. Its CMS automation runs on a **`CMS_E2E_PAT` repo secret**; the
  mid-2026-07 failures were the sweep bugs fixed in v0.1.49-v0.1.51 (#127,
  #130).

## Environment gotchas (this machine / web)

- **The local checkout can be STALE/detached** — `git fetch && git checkout
  main` before any analysis, then branch off `origin/main`; an old one may
  predate the `admin/` → `theme/admin` move.
- The **web** GitHub MCP connector can't create repos (403); `/teleport` to
  local and use `gh`. Editing a non-cwd checkout from a background session trips
  a worktree-isolation prompt on Edit/Write — write via Bash.
- **A live repo-settings check may be IMPOSSIBLE from the session (v0.1.76)** —
  the egress proxy 403s `/actions/variables` and `/actions/secrets`, so say so
  rather than asserting either way, and make credential-dependent features fail
  SOFT with a notice naming the exact knobs (`CMS_PLATFORM_PAT`,
  `vars.CMS_AUTOMATION_APP_ID`, `CMS_AUTOMATION_APP_PRIVATE_KEY` — the App that
  replaced the consumer PAT at #238).

→ `docs/OPERATIONS.md` for all of the how-tos below.

## Approving `regression-review` on a render-neutral PR

`visual-regression` shoots the PR against **production**, and prod lags `main`,
so a version-bump or delete-only PR parks on the manual gate over pre-existing
drift. Never widen `e2e/detect-changed-pages.js` or the caller's content-skip
list (both lint-locked); `Visually different ≥ 1` with `Text changed: 0` is the
false-positive signature (v0.1.73). Prove `git diff --stat <old-tag> <new-tag>
-- theme/` is EMPTY, then approve via `pending_deployments`.

## A validation dispatch tests the code that is REACHABLE, not the code you merged

A host-loop iteration costs over an hour (`cms-publish-loop-host.yml`,
`--workers=1`, `timeout-minutes: 150`). `deploy-production` succeeding is NOT
proof prod `/admin` changed — the invalidation is fired without waiting — so
curl the served asset and grep for the new symbol first, and dispatch on current
HEAD.

## Diagnose a failed loop run from its ARTIFACTS, not from the logs

`gh run download <run-id>`, then read `test-failed-1.png` and `error-context.md`
BEFORE theorising: these specs catch Decap UI-state bugs a log cannot show, and
the v0.1.36 layer was cracked by the screenshot alone.

## Pre-run the required lint lane locally

`node-unit-lints` is a REQUIRED check and the cheapest to reproduce, from
`e2e/`:

```bash
TARGET=prod PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npx playwright test --project=chromium-light --reporter=line ./*.test.js
```

Run the WHOLE set — these lints cross-reference each other. Expected local reds:
the specs on `self-ci.yml`'s DENY list, and anything needing Jekyll.

## Install the e2e fixture's gems into the fixture, not the system gem path

With `GEM_HOME` unset bundler defaults to an unwritable `/var/lib/gems` and the
`e2e/fixture-site` install fails, blocking every lint that needs its
`bundle exec`. Scope the fix to the fixture (`bundle config set --local path
vendor/bundle`, command in `docs/OPERATIONS.md`); `.bundle/` does not travel
with a clone, so it is a one-time step per fresh checkout.

## Before deleting anything from a consumer, grep the PLATFORM too

The platform's own e2e specs reach into a consumer's tree by HARDCODED path, so
"no in-repo references" is necessary and never sufficient: a thin-ification
audit called `assets/images/uploads/e2e-preview-media-probe.png` a stray upload,
and it is the sentinel `e2e/preview-media-resolves.spec.js` fetches to prove the
flat `media_folder` resolves — deleting it reds the REQUIRED `preview-media`
check. Grep all three repos.
