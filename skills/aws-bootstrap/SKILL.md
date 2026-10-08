---
name: aws-bootstrap
description: Deploy, update, or troubleshoot the platform AWS bootstrap CloudFormation stack for a site. Use when setting up AWS infrastructure for the first time, adding new resources, diagnosing CloudFormation errors, checking stack outputs, or explaining what the bootstrap provisions.
compatibility: Requires AWS CLI v2 configured with credentials, bash, Ruby and python3. Must be run from the repo root or infrastructure/bootstrap/.
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
| CloudFront distribution (admin) — only when `AdminDomainName` is set | (no id output; `AdminURL` is the output) | Serves only `/admin/` from the production bucket's REST endpoint at `${AdminDomainName}`, with caching disabled; brings its own ACM certificate, `${AWS::StackName}-admin-site` Function and Route53 A-alias. Empty `AdminDomainName` (the default) creates none of it |
| Route53 records | `*.${ProductionDomainName}`, `${ProductionDomainName}`, `www.${ProductionDomainName}` | Wildcard alias → preview CloudFront; apex + www → production CloudFront |
| OIDC provider | `token.actions.githubusercontent.com` | Conditional via `CreateOIDCProvider` — skip if it already exists in the account |
| IAM role | `${ResourcePrefix}-github-actions` | Assumed by GitHub Actions via OIDC; trust scoped to `repo:${GitHubOrg}/${GitHubRepo}:*` |

The bootstrap stack manages every bucket and distribution above directly —
nothing is created out-of-band.

## CloudFront does NOT negative-cache 404s (`ErrorCachingMinTTL: 0`)

