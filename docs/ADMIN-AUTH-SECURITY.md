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
**inside a single host label** and is refused in the last two labels, so it can
name a site's per-PR preview hosts and nothing wider:

```bash
export ALLOWED_ORIGINS="https://<apex>,https://preview-*.<apex>"
```

- The preview entry is what lets an editor sign in on `preview-prN.<apex>` and
  `preview-cms-<slug>.<apex>`. Leave it out and those admins can no longer
  complete a sign-in; that is a valid choice for a site that does not use them.
- `www.<apex>` serves the same `/admin` on the production distribution but is a
  different origin; list it only if editors really sign in there.
- A bare `*`, an `http://` origin, or an entry with a path is invalid.
  `deploy.sh` refuses to deploy it, and a proxy that somehow ends up with no
  valid entry answers 500 instead of signing anyone in.
- The API has no CORS configuration: nothing fetches it cross-origin, and the
  Lambda is the one place the allowlist is enforced.

## A release does not deploy the proxy

`platform-bump` moves a consumer's pins. It does not touch AWS. The Lambda only
changes when someone with that site's AWS credentials runs the deploy, so a
proxy fix can be merged, released and bumped everywhere while the old code
keeps signing people in. Each site's daily **OAuth proxy build probe**
(`oauth-proxy-build.yml`, below) goes red when that happens
([#518](https://github.com/Adam-S-Daniel/cms-platform/issues/518)).

After any release that changes `oauth-proxy/`, for each site:

```bash
# 1. the site's bump PR is merged, so platform.lock names the new release
cd ~/repos/<site> && git checkout main && git pull
# 2. infrastructure/site-params.env carries the ALLOWED_ORIGINS you intend
# 3. deploy (the wrapper checks the platform out at platform.lock's ref)
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
  2026-10-02), but `deploy.sh` refuses to run without one today, so CI would
  first need a "keep the stack's value" path in `deploy.sh`.
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
origin, and it is an OAuth App token: scope `repo,user,workflow`, every
repository the editor can reach, no expiry. A script that should not be there
is therefore expensive. What was weighed:

| Measure | Status | Why |
|---|---|---|
| Subresource Integrity on the Decap bundle | **Shipped.** All three shells load `decap-cms` from unpkg with `integrity` + `crossorigin`; `e2e/admin-pin-invariant.test.js` locks it. | It is the only third-party script in the admin, and it runs with the token in reach. The browser now refuses a bundle whose bytes differ from the release that was reviewed. |
| Security headers | Deferred — [#515](https://github.com/Adam-S-Daniel/cms-platform/issues/515) | CloudFront serves none. HSTS, `nosniff` and `frame-ancestors` are cheap; a CSP for `/admin` has to live with Decap's `new Function` and inline styles. Needs a bootstrap-stack deploy per site and a live publish loop to prove it. |
| Narrower permissions | Deferred — [#516](https://github.com/Adam-S-Daniel/cms-platform/issues/516) | An OAuth App cannot be limited to one repository. The real narrowing is a GitHub App user token (site repo only, fine-grained, optionally expiring), which changes how every editor signs in. |
| A separate origin for the editor | Deferred — [#517](https://github.com/Adam-S-Daniel/cms-platform/issues/517) | Public pages share the origin, and so do their scripts (the CloudWatch RUM client is loaded from a floating `1.x` path). Moving `/admin` to its own host takes the token out of their reach, and moves a URL most of the e2e harness depends on. |
| Dashboards keeping their own copy (`gh_reviews_token`) | Left as is | Decap's own `decap-cms-user` sits beside it on the same origin, so dropping or moving the second copy would not shrink what a script can read. |

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
- **A new script on `/admin` is same-origin, shipped in the gem**, or it carries
  an exact version and an integrity hash.
- **A new `message` listener checks `origin` and `source` first**, and never
  uses `event.origin` as a reply target before checking it.
- **`oauth-proxy/` changes are not live until deployed and probed** — say which
  sites were probed, and with what result, when reporting the change done.
