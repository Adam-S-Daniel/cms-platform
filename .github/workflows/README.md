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

A Decap editorial PR's preview is built with `jekyll build --unpublished`
(#637), so a new draft saved with Published OFF (`published: false`) renders at
its real URL on `preview-pr<N>.<apex>`, and appears in that preview's listings,
feeds and sitemap, as does any other `published: false` entry already on the
base branch. Every other PR's preview, and production, keep Jekyll's default:
`published: false` entries are not built. Preview responses carry
`X-Robots-Tag: noindex, nofollow`.

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
production, then optionally posts a Mastodon status, shares it to LinkedIn
as an article card, and/or renders a Substack-ready Markdown draft (job
summary + run artifact — Substack has no publish API, so that leg is always
paste-by-hand). On a caller's weekly `schedule` it only checks the LinkedIn
token's age (red from day 50 of 60). Full write-up, including the
dedupe/idempotency model (Mastodon dedupes; LinkedIn is one-shot, never
retried, re-run one leg with `targets`) and why `await-prod-deploy` is
invoked by a LOCAL checked-out path rather than a remote pin (a
`sha_pinning_required` consumer rejects the latter): `docs/CROSS-POSTING.md`.

| Input | Required | Default | Notes |
|---|---|---|---|
| `prod_url` | ✓ | — | e.g. `https://example.com`; fed to `await-prod-deploy` on a push |
| `mastodon_instance` | | `""` | e.g. `https://hachyderm.io`; empty skips the Mastodon leg |
| `linkedin` | | `false` | share to the token owner's LinkedIn profile; also enables the scheduled token-age check |
| `linkedin_token_minted` | | `""` | `YYYY-MM-DD` the LinkedIn token was minted, from the caller's `vars.LINKEDIN_TOKEN_MINTED` |
| `substack` | | `false` | render + upload the Substack Markdown draft |
| `targets` | | `all` | `all` / `mastodon` / `linkedin` / `substack` — re-run one leg without double-posting another |
| `post_path` | | `""` | one `_posts/*.md` for a `workflow_dispatch`-shaped caller (backfill/re-run) |
| `dry_run` | | `false` | log what would post to Mastodon and LinkedIn; post nothing |
| `visibility` | | `public` | Mastodon post visibility (`public` / `unlisted` / `direct`) |
| `platform_repo` | | `Adam-S-Daniel/cms-platform` | where `cross_post.py` lives |
| `platform_ref` | | `main` | pin to the `uses:` ref |

| Secret | Required | Notes |
|---|---|---|
| `MASTODON_ACCESS_TOKEN` | | app token scoped `profile` + `read:statuses` + `write:statuses` (`profile` is what the dedupe's `verify_credentials` call needs, `read:statuses` is what the duplicate-post lookup needs); unset skips the Mastodon leg with a `::warning::` |
| `LINKEDIN_ACCESS_TOKEN` | | 60-day member token scoped `openid profile w_member_social`; unset skips the LinkedIn leg with a `::warning::` |

With `mastodon_instance`, `linkedin` and `substack` all left at their defaults, a run
detects the post, prints one `::notice::`, and does nothing else — the
caller template's own defaults, so a freshly-adopted site gets a harmless
no-op.

## `email-draft.yml`

Turns an email the site owner sent to a secret posting address into a Decap
editorial-workflow draft (never a published post). A thin caller triggered by
`repository_dispatch` (`email-draft`, fired by the
`infrastructure/email-draft-poller/` Lambda) or by hand passes the JMAP email
id; the job verifies the sender's DKIM signature and Fastmail's own
authentication results, opens the draft with the CMS automation App's token,
and replies to the owner. Does nothing until the site's `_config.yml` sets
`cms.email_drafts.enabled: true`. Full write-up, threat model and setup:
`docs/EMAIL-DRAFTS.md`.

| Input | Required | Default | Notes |
|---|---|---|---|
| `email_id` | ✓ | — | JMAP id, validated against `^[A-Za-z0-9_-]{1,255}$` |
| `dry_run` | | `false` | verify and log the plan; create, send and move nothing |
| `platform_repo` | | `Adam-S-Daniel/cms-platform` | where `scripts/email_draft/` lives |
| `platform_ref` | | `main` | pin to the `uses:` ref |

| Secret | Required | Notes |
|---|---|---|
| `FASTMAIL_API_TOKEN` | ✓ in practice | Fastmail token with the Email and Email submission scopes |
| `EMAIL_DRAFT_ADDRESS` | ✓ in practice | the secret posting address |
| `EMAIL_DRAFT_SENDER` | ✓ in practice | the owner's address: the only accepted sender and the only reply recipient |
| `app_private_key` | ✓ in practice | CMS automation App key, with `vars.CMS_AUTOMATION_APP_ID` on the caller; the mint step fails without it |

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
