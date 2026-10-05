# Admin sign-in and token security

How an editor's GitHub token is obtained, who checks what along the way, how to
tell which OAuth proxy a site is really running, and what was evaluated and
deliberately left for later. Read it before touching `oauth-proxy/`, the sign-in
handler in `theme/admin/reviews/*.html`, or the Decap `<script>` tag in
`theme/admin/index*.html`.

## The flow

1. `/admin` (Decap) or a `/admin/reviews/` dashboard opens a popup at
   `<cms.oauth_base_url>/prod/auth`.
2. The proxy (`oauth-proxy/lambda.py`, one Lambda + HTTP API per site) redirects
   the popup to GitHub's consent page.
3. GitHub sends the popup back to `/prod/callback?code=…&state=…`. The proxy
   exchanges the code for a token and answers with a small HTML page that holds
   it.
4. The page and its opener trade `postMessage`s: the page announces
   `authorizing:github`, the opener echoes it, the page replies with
   `authorization:github:success:{"token":…}`.
5. The opener keeps the token in `localStorage` — `decap-cms-user` (Decap's own
   key) or `gh_reviews_token` (the dashboards).

Two trust boundaries are crossed by messages anyone can forge: the redirect
back from GitHub (step 3) and the `postMessage` exchange (step 4). Every check
below exists because one of those was once taken on faith.

## Who verifies what

| Boundary | Check | Enforced in |
|---|---|---|
| `/auth` → GitHub → `/callback` | The proxy mints `state` itself, pins it to the browser in a `__Host-cms-oauth-state` cookie (`Secure; HttpOnly; SameSite=Lax`, 10 minutes, single use) and refuses a callback whose `state` does not match — before it contacts GitHub. A client-supplied `state` is ignored. | `handle_auth` / `handle_callback` |
| callback page → opener | The token is posted only to `window.opener`, only in reply to a message whose `source` is that opener, and only when the opener's origin matches `ALLOWED_ORIGINS`. | the script in `_success_page` |
| popup → Decap | Decap accepts the message only from `backend.base_url`'s origin. | Decap itself (`decap-cms-lib-auth`) |
| popup → dashboard | The handler accepts a message only when `e.origin` is the OAuth proxy's origin **and** `e.source` is the popup it opened, and replies to that origin, never to `e.origin`. | `theme/admin/reviews/index.html`, `health.html` |
| callback page itself | `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and a CSP that allows only the page's own nonce'd script and forbids framing. Values are embedded with `_js_literal`, which cannot close the `<script>` element. | `_html_response` |

`SameSite=Lax` is load-bearing: the return from github.com is a cross-site
top-level navigation, and `Strict` would drop the cookie on exactly that
request. The first `authorizing:github` message is sent with target `'*'` on
purpose — it carries nothing secret, and a popup cannot read a cross-origin
opener's origin; the reply is what gets checked.

Tests: `oauth-proxy/test_lambda.py` (the handler), and
`e2e/oauth-proxy-callback-page.test.js`, which **runs** the callback page's
script in `node:vm` and asserts which origins and windows receive the token —
string-matching the HTML proves nothing about that. The dashboards are covered
by `e2e/admin-reviews-auth.spec.js` in the consumer browser lanes.

## `ALLOWED_ORIGINS`

Comma-separated `https://` origins. `*` stands for one or more of `[a-z0-9-]`
**inside a single host label**, and only **at or beneath the site's own
domain**, `APEX_DOMAIN` (the stack's `SiteApex` parameter, the Lambda's
`SITE_APEX`), so it can name a site's per-PR preview hosts and nothing wider:

```bash
export APEX_DOMAIN="<apex>"   # e.g. example.com; an older site-params.env may lack it
export ALLOWED_ORIGINS="https://<apex>,https://preview-*.<apex>"
```

- The preview entry is what lets an editor sign in on `preview-prN.<apex>` and
  `preview-cms-<slug>.<apex>`. Without it an editor on a preview admin
  finishes GitHub's consent screen and then waits on a popup that never hands
  the token back. `deploy.sh` warns when neither `https://preview-*.<apex>`
  nor `https://*.<apex>` is listed. A site that does not want preview sign-in
  sets `PREVIEW_SIGN_IN=disabled`, which replaces the warning with a line
  saying so; `deploy.sh` refuses `disabled` next to a preview entry, and any
  value other than `enabled` (the default) or `disabled`.
