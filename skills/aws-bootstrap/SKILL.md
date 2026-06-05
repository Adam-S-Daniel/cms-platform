---
name: aws-bootstrap
description: Deploy, update, or troubleshoot the platform AWS bootstrap CloudFormation stack for a site. Use when setting up AWS infrastructure for the first time, adding new resources, diagnosing CloudFormation errors, checking stack outputs, or explaining what the bootstrap provisions.
compatibility: Requires AWS CLI v2 configured with credentials, bash. Must be run from the repo root or infrastructure/bootstrap/.
---

# AWS Bootstrap

Provisions all one-time AWS prerequisites for a platform site's CI/CD. The
template is fully parameterized — every site identity value is a stack
parameter, so one shared AWS account hosts many sites with no hardcoded
domain. Resource names derive from `ResourcePrefix` (the apex with dots
turned to hyphens, e.g. `example.com` → `example-com`); the two CloudFront
Functions bake in `ProductionDomainName` (the apex) at deploy time.

## What the stack creates

All resource names below are derived; `${ResourcePrefix}` and
`${ProductionDomainName}` are the stack parameters that fill them in.

| Resource | Name | Notes |
|---|---|---|
| S3 bucket (artifacts) | `${ResourcePrefix}-cfn-artifacts` (param `ArtifactBucketName`) | SAM/CFN deployment artifacts |
| S3 bucket (preview) | `${ResourcePrefix}-previews` (param `PreviewBucketName`) | PR preview deployments, static website hosting |
| S3 bucket (production) | `${ResourcePrefix}-production` (param `ProductionBucketName`) | Production site, static website hosting |
| ACM certificate (preview) | `*.${ProductionDomainName}` (wildcard) | DNS-validated; covers every `preview-pr<N>.${ProductionDomainName}` |
| ACM certificate (production) | `${ProductionDomainName}` + `www.${ProductionDomainName}` | DNS-validated |
| CloudFront distribution (preview) | (id is a stack output, `PreviewDistributionId`) | Fronts the preview S3 bucket; `${AWS::StackName}-preview-router` Function maps host → `/pr-{N}/` S3 prefix at viewer-request, `${AWS::StackName}-preview-location-fixer` Function strips the same prefix from `Location` headers at viewer-response |
| CloudFront distribution (production) | (id is a stack output, `ProductionDistributionId`) | Fronts the production S3 bucket; aliases `${ProductionDomainName}` + `www.${ProductionDomainName}` |
| Route53 records | `*.${ProductionDomainName}`, `${ProductionDomainName}`, `www.${ProductionDomainName}` | Wildcard alias → preview CloudFront; apex + www → production CloudFront |
| OIDC provider | `token.actions.githubusercontent.com` | Conditional via `CreateOIDCProvider` — skip if it already exists in the account |
| IAM role | `${ResourcePrefix}-github-actions` | Assumed by GitHub Actions via OIDC; trust scoped to `repo:${GitHubOrg}/${GitHubRepo}:*` |

Unlike an earlier single-site setup, the bootstrap stack now manages the
preview AND production buckets and distributions directly — nothing is
created out-of-band.

## CloudFront does NOT negative-cache 404s (`ErrorCachingMinTTL: 0`)

