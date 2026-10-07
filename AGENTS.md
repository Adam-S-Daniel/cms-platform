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
loaded **once per session** no matter how many repos are attached
([2026-08-29: inlined per repo, it took 332.3k tokens](https://github.com/Adam-S-Daniel/_agent-guidance/blob/main/docs/evidence/2026-08-29-guidance-inlined-in-every-repo.md)).

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
trust it in `/hooks`. `codex debug prompt-input` renders instructions loaded
from disk by its own diagnostic process; it does not run SessionStart hooks
or inspect an existing session or daemon. Verify delivery in the launched
session's initial instructions and verdict; see the
[2026-10-04 evidence](https://github.com/Adam-S-Daniel/_agent-guidance/blob/main/docs/evidence/codex-trust-and-daemon-0160.md#prompt-debugging-source-read-2026-10-04-cli-01600-rust-v01600).

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

**Current release: `v0.1.156`** (`v0.1.0`–`v0.1.156` are tagged; cut one with
`gh workflow run release.yml -f version=vX.Y.Z`). The bump is ONE atomic edit in
the release PR, before the dispatch: this line, both plugin manifests
(`plugin.json` + `.claude-plugin/plugin.json`), the `docs/VERSION-HISTORY.md`
entry, **every platform pin under `examples/site/.github/workflows`** (each
`uses:@ref` and each `with: platform_ref:`), and **`scaffold/create-site.js`'s
`PLATFORM_VERSION`**. `release.yml` refuses a tag disagreeing with the
manifests; `e2e/examples-site-pins-current.test.js` enforces this line and the
last two in the REQUIRED node-unit-lints lane, from in-repo values only — which
is what lets the release PR go green *before* the tag exists. **A release-bearing
PR (a manifest `version` change, or a `release/*` branch) also needs
`Independent review: CLEAN at <full head sha>` in its body**, written by a
reviewer independent of the author after reviewing that head (#526 criterion 3,
owner decision 2026-10-05): the REQUIRED `release-review-gate` check fails
without it, and a new push makes the stamp stale.

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
| `docs/ARCHITECTURE.md` | the two-repo design, end to end; what was deliberately never ported. |
| `docs/SYNC.md` | what syncs to a consumer, or drift. |
| `docs/ADMIN-DELIVERY.md` | `theme/admin/`, a render path, `base_collections`, `field_library` `$ref`, the logo / `preview.md` / 404 seeds. |
| `docs/ADMIN-AUTH-SECURITY.md` | sign-in, `oauth-proxy/` (a release does NOT deploy it; each site's daily `oauth-proxy-build` probe goes red until someone does), a `message` listener, the Decap SRI hash. |
| `docs/CONSUMER-COMPATIBILITY.md` | an e2e spec, an org OAuth save failure, bundle parity, a nudge's contexts. |
| `docs/PIN-CONSISTENCY.md` | pin consistency, the pin-comment lint, `platform-bump.yml`. |
| `docs/FLEET-CALLER-CURRENCY.md` | how a fleet repo's `scheduled-run-health` caller stays current: the self-resolving checkout, the currency lane, a fleet repo's cms-platform Dependabot `ignore`. |
| `docs/CI-INVARIANTS.md` | a required check, a scheduled workflow, the label audit, `site-verify.yml`, the webServer, a loop. |
| `docs/E2E-PARALLELISM.md` | e2e workers, sharding, the browser install. |
| `docs/CONTENT-PUBLISH-LATENCY.md` | a content-only e2e lane (shelved), a post's time-to-live. |
| `docs/PUBLISHING-UX.md` | what an editor sees of publish/status, or a spec that publishes. |
| `docs/CROSS-POSTING.md` | `cross-post.yml`, `scripts/cross_post/cross_post.py`, Mastodon dedupe, the LinkedIn leg and its 60-day token, the Substack paste-by-hand leg. |
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
| `theme/spec/` | Ruby theme specs (`ruby theme/spec/<name>_test.rb`, no bundle; pinned `liquid` 4.0.4, `jekyll` 4.4.1, `jekyll-sitemap` 1.4.0 and `jekyll-seo-tag` 2.9.0 for real render/build regressions), excluded from `spec.files` |

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
  (`repo,read:user,workflow`; `test_lambda.py` locks it); de-identified prose uses `<apex>`, `*.<apex>`,
  `<prefix>`, `<owner>/<repo>`, `<your-site>`.
- **`e2e/` deps install via `cd e2e && npm ci`** (`e2e/package-lock.json` is
  tracked); CloudFront-Function specs simulate `Fn::Sub` with a synthetic
  `example.test` apex. **AST always, never regex, for code-shape lints** —
  `e2e/spec-ast.js` for JS, `e2e/workflow-yaml-utils.js` for workflows — and
  **a lint forbidding a token must not read comments**. → `docs/CONTRIBUTING.md`.

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
derivation `entry-status-model.js`). Rules that outlive them: no shim paints a
`position: fixed` overlay over the toolbar (§2.3); a banner on the editor route
needs `cms-notice-band` (#412); a re-arm removes the label first; hiding a
control RETARGETS selectors matching it by ROLE AND NAME; `mergeable` is absent
from the `/pulls` LIST response (§4); every GitHub GET
under `theme/admin/` passes `cache: "no-cache"` (#386); a spec publishes ONE
entry per page (#342). Incidents → `docs/PUBLISHING-UX.md` §2.3, §4.

### A required status check nobody publishes blocks forever, silently (#371)

A ruleset requiring `validate-content` where the consumer publishes
`editorial / validate-content` blocked every feature-branch PR on both
consumers. **Lock a required context to what would EMIT it**
(`ruleset-context-publishable.test.js`). → `docs/PUBLISHING-UX.md` §2.10.

### A consumer's own post-build verifier runs through `site-verify.yml` (#377)

A verifier cited as a guard and run by nothing let a broken `pdf_public` file
reach prod. Parity forbids a consumer-owned caller, so it is a platform seam: the
`site-verify.yml` reusable plus a dictated thin caller. → `docs/CI-INVARIANTS.md`.

## Skills ship as a marketplace bundle, not a file sync (v0.1.83)

`skills/` is where a platform skill is authored, and **nothing copies it into a
consumer**: it is a federated bundle in the `adam-agentskills` marketplace
(`/cms-platform:<skill>`), reaching an ephemeral surface only through the
consuming repo's own `skills.lock`. The old `skills-sync.yml` transport was
deleted in v0.1.83. → `docs/SYNC.md` § Skills, `docs/VERSION-HISTORY.md` v0.1.83.

## Every cross-post target gets text in ITS format, never raw Markdown

Mastodon statuses, LinkedIn's "little text" and Substack's subtitle are plain
text, and Substack's editor does not convert pasted Markdown: the 2026-09-28
LinkedIn post showed `> quote > > quote` verbatim. `cross_post.py` renders
excerpts from a real Markdown parse (`markdown-it-py`) and the Substack draft
as HTML. **A new posting target lands only with its text format researched,
written up in `docs/CROSS-POSTING.md`, and tested on a Markdown-heavy post.**

## Single-version pin consistency guard (anti-skew, #29)

A consumer names the platform version in many places (`uses:@ref` pins,
`Gemfile`/`Gemfile.lock` tags, `platform.lock`, each caller's `platform_ref:`)
that drift piecemeal — a stale `platform_ref` once silently ran a
14-release-old tree. → read `docs/PIN-CONSISTENCY.md` (and the
`platform-release-and-bump` skill) before changing
`check-platform-pin-consistency.js` or `platform-bump.yml`'s seeding.

### A caller naming the version twice must name it the same twice (#283)

A fleet caller naming it in both `uses:@` and `platform_ref:` gets half-bumped
by Dependabot and reports green having run an old script
(`docs/PIN-CONSISTENCY.md` § Pin AGREEMENT). **#424 removed the second
reference** for `scheduled-run-health.yml`, which checks its script out at
`job.workflow_repository`@`job.workflow_sha`. Never put `inputs.platform_ref`
back into that checkout. Never drop a fleet repo's cms-platform Dependabot
`ignore` before its caller deletes `platform_ref`. →
`docs/FLEET-CALLER-CURRENCY.md`.

### Dependabot must not bump ANY cms-platform reference (#242, #244)

`platform-bump` owns the version atomically in ONE PR; a Dependabot bump sees
one slice and skews it. Both consumers and `examples/site` carry an UNSCOPED
`ignore` — `cms-platform-theme` under `bundler` (#242),
`Adam-S-Daniel/cms-platform/*` under `github-actions` (#244) — lint-locked. →
`docs/SYNC.md`.

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

`e2e-tests.yml` runs one CI job per Playwright project (the two admin projects
as three `--shard` jobs each), and the install restores apt's `.deb`s from a
cache only the default branch saves (consumers seed it daily with
`warm-e2e-apt-cache.yml`). All of it rests on counter-intuitive worker-count,
shard and apt measurements that are easy to undo. → `docs/E2E-PARALLELISM.md`.

## E2E local webServer: decap readiness + :4000 crash resilience

decap-server is probed by open TCP port, not a `url:` check, and the `:4000`
static server must not be bare `serve` (a racy ENOENT once cascaded into an
85-test failure). → `docs/CI-INVARIANTS.md` before touching
`e2e/playwright.config.js`'s local `webServer`.

## A cancelled required check blocks the merge (#1815, #285, #289)

**The invariant is the OUTCOME: NO REQUIRED CONTEXT MAY END `cancelled`** —
nothing overrides a cancelled run shadowing a success. Two routes: a
`concurrency` group on a job that fires twice per sha, and a `timeout-minutes`
wall (**GitHub reports it `cancelled`, not `timed_out`**). Put the wall on a
work job no ruleset names; publish the context from a `needs:` + `if: always()`
gate (`e2e/required-context-cancellable.test.js`). → `docs/CI-INVARIANTS.md`.

## An unapproved gate holds its concurrency group, silently (#313)

A run parked at an unapproved `environment:` gate holds its group
(`repo-settings-apply.yml` applied nothing for eleven days). **Read the JOBS, not
the run conclusion. A job that can wait on a human gets no workflow-level
group**, and a job-level one interpolates the MATRIX axis. The gate fires only
on protection-REDUCING writes (`scripts/repo-settings-write-risk.js`). →
`docs/CI-INVARIANTS.md`.

## platform-bump moves files and one dictated input, not just pins (#315)

`platform-bump` re-pins, SEEDS a newly-dictated thin caller, RETIRES one that
left the canonical set, and RECONCILES the nudge's `required_contexts` — all in
the bump commit, or pin-consistency fails (`workflow-set: EXTRA`/`MISSING`). →
`docs/PIN-CONSISTENCY.md`.

## Admin-bundle parity is bump-aware (#14)

The parity check must tell a legitimate gem-bump lag (prod still serving the old
bundle) from real drift, and the `window.CMS_*` injection must be normalized out
of the byte compare. → `docs/CONSUMER-COMPATIBILITY.md` before changing
`e2e/admin-bundle-parity.js`.

## Self-CI lanes

`.github/workflows/self-ci.yml` is this repo's merge gate. Six lanes, all
REQUIRED: **actionlint**, **ruby-theme-specs**, **node-unit-lints** (pure-fs
`e2e/*.test.js`, DENY list), **plugin-validate** (NON-STRICT deliberately),
**python-unit-tests** and **cfn-lint** (no `continue-on-error` since #525). Three
more required contexts come from siblings: `scan / scan`, **`fixture-e2e`**
(#527: the `@lane: local` specs on the two admin projects against
`e2e/fixture-site`; #702 added `chromium-desktop-1080` against both fixtures,
one `/` on the theme layout and one on a site-owned layout) and
**`release-review-gate`** (#526: the review stamp above; the one PR workflow
that fires on `edited`, because the stamp is a body edit).
`self-dependabot-auto-merge.yml` also triggers on every PR, but its job is a
no-op for anyone but Dependabot. → `docs/CONTRIBUTING.md`.

| PR/push workflow | Salient paths |
|---|---|
| `self-ci.yml`, `self-secrets-scan.yml` | all (required; no filter) |
| `self-fixture-e2e.yml` | in-job deny-list: all but `docs/`, `infrastructure/`, `oauth-proxy/`, `scripts/cross_post/`, `LICENSE`, `*.md` outside `e2e/fixture-site/` and `e2e/fixture-site-singlepage/`; push to main always |
| `self-release-review-gate.yml` | all (required; in-job: enforces only on a release-bearing PR, success otherwise) |
| `self-dependabot-auto-merge.yml` | all (an actuator, skipped unless Dependabot) |
| `repo-settings-pat-verify.yml` | its own file (`on.paths`; not required) |
| `repo-settings-apply.yml` | `repo-settings.yml` (push to main) |

## Adding / porting a workflow

Make it `on: workflow_call` with site identity as `inputs`/`secrets`; the site's
trigger + `paths-ignore` + `run-name` live in a **thin caller** under
`examples/site/.github/workflows/`, and platform scripts are checked out into
`.cms-platform/` at `inputs.platform_ref`. → `docs/CONTRIBUTING.md`.

## Definition of done (non-trivial changes)

Green unit-lints are **NOT** "done": they routinely ship a LIVE regression. Done
also requires (1) the prod-mutate loop (`cms-publish-loop-prod.yml`, plus
`cms-media-roundtrip.yml` where relevant) driven to a real GREEN run — a
bump-skip-SKIPPED run is not a validation; (2) every workflow in ALL THREE repos
run after the last real push and latest SUCCESS (here: **Self CI green**); (3) no
OPTIONAL check left red. Apply it after the consumer bump. Delegated work is done
when a named verifier exits 0 (consumer bump: `scripts/verify-consumer-pins.sh`).
→ `docs/CONTRIBUTING.md`.

## E2E workflow matrix (ported)

The real-prod loops (`cms-publish-loop-prod`/`-host`, `cms-media-roundtrip`)
share a hard-mutual-exclusion concurrency lane, a recursion gate that tolerates
a bump-only push, and a deploy-lane diagnostic that asks whether the PR merged
before blaming the deploy chain. → `docs/CI-INVARIANTS.md` (and the
`ci-watcher-loops` / `cms-stuck-pr-triage` skills).

## Consumers

- **adamdaniel.ai** — consumer 1, user-owned, the dogfood: gem-delivered admin
  (PR #1883) live on prod, daily editorial-label-audit adopted; a loop
  co-arrival fix (#1892) narrowed the host publish-loop's push trigger so it
  stops evicting prod-mutate from `prod-mutating-loop`.
- **jodidaniel.com** — consumer 2, org-owned, a SINGLE-PAGE bio: 10 per-section
  collections (6 folder ones, all `output:false` except `media`; 4 file ones
  reading `_data/*.yml`), `cms.base_collections: []`, and `_data/settings.yml`
  `site_live` (default `false`) keeping prod coming-soon; go-live is jodidaniel
  #26. Its CMS automation runs on a **`CMS_E2E_PAT` repo secret**; the
  mid-2026-07 failures were the sweep bugs fixed in v0.1.49-v0.1.51 (#127,
  #130).

## Operations: the short rules (→ `docs/OPERATIONS.md` for each how-to)

- **The local checkout can be STALE/detached** — fetch, then branch off
  `origin/main`. The web GitHub MCP connector can't create repos (403). A live
  `/actions/variables`/`/actions/secrets` read may be IMPOSSIBLE from a session:
  say so, and make credential-dependent features fail SOFT naming the knobs.
- **`regression-review` on a render-neutral PR**: never widen
  `e2e/detect-changed-pages.js` or the content-skip list; prove
  `git diff --stat <old-tag> <new-tag> -- theme/` is EMPTY, then approve.
- **A validation dispatch tests what is REACHABLE**: curl the served asset for
  the new symbol first (the invalidation is not awaited); dispatch on HEAD.
- **Diagnose a failed loop from its ARTIFACTS** (`gh run download`), not logs.
- **Install the e2e fixture's gems into the fixture** (`bundle config set
  --local path vendor/bundle`), once per fresh checkout.
- **Before deleting anything from a consumer, grep the PLATFORM too** — its
  e2e specs reach into a consumer's tree by hardcoded path.

## Pre-run the required lint lane locally

From `e2e/`, the WHOLE set (these lints cross-reference each other); expected
local reds are `self-ci.yml`'s DENY list and anything needing Jekyll:

```bash
TARGET=prod PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npx playwright test --project=chromium-light --reporter=line ./*.test.js
```
