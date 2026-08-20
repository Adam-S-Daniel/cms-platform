# Bidirectional sync

How platform changes reach sites, and how site-side improvements get back.

## Down (platform → sites)

| What | Mechanism |
|---|---|
| Reusable workflow `uses:@<tag>` pins | **`platform-bump`** (Dependabot's `github-actions` ecosystem `ignore`s every cms-platform ref as of #244 — see below) |
| `cms-platform-theme` gem (layouts/includes/assets/plugins + Decap render hook + **admin UI** `theme/admin`) | **`platform-bump`** (Dependabot's `bundler` ecosystem `ignore`s this gem as of #242 — see below) |
| **EVERY** version ref in ONE PR — `platform_ref:` inputs + `platform.lock`, the `uses:@<tag>` pins, the gem `tag:`, `Gemfile.lock` `tag:` + `revision:`, and any composite `@<sha>` pin — plus seeding any workflow caller the release newly made platform-dictated | **`platform-bump`** reusable workflow — an **atomic single-version bump** (#13) that also seeds newly-dictated workflow callers so workflow-SET parity (#54) passes too. Checks out with the caller PAT so the workflow-file push is authorised |
| Skills (`skills/`) | **not a down-sync at all** — published as a federated bundle in the `agentskills` marketplace; nothing is copied into a consumer (see "Skills" below) |
| AWS infra templates | re-run `infrastructure/*/deploy.sh` with the new templates |

Cut a release on `cms-platform` (Actions → **Cut release**, `workflow_dispatch`
with a `vX.Y.Z` input) → the release job **immediately dispatches each
consumer's `platform-bump` workflow** (fail-open: a missing/expired
`BUMP_DISPATCH_<CONSUMER>` secret or a failed dispatch just leaves that site to
its weekly Monday-07:00-UTC cron, the pre-chaining behavior) → each bump PR
enables **auto-merge** and lands as soon as the site's required checks go
green → deploy-production takes it live. The release cut stays a deliberate
human decision; everything after it is mechanical. (Both the dispatch fan-out
and the bump PR's auto-merge ship in the release that contains them — a
consumer picks them up one release AFTER adopting, since its caller runs the
previously-pinned reusable.)

`platform-bump` now moves **all** of the version references at once (rows 9–11
above), so its PR is single-version-consistent on its own (#13). **Neither
Dependabot ecosystem is a safety net for those references anymore** — #244
closes the `github-actions` half the same way #242 already closed `bundler`
(both below) — so `platform-bump` is the **sole** down-sync path for every
cms-platform version reference a consumer carries. Dependabot stays wired
only for the site's own non-cms-platform deps.

**Dependabot does not own any cms-platform version reference (#242, #244).**
Both consumers' `dependabot.yml`, and the canonical
`examples/site/.github/dependabot.yml` template, carry explicit `ignore`
entries so neither the `bundler` nor the `github-actions` ecosystem ever
proposes a cms-platform bump. The structural reason is the same for both:
`platform-bump` moves every reference in ONE PR, which is exactly what lets
`check-platform-pin-consistency.js --require-canonical` pass on that PR
alone — Dependabot's ecosystems can each see only their own narrow slice, so
a Dependabot-authored bump there is either redundant (`platform-bump` already
got there) or actively skews the tree.

**`bundler` (#242): the theme gem.** A Dependabot bundler PR could only ever
move the `Gemfile`/`Gemfile.lock` half of the gem's version references:
`Adam-S-Daniel/adamdaniel.ai` PR #3076 (2026-08-12) rebased a stale Dependabot
PR forward without re-resolving its target and proposed **downgrading** the
gem `v0.1.80` → `v0.1.75`; `platform-pin-consistency`, `admin-bundle-parity`,
and `dependabot-auto-merge` all caught it and it was closed unmerged. **Note:**
a bare `dependency-name` ignore suppresses *security* updates for that
dependency too, not only version updates — nothing is lost here, since
`cms-platform-theme` is a first-party git-sourced gem with no
advisory-database entry, and `platform-bump` adopts every release, security
fixes included.

**`github-actions` (#244): the `uses:@<tag>` / composite pins.** That
ecosystem treats each workflow FILE's `uses:` as its own independent
dependency, so Dependabot can only move them ONE PR AT A TIME — every such PR
necessarily leaves the other ~34 references (`platform.lock`, the gem `tag:`,
each caller's `platform_ref:` input, and every other `uses:@<tag>`) behind,
which is precisely the skew `check-platform-pin-consistency.js` exists to
fail. Not theoretical: **jodidaniel.com #8–#22** (2026-06-03/04) produced
**fifteen** separate bump PRs from a single platform release, one per
reusable caller, all `0.1.1 → 0.1.3` — Dependabot itself closed two of them
(#9, #21) as "no longer needed" once `platform-bump` had already landed the
change, pure redundant churn. **adamdaniel.ai #1895–#1898** (2026-06-04)
produced four more with DIFFERENT from-versions per file in the same batch
(`0.1.0 → 0.1.6`, `0.1.3 → 0.1.6`) — exactly the piecemeal-drift shape the
single-version pin invariant below (#29) already exists to catch.
**adamdaniel.ai #1900** was closed with reasoning that generalizes verbatim:
"a piecemeal bump to v0.1.6 would now fail the platform-pin-consistency
guard." The class had gone quiet since only because `platform-bump` (cron +
release-dispatch) reliably beats Dependabot's weekly run to each release — a
timing accident, not a guarantee, as `adamdaniel.ai#3076` (above) shows once
a stale PR is left open long enough.

Both consumers' `dependabot.yml` and the `examples/site` template ignore
`Adam-S-Daniel/cms-platform/*` under `github-actions`, scoped deliberately
narrower than a bare `*`: the ecosystem stays WIRED and still picks up a
genuine third-party action the moment one is added. Today it watches nothing
else there — verified, neither consumer pins a single third-party action;
every `uses:` in both repos' `.github/workflows/` is a cms-platform reusable
(34 in each). The thin-ification (adamdaniel.ai#2007-P7) removed the last of
the third-party ones; the June 2026 Dependabot PRs for `ruby/setup-ruby`,
`aws-actions/configure-aws-credentials`, `docker/*`, and `actions/checkout`
all pre-date it.

**The counter-argument, and how it was closed.** A Dependabot actions PR was,
incidentally, the only INDEPENDENT signal that a release existed if
`platform-bump` ever silently stopped — `scheduled-run-health.yml` alerts on
a FAILING scheduled run, not one that succeeds-and-no-ops.
`platform-bump.yml`'s release lookup had exactly that hole:

```bash
LATEST=$(gh release view --repo "$PLATFORM" --json tagName -q .tagName 2>/dev/null || echo "")
[ -n "$LATEST" ] || { echo "no release on $PLATFORM yet"; exit 0; }
```

— which folded an expired/insufficiently-granted `CMS_PLATFORM_PAT`, a
revoked cross-repo grant, and a GitHub API outage into the SAME green
`exit 0` as the one benign case (no release published yet). A consumer could
freeze at its current platform version indefinitely while every weekly run
reported success. v0.1.82 closes it: the lookup now uses
`gh api repos/<repo>/releases/latest`, whose failure modes are
distinguishable — **404 means "no published release" and nothing else**,
because cms-platform is a PUBLIC repo, so a 404 can never mean "you lack
access" — treats 404 as the benign `exit 0` and every other failure as
`::error::` + `exit 1`, which `scheduled-run-health.yml` then surfaces. Only
the HTTP status code is echoed on failure, never the response body. Locked by
a new test in `e2e/platform-bump-atomic.test.js`.

**Wildcard semantics (load-bearing).** Dependabot matches an `ignore:`
`dependency-name` with a case-INSENSITIVE wildcard matcher
(`Dependabot::Config::UpdateConfig.wildcard_match?`, in
`common/lib/dependabot/config/update_config.rb`) that converts `*` to `.*`
and anchors it, and that `.*` DOES cross `/`. That is why one `Adam-S-Daniel/cms-platform/*`
pattern covers all 34 `…/.github/workflows/<n>.yml` dependency names (the
github-actions dependency name for a reusable workflow INCLUDES its path)
and any future `…/.github/actions/<n>` composite. Two lints lock both
ignores: `e2e/dependabot-theme-gem-ignored.test.js` re-checks a consumer's
OWN file in CONSUMER mode, and `e2e/scaffold-seeds-dependabot-ignore.test.js`
(platform-internal) asserts both the `examples/site` template and the
scaffolder's generated output carry it. Their shared helper
`e2e/dependabot-config-utils.js` carries a faithful JS mirror of the
wildcard matcher and asserts, against the workflows directory under test:
(a) non-vacuity — the tree actually pins cms-platform `uses:` refs, so the
check can never pass by looking at nothing; (b) every one of those
dependency names is wildcard-covered by some ignore entry; (c) every
covering entry is UNSCOPED (no `update-types`, no `versions` — a scoped one
would let a plain version bump through, exactly as it would not have stopped
adamdaniel.ai#3076); (d) no ignore entry matches a third-party action name
(`actions/checkout`, `actions/setup-node`, `ruby/setup-ruby`,
`aws-actions/configure-aws-credentials`), which catches a lazy
`- dependency-name: "*"` that would silently disable the whole ecosystem.

NOTE: a consumer only gets the atomic bump once its `platform-bump` thin
caller pins a platform release that **contains** this fix; until then bump it
manually (see the `platform-release-and-bump` skill). `platform-bump` also
seeds any workflow caller a release newly made platform-dictated — a file
`examples/site/.github/workflows/` gained since the consumer's last bump — so
a bump PR passes workflow-SET parity (#54) on its own too, not just
version-pin-consistency (#29).

## Up (site → platform)

**No platform-owned file physically lives in a site anymore**, so there is nothing
left to byte-match: the admin machinery ships in the gem (v0.1.4) and the skills
ship as a marketplace bundle (v0.1.83). The up-sync route is therefore just the
plain one — make the change **here** and open a PR against this repo.

The `platform-drift-guard` reusable, which byte-compared a consumer's vendored
`.claude/skills/` against the platform at its pinned ref, was **deleted in
v0.1.83** along with the transport that created those copies. It is worth being
precise about what it did, because prose elsewhere used to say it *enforced*
parity: it was never a required check on `consumer-main`, it iterated the files
**present** in the site (so a deleted platform-owned file was invisible to it),
and it exited green when the guarded path was absent. Drift over its lifetime was
**observed zero, never enforced zero**.

The **admin machinery** (`admin/` except the seam) is shipped via the `cms-platform-theme`
gem (`theme/admin`) as of v0.1.4 — sites no longer vendor byte-copies, so it isn't
byte-match-guarded; a gem bump (`platform-bump`, not Dependabot `bundler` — see
above) is its down-sync path. Site-owned
seams (`admin/collections.site.yml`) and generated configs (`admin/config.yml`,
`admin/config-local.yml`) are never platform-owned. A site can also opt out of the
platform's built-in collections via `_config.yml: cms.base_collections` (a keep-list;
v0.1.7) without forking any admin file.

So an improvement made while working on any site is routed here as a PR → merge →
tag → it flows back down to all sites. Site **content/branding/docs never sync** — only machinery.

## Skills — federated, not synced (v0.1.83)

`skills/` in this repo is the canonical home of the platform skills, and the only
place one is authored or edited. They do **not** travel down any of the paths
above:

- They are published as a **federated bundle in the `agentskills` marketplace**
  (`Adam-S-Daniel/agentskills`), which resolves the `cms-platform` bundle from
  this repo's own plugin manifest rather than holding a mirror of it.
- A **durable machine** installs it once with
  `/plugin install cms-platform@agentskills`; skills are bundle-namespaced, so
  they invoke as `/cms-platform:<skill>`.
- On an **ephemeral surface** — a Claude Code cloud session, a CI runner —
  that install does not persist, so the delivery channel is the registry's
  `skills-bootstrap` SessionStart hook. The hook installs what a pinned,
  per-skill-hashed `skills.lock` names, and that lock is a **per-consuming-repo
  artifact**: a repo receives this bundle only once its own `skills.lock`
  declares `cms-platform` as a source, pinned to a commit with per-skill
  digests. The registry's own `skills.lock` stays `adam`-only by design and
  never carries these skills. adamdaniel.ai declared the source on 2026-08-14
  (PR #3109): its lock pins this repo at `679fb614` and hashes the 14
  `cms-platform` skills alongside the 9 it takes from `adam`. jodidaniel.com
  adopted it on 2026-08-16 (PR #134), declaring the same two sources — so both
  consumers now carry a federated lock.

**Nothing is rsynced into a consumer and no consumer vendors a copy**, so a
consumer's `platform_ref` has no bearing on which skills a session sees, and
there is no second copy that can drift. Until v0.1.83 a `skills-sync` reusable
did copy `skills/` into a consumer's `.claude/skills/` — and it is worth
recording that it **never reached every consumer**, contrary to the universal
framing the READMEs and the down-sync table above used to carry: jodidaniel.com
shipped the caller until v0.1.83 retired it, and has never had a
`.claude/skills` directory at all, a state the issue #83 destination-presence
gate then made permanent by design. See `docs/VERSION-HISTORY.md` v0.1.83 for the removal and for why that
gate was unrepairable by construction.

## Single-version pin invariant (anti-skew, issue #29)

A consuming repo references the platform version in **many** places. Before
issues #242/#244 the down-sync mechanisms above landed bumps **piecemeal**
across two independent bumpers (Dependabot + `platform-bump`) — so a consumer could
drift; `platform-bump` is now the sole bumper of all four rows below, and
this guard is what keeps that single-bumper invariant enforced rather than
merely assumed:

| Reference | Bumped by |
|---|---|
| `.github/workflows/**` reusable-workflow `uses: …/.github/workflows/<n>.yml@<ref>` | `platform-bump` (Dependabot `github-actions` ignores every cms-platform ref, #244) |
| `.github/workflows/**` SHA-pinned composite `uses: …/.github/actions/<n>@<sha>  # vX.Y.Z` (the **comment**) | `platform-bump` (same #244 ignore covers a future composite too) |
| `Gemfile` `gem "cms-platform-theme", …, tag:` + `Gemfile.lock` git-source `tag:` | `platform-bump` (Dependabot `bundler` ignores this gem, #242) |
| `platform.lock` `platform_ref` + `with: platform_ref:` workflow inputs | `platform-bump` |

**On the composite-comment row:** the `# vX.Y.Z` here is the PLATFORM's own
release identity on a cms-platform composite — the pin-consistency gate — and
`platform-bump` owns it. It is NOT the third-party action pin comment, which
was retired fleet-wide (2026-08-20): a trailing `# vX.Y.Z (YYYY-MM-DD)` on a
third-party SHA pin goes stale silently and then actively lies, and
Dependabot rewrites it only sometimes. `dependabot-comment-sync.yml` and
`scripts/sync-action-pin-comments.sh`, which existed to keep those comments
accurate, are deleted. A third-party `uses:` is now `@<sha>` and nothing
else; resolve the version when you need it
(`git ls-remote <url> | grep <sha>`, or the Dependabot PR title).

Because they used to run independently, a consumer could sit skewed for a
long time (observed live: **adamdaniel.ai** pinned `@v0.1.0` loop/deploy
callers, gem `@v0.1.5`, and others `@v0.1.3`/`@v0.1.6` simultaneously). A
`v0.1.0` reusable running against a `v0.1.5` gem is a latent behaviour-bug
source and breaks the "platform moves in lockstep" model.

**The invariant:** every platform-version reference in a consumer MUST equal a
**single** version — the `platform.lock` `platform_ref` (the **source of
truth**, bumped by `platform-bump`).

**`platform-pin-consistency`** enforces it. The reusable
(`.github/workflows/platform-pin-consistency.yml`, wired via the
`examples/site` thin caller on `pull_request`) checks the platform out at the
consumer's `platform_ref` into `.cms-platform/` and runs the platform-owned
`scripts/check-platform-pin-consistency.js` against the consumer tree. The
checker derives the canonical version from `platform.lock`, parses every
workflow with the **`yaml` parser** (anchors resolved — not regex) to collect
cms-platform `uses:@` refs, reads the SHA-pinned composites' trailing
`# vX.Y.Z` comment via a **line-aware pass** (the only justified exception — the
YAML parser drops comments and the gate lives in one),
checks every literal **`with: platform_ref:`** input, and
reads the Gemfile/Gemfile.lock `tag:`. It **aggregates all** violations and
fails CI with a per-file diff (found vs expected) when any disagree; exits 0
with an OK summary when they all match. It tolerates a consumer with no Gemfile
and ignores non-cms-platform `uses:`. Self-tested by
`e2e/check-platform-pin-consistency.test.js` (consistent fixture → 0; skewed
fixture → non-zero, each offending file/value named).

The **`platform_ref` input matters most and was the last one covered** (#220,
v0.1.74). Each reusable's own platform checkout does `ref: ${{ inputs.platform_ref }}`,
so that input — not the `uses:@` pin beside it — decides WHICH platform tree the
job runs; and the workflow-CONTENT parity check below deliberately masks `with:`
VALUES as site-specific, so nothing saw it. A caller sat 14 releases stale while
every check reported consistent. An input DECLARATION (a map value, as in the
reusables' own `platform_ref: { type: string, default: main }`) and a `${{ … }}`
expression are skipped — neither is a pin. **A stale `platform_ref` produces no
symptom until a reusable references a path its pinned tree lacks**, so the guard
is the only thing that can see it; do not reason about pin skew from whether runs
are passing.

Since v0.1.83 this is the **only** cross-repo guard left. It used to be described
as complementing `platform-drift-guard` — that one guarded file **content**
(platform-owned files vendored into a site had to byte-match the platform), this
one guards **version consistency** (all the version references must agree on one
release). With the admin machinery in the gem and the skills in a marketplace
bundle, no platform-owned file is vendored into a site at all, so only the
version-consistency half still has something to check. A consumer adopting the
caller reconciles its pins to a single release in the same change.

## Repo settings as code (#109)

GitHub repo settings (`delete_branch_on_merge`, merge-method toggles,
auto-merge enablement) and branch-protection **rulesets** are declared in
**`repo-settings.yml`** at the platform root — for the platform repo AND both
consumers. Live-only changes are invisible to git and undiscoverable after
the fact: the motivating incident was v0.1.40 having to re-enable
`delete_branch_on_merge` on both consumers with no record anywhere of why it
had ever been turned off, while the consumers' `main` rulesets had silently
skewed with no guard analogous to `platform-pin-consistency`.

**The mechanism (audit-first, human apply):**

- `repo-settings.yml` — the manifest. Effective flags per repo =
  shallow-merge of `settings_defaults` + the repo's `settings:` override;
  ruleset bodies live in a shared `ruleset_library` and mirror the REST PUT
  payload. Every value leaf carries a `# why:` comment — lint-enforced by
  `e2e/repo-settings-manifest.test.js`, which also locks every settings key
  to the script's `MANAGED_REPO_KEYS` (the SSOT of what `--fix` may PATCH)
  and cross-locks the `release.yml` fan-out consumers to the managed set.
- **Actions permissions** are a THIRD managed surface —
  `actions_permissions_defaults` (+ optional per-repo `actions_permissions`
  overrides), keyed to `MANAGED_ACTIONS_PERMISSION_KEYS`. These are NOT part
  of `repos/{owner}/{repo}`; each is its own GET/PUT endpoint:
  - `sha_pinning_required` (`true`) →
    `repos/{owner}/{repo}/actions/permissions` — require every workflow
    `uses:` to be pinned to a full-length commit SHA. The `--fix` PUT **echoes
    the live `enabled` + `allowed_actions`** back alongside it, so enforcing
    the pin can never disable Actions or narrow the allowed-actions policy.
  - `approval_policy` (`all_external_contributors` — the SHORT form the live
    API returns for "all outside collaborators", **not**
    `require_approval_for_all_outside_collaborators`) →
    `repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval` —
    require approval before any outside collaborator's fork PR runs workflows.
    **This endpoint returns HTTP 422 on a private repo** ("not allowed for
    private repositories"); the audit treats that as an operational **skip**
    (informational, never drift). All three repos are public today, so the
    value applies. As-found 2026-07-13 the consumers already require SHA
    pinning; cms-platform did not, and all three sat at
    `first_time_contributors` — the drift the next `--fix` corrects.
- `scripts/audit-repo-settings.js` — read-only drift audit (exit 2 on
  drift), `--issue` tracking-issue lifecycle (single `ci`-labelled issue
  found via a hidden marker, fingerprint-deduped comments, auto-close on a
  clean scan — the `audit-scheduled-runs.js` exit contract: a red run means
  the alerting layer broke), and the human-run `--fix [--yes]` apply (plan
  printed first; only drifted flag keys PATCHed; rulesets PUT by name with
  the full library body; live-only rulesets NEVER deleted; `default_branch`
  audited but manual-only; a live ruleset carrying an unknown
  non-allowlisted field is fix-SKIPPED — the lossy-PUT guard). Anti-flap
  normalization is fixture-locked by `e2e/repo-settings-audit.test.js`.
- `.github/workflows/repo-settings-audit.yml` — daily scheduled audit, plus
  a push-triggered run on manifest changes. **No write credential in CI** —
  reads use per-owner fine-grained `REPO_SETTINGS_READ_*` PATs
  (Administration: **Read-only**; minting/verification in the
  `consumer-repo-provisioning` skill), writes are operator-only.

**Ratify-or-revert protocol:** when the audit files drift, the same day
either RATIFY (PR the live value into `repo-settings.yml` with a `# why:`)
or REVERT (`node scripts/audit-repo-settings.js --fix --yes --repo
<owner/repo>`). Emergency live flips are allowed precisely because CI never
auto-clobbers them — but they must be ratified or reverted, never left
silent.

**Rejected alternatives (recorded so we don't re-litigate):**

- *safe-settings (GitHub app)* — org-only; `Adam-S-Daniel` is a User account.
- *Probot settings app* — applies but never DETECTS drift (the motivating
  incident class), and grants a third party admin on every repo.
- *Terraform* — viable, but loses at 3-repo scale: a state backend, an
  Admin-R/W credential in CI, and provider lag on new GitHub fields.
  Tipping conditions to revisit it: repo count > ~6, org-level
  settings/teams/webhooks in scope, multi-human plan review, or GitHub
  settings churn too heavy to hand-normalize.

Actions **variables/secrets stay out of scope** here — they are owned by
`scripts/set-repo-variables.sh` + the `consumer-repo-provisioning` skill (which
cross-reference back to `repo-settings.yml` for settings). Actions
**permissions** (SHA pinning, fork-PR approval) are settings, not
variables/secrets, and ARE managed here (see above).
