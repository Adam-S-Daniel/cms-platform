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

## Consumer sites delegate (they don't vendor templates)

A scaffolded site (`npx github:Adam-S-Daniel/cms-platform`) does **not** copy the
CloudFormation templates or the OAuth-proxy `lambda.py`/`template.yaml`. Instead it
commits two thin **delegating wrappers** (emitted from
`infrastructure/bootstrap/deploy.sh.delegating` and
`oauth-proxy/deploy.sh.delegating`, locked by
`e2e/scaffold-deploy-delegators.test.js`):

```
infrastructure/bootstrap/deploy.sh   # delegating wrapper
oauth-proxy/deploy.sh                # delegating wrapper
```

Each wrapper reads `platform_repo` / `platform_ref` from `platform.lock`, checks
the platform out at that ref into `.cms-platform/` (a gitignored dot-dir, the same
pattern the reusable-workflow callers use), sources
`infrastructure/site-params.env` for the site identity + secrets, then `exec`s the
platform's real `deploy.sh` — so the parameterized template + lambda are the single
source of truth and a platform fix flows to every consumer on the next
`platform_ref` bump (no fork to keep in sync). The site runs them exactly as above
(`bash oauth-proxy/deploy.sh`), no platform checkout needed.

The OAuth wrapper adopts the platform default scope **`repo,user,workflow`**.
⚠️ If a redeploy **widens** the scope your live GitHub OAuth App was authorized
with, the OAuth App owner must **manually re-consent** (re-authorize the app)
once — GitHub requires that human step; it can't be automated.
