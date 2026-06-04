# Bidirectional sync

How platform changes reach sites, and how site-side improvements get back.

## Down (platform → sites)

| What | Mechanism |
|---|---|
| Reusable workflow `uses:@<tag>` pins | **Dependabot** `github-actions` ecosystem (`examples/site/.github/dependabot.yml`) |
| `cms-platform-theme` gem (layouts/includes/assets/plugins + Decap render hook + **admin UI** `theme/admin`) | **Dependabot** `bundler` ecosystem |
| `platform_ref:` workflow inputs + `platform.lock` | **`platform-bump`** reusable workflow (Dependabot doesn't touch `with:` inputs) |
| Skills (`.claude/skills`) | **`skills-sync`** reusable workflow (rsync + PR, platform-authoritative) |
| AWS infra templates | re-run `infrastructure/*/deploy.sh` with the new templates |

Tag a release on `cms-platform` → the bump PRs fan out to every site; site CI gates the merge.

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
