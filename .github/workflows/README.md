# Reusable workflows

These are `workflow_call` workflows. A site consumes one from a thin wrapper in
its own `.github/workflows/` that owns the trigger (`on:`), `paths-ignore`, and
`run-name`, then delegates the work here. Copyable wrappers live in
[`examples/site/.github/workflows/`](../../examples/site/.github/workflows/).

Pin the `uses:` reference to a release tag (`@v0.1.0`) or full SHA and let
**Dependabot** (`github-actions` ecosystem) open the bump PRs — that is the
platform→site down-sync path.

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

## Permissions

Reusable workflows are capped by the **caller's** `GITHUB_TOKEN` permissions, so
the wrapper must grant at least what the reusable workflow declares (see each
example caller's top-level `permissions:` block).

## Action pinning

Every `uses:` in these files is pinned to a full 40-char commit SHA with a
version + date comment, per the platform's SHA-pinning policy. Bump them only
after the 7-day cooling-off window.
