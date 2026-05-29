# Infrastructure

Parameterized CloudFormation for a platform site, deployed once per site into
the shared AWS account (one account, many domains). Every site identity value
is a stack parameter — nothing is hardcoded to a specific domain.

## Stacks

| Dir | Stack | What it creates |
|---|---|---|
| `bootstrap/` | `<prefix>-bootstrap` | OIDC provider + GitHub Actions IAM role, S3 buckets (artifacts/preview/production), ACM certs, the preview + production CloudFront distributions, the **preview-router** + **location-fixer** CloudFront Functions, and Route53 records. |
| `rum/` | `<prefix>-rum` | CloudWatch RUM app monitor + Cognito guest identity pool. |
| `../oauth-proxy/` | `<prefix>-oauth-proxy` | Lambda + API Gateway implementing the Decap CMS GitHub OAuth handshake (SAM). |

## Key parameterization

- **`ResourcePrefix`** (bootstrap): lowercase prefix (apex with dots→hyphens, e.g.
  `example-com`) that names the IAM role and scopes the CloudFormation / Lambda /
  Logs ARNs the role may touch.
- **`ProductionDomainName`** (the apex) is `!Sub`-injected into the two CloudFront
  Functions at deploy time — they match preview hosts (`preview-pr<N>.<apex>`,
  `preview-cms-<slug>.<apex>`) via string ops, since CloudFront Functions can't
  read stack params at runtime.
- **oauth-proxy `FunctionName`** is a parameter (keep unique per site).

## Deploying

```bash
cp infrastructure/site-params.example.env infrastructure/site-params.env
# edit site-params.env
set -a; source infrastructure/site-params.env; set +a

bash infrastructure/bootstrap/deploy.sh     # once per account+site
bash oauth-proxy/deploy.sh                   # needs GITHUB_CLIENT_ID/SECRET
bash infrastructure/rum/deploy.sh            # optional analytics
```

Copy the stack outputs (`RoleArn` → `AWS_ROLE_ARN` secret; CloudFront ids;
RUM `AppMonitorId`/`IdentityPoolId` → `_config.yml`) as printed by each script.