All three distributions (preview, production, and the optional admin one) set
`CustomErrorResponses → ErrorCachingMinTTL: 0` for 403 and 404. This is
load-bearing for the prod-canary loops: a loop polls
`/blog/<future-dated-slug>/` BEFORE the canary deploys, so S3 returns 404; any
nonzero TTL makes CloudFront **negative-cache** that 404 (re-cached on each
poll), so after the page lands on S3 + the `/*` invalidation the reflect-poll
still reads the stale cached 404 → "URL never reflected". The
`CachingOptimized` policy ignores query strings, so e2e-side cache-busting can't
help — the TTL has to be 0 in the template. (The incident and the 300 → 0 fix:
cms#21 / adamdaniel#1815, v0.1.13 / cms#39 in `docs/VERSION-HISTORY.md`.)

**A template change reaches a LIVE distribution only through a stack
redeploy:** `bash
infrastructure/bootstrap/deploy.sh` for that site. Direct live-distribution
mutation is denied by the auto-mode classifier — go via the template + stack
deploy. Verify:

```bash
aws cloudfront get-distribution-config --id <ProductionDistributionId>   --query 'DistributionConfig.CustomErrorResponses.Items[].{code:ErrorCode,ttl:ErrorCachingMinTTL}'
# → both 403 and 404 must show ttl: 0 (same check for PreviewDistributionId)
```

## Deployment

The deploy script reads its site identity from environment variables (the
scaffolder writes these into `infrastructure/site-params.env`). Only
`GITHUB_REPO` and `APEX_DOMAIN` are required; everything else derives.

```bash
# Standard deploy — load site params, then run (auto-detects Route53 zone)
cp infrastructure/site-params.example.env infrastructure/site-params.env   # first time
set -a; source infrastructure/site-params.env; set +a
# Stack: BOOTSTRAP_STACK_NAME, default <prefix>-bootstrap. site-params.env's
# STACK_NAME names the OAuth proxy stack and is never used for this one
# (infrastructure/README.md, "The STACK_NAME collision")
bash infrastructure/bootstrap/deploy.sh

# A site's FIRST bootstrap creates the stack, which is refused without this
# (a typo in the stack name would otherwise create a new stack)
ALLOW_STACK_CREATE=1 bash infrastructure/bootstrap/deploy.sh

# If a GitHub OIDC provider already exists in the account
CREATE_OIDC_PROVIDER=false bash infrastructure/bootstrap/deploy.sh

# Override hosted zone manually (otherwise auto-detected from APEX_DOMAIN)
HOSTED_ZONE_ID=<your-zone-id> bash infrastructure/bootstrap/deploy.sh

# Execute a change set that removes or replaces resources (refused otherwise)
ALLOW_DESTRUCTIVE_CHANGES=1 bash infrastructure/bootstrap/deploy.sh
```

Key env vars (see `infrastructure/site-params.example.env` for the full set):

| Var | Required | Default |
|---|---|---|
| `GITHUB_REPO` | yes | — (e.g. `example.com`) |
| `APEX_DOMAIN` | yes | — (e.g. `example.com`) |
| `GITHUB_ORG` | no | `Adam-S-Daniel` |
| `RESOURCE_PREFIX` | no | `APEX_DOMAIN` with dots → hyphens |
| `BOOTSTRAP_STACK_NAME` | no | `${RESOURCE_PREFIX}-bootstrap`. `STACK_NAME` is not read as this stack's name: one equal to `site-params.env`'s is ignored, one equal to the default is accepted, any other stops the script; a bootstrap name equal to `site-params.env`'s `STACK_NAME` is refused |
| `AWS_REGION` | no | `us-east-1` |
| `HOSTED_ZONE_ID` | no | auto-detected from `APEX_DOMAIN` |
| `CREATE_OIDC_PROVIDER` | no | `true` |
| `ALLOW_DESTRUCTIVE_CHANGES` | no | unset: a removal or replacement is refused |
| `ALLOW_STACK_CREATE` | first bootstrap only | unset: creating a stack that does not exist is refused; an update needs no flag |

The script:
1. Auto-detects the Route53 hosted zone for `${APEX_DOMAIN}` (unless `HOSTED_ZONE_ID` is set)
2. Minifies the template with `minify-template.rb` (Ruby's YAML parser: comments go, every tag and value stays), because the raw file is over the CLI's 51,200-byte inline limit; it refuses, before any AWS call, if the minified copy is still over it
3. Creates a change set (`aws cloudformation deploy --no-execute-changeset`, `CAPABILITY_NAMED_IAM`, the derived parameters), prints one line per resource action, and refuses to execute when any resource would be removed or replaced unless `ALLOW_DESTRUCTIVE_CHANGES=1`, and refuses to create a stack that does not exist unless `ALLOW_STACK_CREATE=1`; otherwise executes it and waits. An empty change set is a success
4. Prints outputs including the Role ARN and both CloudFront distribution IDs

## Stack outputs → GitHub secrets

After deploying, add these as GitHub Actions secrets (repo → Settings → Secrets → Actions):

| Output key | Secret name |
|---|---|
| `RoleArn` | `AWS_ROLE_ARN` |
| `PreviewDistributionId` | `PREVIEW_CLOUDFRONT_ID` |
| `ProductionDistributionId` | `PRODUCTION_CLOUDFRONT_ID` |

## Common errors and fixes

### `Templates with a size greater than 51,200 bytes must be deployed via an S3 Bucket`
An old copy of `deploy.sh` (v0.1.125, before the minified inline deploy) is running: pull the current platform ref. The current script stops on its own, before any AWS call, if even the minified template is over the limit.

### `Refusing to execute: the change set above removes or replaces resources`
Read the lines marked `DESTRUCTIVE`. The usual causes are a live apex without `CREATE_APEX_DNS_RECORDS=true` or a site with an admin host but no `ADMIN_DOMAIN`. Fix the setting and re-run; use `ALLOW_DESTRUCTIVE_CHANGES=1` only when the removal is intended. Nothing was changed, and the refused change set is left on the stack for review.

### `Refusing to execute: stack <name> does not exist, so this change set would CREATE it`
Usually a typo in `BOOTSTRAP_STACK_NAME`, `RESOURCE_PREFIX` or `APEX_DOMAIN`: check the name against the stack you meant. Only for a site's genuine first bootstrap, re-run with `ALLOW_STACK_CREATE=1`. Nothing was changed, and the change set is left on the new stack for review.

### `Creating the change set failed for stack <name>`
The script does not echo the AWS CLI's message (it can carry the account id). Run the printed read-only `describe-stacks` command to see the stack's state; otherwise check the AWS session's credentials and CloudFormation permissions.

### `STACK_NAME=... is set, and this script no longer reads STACK_NAME`
`STACK_NAME` is the OAuth proxy stack's name, so the script will not guess. Run with `STACK_NAME=` for the default `<prefix>-bootstrap`, or set `BOOTSTRAP_STACK_NAME`. Nothing was deployed.

### `Refusing: the bootstrap stack name ... is the STACK_NAME in ...site-params.env`
`BOOTSTRAP_STACK_NAME` names the OAuth proxy stack. Set it to the bootstrap stack's name (default `<prefix>-bootstrap`). Nothing was deployed.

### `Stack <name> is in ROLLBACK_COMPLETE` (or `CREATE_FAILED`, `UPDATE_ROLLBACK_FAILED`)
CloudFormation cannot take a change set for a stack in a failed state, and the script executes nothing. After a failed first create (`ROLLBACK_COMPLETE`, `CREATE_FAILED`), read the stack's events, delete the failed stack, then re-run. After `UPDATE_ROLLBACK_FAILED`, fix the resource named in the events and continue the rollback from the CloudFormation console, then re-run.

### `ResourceExistenceCheck` / changeset FAILED
The `AWS::Route53::HostedZone::Id` parameter type triggers early validation. The `HostedZoneId` parameter is typed as `String` with `AllowedPattern: "^Z[A-Z0-9]+$"` to avoid this.

If this error reappears: check whether a resource being added already exists outside the stack. Delete failed changesets before re-running (substitute your stack name):
```bash
aws cloudformation list-change-sets --stack-name "${BOOTSTRAP_STACK_NAME}" \
  --query 'Summaries[?Status==`FAILED`].ChangeSetName' --output text | \
  xargs -I{} aws cloudformation delete-change-set \
    --stack-name "${BOOTSTRAP_STACK_NAME}" --change-set-name {}
```

### Certificate error on CloudFront: "SSL certificate doesn't exist"
CloudFormation rolled back and deleted the ACM cert. The cert has `DeletionPolicy: Retain` to prevent this. If it happens:
1. Check `aws acm list-certificates --region us-east-1` for the cert status
2. Re-run the deploy — the cert will be re-created and DNS-validated via Route53
3. CloudFront creation waits on the certificate its `!Ref` names (an implicit dependency; the template carries no explicit one)

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