Both distributions set `CustomErrorResponses → ErrorCachingMinTTL: 0` for 403
and 404 (template, v0.1.13 / cms#39). This is load-bearing for the prod-canary
loops: a loop polls `/blog/<future-dated-slug>/` BEFORE the canary deploys, so
S3 returns 404; with the old `ErrorCachingMinTTL: 300` CloudFront would
**negative-cache** that 404 for 5 min (re-cached on each poll), so after the
page landed on S3 + the `/*` invalidation the reflect-poll still read the stale
cached 404 → "URL never reflected" (cms#21 / adamdaniel#1815). The
`CachingOptimized` policy ignores query strings, so e2e-side cache-busting can't
help — the fix has to be in the template. New sites inherit it automatically.

**Applying the fix to a LIVE distribution requires a stack redeploy** (the
template change alone does nothing until deployed): `bash
infrastructure/bootstrap/deploy.sh` for that site. Direct live-distribution
mutation is denied by the auto-mode classifier — go via the template + stack
deploy. Verify:

```bash
aws cloudfront get-distribution-config --id <ProductionDistributionId>   --query 'DistributionConfig.CustomErrorResponses.Items[].{code:ErrorCode,ttl:ErrorCachingMinTTL}'
# → both 403 and 404 must show ttl: 0
```

## Deployment

The deploy script reads its site identity from environment variables (the
scaffolder writes these into `infrastructure/site-params.env`). Only
`GITHUB_REPO` and `APEX_DOMAIN` are required; everything else derives.

```bash
# Standard deploy — load site params, then run (auto-detects Route53 zone)
cp infrastructure/site-params.example.env infrastructure/site-params.env   # first time
set -a; source infrastructure/site-params.env; set +a
bash infrastructure/bootstrap/deploy.sh

# If a GitHub OIDC provider already exists in the account
CREATE_OIDC_PROVIDER=false bash infrastructure/bootstrap/deploy.sh

# Override hosted zone manually (otherwise auto-detected from APEX_DOMAIN)
HOSTED_ZONE_ID=<your-zone-id> bash infrastructure/bootstrap/deploy.sh
```

Key env vars (see `infrastructure/site-params.example.env` for the full set):

| Var | Required | Default |
|---|---|---|
| `GITHUB_REPO` | yes | — (e.g. `example.com`) |
| `APEX_DOMAIN` | yes | — (e.g. `example.com`) |
| `GITHUB_ORG` | no | `Adam-S-Daniel` |
| `RESOURCE_PREFIX` | no | `APEX_DOMAIN` with dots → hyphens |
| `STACK_NAME` | no | `${RESOURCE_PREFIX}-bootstrap` |
| `AWS_REGION` | no | `us-east-1` |
| `HOSTED_ZONE_ID` | no | auto-detected from `APEX_DOMAIN` |
| `CREATE_OIDC_PROVIDER` | no | `true` |

The script:
1. Auto-detects the Route53 hosted zone for `${APEX_DOMAIN}` (unless `HOSTED_ZONE_ID` is set)
2. Runs `aws cloudformation deploy` with `CAPABILITY_NAMED_IAM`, passing the derived parameters
3. Prints outputs including the Role ARN and both CloudFront distribution IDs

## Stack outputs → GitHub secrets

After deploying, add these as GitHub Actions secrets (repo → Settings → Secrets → Actions):

| Output key | Secret name |
|---|---|
| `RoleArn` | `AWS_ROLE_ARN` |
| `PreviewDistributionId` | `PREVIEW_CLOUDFRONT_ID` |
| `ProductionDistributionId` | `PRODUCTION_CLOUDFRONT_ID` |

## Common errors and fixes

### `ResourceExistenceCheck` / changeset FAILED
The `AWS::Route53::HostedZone::Id` parameter type triggers early validation. The `HostedZoneId` parameter is typed as `String` with `AllowedPattern: "^Z[A-Z0-9]+$"` to avoid this.

If this error reappears: check whether a resource being added already exists outside the stack. Delete failed changesets before re-running (substitute your stack name):
```bash
aws cloudformation list-change-sets --stack-name "${STACK_NAME}" \
  --query 'Summaries[?Status==`FAILED`].ChangeSetName' --output text | \
  xargs -I{} aws cloudformation delete-change-set \
    --stack-name "${STACK_NAME}" --change-set-name {}
```

### Certificate error on CloudFront: "SSL certificate doesn't exist"
CloudFormation rolled back and deleted the ACM cert. The cert has `DeletionPolicy: Retain` to prevent this. If it happens:
1. Check `aws acm list-certificates --region us-east-1` for the cert status
2. Re-run the deploy — the cert will be re-created and DNS-validated via Route53
3. CloudFront creation waits on its `DependsOn` certificate

### `NoSuchOriginRequestPolicy`
The `CORS-S3Origin` managed origin request policy doesn't exist in all accounts. It is not used — S3 website custom origins don't need it.

### Stack in `UPDATE_ROLLBACK_COMPLETE`
Safe to re-run `deploy.sh` — CloudFormation will create a new changeset.

## IAM role permissions (scope)

All policies are scoped to `${ResourcePrefix}-*` prefixed resources (and the
account-scoped ARNs the role legitimately needs):
- **S3**: get/put/delete objects, list — artifacts, preview, and production buckets only
- **CloudFormation**: full stack management on `${ResourcePrefix}-*` stacks
- **CloudFront**: all distribution operations (global resource, wildcard)
- **ACM**: request/describe/delete certificates (global resource, wildcard)
- **Route53**: change/list records in the site's hosted zone
- **IAM**: create/manage roles named `${ResourcePrefix}-*`
- **Lambda**: all operations on functions named `${ResourcePrefix}-*`
- **API Gateway**: manage APIs and tags
- **CloudWatch Logs**: manage log groups for `/aws/lambda/${ResourcePrefix}-*`

## Template location

`infrastructure/bootstrap/template.yaml` — vanilla CloudFormation (no SAM transform).
`infrastructure/bootstrap/deploy.sh` — idempotent deploy script.

## Sibling stack: CloudWatch RUM

A separate CloudFormation stack `${ResourcePrefix}-rum` provisions Amazon
CloudWatch RUM (real-user monitoring — Core Web Vitals, JS errors,
page-load timings). It's independent of the bootstrap stack so you can
deploy/redeploy/teardown analytics without touching the deploy pipeline.

Deploy it with `bash infrastructure/rum/deploy.sh` (same env-var convention
— `APEX_DOMAIN` required, the rest derive). After it finishes, copy the
`AppMonitorId` and `IdentityPoolId` outputs into `_config.yml` under
`analytics.cloudwatch_rum`, then deploy the site. See
`infrastructure/README.md` for the full stack table and deploy order; the
script + template are `infrastructure/rum/deploy.sh` and
`infrastructure/rum/template.yaml`.
