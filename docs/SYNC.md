# Bidirectional sync

How platform changes reach sites, and how site-side improvements get back.

## Down (platform → sites)

| What | Mechanism |
|---|---|
| Reusable workflow `uses:@<tag>` pins | **Dependabot** `github-actions` ecosystem (`examples/site/.github/dependabot.yml`) |
| `cms-platform-theme` gem (layouts/includes/assets/plugins + Decap render hook + **admin UI** `theme/admin`) | **Dependabot** `bundler` ecosystem |
| **EVERY** version ref in ONE PR — `platform_ref:` inputs + `platform.lock`, the `uses:@<tag>` pins, the gem `tag:`, `Gemfile.lock` `tag:` + `revision:`, and any composite `@<sha>` pin — plus seeding any workflow caller the release newly made platform-dictated | **`platform-bump`** reusable workflow — an **atomic single-version bump** (#13) that also seeds newly-dictated workflow callers so workflow-SET parity (#54) passes too. Checks out with the caller PAT so the workflow-file push is authorised |
| Skills (`.claude/skills`) | **`skills-sync`** reusable workflow (rsync + PR, platform-authoritative) |
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
above), so its PR is single-version-consistent on its own (#13) — Dependabot's
`github-actions` / `bundler` ecosystems remain wired as an independent safety net
(and for non-cms-platform deps), but they're no longer the *only* path for the
`uses:@`/gem pins, so a consumer no longer sits skewed waiting for them to catch
up. NOTE: a consumer only gets the atomic bump once its `platform-bump` thin
caller pins a platform release that **contains** this fix; until then bump it
manually (see the `platform-release-and-bump` skill). `platform-bump` also
seeds any workflow caller a release newly made platform-dictated — a file
`examples/site/.github/workflows/` gained since the consumer's last bump — so
a bump PR passes workflow-SET parity (#54) on its own too, not just
version-pin-consistency (#29).

## Up (site → platform)

**`platform-drift-guard`** runs on site PRs: platform-owned files that live in the
site (`.claude/skills/`) must byte-match the platform at the site's pinned ref. A PR
that edits one **fails** with guidance to make the change in `cms-platform` instead.

The **admin machinery** (`admin/` except the seam) is shipped via the `cms-platform-theme`
gem (`theme/admin`) as of v0.1.4 — sites no longer vendor byte-copies, so it isn't
byte-match-guarded; a gem bump (Dependabot `bundler`) is its down-sync path. Site-owned
seams (`admin/collections.site.yml`) and generated configs (`admin/config.yml`,
`admin/config-local.yml`) are never platform-owned. A site can also opt out of the
platform's built-in collections via `_config.yml: cms.base_collections` (a keep-list;
v0.1.7) without forking any admin file.

So an improvement made while working on any site is routed here as a PR → merge →
tag → it flows back down to all sites. Site **content/branding/docs never sync** — only machinery.

## Single-version pin invariant (anti-skew, issue #29)

A consuming repo references the platform version in **many** places, and the
down-sync mechanisms above land bumps **piecemeal** — so a consumer can drift:

| Reference | Bumped by |
|---|---|
| `.github/workflows/**` reusable-workflow `uses: …/.github/workflows/<n>.yml@<ref>` | Dependabot `github-actions` |
| `.github/workflows/**` SHA-pinned composite `uses: …/.github/actions/<n>@<sha>  # vX.Y.Z` (the **comment**) | Dependabot + `dependabot-comment-sync` |
| `Gemfile` `gem "cms-platform-theme", …, tag:` + `Gemfile.lock` git-source `tag:` | Dependabot `bundler` |
| `platform.lock` `platform_ref` + `with: platform_ref:` workflow inputs | `platform-bump` |

Because these run independently, a consumer can sit skewed for a long time
(observed live: **adamdaniel.ai** pinned `@v0.1.0` loop/deploy callers, gem
`@v0.1.5`, and others `@v0.1.3`/`@v0.1.6` simultaneously). A `v0.1.0` reusable
running against a `v0.1.5` gem is a latent behaviour-bug source and breaks the
"platform moves in lockstep" model.

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
YAML parser drops comments, same as `scripts/sync-action-pin-comments.sh`), and
reads the Gemfile/Gemfile.lock `tag:`. It **aggregates all** violations and
fails CI with a per-file diff (found vs expected) when any disagree; exits 0
with an OK summary when they all match. It tolerates a consumer with no Gemfile
and ignores non-cms-platform `uses:`. Self-tested by
`e2e/check-platform-pin-consistency.test.js` (consistent fixture → 0; skewed
fixture → non-zero, each offending file/value named).

This **complements `platform-drift-guard`**: drift-guard guards file **content**
(platform-owned files in the site must byte-match the platform); pin-consistency
guards **version consistency** (all the version references must agree on one
release). A consumer adopting the caller reconciles its pins to a single release
in the same change.

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
  `cms-platform-secrets` skill), writes are operator-only.

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
`scripts/set-repo-variables.sh` + the `cms-platform-secrets` skill (which
cross-reference back to `repo-settings.yml` for settings).
