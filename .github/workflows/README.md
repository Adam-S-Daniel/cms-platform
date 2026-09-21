# Reusable workflows

These are `workflow_call` workflows. A site consumes one from a thin wrapper in
its own `.github/workflows/` that owns the trigger (`on:`), `paths-ignore`, and
`run-name`, then delegates the work here. Copyable wrappers live in
[`examples/site/.github/workflows/`](../../examples/site/.github/workflows/).

Pin the `uses:` reference to a release tag (`@v0.1.1`) or full SHA —
**`platform-bump`** opens the bump PR (Dependabot's `github-actions`
ecosystem `ignore`s every `Adam-S-Daniel/cms-platform/*` ref, #244; see
`docs/SYNC.md`); that is the platform→site down-sync path.

## `deploy-production.yml`

Builds Jekyll (`JEKYLL_ENV=production`), syncs `_site/` to the production
bucket, invalidates CloudFront, and registers a `production` GitHub Deployment.

| Input | Required | Default | Notes |
|---|---|---|---|
| `apex_domain` | ✓ | — | e.g. `example.com` (no scheme) |
| `prod_bucket` | ✓ | — | production S3 bucket name |
| `aws_region` | | `us-east-1` | |
| `ruby_version` | | `3.2` | |

| Secret | Required | Notes |
|---|---|---|
| `AWS_ROLE_ARN` | ✓ | OIDC role to assume |
| `PRODUCTION_CLOUDFRONT_ID` | | distribution id; invalidation is skipped when empty |

## `deploy-preview.yml`

Per-PR preview deploy + teardown. Publishes `pr-<N>/` and, for Decap editorial
PRs (`cms/<col>/<entry>` branches), a draft-cycle-stable `cms-<slug>/` alias.
Registers the `deploy/preview` commit status Decap's editor reads, plus GH
Deployment rows. Posts/refreshes a single marker-tagged PR comment.

Because the helper scripts (`cms-preview-slug.sh`, `patch-preview-config.sh`)
are platform-owned and absent from the site repo, this workflow checks the
platform repo out into `.cms-platform/` (a dot-dir Jekyll ignores). **Pin
`platform_ref` to the same ref as the `uses:` pin** so the scripts match.

| Input | Required | Default | Notes |
|---|---|---|---|
| `apex_domain` | ✓ | — | e.g. `example.com` |
| `preview_bucket` | ✓ | — | preview S3 bucket name |
| `bot_marker` | | `cms-preview-bot` | keep unique per site so comment markers don't collide |
| `aws_region` | | `us-east-1` | |
| `ruby_version` | | `3.2` | |
| `platform_repo` | | `Adam-S-Daniel/cms-platform` | where the helper scripts live |
| `platform_ref` | | `main` | pin to the `uses:` ref |

| Secret | Required | Notes |
|---|---|---|
| `AWS_ROLE_ARN` | ✓ | OIDC role to assume |
| `PREVIEW_CLOUDFRONT_ID` | | falls back to the raw S3 website endpoint when empty |

## `cross-post.yml`

Detects a newly-published `_posts/*.md`, waits for it to actually be live on
production, then optionally posts a Mastodon status and/or renders a
Substack-ready Markdown draft (job summary + run artifact — Substack has no
publish API, so that leg is always paste-by-hand). Full write-up, including
the dedupe/idempotency model and why `await-prod-deploy` is invoked by a
LOCAL checked-out path rather than a remote pin (a `sha_pinning_required`
consumer rejects the latter): `docs/CROSS-POSTING.md`.

| Input | Required | Default | Notes |
|---|---|---|---|
| `prod_url` | ✓ | — | e.g. `https://example.com`; fed to `await-prod-deploy` on a push |
| `mastodon_instance` | | `""` | e.g. `https://hachyderm.io`; empty skips the Mastodon leg |
| `substack` | | `false` | render + upload the Substack Markdown draft |
| `post_path` | | `""` | one `_posts/*.md` for a `workflow_dispatch`-shaped caller (backfill/re-run) |
| `dry_run` | | `false` | log what would post to Mastodon; post nothing |
| `visibility` | | `public` | Mastodon post visibility (`public` / `unlisted` / `direct`) |
| `platform_repo` | | `Adam-S-Daniel/cms-platform` | where `cross_post.py` lives |
| `platform_ref` | | `main` | pin to the `uses:` ref |

| Secret | Required | Notes |
|---|---|---|
| `MASTODON_ACCESS_TOKEN` | | app token scoped `write:statuses` only; unset skips the Mastodon leg with a `::warning::` |

With both `mastodon_instance` and `substack` left at their defaults, a run
detects the post, prints one `::notice::`, and does nothing else — the
caller template's own defaults, so a freshly-adopted site gets a harmless
no-op.

## Permissions

Reusable workflows are capped by the **caller's** `GITHUB_TOKEN` permissions, so
the wrapper must grant at least what the reusable workflow declares (see each
example caller's top-level `permissions:` block).

## Action pinning

Every third-party `uses:` in these files is pinned to a full 40-char commit SHA
and **nothing after it** — the trailing `# vX.Y.Z (YYYY-MM-DD)` comment was
retired on 2026-08-20 because it went stale silently and then lied, and
Dependabot refreshed it only sometimes. Resolve a version when you need one
(`git ls-remote <url> | grep <sha>`, or the Dependabot PR title). Bump only
after the 7-day cooling-off window.

**No `# vX.Y.Z` survives anywhere, including on a platform ref.** A cms-platform
**composite** referenced from another repo was the last holdout — there the
comment was the pin-consistency GATE rather than a label — and it now takes a
release TAG instead (`…/.github/actions/<n>@v0.1.88`), which ties it to
`platform.lock`'s `platform_ref` directly with no comment to parse. See
`docs/PIN-CONSISTENCY.md`.