- **Why the apex bounds the wildcard
  ([#535](https://github.com/Adam-S-Daniel/cms-platform/issues/535)).** The
  first rule refused `*` only in the last two labels. That is not where a
  registrable domain ends: `https://*.co.uk` and `https://*.github.io` both
  passed, and each spans sites registered by strangers, any of which could
  open the sign-in popup and receive an editor's token. Which labels end a
  registrable domain is the [Public Suffix List](https://publicsuffix.org/)'s
  knowledge, and neither the Lambda nor `deploy.sh` carries a copy: a
  partial list fails open for every suffix it misses, and a full one is a
  dependency that goes stale. Instead the site declares its own domain, and
  the labels after the last label holding a `*` must be that domain or a name
  under it. `APEX_DOMAIN` is the domain whose Route 53 zone the bootstrap
  stack serves, so it cannot be `co.uk` or `github.io` for a working site.
  Nothing needs maintaining; the cost is that a wildcard over a domain the
  site does not use as `APEX_DOMAIN` is refused, and must be listed as
  literal origins instead.
- **A `site-params.env` that predates this bound may not carry `APEX_DOMAIN`.**
  Add `export APEX_DOMAIN="<the site's apex, e.g. example.com>"` to it before
  redeploying; `deploy.sh` stops before any AWS call, and names the file and
  the line to add, when a `*` entry has no apex. It does not guess the apex
  from `ALLOWED_ORIGINS`, because that would bound the list by itself.
- It **fails closed**: with `APEX_DOMAIN` unset, or not a plain domain of two
  or more labels, `deploy.sh` refuses every `*` entry, and a Lambda whose
  `SITE_APEX` is empty or malformed drops them (literal origins still work).
  Lookalikes are refused too: `https://*<apex>` (the `*` would absorb
  `evil<apex>`), `https://preview-*.not<apex>`, and
  `https://preview-*.<apex>.example.net`.
- `www.<apex>` serves the same `/admin` on the production distribution but is a
  different origin; list it only if editors really sign in there.
- A site that serves its editor from its own origin (below) lists that origin
  **instead of** the apex: `https://admin.<apex>,https://preview-*.<apex>`.
  Leaving the apex in lets a script on any public page open the sign-in popup
  itself and, for an editor who has already authorized the app (GitHub then
  skips the consent screen), receive a token.
- A bare `*`, an `http://` origin, or an entry with a path is invalid.
  `deploy.sh` refuses to deploy a list holding any invalid entry. The Lambda
  applies the same grammar and drops an invalid entry (logging it) rather than
  widening anything; one that ends up with no valid entry answers 500 instead
  of signing anyone in. `e2e/oauth-proxy-deploy-credentials.test.js` runs one
  table of entries through both validators and requires the same verdict.
- The API has no CORS configuration: nothing fetches it cross-origin, and the
  Lambda is the one place the allowlist is enforced.

## Outside contributors and previews ([#536](https://github.com/Adam-S-Daniel/cms-platform/issues/536))

**Listing `https://preview-*.<apex>` trusts every preview's JavaScript with the
editor's token.** An editor who signs in on a preview hands the token to the
page, and the page is built from the PR's code. The token's scopes are
`repo,read:user,workflow`, so that JavaScript can do anything the editor can:
push to any branch, edit any workflow file, and merge where the editor may.
`PREVIEW_SIGN_IN=disabled` (above) is the way to withhold that trust.

**The rule: a preview for an outside contributor's PR never runs the PR's code
with repository secrets.** Only someone who can push a branch to the site repo
can get code onto a preview, so granting write access is the trust decision.
How each kind of PR reaches the preview workflow (`deploy-preview.yml`, called
from the site's thin caller on `pull_request`):

| PR from | What runs | Why it cannot deploy a preview, or why it may |
|---|---|---|
| A fork (outside contributor) | Nothing until a maintainer approves the run (`approval_policy: all_external_contributors` in `repo-settings.yml`, all three repos). Approved, the PR's code builds. | GitHub gives a fork's `pull_request` run a read-only `GITHUB_TOKEN` and no repository secrets. The deploy role's ARN (`AWS_ROLE_ARN`) is itself a secret, so the step that assumes the AWS role has no role to assume, and nothing reaches the preview bucket. Approving the run lets it proceed; it does not grant secrets. |
| Dependabot | Nothing: the deploy and teardown jobs skip `dependabot[bot]`. | Dependabot runs get only Dependabot secrets, and the preview is for a human reviewer. |
| A branch in the site repo | The full build and deploy, with the role and `pull-requests: write`. | The author can already push to the repo and edit its workflows, so their code is trusted by the act of granting write access. Decap's `cms/*` branches are this case: they are pushed with the editor's own token. |

A fork's PR can edit the thin caller itself, because a `pull_request` run uses
the workflow files from the PR's merge commit. That is why the protection has to
come from GitHub withholding secrets on the `pull_request` trigger. (Fork PRs
get the same treatment on `pull_request_review` and
`pull_request_review_comment`.) The triggers that do NOT withhold secrets but
can still be fired by someone the repo never trusted are the privileged ones.
None of them may bring untrusted code or data into a run that holds secrets:

- **`pull_request_target`** runs the base repo's workflow with its secrets and
  a write token for a fork's PR. Checking out the PR's head there runs fork
  code with both. No workflow here or in the templates uses it, and the lint
  bans it outright.
- **`workflow_run`** also runs in the base repo's context, even when a fork's
  run triggered it. `auto-resolve-newline-conflict.yml` is the one user: its
  caller passes only the PR *number*, its token is read-only, it checks out
  only the platform's own scripts, and the resolver skips any PR whose head
  repo is not the base repo.
- **`issue_comment`, `issues`, `discussion` and `discussion_comment`** run in
  the base repo's context too, and any GitHub user can fire them on a public
  repo. A "comment `/deploy` to preview" workflow that checks out
  `refs/pull/<issue number>/head` is the classic pwn request. No workflow here
  uses these triggers. **`fork`** and **`watch`** (starring) can also be fired
  by anyone. They carry no code, but the run still holds secrets and a write
  token, so they get the same rules.

**What enforces it.** `e2e/contributor-trust-boundary-lint.test.js` (platform
tree and `examples/site` templates, in self-CI) and
`e2e/consumer-contributor-trust-boundary-lint.test.js` (a consumer's real
callers, on the consumer's e2e lane) run the rules in
`e2e/contributor-trust-boundary-rules.js`. Each reusable is judged under the
triggers its callers give it, because pin-consistency's caller parity
deliberately ignores `on:` and a consumer could otherwise move its preview
caller to `pull_request_target` with every check green. The rules:
`pull_request_target` is banned; a workflow a contributor can reach declares a
`permissions:` map and nothing is `write-all`. A run on any privileged trigger
above has no `write` token scope and checks out no PR or run head (in any
spelling, including `refs/pull/`). It passes no head data to a reusable. It
downloads no artifacts: no action whose name contains `download-artifact`, in
any case. github-script bodies are read with acorn, destructured names
included, and a `request()` route that is not a plain literal is denied. No
job a contributor can reach uses `secrets: inherit`; and a checkout of the PR
head pins `github.event.pull_request.head.sha`, never a branch name, which
would resolve to whatever was pushed after a run was approved. It also asserts
that `deploy-preview.yml` and every other reusable that checks out the PR head
are called, and only from `pull_request`, and that `repo-settings.yml` keeps
`approval_policy: all_external_contributors` for every repo.
`${{ github.event.* }}` in a `run:` body is the injection lint's job
([#261](https://github.com/Adam-S-Daniel/cms-platform/issues/261)).

**What it cannot see.** Local composite actions (`uses: ./.github/actions/...`)
are not expanded, so an artifact download inside a local wrapper may be invisible.
Shell is not parsed, so a `run:` body that fetches
`pull/N/head` or runs `gh run download` under a privileged trigger is
invisible, as is a head ref laundered through a step output or `env:` before
it reaches `ref:`. That is why `pull_request_target` is banned rather than
pattern-checked. Both consumers' callers (adamdaniel.ai at `c639f2e`,
jodidaniel.com at `e88dfe7`, 2026-10-04) were run through the rules against
the platform's current reusables with no finding.

## One sign-in at a time, and the proxy's cookie

[#537](https://github.com/Adam-S-Daniel/cms-platform/issues/537). The proxy
keeps the `state` of a sign-in in progress in one cookie,
`__Host-cms-oauth-state`, on its own host (`<api-id>.execute-api.<region>.amazonaws.com`).
Two consequences follow, and neither is worked around: the state check is what
stops a forged callback, so it stays.

**Only one sign-in can be in progress per browser cookie context** (a browser
profile; a private window has its own). `/auth` overwrites the cookie, so a
second sign-in started before the first returns replaces the first one's
`state`, and every callback clears the cookie, success or not. So:

- start a second sign-in, finish the first: the first fails, and the cookie it
  clears was the second's, so the second fails too;
- finish the second first: it succeeds, and the first then fails.

Every sign-in through the same proxy counts: `/admin`, `/admin/reviews/` and
the preview admins of one site all share its proxy host, so a sign-in on a
preview admin started during one on production collides with it. Two sites
have two proxies and do not collide. The failure page reads **"This sign-in could not be
verified. Close this window and start again."**, with HTTP 400, before the
proxy contacts GitHub, and the Lambda logs
`Callback state check failed (state param present=…, cookie present=…)`
without either value. **To recover: close every sign-in popup, then start one
sign-in and finish it before starting another.**

**The browser must keep the proxy host's cookies.** `/auth` sets the cookie on
a top-level page: the popup is a window of its own, not a frame inside the
site. A browser that refuses cookies for that host returns from GitHub without
it, and the sign-in fails with the same message (the log then says
`cookie present=False`). Blocking *third-party* cookies is not the same thing
and does not break it. Measured on 2026-10-03 with Playwright's builds over
loopback (stand-in hosts for the site, the proxy and GitHub; a cookie set in a
cross-site iframe on the site's page was the control showing each setting was
live):

| Browser setting | Sign-in |
|---|---|
| Chromium 153: default; "Block third-party cookies"; cookies blocked for the site only | works |
| Chromium 153: all cookies blocked (the default cookie setting set to block); cookies blocked for the proxy host | fails: cookie missing |
| Firefox 155: Standard (Total Cookie Protection); block cross-site tracking cookies; block third-party cookies; accept all | works |
| Firefox 155: block all cookies | fails: cookie missing |

Not measured: Safari and other WebKit browsers, extensions that strip
`Set-Cookie`, and enterprise cookie policies; a rule that blocks
`amazonaws.com` or `execute-api` hosts behaves like blocking the proxy host.
An editor in such a browser allows cookies for the proxy host (its address is
the popup's URL, and `cms.oauth_base_url` in `_config.yml`).

`oauth-proxy/test_lambda.py`'s `TestConcurrentSignIn` drives both orders, the
retry and a refused cookie through a cookie jar, with GitHub mocked.

## A release does not deploy the proxy

`platform-bump` moves a consumer's pins. It does not touch AWS. The Lambda only
changes when someone with that site's AWS credentials runs the deploy, so a
proxy fix can be merged, released and bumped everywhere while the old code
keeps signing people in. Each site's daily **OAuth proxy build probe**
(`oauth-proxy-build.yml`, below) goes red when that happens to `lambda.py`
([#518](https://github.com/Adam-S-Daniel/cms-platform/issues/518)).

After any release that changes `oauth-proxy/`, for each site:

```bash
# 1. the site's bump PR is merged, so platform.lock names the new release
cd ~/repos/<site> && git checkout main && git pull
# 2. infrastructure/site-params.env carries the ALLOWED_ORIGINS you intend
#    (with https://preview-*.<apex> unless PREVIEW_SIGN_IN=disabled), and
#    GITHUB_CLIENT_ID/SECRET empty to keep the live credentials (see below)
# 3. the same file carries APEX_DOMAIN, which any '*' entry needs. A file that
#    predates the apex bound may lack it: add
#      export APEX_DOMAIN="<the site's apex, e.g. example.com>"
#    before deploying, or deploy.sh stops before any AWS call
# 4. deploy (the wrapper checks the platform out at platform.lock's ref)
bash oauth-proxy/deploy.sh
```

`platform-bump` seeds the wrapper (and the bootstrap one) into a site that has
none. Until that bump lands, a site with no `oauth-proxy/deploy.sh` wrapper
deploys from a platform checkout at the release tag instead:

```bash
cd ~/repos/cms-platform && git fetch --tags && git checkout vX.Y.Z
( set -a; source ~/repos/<site>/infrastructure/site-params.env; set +a
  bash oauth-proxy/deploy.sh )
```

It is an in-place stack update: the API Gateway URL, `cms.oauth_base_url` and
the GitHub OAuth App's callback URL do not change. If the deploy **widens** the
scope the live proxy was requesting, each editor is asked to re-authorize the
app once. Then dispatch the site's `oauth-proxy-build` workflow and confirm it
says `current`.

### Deploying without touching the credentials

A `site-params.env` that still holds the example's `xxxx…` placeholders, or a
secret that has since been rotated, **overwrites the live secret** when its
credentials are deployed, and every sign-in then fails at the code exchange.
One consumer's local file held placeholders when v0.1.124 was deployed
(2026-10-02).

To change only the code, `AllowedOrigins` or the scope, **leave both
credentials unset and run `deploy.sh`**: empty the two lines in
`site-params.env` (`export GITHUB_CLIENT_ID=""`,
`export GITHUB_CLIENT_SECRET=""`) and deploy as above. `deploy.sh` then checks
that the stack exists and deploys without either credential parameter, and
CloudFormation keeps the stack's values: `sam deploy` sends every template
parameter it is not given as `UsePreviousValue` on an update. It prints
`keeping the stack's existing credentials`; with both set it prints
`setting credentials from the environment` instead. It never prints either
value. It stops before deploying when:

- either credential is a placeholder: all `x` as in the example file, or
  `your_client_id` / `your_client_secret`;
- either credential starts or ends with whitespace (a `" "` is not empty);
- only one of the two is set;
- both are unset and the stack does not exist yet: a new stack needs both;
- it cannot tell whether the stack exists (an expired session, no network).

**The careful path** stops at the change set so it can be read before
anything changes. It is the same deploy by hand, with the credentials left out
of `--parameter-overrides`:

```bash
cd ~/repos/cms-platform/oauth-proxy        # checked out at the release tag
sam build --template-file template.yaml --region us-east-1
sam deploy --template-file .aws-sam/build/template.yaml \
  --stack-name <prefix>-oauth-proxy --region us-east-1 \
  --capabilities CAPABILITY_IAM --resolve-s3 --no-execute-changeset \
  --parameter-overrides "AllowedOrigins=https://<apex>,https://preview-*.<apex>" \
    "SiteApex=<apex>" "GitHubScope=repo,read:user,workflow" \
    "FunctionName=<prefix>-oauth-proxy"
```

`--no-execute-changeset` stops at the change set, so it can be read first
(`aws cloudformation describe-change-set --change-set-name <arn>`):

- `OAuthHttpApi` and `OAuthProxyFunction` are `Modify` with `Replacement:
  False` — the API URL does not move;
- the function's `Environment` change is caused by `AllowedOrigins`,
  `SiteApex` and `GitHubScope` only. A `ParameterReference` naming
  `GitHubClientSecret` means the secret is about to change.

Then `aws cloudformation execute-change-set --change-set-name <arn>` and
`aws cloudformation wait stack-update-complete --stack-name <prefix>-oauth-proxy`.

To learn whether a local file's secret is the live one without printing
either, compare hashes: the deployed value is the function's
`GITHUB_CLIENT_SECRET` environment variable
(`aws lambda get-function-configuration`).

### Which proxy is a site running?

`/prod/health` reports the build. `release` is the tag (or commit) `deploy.sh`
deployed from, and `handler_sha256` is the sha256 of the deployed `lambda.py`,
computed by the Lambda from its own file:

```json
{"status": "ok", "service": "cms-oauth-proxy", "release": "vX.Y.Z", "handler_sha256": "<64 hex>"}
```

Compare the digest, not the release: most releases do not change `lambda.py`,
so two releases can serve the same handler. `scripts/probe-oauth-proxy-build.js`
does the comparison against the `lambda.py` of the release the site is pinned
to, credential-free, and the dictated caller `oauth-proxy-build.yml` runs it
daily.
It sees only `lambda.py`: a release that changes nothing but `template.yaml` or
`deploy.sh` (a route, a timeout, a parameter default) still needs the redeploy
above, and the probe keeps saying `current` until someone runs it.
A red run is a scheduled failure, so it lands on the site's `ci` tracking issue
through `scheduled-run-health`, which also notices the probe going quiet.

| Outcome | Exit | Meaning |
|---|---|---|
| `current` | 0 | the live handler is the pinned release's |
| `stale` | 1 | the live handler differs; the message names the live and pinned releases. Redeploy. |
| `predates` | 1 | no `handler_sha256`, or no health route at all: the proxy is older than build reporting. The message also says whether it has the sign-in `state` check, from the cookie marker below. Redeploy. |
| `unreachable` | 2 | the request failed; the build is unknown |
| `unexpected` | 2 | any other answer (a redirect, which is never followed; a non-JSON or oversized body; a malformed digest; a 404 from something that does not redirect `/prod/auth` to GitHub) |

To run it by hand from a site checkout:

```bash
ref=$(awk '$1=="platform_ref:" {print $2}' platform.lock)
git clone --quiet --depth 1 --branch "$ref" https://github.com/Adam-S-Daniel/cms-platform.git /path/to/scratch/cms-platform
base=$(ruby -ryaml -e 'puts YAML.load_file("_config.yml").dig("cms", "oauth_base_url")')
node /path/to/scratch/cms-platform/scripts/probe-oauth-proxy-build.js \
  --base-url "$base" --platform-dir /path/to/scratch/cms-platform --pinned-release "$ref"
```

The manual probe still works on any build, including one that predates the
health fields:

```bash
base=$(ruby -ryaml -e 'puts YAML.load_file("_config.yml").dig("cms", "oauth_base_url")')
curl -s -o /dev/null -D - "$base/prod/auth" | grep -i -E '^(set-cookie|location):'
curl -s "$base/prod/callback?code=x&state=y" | grep -o '<code>[^<]*</code>'
```

| Answer | Meaning |
|---|---|
| a `set-cookie: __Host-cms-oauth-state=…` line whose value equals `state=` in `location:`, and `This sign-in could not be verified.` from the second command | the hardened proxy is live |
| no `set-cookie` line, an empty `state=`, and `The code passed is incorrect or expired.` — the proxy took the code to GitHub without checking `state` | the proxy predates the `state` and origin checks — redeploy |

Read the page's message, not the status code: both builds answer the second
request with HTTP 400, one because the proxy refused it and the other because
GitHub did.

The origin check cannot be probed without completing a real sign-in; the cookie
is the marker, because both checks shipped in the same build. Finish with one
real sign-in on `/admin`, one on `/admin/reviews/`, and one on a preview admin
if the site lists the preview entry.

### Should CI deploy the proxy? Not yet (decided 2026-10-02)

[#518](https://github.com/Adam-S-Daniel/cms-platform/issues/518) asked whether
proxy deploys should run from CI with the site's deploy role instead of from a
workstation. **Decision: no, for now.** Deploys stay a manual step, and the
build probe makes a missed one visible within a day.

- **The role could, on paper.** The bootstrap stack's `<prefix>-github-actions`
  role already grants CloudFormation on `stack/<prefix>-*`, Lambda on
  `function:<prefix>-*`, IAM role management and `iam:PassRole` on
  `role/<prefix>-*`, API Gateway on `/apis/*`, and log groups under
  `/aws/lambda/<prefix>-*`: every service `deploy.sh` uses.
- **But not as the proxy is deployed today.** The proxy's `STACK_NAME` is set
  per site in `site-params.env`, independently of the bootstrap
  `ResourcePrefix`, and nothing makes the first start with the second; outside
  that prefix every call is denied. `deploy.sh` also defaults to
  `sam deploy --resolve-s3`, which creates SAM's own managed stack and bucket,
  outside the role entirely. A CI deploy needs both fixed first.
- **The secret need not reach CI.** An in-place update can keep the stack's
  current `GitHubClientSecret` (both live stacks were updated that way on
  2026-10-02), and `deploy.sh` does that when both credentials are unset
  (see "Deploying without touching the credentials").
- **It widens what a branch can do to sign-in.** The role trusts
  `repo:<owner>/<repo>:*`, so any workflow on any branch of the site repo can
  assume it. Adding the proxy deploy to that role puts the code that issues
  every editor's token one pushed workflow away. Deploying from CI should wait
  for a trust condition narrowed to an approved `environment:`, which is a
  bootstrap change and a per-site redeploy.
- **The cost of staying manual is now bounded.** The harm in #518 was that a
  stale proxy was invisible. With the probe red until someone redeploys, a
  release that changes `oauth-proxy/` is a known, tracked step.

Revisit when #516 settles whether the proxy stays an OAuth App proxy, or if
the probe shows deploys trailing releases by more than a release cycle.

## The token at rest

Once issued, the token sits in `localStorage`, readable by every script on the
origin, and it is an OAuth App token: scope `repo,user,workflow` (or
`repo,read:user,workflow` from a proxy deployed after #516), every repository
the editor can reach, no expiry. A script that should not be there
is therefore expensive. What was weighed:

| Measure | Status | Why |
|---|---|---|
| Subresource Integrity on the Decap bundle | **Shipped.** All three shells load `decap-cms` from unpkg with `integrity` + `crossorigin`; `e2e/admin-pin-invariant.test.js` locks it. | It is the only third-party script in the admin, and it runs with the token in reach. The browser now refuses a bundle whose bytes differ from the release that was reviewed. |
| Security headers | **In the template, not yet deployed** — [#515](https://github.com/Adam-S-Daniel/cms-platform/issues/515) | Both distributions send HSTS, `nosniff`, `Referrer-Policy` and same-origin framing once a site redeploys its bootstrap stack; `/admin/*` adds a CSP, Report-Only until `AdminCspMode=enforce`. Decap's `new Function` and the per-site inline scripts keep `script-src` loose; the gain is `connect-src`, `object-src`, `base-uri` and `frame-ancestors`. See [Security headers](#security-headers) below. |
| Narrower permissions | Evaluated, spike pending — [#516](https://github.com/Adam-S-Daniel/cms-platform/issues/516); `read:user` replaces `user` in the proxy's default scope | An OAuth App cannot be limited to one repository. The real narrowing is a GitHub App user token (site repo only, fine-grained, optionally expiring), which changes how every editor signs in. The source evaluation, the minimal permission set and the spike kit are in [GitHub App sign-in](#github-app-sign-in-516) below. |
| A separate origin for the editor | **Opt-in, per site** — [#517](https://github.com/Adam-S-Daniel/cms-platform/issues/517); off until a site follows the runbook below | Public pages share the origin, and so do their scripts. The CloudWatch RUM client is no longer fetched from AWS: the gem ships the exact release and pages load it from the site's own origin (rule below), which takes the RUM CDN out of the page but not the client out of the token's reach. Opted in, the editor is served by a distribution of its own that never returns a page with public-page script, and the apex only redirects to it. That closes public-page scripts' reach to the tokens once the old ones are revoked; content rendered inside the editor and the per-PR preview admins are not covered (see "What it closes, and what it does not"). |
| Dashboards keeping their own copy (`gh_reviews_token`) | Left as is | Decap's own `decap-cms-user` sits beside it on the same origin, so dropping or moving the second copy would not shrink what a script can read. |

## Serving the editor from its own origin (opt-in, #517)

Off by default: with the bootstrap stack's `AdminDomainName` empty, no admin
resource exists and the production distribution is exactly what it was. With
it set, `/admin/` and `/admin/reviews/` are served from `admin.<apex>` by a
**separate CloudFront distribution**, and the apex only redirects there.

| Request | Answer |
|---|---|
| `admin.<apex>/admin/…` (a clean path) | the same `admin/` objects from the production bucket; a path ending in `/` gets its `index.html` |
| `admin.<apex>/admin`, `admin.<apex>/admin/reviews` | 302 to the `/` form (the REST origin has no index document of its own) |
| `admin.<apex>/admin/…` with a `%`-escape, a `.`/`..` segment, a `//`, or any character outside `[A-Za-z0-9._-]` | bare 404 with no body; reaches neither S3 nor the apex |
| `admin.<apex>/` | 302 to `admin.<apex>/admin/` |
| `GET admin.<apex>/<anything else>` | 302 to the same path and query on `<apex>`; never reaches S3 |
| `HEAD admin.<apex>/<anything else>` | served (with the same `index.html` mapping): no body runs, and `slug-pin.js` probes `/blog/<slug>/` same-origin |
| a miss on `admin.<apex>` (S3 403 or 404) | `/admin/not-found.html` as a 404: plain HTML from the gem, no script, no style, no external resource |
| `<apex>/admin…`, `www.<apex>/admin…` | 302 to the same path and query on `admin.<apex>` (the browser keeps the `#/…` fragment) |

Why a distribution of its own, and not an alias on the production one (the
first version of this change): a distribution's `CustomErrorResponses` cannot
vary by host, and viewer functions do not run for the error-page fetch, so a
missing `admin.<apex>/admin/<x>` was answered with the public `/404.html`, RUM
client included, on the admin origin. Any public-page script could open such a
URL in a same-site iframe or a popup and read the tokens through it.

How the admin distribution keeps that from happening:

- **Origin: the production bucket's REST endpoint**
  (`ProductionBucket.RegionalDomainName`), read anonymously. The bucket is
  already world-readable through `ProductionBucketPolicy`, so this needs no
  origin access control and no change to that retained policy; it reads
  nothing the website endpoint does not already serve to anyone. What it
  changes is the error path: the REST endpoint has no website `ErrorDocument`,
  so a missing key is S3's own XML error (`403 AccessDenied` for an anonymous
  reader without `s3:ListBucket`), never an HTML page from the site.
- **Errors**: 403 and 404 map to `/admin/not-found.html` with status 404.
  `theme/spec/admin_not_found_page_test.rb` parses that page and fails on any
  element or attribute outside a short allowlist. If the page is itself
  missing (a site that deployed the stack before bumping the gem), CloudFront
  returns "the status code that CloudFront received from the origin that
  contains the custom error pages"
  ([AWS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/GeneratingCustomErrorResponses.html))
  — here S3's 403 for the page. That the body is then S3's XML error is
  inferred (it is all the REST endpoint returns for a missing key), not stated
  by AWS and not observed live.
- **One cache behavior**, guarded by the `admin-site` viewer-request function
  (`AdminSiteFunction`); `GET`/`HEAD` only; `CachingDisabled`, because the
  site's deploy invalidates only the production distribution; no origin
  request policy, so no viewer query string reaches S3.
- **Paths**: CloudFront normalizes a path (dot segments, `//`) only to choose
  a cache behavior and then "sends the raw URI path to the origin"
  ([AWS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#path-normalization)).
  AWS does not say whether the function sees the raw or the normalized path,
  so the function assumes neither: it forwards only a path matching
  `/admin(/<segment>)*` where no segment starts with a dot, and sets the
  request's URI to the value it checked. Case variants (`/Admin/`) and a
  prefix that is not a segment (`/administrator`, `/admin.html`,
  `/admin%2f…`) are not `/admin/` and go to the apex like any public path. The
  function does not read the `Host` header: only `admin.<apex>` and the
  distribution's own `*.cloudfront.net` name reach it. A trailing-dot host
  (`admin.<apex>.`) is a different origin in the browser, holding no tokens
  and not in `ALLOWED_ORIGINS`; which distribution CloudFront picks for it was
  not tested.
- **Certificate and DNS**: its own ACM certificate, DNS-validated in the
  site's hosted zone in us-east-1 (the region CloudFront requires, and the
  region the bootstrap stack already deploys its certificates in), so opting
  in or out never touches `ProductionCertificate`; its own Route53 A-alias.
  `admin.<apex>` then exists as a name, so the `*.<apex>` wildcard record no
  longer answers for it, and CloudFront "sends the request to the distribution
  with the more specific name match"
  ([AWS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html#alternate-domain-names-restrictions)),
  so the preview distribution never serves the admin host.
- **Headers**: its one behavior attaches `<prefix>-admin-headers`, the same
  policy as the apex's `/admin/*` behavior (see [Security headers](#security-headers)):
  HSTS, `nosniff`, `frame-ancestors 'self'` and the admin CSP, Report-Only
  until `AdminCspMode=enforce`. Opting in drops none of them. `'self'` there
  is `admin.<apex>`; the apex and its subdomains are listed by name.

On the production distribution the only change is the `admin-redirect`
viewer-request function (`ApexAdminRedirectFunction`) on its default
behavior and on its `/admin/*` behavior (#515's headers behavior). Any cache behavior added there that can match `/admin` must carry
the same association; `e2e/admin-host-router.test.js` checks every behavior.

The site side: `cms.admin_origin` (injected as `window.CMS_ADMIN_ORIGIN`; on
that origin `site-hostname.js` and `live-url-derive.js` build public URLs and
"on `<host>`" copy from `url`), and `ALLOWED_ORIGINS`. Tests:
`e2e/admin-host-router.test.js` runs both functions (including that they never
bounce a request between the hosts) and checks the template's shape and that an
un-opted stack deploys exactly what it did before;
`theme/spec/admin_not_found_page_test.rb` checks the error page.

### What it closes, and what it does not

**Closed**, once the runbook below is finished (old tokens revoked, apex out of
`ALLOWED_ORIGINS`): a script running on a public page of the production site
(the RUM client, an HTML embed rendered on a published page, any include a
site adds) can no longer read an editor's token from storage, open the
sign-in popup and receive one, or get a page of its choosing rendered on the
admin origin.

**Not closed:**

- **Content rendered inside the editor.** Decap draws the markdown preview
  pane in a same-origin frame, and the platform leaves Decap's
  `sanitize_preview` at its default (`false`), so an HTML embed
  (`editor-component-html-embed.js`) with an event-handler attribute, such as
  an `<img onerror>`, runs in the admin origin when the entry is opened;
  `<script>` tags do not (they arrive through `innerHTML`). Anyone who can put
  content on a `cms/*` branch reaches every editor who opens it. Not verified
  in a browser here.
- **Per-PR preview admins are unchanged.** `preview-prN.<apex>` and
  `preview-cms-<slug>.<apex>` each serve their admin next to that build's
  public pages. Preview builds run with `JEKYLL_ENV=preview`, so they load no
  RUM client; but `/preview/` loads `marked` from unpkg with no integrity
  hash, and a draft's HTML embed is a real `<script>` on its rendered page. A
  token from a sign-in on a preview admin sits beside both. Drop the preview
  entry from `ALLOWED_ORIGINS` to refuse those sign-ins.
- **The admin objects are still in the production bucket under `admin/`.**
  The apex no longer serves them for `/admin` or `/admin/…`. A path that only
  looks like one to S3 (for example `/admin%2Findex.html`) is not matched by
  the redirect and goes to the website endpoint; whether S3 then decodes it
  and serves the shell on the apex was not tested. If it does, that copy can
  neither sign in (the apex is out of `ALLOWED_ORIGINS`) nor use the old
  tokens (revoked). The S3 website and REST endpoints serve the same objects
  on `amazonaws.com` origins, which hold no tokens.
- **Live Preview is hidden on the admin origin.** `/preview/` fills from a
  same-origin `BroadcastChannel`, and it stays on the public site: it is a
  public page that loads `marked` from unpkg without an integrity hash and,
  in production, the RUM client. Decap's own preview pane still works.
  Bringing the button back needs a cross-origin transport (`postMessage` to a
  window the editor opened), which is not built.
- **Framing and CSP need the bootstrap redeploy.** `frame-ancestors 'self'`
  and the admin CSP reach `admin.<apex>` only once the stack carrying #515 is
  deployed, and the CSP only reports until `AdminCspMode=enforce`; with its
  `'unsafe-inline'` and `'unsafe-eval'` it does not stop the preview-pane
  embed above.
- **Tokens issued before the cut-over.** They stay in the apex's
  `localStorage` (`decap-cms-user`, `gh_reviews_token`), readable by every
  apex script, and the editor on its new origin cannot clear another origin's
  storage. They are harmless only once revoked: step 7 of the runbook is not
  optional. A script-free clean-up on the apex (a `Clear-Site-Data: "storage"`
  header on the apex `/admin` redirect) was considered and not built: it
  cannot name the two keys, so it would wipe all of the apex's storage
  (including the RUM opt-out and the share row's remembered host) on every
  visit to an old `/admin` bookmark, and once the tokens are revoked there is
  nothing left for it to protect. An editor who wants the dead entries gone
  clears the apex's site data in the browser.
- **The e2e harness is unchanged.** Local lanes serve one origin, preview
  lanes drive preview admins, and the prod lanes go to `<apex>/admin/` and
  follow the 302: every spec seeds tokens with `page.addInitScript` (which
  runs on whatever origin the page lands on), and every `page.route` pattern
  is a host-agnostic glob. Admin-bundle parity fetches `<apex>/admin/…` with
  redirects followed, so it compares the same bytes. None of this has run
  against an opted-in site yet: the first prod loop after cut-over is the
  proof.

### Runbook, per site

Needs a release carrying this change, bumped into the site (`platform.lock`),
and deployed, so `admin/not-found.html` is in the production bucket before the
admin distribution exists. Run from the site repo with that site's AWS
credentials. Deploy the proxy as "Deploying without touching the credentials"
(above) describes, so a stale `site-params.env` cannot overwrite its secret.

```bash
# 0. The name is free (expect []), and the error page is live (expect 200)
aws route53 list-resource-record-sets --hosted-zone-id <zone-id> \
  --query "ResourceRecordSets[?Name=='admin.<apex>.']"
curl -s -o /dev/null -w '%{http_code}\n' "https://<apex>/admin/not-found.html"

# 1. Site PR: _config.yml gains, under cms:
#      admin_origin: https://admin.<apex>
#    Merge and let it deploy. It is inert until the host serves the admin.

# 2. Deploy the proxy accepting BOTH origins during the switch:
#      AllowedOrigins=https://<apex>,https://admin.<apex>,https://preview-*.<apex>

# 3. Add ADMIN_DOMAIN=admin.<apex> to infrastructure/site-params.env (every
#    later bootstrap redeploy needs it too, or the admin host is removed),
#    then redeploy the bootstrap stack the way docs/MEDIA-ARCHIVE.md step 3
#    does for that site: a live apex keeps CREATE_APEX_DNS_RECORDS=true (a
#    redeploy without it DELETES the apex records). The bootstrap stack is
#    BOOTSTRAP_STACK_NAME (default <prefix>-bootstrap), never site-params.env's
#    STACK_NAME, which names the proxy (infrastructure/README.md, "The
#    STACK_NAME collision"). Expect Add lines for the Admin* resources in the
#    printed change set; the script refuses a removal or a replacement. A new
#    certificate is validated and a new distribution deployed: allow several
#    minutes.
bash infrastructure/bootstrap/deploy.sh   # the site's delegating wrapper

# 4. Verify with GET (curl -I sends HEAD, which the admin host serves on purpose)
hdr() { curl -s -o /dev/null -D - "$1" | grep -i -E '^(HTTP|location|content-type)'; }
hdr "https://<apex>/admin/"                    # 302, location: https://admin.<apex>/admin/
hdr "https://www.<apex>/admin/reviews/?q=a%26b" # 302, location keeps ?q=a%26b as sent
hdr "https://admin.<apex>/admin/"              # 200, text/html
hdr "https://admin.<apex>/admin/reviews"       # 302, location: https://admin.<apex>/admin/reviews/
hdr "https://admin.<apex>/admin/nope.html"     # 404, text/html
curl -s "https://admin.<apex>/admin/nope.html" | grep -c '<script'   # 0
# a dot segment sent raw: 404 (or a 302 to the apex, if CloudFront hands the
# function the normalized path), never 200
curl -s -o /dev/null -w '%{http_code}\n' --path-as-is "https://admin.<apex>/admin/../404.html"
hdr "https://admin.<apex>/blog/"               # 302, location: https://<apex>/blog/
hdr "https://admin.<apex>/"                    # 302, location: https://admin.<apex>/admin/
curl -s "https://admin.<apex>/admin/" | grep -o 'window.CMS_ADMIN_ORIGIN="[^"]*"'
echo | openssl s_client -connect admin.<apex>:443 -servername admin.<apex> 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName    # admin.<apex> only

# 5. One real sign-in at https://admin.<apex>/admin/ and one at /admin/reviews/;
#    open a published post: "View page on site" names https://<apex>/...

# 6. Deploy the proxy again with the apex out of its list:
#      AllowedOrigins=https://admin.<apex>,https://preview-*.<apex>
```

7. **Revoke every token issued before the cut-over.** On the site's GitHub
   OAuth App (Settings → Developer settings → OAuth Apps → the app, or the
   owning organization's settings for an org-owned app) use **Revoke all user
   tokens**. Every editor then signs in once on `admin.<apex>`; there is
   nothing to carry over, since `localStorage` belongs to an origin. This
   signs out every session of that app, preview admins included, and anything
   else using a token the app issued. If an app owner is not available, each
   editor revokes the app at `https://github.com/settings/applications`
   instead, which covers only that editor. Until one of these is done, the
   old tokens are valid (OAuth App tokens do not expire) and readable by apex
   scripts.

If step 3 fails with "One or more aliases specified for the distribution
includes an incorrectly configured DNS record that points to another
CloudFront distribution", CloudFront resolved `admin.<apex>` through the
`*.<apex>` wildcard to the preview distribution
([AWS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/troubleshooting-distributions.html#troubleshoot-incorrectly-configured-DNS-record-error)).
The stack rolls back with nothing changed. Whether CloudFront applies that
check here was not tested. A way through that should work but is also
untested: create any record of another type at `admin.<apex>` first (for
example a `TXT`), so the name exists and the wildcard no longer answers for it,
wait out the wildcard's TTL, rerun step 3, and delete the placeholder after.

**Rollback**: put the apex back in `AllowedOrigins` and deploy the proxy, then
remove `ADMIN_DOMAIN` and rerun step 3 (the admin distribution, certificate,
record and both functions go; the production certificate is untouched). The
redirects are 302s, so no browser keeps them. `cms.admin_origin` can stay: it
is inert while the editor is served from the apex. Editors sign in again on the
apex.

## Security headers

`infrastructure/bootstrap/template.yaml` attaches two response headers
policies, `<prefix>-baseline-headers` on each distribution's default behavior
and `<prefix>-admin-headers` on an `/admin/*` behavior that is otherwise a
copy of the default (same origin, cache policy and functions;
`e2e/cloudfront-security-headers.test.js` holds them equal). A site serving
its editor from its own origin (#517, above) also sends `<prefix>-admin-headers`
on every response of `admin.<apex>`; its apex `/admin/*` then only redirects,
so run the checks below against `admin.<apex>/admin/` instead.

| Header | Everywhere | `/admin/*` |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000` (`HstsMaxAgeSeconds`); `includeSubDomains` / `preload` only with `HstsScope` | same |
| `X-Content-Type-Options` | `nosniff` | same |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | same |
| `X-Frame-Options` | `SAMEORIGIN` | same |
| `Content-Security-Policy` | `frame-ancestors 'self'` | report-only: `frame-ancestors 'self'`; enforce: the full policy |
| `Content-Security-Policy-Report-Only` | — | report-only: the full policy; enforce: absent |

Nothing frames these pages from another origin: Decap's preview pane is a
`srcdoc` iframe inside `/admin`, embedded tools are same-origin
`/assets/tools/` iframes, the live preview is a separate tab, and the
visual-regression harness navigates top-level. A site that wants another
origin to embed its pages has to widen `frame-ancestors` first.

The full `/admin` policy, and why each part is there:

- `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com` — Decap
  (SRI-pinned) calls `new Function`; the shells' inline scripts carry
  per-site `window.CMS_*`, so a hash would differ per site and render path.
- `style-src 'self' 'unsafe-inline'` — Decap injects inline styles.
- `connect-src 'self' blob: https://<apex> https://*.<apex> https://api.github.com
  https://www.githubstatus.com` — no bare `https:`. The subdomains cover the
  dashboards' `preview-pr<N>` `regression.json`; githubstatus.com is Decap's
  status probe. The OAuth proxy is absent on purpose: sign-in is a popup and
  `postMessage`, which `connect-src` does not govern. If #516 adds a token
  refresh `fetch` to the proxy, its origin has to be added.
- `img-src 'self' data: blob: https://<apex> https://*.<apex>
  https://avatars.githubusercontent.com`, `media-src 'self' blob:
  https://<apex> https://*.<apex>` (the dashboards' `regression.mp4`),
  `font-src 'self' data:`, `frame-src 'self'`, `default-src 'self'`.
- `object-src 'none'`, `base-uri 'none'` (no shell has a `<base>`).

A new third-party script, stylesheet or `fetch` target under `theme/admin/`
needs a matching source in the template, or it breaks once a site enforces.
Decap's preview pane is a `srcdoc` iframe, and a `srcdoc` document inherits
the `/admin` policy, so a third-party image, script or iframe inside an
entry's body (an HTML Embed, a hotlinked image) previews blank once a site
enforces, while the published page still shows it. An iframe that loads a
same-origin URL such as `/assets/tools/<slug>/` gets that page's own policy.

It narrows where a script can quietly send what it reads; it cannot stop a
script that navigates the page away, and the GitHub API it must allow is
itself writable. There is no reporting endpoint: Report-Only violations
appear only in the browser console, as `[Report Only] Refused to …`.
`/admin/index-local.html` is a local-development shell talking to
`decap-server` on `localhost`; through CloudFront an enforced policy blocks
that, which changes nothing a deployed site uses.

### Rolling it out, per site

1. Redeploy the bootstrap stack from the site repo once its bump PR naming
   the release is merged. A live apex must keep `CREATE_APEX_DNS_RECORDS=true`
   (in `site-params.env` or the wrapper), or the update deletes its apex and
   `www` records:

   ```bash
   cd ~/repos/<site> && git checkout main && git pull
   # ADMIN_CSP_MODE unset = keep the deployed mode (report-only on a stack
   # that predates the parameter). The stack is BOOTSTRAP_STACK_NAME
   # (default <prefix>-bootstrap), never site-params.env's STACK_NAME, which
   # names the OAuth proxy (infrastructure/README.md, "The STACK_NAME collision"):
   bash infrastructure/bootstrap/deploy.sh   # the site's delegating wrapper
   ```

   The script sends a minified copy of `template.yaml` (the raw file is over
   the AWS CLI's 51,200-byte inline limit), then prints the change set, one
   line per resource. It refuses to execute a change set with anything marked
   `DESTRUCTIVE` (a removal or a replacement) and changes nothing; read the
   list before reaching for `ALLOW_DESTRUCTIVE_CHANGES=1`, since a missing
   `CREATE_APEX_DNS_RECORDS=true` or `ADMIN_DOMAIN` is the usual cause. This
   is an update of an existing stack, so it needs no `ALLOW_STACK_CREATE`: a
   refusal saying the stack does not exist means the stack name is wrong, not
   that the flag is missing.

2. Check the headers on production and on one live preview host (no
   invalidation is needed; the policy applies to cached responses too):

   ```bash
   for u in https://<apex>/ https://<apex>/admin/ https://<apex>/admin/reviews/ \
            https://preview-pr<N>.<apex>/ https://preview-pr<N>.<apex>/admin/ \
            https://preview-pr<N>.<apex>/admin/reviews/; do
     echo "== $u"
     curl -sI "$u" | grep -i -E '^(strict-transport-security|x-content-type-options|referrer-policy|x-frame-options|content-security-policy)'
   done
   ```

   `/` shows five headers; each `/admin/` URL also shows
   `content-security-policy-report-only`.
3. Do an editor round-trip with the browser console open on `/admin/`: sign
   in, open and edit an entry, watch the preview pane, upload an image and
   open the media library, save, publish; then sign in on `/admin/reviews/`
   and `/admin/reviews/health.html`, and repeat on a preview admin. Every
   `[Report Only]` line is a source the policy is missing: fix the template
   before enforcing.
4. Enforce once, explicitly:
   `ADMIN_CSP_MODE=enforce bash infrastructure/bootstrap/deploy.sh`, then
   repeat step 2: `content-security-policy` now carries the full policy and
   the Report-Only header is gone. Later redeploys keep it: with
   `ADMIN_CSP_MODE` unset, the platform script reads the stack's deployed
   `AdminCspMode` and sends it back, logging
   `Admin CSP mode: enforce (kept from deployed stack)`. Only a new stack, or
   one deployed before the parameter existed, defaults to report-only. An
   explicit value always wins, and anything but `enforce` or `report-only`
   (or a `describe-stacks` failure other than "does not exist") stops the
   script before the change set. Do not count on a wrapper to carry the
   setting: the scaffolder's delegating wrapper sources
   `infrastructure/site-params.env`, but a site's own wrapper may not
   (adamdaniel.ai's does not), so an export there can be silently ignored.
   Read the log line instead.
5. Drive `gh workflow run cms-publish-loop-prod.yml --repo <owner>/<repo>`
   green (the definition of done in `AGENTS.md`). To back out, redeploy with
   `ADMIN_CSP_MODE=report-only bash infrastructure/bootstrap/deploy.sh`; that
   value is then the deployed one, and later redeploys keep report-only.

## Rules that follow

- **Bumping Decap means recomputing the hash**, in all three shells, from the
  exact file the tag will load, cross-checked against the npm tarball:

  ```bash
  v=X.Y.Z
  curl -s "https://unpkg.com/decap-cms@$v/dist/decap-cms.js" | openssl dgst -sha384 -binary | openssl base64 -A
  npm pack "decap-cms@$v" && tar xzf "decap-cms-$v.tgz" package/dist/decap-cms.js \
    && openssl dgst -sha384 -binary package/dist/decap-cms.js | openssl base64 -A
  ```

  A wrong hash does not degrade: Decap does not load at all.
- **Bumping the CloudWatch RUM client means re-vendoring it**, never pointing
  `theme/_includes/analytics/cloudwatch-rum.html` back at AWS. The gem ships it
  as `theme/assets/js/aws-rum-web/cwr-<version>.js`; the version is in the file
  name because production caches assets for a day, and `provenance.json` beside
  it records version, source URL and sha384, which
  `e2e/analytics-rum-client-vendored.test.js` holds the bytes to:

  ```bash
  v=X.Y.Z; d=theme/assets/js/aws-rum-web
  curl -fsS -o "$d/cwr-$v.js" "https://client.rum.us-east-1.amazonaws.com/$v/cwr.js"
  openssl dgst -sha384 -binary "$d/cwr-$v.js" | openssl base64 -A
  npm pack "aws-rum-web@$v" && tar xzf "aws-rum-web-$v.tgz" -C "$d" --strip-components=1 \
    package/LICENSE package/NOTICE package/LICENSE-THIRD-PARTY
  ```

  Then `git rm` the old `cwr-*.js` and move `provenance.json` and the include's
  path to the new version. The npm package carries no browser bundle, so the
  CDN is the only source of these bytes; cross-check them against
  `/<major>.x/cwr.js` while `$v` is the newest release, and fetch from
  `us-east-1`, the only region whose client host resolves. **Never cross a
  major version without reading its changelog**: 2.x and 3.x change defaults,
  and 3.x turns on session replay. Loading the CDN copy with `integrity` +
  `crossorigin` instead does not work: the CDN does not vary its cache on
  `Origin`, so `Access-Control-Allow-Origin` comes back only when the request
  that filled a POP's cache sent one, and a real browser blocked the tag.
- **A new script on `/admin` is same-origin, shipped in the gem**, or it carries
  an exact version and an integrity hash.
- **A new `message` listener checks `origin` and `source` first**, and never
  uses `event.origin` as a reply target before checking it.
- **`oauth-proxy/` changes are not live until deployed and probed** — say which
  sites were probed, and with what result, when reporting the change done.

## GitHub App sign-in (#516)

Status: **evaluated from source, not yet measured.** Nothing below has run
with a real `ghu_` token; the spike at the end is what decides it.

**Sources.** `decap-cms@3.15.1` (the version all three shells pin) was published
2026-07-24 and bundles `decap-cms-backend-github@3.8.0`,
`decap-cms-lib-auth@3.2.1` and `decap-cms-core@3.17.1`: each is the floor of
its caret range and the newest release before that date, and the strings cited
below were cross-checked in `dist/decap-cms.js`. `backend-github/` below means
that package's `src/`. Permissions come from GitHub's *Permissions required for
GitHub Apps* table (its user-access-token column), read 2026-10-02.

### Every GitHub call made with the editor's token

Decap (`backend: github`, REST — `use_graphql` is unset,
`backend-github/implementation.tsx:134`):

| Call | Where | App permission |
|---|---|---|
| `GET /user` | `implementation.tsx:217-232`; also both dashboards (`reviews/index.html:384`, `reviews/health.html:423`) | none — any user token |
| `GET /users/{login}` (PR author name) | `API.ts:633-644` | none — public |
| `GET /repos/{o}/{r}`, reading `permissions.push` — **the sign-in write check** | `API.ts:292-304`, called from `implementation.tsx:363-378` on every sign-in and reload | Metadata: read |
| `GET /pulls`, `GET /pulls/{n}/commits` | `API.ts:550-568`, `619-631` | Pull requests: read |
| `POST /pulls`, `PATCH /pulls/{n}` | `API.ts:1349-1386` | Pull requests: write |
| `PUT /issues/{n}/labels` (editorial status) | `API.ts:1011-1016`, `1181-1189` | Pull requests: write **or** Issues: write |
| `PUT /pulls/{n}/merge` | `API.ts:1388-1408` | Contents: write |
| `POST /git/blobs`, `/git/trees`, `/git/commits` — entries **and media uploads** (`persistMedia`, `implementation.tsx:561-577` → `persistFiles`, `API.ts:947-969`) | `API.ts:1432-1447`, `1519-1546` | Contents: write |
| `POST`/`PATCH`/`DELETE /git/refs` | `API.ts:1242-1265`, `1294-1345` | Contents: write; Workflows: write only if the ref change touches `.github/workflows/` |
| `GET /git/blobs`, `/git/trees/{ref}:{dir}`, `/branches/{b}`, `/compare/{a}...{b}`, `/commits?path=` | `API.ts:690-760`, `971-992`, `1089-1106`, `1267-1277` | Contents: read |
| `GET /commits/{sha}/status` (`preview_context`) | `API.ts:931-945` | Commit statuses: read |
| `GET /search/issues`, `PATCH /issues/{n}` (notes cleanup on publish/delete) | `API.ts:1802-1828`, `1960-1983` | search: none; PATCH: Pull requests or Issues write |

The notes calls are dormant: notes default off (`decap-cms-core`
`actions/config.ts:244-245`; `config.base.yml` sets no `editor:`), so the
search finds nothing, and both calls sit in a `try/catch`. The
`refs/meta/_decap_cms` metadata branch (`API.ts:430-505`) is reached only by the
legacy label migration.

The platform (`theme/admin/`):

| Call | Where | App permission |
|---|---|---|
| `GET /pulls?state=…`, `GET /pulls/{n}` | `live-url-banner.js:141`, `publish-progress.js:287,409,469`, `posts-list-enhance.js:405`, `reviews/index.html:443` | Pull requests: read |
| `GET /git/ref/…`, `/git/matching-refs/heads/cms/posts/`, `/contents/{path}` | `publish-progress.js:369`, `posts-list-enhance.js:382`, `site-gate-banner.js:156` | Contents: read |
| `GET /commits/{sha}/check-runs` | `publish-progress.js:371`, `posts-list-enhance.js:471` | Checks: read |
| `GET /actions/runs?…`, `/actions/workflows/{f}/runs`, `GET …/pending_deployments` | `publish-progress.js:421`, `reviews/index.html:402,431`, `reviews/health.html:440` | Actions: read |
| `POST /actions/runs/{id}/pending_deployments` — **approve / reject** | `reviews/index.html:558,587` | **Deployments: write** |
| `GET /deployments`, `/deployments/{id}/statuses` | `deploy-status-pill.js:224-260`, `publish-progress.js:483-485`, `posts-list-enhance.js:344-353` | Deployments: read |
| `POST`/`DELETE /issues/{n}/labels` (`cms/ready`) | `publish-button.js:222-233`, `publish-via-auto-merge.js:93,250` | Pull requests: write or Issues: write |
| `POST /git/refs`, `POST /pulls` (delete recovery) | `publish-via-auto-merge.js:208-226` | Contents: write, Pull requests: write |
| GraphQL `history { associatedPullRequests }` on `main` | `posts-list-enhance.js:280-310` | Contents + Pull requests: read (GraphQL has no published table; a gap answers HTTP 200 with an `errors` entry such as *Resource not accessible by integration*, and the shim then drops dates and PR links without a console error) |

Called by nothing: a `delete-via-pr.yml` dispatch (removed —
`publish-via-auto-merge.js:58-63`, `e2e/decap-pat.js:19-27`; the issue's list is
stale there), enabling auto-merge (the `cms/ready` label makes
`cms-editorial-workflow.yml` do it with its own credential), `PATCH /user`,
`/user/emails`. The only `PUT /user` in the bundle is GoTrue's, used by the
`git-gateway` backend.

### Where a GitHub App behaves differently

1. **The write check.** Decap signs in only when `GET /repos/{o}/{r}` reports
   `permissions.push` (`API.ts:299`); `bypassWriteAccessCheckForAppTokens` is a
   class field no config key sets (`implementation.tsx:89,377`). #238 measured
   an *installation* token: `false`. A user token acts as the user, but GitHub
   does not document whether `permissions` then reports the user's role or the
   App's grant. The closest evidence is favorable: the e2e loops already sign
   Decap in with a fine-grained PAT (`e2e/decap-pat.js`).
2. **Approving a deployment needs Deployments: write**, in both the App and the
   fine-grained-PAT tables. `skills/consumer-repo-provisioning/SKILL.md` calls
   it an Actions endpoint; GitHub's tables disagree. The approver must still be
   a required reviewer of the environment, and a user token acts as that user.
3. **`scope` is not a GitHub App authorize parameter.** The proxy keeps sending
   `&scope=`; GitHub is expected to ignore it.
4. **`workflow`'s stated reason is gone**: the dispatch it was added for no
   longer exists (above), and Decap's ref writes carry content only: new commits sit on `main`'s tip or on
   the branch's merge base (`editorialWorkflowGit`, `API.ts:1030-1087`;
   `rebaseBranch`, `1165-1180`). The App below has no Workflows permission, so
   the spike measures whether anything still needs it.

**Minimal permission set:** Metadata read, Contents read/write, Pull requests
read/write, Commit statuses read, Checks read, Actions read, Deployments
read/write. Not Issues, Workflows, Administration, or any account permission.
It is `oauth-proxy/github-app-manifest.json`, locked by `test_lambda.py`.

### Token expiry

Decap's GitHub backend has no refresh flow: `lib-auth`'s `refresh()`
(`netlify-auth.js:132-161`) is never called by `backend-github`, and any failure
restoring a stored user logs the editor out (`decap-cms-core`
`actions/auth.ts:56-76`). After expiry every call fails until a reload; on
reload `currentUser` parses the 401 body without checking `res.ok`
(`implementation.tsx:220-226`), the write check throws, and Decap shows its
*Repo not found … ensure the organization has granted access* text
(`implementation.tsx:363-374`) above the login button. Misleading, not broken.
The dashboards already handle 401 (`reviews/index.html:301-305`).

| | Expiring (8 h) | Expiry off |
|---|---|---|
| A leaked token is good for | at most 8 h | until revoked |
| Repo and permission limits | yes | yes |
| Editor cost | one *Login with GitHub* click per working day (no consent screen once authorized) | none |

A refresh token must never reach the browser: it lives six months and mints new
access tokens. The proxy hands over `access_token` alone and drops
`refresh_token` and `expires_in` (`_exchange_code`;
`TestGitHubAppTokenResponse`).

**Recommendation: expiring.** Fall back to expiry off only if spike step 11
shows an unsaved edit lost across a re-login.

### Org-owned consumers (#26) and the restriction detector

OAuth App access restrictions apply to OAuth Apps only. Under a GitHub App the
gate is the **installation**: an org owner installs the App on the org and
picks the site repo, so the installer is the approver, as with the automation
App. Members then authorize it at their first sign-in. The failure moves from
"signs in, cannot save" to "cannot sign in": with no installation the token
reaches nothing in the org, and the write check fails with the same misleading
text as an expired token.

`oauth-app-restriction-detector.js` matches GitHub's *OAuth App access
restrictions* message, which an App never produces, so it stays inert. Keep it
while any site signs in through an OAuth App. A login-screen hint for the
missing-installation case is the right replacement once the spike shows the
exact error; it is not built yet. A user-owned App can be installed on another
account only if it is public, so the org consumer's App belongs to the org.

### One App or two

**Do not reuse the CMS automation App (#238).**

- A user token holds the intersection of the App's permissions and the user's,
  on every repo the App is installed on. The automation App has Workflows:
  write (the one permission the sign-in token must not carry) and is installed
  on `cms-platform` as well, so an editor who can write there would carry that
  too.
- It lacks Actions, Checks, Commit statuses and Deployments. Adding them widens
  what its private key, a repo secret on every consumer
  (`CMS_AUTOMATION_APP_PRIVATE_KEY`), can mint: deployment approvals included.
  `mint-app-token.js` narrows each run's token; the key holder can mint the
  full set.
- The sign-in App's client secret lives in each site's Lambda environment.
  Sharing one App ties a Lambda leak and a repo-secret leak to the same
  identity and the same rotation.

**Use a second App, one per site** (`<prefix>-cms-signin`): no private key (the
web flow needs only the client id and secret), no webhook, installed on the one
site repo. One per site, because the proxy sends no `redirect_uri`, so GitHub
returns every sign-in to the App's *first* callback URL; one App per site
mirrors today's one OAuth App per site and needs no proxy change.

### Go/no-go, and the risks the spike must retire

**Go for the spike. No rollout until it passes.** Ranked:

1. Decap's write check with a `ghu_` token. If `permissions.push` is `false`,
   sign-in fails and Decap 3.15.1 has no switch for it: **no-go**.
2. Approving a deployment with the user token.
3. Label writes on PRs with Pull requests: write and no Issues permission.
4. Save, media upload, publish and delete end to end.
5. The posts-list GraphQL query.
6. A re-login after expiry restoring an unsaved edit.
7. Anything refusing for lack of Workflows.
8. The org install path, on the org-owned consumer.

### The spike

It runs on a **throwaway PR's preview admin** of a user-owned consumer, not on
a scratch repo: the dashboards need the site's own workflows and
`regression-review` environment, and a preview admin's backend branch is the PR
head (`scripts/patch-preview-config.sh`), so saves, publishes and deletes land on
the throwaway branch, never on `main`.

Setup, owner only:

1. Create the App at <https://github.com/settings/apps/new> with the values in
   `oauth-proxy/github-app-manifest.json` (callback `https://<apex>/` for now;
   *Expire user authorization tokens* left on; webhook inactive; "Only on this
   account"). Generate a client secret. Do not generate a private key.
   Fill the form by hand; do **not** register it through GitHub's manifest
   flow. That flow always generates a private key, and it redirects to the
   manifest's `redirect_url` (the public site, where access logs and RUM
   record the URL) with a one-hour `code` that
   `POST /app-manifests/{code}/conversions` exchanges, with no credentials,
   for the private key and the client secret.
2. Install it on the site repo only.
3. Deploy a separate spike proxy from this branch:

   ```bash
   cd ~/repos/cms-platform && git fetch origin \
     && git checkout --detach origin/feat/github-app-signin-evaluation
   read -rs GITHUB_CLIENT_SECRET   # the App's client secret; not echoed
   ( export GITHUB_CLIENT_SECRET STACK_NAME=<prefix>-oauth-proxy-app-spike \
       GITHUB_CLIENT_ID=<app-client-id> ALLOWED_ORIGINS='https://preview-*.<apex>' \
       APEX_DOMAIN=<apex> \
       GITHUB_ORG=<owner> GITHUB_REPO=<repo>
     bash oauth-proxy/deploy.sh )
   ```

4. Set the App's callback URL to the `CallbackEndpoint` the deploy printed.
5. In the site repo, on a branch `spike/github-app-signin`, set
   `cms.oauth_base_url` in `_config.yml` to the printed `ApiUrl`, open a PR and
   wait for `https://preview-pr<N>.<apex>`.

Checklist, all on that preview:

| # | Do | Pass |
|---|---|---|
| 1 | `/admin/` → *Login with GitHub* | GitHub's page names the App and its repository permissions; the collections load. *"Your GitHub user account does not have access to this repo"* is risk 1: stop, no-go. |
| 2 | Console: `u = JSON.parse(localStorage['decap-cms-user']); [u.token.slice(0, 4), Object.keys(u)]` | `ghu_`, and no `refresh_token` key |
| 3 | Console: `fetch('https://api.github.com/repos/<owner>/<another-private-repo>', {headers: {Authorization: 'token ' + u.token}}).then(r => r.status)` | `404`: the token cannot see a repo the App is not installed on |
| 4 | New entry → Save | a `cms/…` PR opens against `spike/github-app-signin` with `decap-cms/draft` |
| 5 | Add an image to it → Save | the image is in the PR's diff |
| 6 | Move it to Ready | the label changes; no error toast |
| 7 | Publish | the PR merges into the spike branch, or is labeled `cms/ready` by the shim; no *workflows* refusal anywhere |
| 8 | Posts list and the deploy pill; then in the console: `fetch('https://api.github.com/graphql', {method: 'POST', headers: {Authorization: 'bearer ' + u.token}, body: JSON.stringify({query: '{repository(owner:"<owner>",name:"<repo>"){ref(qualifiedName:"refs/heads/main"){target{... on Commit{history(first:1){nodes{committedDate associatedPullRequests(first:1){nodes{number}}}}}}}}}'})}).then(r => r.json())` | dates, PR links and a pill state render, and the response has `data` and no `errors` key. GraphQL reports a permission gap as HTTP 200 with `errors`, not as a 401, so the status code alone proves nothing. |
| 9 | `/admin/reviews/` and `/admin/reviews/health.html` → sign in | waiting runs and the health table load |
| 10 | Approve the spike PR's parked `regression-review` gate, if any | *Regression approved*, and the run moves on. A 403 is risk 2. |
| 11 | Open the entry, type without saving; in a terminal revoke the token: `curl -u <app-client-id> -X DELETE https://api.github.com/applications/<app-client-id>/token -d '{"access_token":"<token from step 2>"}'` (the client secret is the password); Save; reload; sign in again | the Save fails, and after signing in again Decap offers the unsaved edit back |
| 12 | Delete the spike entry from the posts list | the file leaves the spike branch |
| 13 | On the org-owned consumer: an org owner creates the same App under the org and installs it; repeat 1–3 there | sign-in works, no *OAuth App access restrictions* banner |

Teardown: close the PR and delete `spike/github-app-signin`;
`aws cloudformation delete-stack --stack-name <prefix>-oauth-proxy-app-spike`;
revoke the App at <https://github.com/settings/apps/authorizations>, or keep it
for the rollout.

### The interim step: `read:user` instead of `user`

The proxy's default scope is now `repo,read:user,workflow` in `lambda.py`,
`template.yaml` and `deploy.sh` (`TestScopeLockstep`). Nothing in Decap or the
platform writes the profile; the tables above list every `/user` call, and
each is a `GET`. **It is not live until each site's proxy is redeployed** (see
[A release does not deploy the proxy](#a-release-does-not-deploy-the-proxy)),
then confirmed by one real sign-in:

```bash
curl -s -o /dev/null -D - "$base/prod/auth" | grep -i '^location:'
# expect scope=repo%2Cread%3Auser%2Cworkflow
```

Then sign out of `/admin`, sign in, and in the console:
`fetch('https://api.github.com/user', {headers: {Authorization: 'token ' + JSON.parse(localStorage['decap-cms-user']).token}}).then(r => r.headers.get('x-oauth-scopes'))`
should print `read:user, repo, workflow`. If it still says `user`, revoke the
OAuth App at <https://github.com/settings/applications>, sign in once more,
then save a draft and open `/admin/reviews/`.
