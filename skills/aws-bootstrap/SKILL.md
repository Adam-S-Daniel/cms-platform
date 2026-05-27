---
name: aws-bootstrap
description: Deploy, update, or troubleshoot the adamdaniel.ai AWS bootstrap CloudFormation stack. Use when setting up AWS infrastructure for the first time, adding new resources, diagnosing CloudFormation errors, checking stack outputs, or explaining what the bootstrap provisions.
compatibility: Requires AWS CLI v2 configured with credentials, bash. Must be run from the repo root or infrastructure/bootstrap/.
---

# AWS Bootstrap

Provisions all one-time AWS prerequisites for adamdaniel.ai CI/CD.

## What the stack creates

| Resource | Name | Notes |
|---|---|---|
| S3 bucket | `adamdaniel-ai-cfn-artifacts` | SAM/CFN deployment artifacts |
| ACM certificate | `*.adamdaniel.ai` (wildcard) | DNS-validated; covers every `preview-pr{N}.adamdaniel.ai` |
| CloudFront distribution | `E2OBHKV0LC6CJ2` | Fronts S3 preview bucket; viewer-request Function maps host → `/pr-{N}/` S3 prefix, viewer-response Function strips the same prefix from `Location` headers so S3 trailing-slash redirects don't leak it |
| Route53 A record | `*.adamdaniel.ai` | Wildcard alias to preview CloudFront |
| OIDC provider | `token.actions.githubusercontent.com` | Conditional — skip if exists |
| IAM role | `adamdaniel-ai-github-actions` | Assumed by GitHub Actions via OIDC |

The preview S3 bucket (`adamdaniel-ai-previews`) is **not** CFN-managed — it was created outside the stack. The CloudFront origin references it by name.

## Deployment

```bash
# Standard deploy (auto-detects Route53 hosted zone)
bash infrastructure/bootstrap/deploy.sh

# If OIDC provider already exists in the account
CREATE_OIDC_PROVIDER=false bash infrastructure/bootstrap/deploy.sh

# Override hosted zone manually
HOSTED_ZONE_ID=Z02339993KRS1LII3B24S bash infrastructure/bootstrap/deploy.sh
```

The script:
1. Auto-detects the Route53 hosted zone for `adamdaniel.ai`
2. Runs `aws cloudformation deploy` with `CAPABILITY_NAMED_IAM`
3. Prints outputs including Role ARN and CloudFront distribution ID

## Stack outputs → GitHub secrets

After deploying, add these as GitHub Actions secrets (repo → Settings → Secrets → Actions):

| Output key | Secret name |
|---|---|
| `RoleArn` | `AWS_ROLE_ARN` |
| `PreviewDistributionId` | `PREVIEW_CLOUDFRONT_ID` |

## Common errors and fixes

### `ResourceExistenceCheck` / changeset FAILED
The `AWS::Route53::HostedZone::Id` parameter type triggers early validation. The `HostedZoneId` parameter is typed as `String` with `AllowedPattern: "^Z[A-Z0-9]+$"` to avoid this.

If this error reappears: check whether a resource being added already exists outside the stack. Delete failed changesets before re-running:
```bash
aws cloudformation list-change-sets --stack-name adamdaniel-ai-bootstrap \
  --query 'Summaries[?Status==`FAILED`].ChangeSetName' --output text | \
  xargs -I{} aws cloudformation delete-change-set \
    --stack-name adamdaniel-ai-bootstrap --change-set-name {}
```

### Certificate error on CloudFront: "SSL certificate doesn't exist"
CloudFormation rolled back and deleted the ACM cert. The cert has `DeletionPolicy: Retain` to prevent this. If it happens:
1. Check `aws acm list-certificates --region us-east-1` for the cert status
2. Re-run the deploy — the cert will be re-created and DNS-validated via Route53
3. CloudFront creation waits on `DependsOn: PreviewCertificate`

### `NoSuchOriginRequestPolicy`
The `CORS-S3Origin` managed origin request policy doesn't exist in all accounts. It was removed from the template — S3 website custom origins don't need it.

### Stack in `UPDATE_ROLLBACK_COMPLETE`
Safe to re-run `deploy.sh` — CloudFormation will create a new changeset.

## IAM role permissions (scope)

All policies are scoped to `adamdaniel-ai-*` prefixed resources:
- **S3**: get/put/delete objects, list — artifacts and preview buckets only
- **CloudFormation**: full stack management on `adamdaniel-ai-*` stacks
- **CloudFront**: all distribution operations (global resource, wildcard)
- **ACM**: request/describe/delete certificates (global resource, wildcard)
- **Route53**: change/list records in any hosted zone
- **IAM**: create/manage roles named `adamdaniel-ai-*`
- **Lambda**: all operations on functions named `adamdaniel-ai-*`
- **API Gateway**: manage APIs and tags
- **CloudWatch Logs**: manage log groups for `adamdaniel-ai-*` Lambda functions

## Template location

`infrastructure/bootstrap/template.yaml` — vanilla CloudFormation (no SAM transform).
`infrastructure/bootstrap/deploy.sh` — idempotent deploy script.

## Sibling stack: CloudWatch RUM

A separate CloudFormation stack `adamdaniel-ai-rum` provisions Amazon CloudWatch RUM (real-user monitoring — Core Web Vitals, JS errors, page-load timings). Independent of the bootstrap stack so you can deploy/redeploy/teardown analytics without touching the deploy pipeline. See [`ANALYTICS_SETUP.md`](../../../ANALYTICS_SETUP.md) for the deploy + config-wiring steps; the script is `infrastructure/rum/deploy.sh`.
