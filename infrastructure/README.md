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
- **`AdminDomainName`** (bootstrap, optional, default empty = off) puts the
  editor on its own host, e.g. `admin.<apex>`: a separate CloudFront
  distribution, certificate and DNS record serve only `/admin/` from the
  production bucket's REST endpoint (the **admin-site** function), with a
  script-free page for every miss, and the **admin-redirect** function on the
  production distribution sends `/admin` there. Opt-in runbook:
  `docs/ADMIN-AUTH-SECURITY.md`.
- **Security headers** (bootstrap, #515): both distributions attach
  `<prefix>-baseline-headers` (HSTS, `nosniff`, `Referrer-Policy`,
  `frame-ancestors 'self'`), and an `/admin/*` behavior attaches
  `<prefix>-admin-headers`, which adds a Content-Security-Policy.
  `AdminCspMode` (`ADMIN_CSP_MODE`, default `report-only`), `HstsMaxAgeSeconds`
  (`HSTS_MAX_AGE_SECONDS`, default one year) and `HstsScope` (`HSTS_SCOPE`,
  default `this-host-only`) tune them; the rollout runbook is in
  `docs/ADMIN-AUTH-SECURITY.md`. An account holds at most 20 custom response
  headers policies, two per site.

## Deploying

```bash
cp infrastructure/site-params.example.env infrastructure/site-params.env
# edit site-params.env
set -a; source infrastructure/site-params.env; set +a

STACK_NAME= bash infrastructure/bootstrap/deploy.sh   # see "The STACK_NAME collision"
bash oauth-proxy/deploy.sh                   # first deploy needs GITHUB_CLIENT_ID/SECRET
bash infrastructure/rum/deploy.sh            # optional analytics
```

### What `bootstrap/deploy.sh` checks before it changes anything

- **Template size.** `bootstrap/template.yaml` is over the AWS CLI's
  51,200-byte limit for a template sent inline, because of its comments. The
  script deploys a minified copy made by `bootstrap/minify-template.rb` (Ruby's
  standard-library YAML parser: comments and layout go, every tag, value and
  block scalar stays, and the script refuses if the copy parses to anything
  else). It stops before any AWS call if the copy is still over 51,200 bytes;
  `e2e/bootstrap-template-minify.test.js` goes red above 48,000 so growth is
  noticed first. Needs Ruby and `python3` on the workstation.
- **Destructive changes.** It creates a change set instead of deploying
  directly, prints one line per resource action, for example

  ```
  [INFO]  Change set for <prefix>-bootstrap:
    Modify   ProductionDistribution (AWS::CloudFront::Distribution) replacement=False
    Remove   ProductionDnsRecord (AWS::Route53::RecordSet)  <- DESTRUCTIVE
  [ERROR] Refusing to execute: the change set above removes or replaces resources ...
  ```

  and refuses to execute when any resource would be removed or replaced
  (`Replacement` `True` or `Conditional`), leaving the change set for review.
  Re-run with `ALLOW_DESTRUCTIVE_CHANGES=1` only when that is the intent.
  Otherwise it executes the change set and waits for the stack. An empty change
  set is a success. Every parameter is passed from the environment on every
  run, so the usual cause of a refusal is a missing setting: a live apex
  without `CREATE_APEX_DNS_RECORDS=true` (removes the apex and `www` records),
  a site with an admin host but no `ADMIN_DOMAIN` (removes it), or the wrong
  `STACK_NAME` (below).

### The STACK_NAME collision

`site-params.env` exports `STACK_NAME` for the **OAuth proxy** stack, because
`oauth-proxy/deploy.sh` requires it. `bootstrap/deploy.sh` also honors
`STACK_NAME` (default `<prefix>-bootstrap`), so after sourcing the file it
would aim the bootstrap template at the proxy stack: on a proxy stack that
exists, the change set removes every proxy resource and the guard refuses; on
a new site, it would create the bootstrap stack under the proxy's name. The
bootstrap script must not inherit that name. From a platform checkout, empty it
for the one command:

```bash
set -a; source infrastructure/site-params.env; set +a
STACK_NAME= bash infrastructure/bootstrap/deploy.sh   # empty = <prefix>-bootstrap
```

A consumer's delegating wrapper sources `site-params.env` itself, after the
command line, so `STACK_NAME=` in front of the wrapper does not help. Run the
platform script directly instead, from a checkout at `platform.lock`'s
`platform_ref`:

```bash
git clone --quiet --depth 1 --branch <platform_ref> \
  https://github.com/Adam-S-Daniel/cms-platform.git .cms-platform
set -a; source infrastructure/site-params.env; set +a
STACK_NAME= bash .cms-platform/infrastructure/bootstrap/deploy.sh
```

A later `oauth-proxy/deploy.sh` with both credentials empty keeps the stack's
live ones ([docs/ADMIN-AUTH-SECURITY.md](../docs/ADMIN-AUTH-SECURITY.md),
"Deploying without touching the credentials").

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

The OAuth wrapper adopts the platform default scope **`repo,read:user,workflow`**.
⚠️ If a redeploy **widens** the scope your live GitHub OAuth App was authorized
with, the OAuth App owner must **manually re-consent** (re-authorize the app)
once — GitHub requires that human step; it can't be automated.
