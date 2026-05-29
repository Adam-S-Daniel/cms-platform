---
name: preview-environments
description: Work with PR preview environments for a platform site. Use when checking preview status, debugging failed deployments, understanding the S3/CloudFront pipeline, fixing the preview bot comment, investigating cache issues, or explaining how previews are deployed and torn down.
compatibility: Requires AWS CLI v2 and gh CLI for debugging tasks.
---

# Preview Environments

Each PR gets a preview at `https://preview-pr{N}.${ApexDomain}/`. URL
paths on the preview subdomain match production exactly — e.g. a post
at `/blog/foo/` is reachable at both
`https://${ApexDomain}/blog/foo/` and
`https://preview-pr21.${ApexDomain}/blog/foo/`.

`${ApexDomain}` is the site's apex (the bootstrap stack's
`ProductionDomainName` parameter); every value below derives from the
site's `ResourcePrefix` (apex with dots → hyphens) or the apex itself.
Nothing is hardcoded to a specific domain.

## Architecture

```
PR push
  → deploy-preview.yml
  → Jekyll build (no --baseurl; root-relative URLs)
  → patch-preview-config.sh → repoint admin/config.yml for this PR
  → aws s3 sync → s3://${ResourcePrefix}-previews/pr-{N}/
  → CloudFront invalidation /pr-{N}/*
  → Bot comment updated: https://preview-pr{N}.${ApexDomain}/

Request-time (every visitor hit)
  → Browser → preview-pr21.${ApexDomain}/blog/foo/
  → Route53 wildcard *.${ApexDomain} → Preview CloudFront
  → CloudFront Function (viewer-request): host → S3-prefix
    req.uri = '/pr-21/blog/foo/'
  → CloudFront cache keyed by /pr-21/blog/foo/
  → (on miss) S3 website endpoint serves /pr-21/blog/foo/index.html
  → CloudFront Function (viewer-response): strip `/pr-21/` from
    any Location header so S3's trailing-slash redirects
    (e.g. /admin → /pr-21/admin/) hide the internal prefix from the
    browser, which only knows about the clean public URL space.

PR close/merge
  → deploy-preview.yml `teardown-preview` job (gated on
    github.event.action == 'closed')
  → aws s3 rm s3://${ResourcePrefix}-previews/pr-{N}/ --recursive
  → CloudFront invalidation /pr-{N}/*
  → Bot comment: "🗑️ Preview environment cleaned up."
```

The deploy and teardown logic share one workflow file
(`deploy-preview.yml`): the deploy job gates on
`github.event.action != 'closed'` and the `teardown-preview` job on
`== 'closed'`. There is no separate `teardown-preview.yml`. CMS preview
PRs (`cms/*` head refs) deploy under a `cms-{slug}/` prefix instead of
`pr-{N}/`; teardown removes whichever prefix the PR used.

## Key resources

| Resource | Value |
|---|---|
| S3 bucket | `${ResourcePrefix}-previews` (static website hosting, public read) |
| CloudFront ID | `PreviewDistributionId` stack output → `PREVIEW_CLOUDFRONT_ID` secret |
| Preview domain pattern | `preview-pr{N}.${ApexDomain}` (matched by `*.${ApexDomain}` wildcard) |
| CloudFront Function (request) | `${AWS::StackName}-preview-router` — host → S3 prefix rewrite at viewer-request |
| CloudFront Function (response) | `${AWS::StackName}-preview-location-fixer` — strips `/pr-N/` from `Location` headers at viewer-response |
| AWS region | `us-east-1` |

## Workflow file: `.github/workflows/deploy-preview.yml`

**Triggers:** `pull_request` types `[opened, synchronize, reopened, closed]` targeting `main`

**Permissions:** `contents: read`, `pull-requests: write`, `id-token: write`

**Required secrets:**
- `AWS_ROLE_ARN` — OIDC role for AWS auth (no long-lived keys)
- `PREVIEW_CLOUDFRONT_ID` — the bootstrap stack's `PreviewDistributionId` output

