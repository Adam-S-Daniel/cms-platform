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
  `AdminCspMode` (`ADMIN_CSP_MODE`; unset keeps the deployed stack's value,
  and only a new stack or one without the parameter gets `report-only`; an
  explicit `enforce` or `report-only` always wins), `HstsMaxAgeSeconds`
  (`HSTS_MAX_AGE_SECONDS`, default one year) and `HstsScope` (`HSTS_SCOPE`,
  default `this-host-only`) tune them; the rollout runbook is in
  `docs/ADMIN-AUTH-SECURITY.md`. An account holds at most 20 custom response
  headers policies, two per site.

## Deploying

```bash
cp infrastructure/site-params.example.env infrastructure/site-params.env
# edit site-params.env
set -a; source infrastructure/site-params.env; set +a

bash infrastructure/bootstrap/deploy.sh      # stack <prefix>-bootstrap; see "The STACK_NAME collision"
#   first bootstrap of a site only: ALLOW_STACK_CREATE=1 bash infrastructure/bootstrap/deploy.sh
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
  It fails closed: an action it does not recognize as a safe `Add`, `Modify` or
  `Import` counts as destructive, and a change set it cannot read in full is
  refused even with `ALLOW_DESTRUCTIVE_CHANGES=1`.
  Re-run with `ALLOW_DESTRUCTIVE_CHANGES=1` only when that is the intent.
  Otherwise it executes the change set and waits for the stack. An empty change
  set is a success. Every parameter is passed from the environment on every
  run, so the usual cause of a refusal is a missing setting: a live apex
  without `CREATE_APEX_DNS_RECORDS=true` (removes the apex and `www` records)
  or a site with an admin host but no `ADMIN_DOMAIN` (removes it).
- **Creating a stack.** A change set that would create the stack (it does not
  exist yet) is all `Add` actions, so the guard above would pass a mistyped
  stack name. The script refuses to execute it unless `ALLOW_STACK_CREATE=1`
  (any other value refuses), names the stack, says a typo is the usual cause,
  and leaves the change set for review. Set the flag only for a site's first
  bootstrap; an update of an existing stack needs no flag.
- **A failed change set.** If the change set cannot be created (the
  `aws cloudformation deploy` call), the script prints a fixed message instead
  of the CLI's: it names the stack and the likely causes and gives the
  read-only `describe-stacks` command to run by hand. A stack in
  `ROLLBACK_COMPLETE`, `CREATE_FAILED` or `UPDATE_ROLLBACK_FAILED` gets a
  specific message when the CLI's wording is recognized. That is the only
  fixed-message path: errors from the other AWS CLI calls (the Route53 lookup,
  `describe-change-set`, `describe-stacks`, `execute-change-set`, `wait`) are
  shown as the CLI prints them and may include the stack ARN, which carries the
  account id, so do not paste them into a public issue.
- **Stack status.** Before executing, it reads the stack's status and goes on
  only from `REVIEW_IN_PROGRESS` (a new stack, which needs
  `ALLOW_STACK_CREATE=1`) or a status from which CloudFormation executes an
  update (`CREATE_COMPLETE`, `UPDATE_COMPLETE`, `UPDATE_ROLLBACK_COMPLETE`,
  `IMPORT_COMPLETE`, `IMPORT_ROLLBACK_COMPLETE`). Any other status, or one it
  cannot read, is refused and the change set left for review.

### The STACK_NAME collision

`site-params.env` exports `STACK_NAME` for the **OAuth proxy** stack, because
`oauth-proxy/deploy.sh` requires it. The bootstrap stack therefore has its own
variable, **`BOOTSTRAP_STACK_NAME`** (default `<prefix>-bootstrap`), and
`bootstrap/deploy.sh` never takes its stack name from a `STACK_NAME` that
`site-params.env` set. Before any AWS call it:

- reads the `STACK_NAME` in `site-params.env` (the file named by
  `SITE_PARAMS_FILE`, else `./infrastructure/site-params.env` under the
  current directory), in a child shell that prints nothing from the file;
- ignores an inherited `STACK_NAME` equal to that value;
- accepts a `STACK_NAME` equal to `<prefix>-bootstrap`, with a warning, so an
  older `STACK_NAME=<prefix>-bootstrap` command still targets the same stack;
- stops on any other `STACK_NAME` and names `BOOTSTRAP_STACK_NAME`, rather than
  guess which stack was meant;
- refuses to run if the resolved bootstrap stack name equals the
  `STACK_NAME` in `site-params.env`.

This matters most on a **new** site: a change set that would create the
bootstrap stack under the proxy's name contains only `Add` actions, so the
destructive-change guard could not catch it.

One case is left that this check cannot see: an explicit
`BOOTSTRAP_STACK_NAME` equal to the proxy's name when `site-params.env` is
absent or has no `STACK_NAME` line. That run is still stopped: if no such stack
exists, creating it needs `ALLOW_STACK_CREATE=1`; if the proxy stack exists,
its change set removes every proxy resource and the destructive-change guard
refuses it.

A consumer's delegating wrapper sources `site-params.env` itself, then puts
`STACK_NAME` back to what it was before (unset, or the caller's value), and
passes the file's path on as `SITE_PARAMS_FILE`. So the wrapper is safe to run
on its own or after the file was sourced in the shell:

```bash
bash infrastructure/bootstrap/deploy.sh                                  # <prefix>-bootstrap
BOOTSTRAP_STACK_NAME=<name> bash infrastructure/bootstrap/deploy.sh      # a non-default name
```

From a platform checkout, run the same commands after sourcing the site's
`site-params.env`, from the site's root (so the script finds the file) or with
`SITE_PARAMS_FILE` set. `STACK_NAME= bash ...` still works and means the
default.

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
