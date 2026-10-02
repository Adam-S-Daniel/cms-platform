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
- A site that serves its editor from its own origin (below) lists that origin
  **instead of** the apex: `https://admin.<apex>,https://preview-*.<apex>`.
  Leaving the apex in lets a script on any public page open the sign-in popup
  itself and, for an editor who has already authorized the app (GitHub then
  skips the consent screen), receive a token.
- A bare `*`, an `http://` origin, or an entry with a path is invalid.
  `deploy.sh` refuses to deploy it, and a proxy that somehow ends up with no
  valid entry answers 500 instead of signing anyone in.
- The API has no CORS configuration: nothing fetches it cross-origin, and the
  Lambda is the one place the allowlist is enforced.

## A release does not deploy the proxy

`platform-bump` moves a consumer's pins. It does not touch AWS. The Lambda only
changes when someone with that site's AWS credentials runs the deploy, so a
proxy fix can be merged, released and bumped everywhere while the old code
keeps signing people in ([#518](https://github.com/Adam-S-Daniel/cms-platform/issues/518) tracks detecting that).

After any release that changes `oauth-proxy/`, for each site:

```bash
# 1. the site's bump PR is merged, so platform.lock names the new release
cd ~/repos/<site> && git checkout main && git pull
# 2. infrastructure/site-params.env carries the ALLOWED_ORIGINS you intend
# 3. deploy (the wrapper checks the platform out at platform.lock's ref)
bash oauth-proxy/deploy.sh
```

A site with no `oauth-proxy/deploy.sh` wrapper deploys from a platform checkout
at the release tag instead:

```bash
cd ~/repos/cms-platform && git fetch --tags && git checkout vX.Y.Z
( set -a; source ~/repos/<site>/infrastructure/site-params.env; set +a
  bash oauth-proxy/deploy.sh )
```

It is an in-place stack update: the API Gateway URL, `cms.oauth_base_url` and
the GitHub OAuth App's callback URL do not change. If the deploy **widens** the
scope the live proxy was requesting, each editor is asked to re-authorize the
app once.

### Deploying without touching the credentials

`deploy.sh` passes `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from the
environment on every run. A `site-params.env` that still holds the example's
`xxxx…` placeholders, or a secret that has since been rotated, therefore
**overwrites the live secret**, and every sign-in then fails at the code
exchange. One consumer's local file held placeholders when v0.1.124 was
deployed (2026-10-02).

To change only the code, `AllowedOrigins` or the scope, leave both credentials
out: SAM keeps a stack's existing value for every parameter it is not given.

```bash
cd ~/repos/cms-platform/oauth-proxy        # checked out at the release tag
sam build --template-file template.yaml --region us-east-1
sam deploy --template-file .aws-sam/build/template.yaml \
  --stack-name <prefix>-oauth-proxy --region us-east-1 \
  --capabilities CAPABILITY_IAM --resolve-s3 --no-execute-changeset \
  --parameter-overrides "AllowedOrigins=https://<apex>,https://preview-*.<apex>" \
    "GitHubScope=repo,user,workflow" "FunctionName=<prefix>-oauth-proxy"
```

`--no-execute-changeset` stops at the change set, so it can be read first
(`aws cloudformation describe-change-set --change-set-name <arn>`):

- `OAuthHttpApi` and `OAuthProxyFunction` are `Modify` with `Replacement:
  False` — the API URL does not move;
- the function's `Environment` change is caused by `AllowedOrigins` and
  `GitHubScope` only. A `ParameterReference` naming `GitHubClientSecret` means
  the secret is about to change.

Then `aws cloudformation execute-change-set --change-set-name <arn>` and
`aws cloudformation wait stack-update-complete --stack-name <prefix>-oauth-proxy`.

To learn whether a local file's secret is the live one without printing
either, compare hashes: the deployed value is the function's
`GITHUB_CLIENT_SECRET` environment variable
(`aws lambda get-function-configuration`).

### Which proxy is a site running?

No credentials needed — ask the proxy:

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

## The token at rest

Once issued, the token sits in `localStorage`, readable by every script on the
origin, and it is an OAuth App token: scope `repo,user,workflow`, every
repository the editor can reach, no expiry. A script that should not be there
is therefore expensive. What was weighed:

| Measure | Status | Why |
|---|---|---|
| Subresource Integrity on the Decap bundle | **Shipped.** All three shells load `decap-cms` from unpkg with `integrity` + `crossorigin`; `e2e/admin-pin-invariant.test.js` locks it. | It is the only third-party script in the admin, and it runs with the token in reach. The browser now refuses a bundle whose bytes differ from the release that was reviewed. |
| Security headers | **In the template, not yet deployed** — [#515](https://github.com/Adam-S-Daniel/cms-platform/issues/515) | Both distributions send HSTS, `nosniff`, `Referrer-Policy` and same-origin framing once a site redeploys its bootstrap stack; `/admin/*` adds a CSP, Report-Only until `AdminCspMode=enforce`. Decap's `new Function` and the per-site inline scripts keep `script-src` loose; the gain is `connect-src`, `object-src`, `base-uri` and `frame-ancestors`. See [Security headers](#security-headers) below. |
| Narrower permissions | Deferred — [#516](https://github.com/Adam-S-Daniel/cms-platform/issues/516) | An OAuth App cannot be limited to one repository. The real narrowing is a GitHub App user token (site repo only, fine-grained, optionally expiring), which changes how every editor signs in. |
| A separate origin for the editor | **Opt-in, per site** — [#517](https://github.com/Adam-S-Daniel/cms-platform/issues/517); off until a site follows the runbook below | Public pages share the origin, and so do their scripts (the CloudWatch RUM client is loaded from a floating `1.x` path). Opted in, the editor is served by a distribution of its own that never returns a page with public-page script, and the apex only redirects to it. That closes public-page scripts' reach to the tokens once the old ones are revoked; content rendered inside the editor and the per-PR preview admins are not covered (see "What it closes, and what it does not"). |
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
#    redeploy without it DELETES the apex records), and STACK_NAME must name
#    the bootstrap stack, not the proxy's. A new certificate is validated and
#    a new distribution deployed: allow several minutes.
bash infrastructure/bootstrap/deploy.sh

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
- `connect-src 'self' https://<apex> https://*.<apex> https://api.github.com
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
   bash infrastructure/bootstrap/deploy.sh   # ADMIN_CSP_MODE unset = report-only
   ```

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
4. Enforce: add `export ADMIN_CSP_MODE="enforce"` to
   `infrastructure/site-params.env` (the wrapper sources it, and a later
   redeploy without it goes back to report-only), run
   `bash infrastructure/bootstrap/deploy.sh` again, and repeat step 2:
   `content-security-policy` now carries the full policy and the Report-Only
   header is gone.
5. Drive `gh workflow run cms-publish-loop-prod.yml --repo <owner>/<repo>`
   green (the definition of done in `AGENTS.md`). To back out, redeploy with
   `ADMIN_CSP_MODE=report-only`.

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