If `PREVIEW_CLOUDFRONT_ID` is unset, the workflow falls back to the S3 website URL at `/pr-{N}/` (HTTP only — won't work with Decap CMS).

## Jekyll build

Preview builds run with **no** `--baseurl`. Each PR serves from its
own subdomain root, so pages use root-relative URLs identical to
production. The site is built into `./_site_preview/` then synced to
the S3 prefix `pr-{N}/`. The CloudFront Function handles the
prefix-to-subdomain mapping transparently at request time.

## CloudFront cache behaviour

- Cache policy: `CachingDisabled` (AWS-managed `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`) — previews always serve fresh content
- Invalidations run on every push and on teardown, against `/pr-{N}/*` — the post-rewrite URI is what CloudFront caches by
- Origin: S3 website endpoint (`${ResourcePrefix}-previews.s3-website-us-east-1.amazonaws.com`) via `http-only` custom origin

## Bot comment

The bot uses `<!-- cms-preview-bot -->` as a marker to find and update the existing comment rather than posting a new one each push. The comment renders a markdown table with preview URL, commit SHA, and branch name.

## Debugging

The examples below use `${ApexDomain}` / `${ResourcePrefix}` /
`$PREVIEW_CLOUDFRONT_ID` as placeholders; substitute the site's own
values (or `export` them first).

**Check workflow status for a PR:**
```bash
gh pr checks <pr-number>      # run from the site repo, or add --repo <owner>/<repo>
```

**Check what's in S3 for a PR:**
```bash
aws s3 ls "s3://${ResourcePrefix}-previews/pr-<N>/" --region us-east-1
```

**Manually invalidate CloudFront cache:**
```bash
aws cloudfront create-invalidation \
  --distribution-id "$PREVIEW_CLOUDFRONT_ID" \
  --paths "/pr-<N>/*"
```

**Check CloudFront distribution status:**
```bash
aws cloudfront get-distribution --id "$PREVIEW_CLOUDFRONT_ID" \
  --query 'Distribution.{Status: Status, Domain: DomainName}'
```

**Manually sync a build to S3:**
```bash
bundle exec jekyll build --destination ./_site_preview
aws s3 sync ./_site_preview "s3://${ResourcePrefix}-previews/pr-<N>/" \
  --delete --cache-control "no-cache, must-revalidate"
```

## Common issues

**Preview URL shows HTTP S3 link instead of HTTPS:**
The `PREVIEW_CLOUDFRONT_ID` secret was not set when the workflow ran. Add the secret and re-trigger (push an empty commit).

**Decap CMS won't load from the preview URL:**
Decap requires HTTPS for GitHub OAuth (or a localhost dev server). The preview domain must be served via CloudFront (HTTPS). If the S3 fallback URL appears, check the secret is set.

**"View on Live Site" in the CMS editor sends editors to prod:**
`patch-preview-config.sh` rewrites `admin/config.yml` during the preview build so Decap's `site_url`/`display_url` point at the PR's subdomain and the GitHub backend reads from the PR's head branch. If this step is missing, Decap will open production URLs with the slugified title rather than the PR's draft content.

**preview-pr{N}.${ApexDomain} resolves but returns 404 or XML:**
Either the CloudFront Function isn't attached to the distribution's viewer-request behaviour, or the wildcard Route53 record / wildcard ACM cert is missing. Re-run `infrastructure/bootstrap/deploy.sh`.

**No-trailing-slash URL 404s (e.g. `/admin` instead of `/admin/`):**
S3 302s directory requests to `…/admin/`, but without the response-side function the `Location` header leaks the internal `/pr-{N}/` prefix and the browser navigates into a nonexistent URL space. The `${AWS::StackName}-preview-location-fixer` Function at viewer-response strips that prefix; if it's missing, re-run `infrastructure/bootstrap/deploy.sh`. Verify with `curl -I https://preview-pr{N}.${ApexDomain}/admin` — `Location` should be `/admin/`, not `/pr-{N}/admin/`.

**Old preview content still showing:**
CloudFront cache not yet invalidated, or the invalidation is in progress. Wait ~30s or manually invalidate (see above).

**Teardown left orphaned S3 files:**
```bash
aws s3 rm "s3://${ResourcePrefix}-previews/pr-<N>/" --recursive --region us-east-1
```
