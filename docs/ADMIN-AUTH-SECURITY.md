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
| Security headers | Deferred — [#515](https://github.com/Adam-S-Daniel/cms-platform/issues/515) | CloudFront serves none. HSTS, `nosniff` and `frame-ancestors` are cheap; a CSP for `/admin` has to live with Decap's `new Function` and inline styles. Needs a bootstrap-stack deploy per site and a live publish loop to prove it. |
| Narrower permissions | Deferred — [#516](https://github.com/Adam-S-Daniel/cms-platform/issues/516) | An OAuth App cannot be limited to one repository. The real narrowing is a GitHub App user token (site repo only, fine-grained, optionally expiring), which changes how every editor signs in. |
| A separate origin for the editor | **Opt-in, per site** — [#517](https://github.com/Adam-S-Daniel/cms-platform/issues/517); off until a site follows the runbook below | Public pages share the origin, and so do their scripts (the CloudWatch RUM client is loaded from a floating `1.x` path). On its own host the editor's tokens are out of their reach. |
| Dashboards keeping their own copy (`gh_reviews_token`) | Left as is | Decap's own `decap-cms-user` sits beside it on the same origin, so dropping or moving the second copy would not shrink what a script can read. |

## Serving the editor from its own origin (opt-in, #517)

Off by default. With it on, `/admin/` and `/admin/reviews/` are served from
`admin.<apex>` and nothing public is:

| Request | Answer |
|---|---|
| `admin.<apex>/admin…` | the same `admin/` objects, at the same paths |
| `admin.<apex>/` | 302 to `admin.<apex>/admin/` |
| `admin.<apex>/<anything else>` | 302 to the same path and query on `<apex>` |
| `HEAD admin.<apex>/<anything>` | served: no body runs, and `slug-pin.js` probes `/blog/<slug>/` same-origin |
| `<apex>/admin…`, `www.<apex>/admin…` | 302 to the same path and query on `admin.<apex>` (the browser keeps the `#/…` fragment) |

The pieces: the bootstrap stack's `AdminDomainName` parameter (alias, SAN,
Route53 record and the `admin-host-router` CloudFront Function on the
production distribution), the site's `cms.admin_origin` (injected as
`window.CMS_ADMIN_ORIGIN`; on that origin `site-hostname.js` and
`live-url-derive.js` build public URLs and "on `<host>`" copy from `url`), and
`ALLOWED_ORIGINS`. Tests: `e2e/admin-host-router.test.js` runs the function
and checks that an un-opted stack deploys exactly what it did before.

What it does **not** cover, as of this change:

- **Live Preview is hidden on the admin origin.** `/preview/` fills from a
  same-origin `BroadcastChannel`, and it stays on the public site: it is a
  public page that loads `marked` from unpkg without an integrity hash and,
  in production, the RUM client. Decap's own preview pane still works.
  Bringing the button back needs a cross-origin transport (`postMessage` to a
  window the editor opened), which is not built.
- **A missing `/admin/` file is answered with the public `/404.html` on the
  admin origin** (the distribution's custom error response cannot vary by
  host), so a mistyped admin URL runs that page's scripts, RUM included, next
  to the token.
- **The editor's own content still runs in the admin origin.** Decap renders
  the markdown preview pane in a same-origin frame and the platform leaves
  Decap's `sanitize_preview` at its default (`false`), so an HTML embed
  (`editor-component-html-embed.js`) with an event-handler attribute, such as
  an `<img onerror>`, executes there when the entry is opened. `<script>`
  tags do not (they arrive through `innerHTML`). Anyone who can put content on
  a `cms/*` branch reaches every editor who opens it. Not verified in a
  browser here.
- **Per-PR preview admins are unchanged.** `preview-prN.<apex>` and
  `preview-cms-<slug>.<apex>` each serve their admin next to that build's
  public pages. Preview builds run with `JEKYLL_ENV=preview`, so they load no
  RUM client; but `/preview/` loads `marked` from unpkg with no integrity
  hash, and a draft's HTML embed is a real `<script>` on its rendered page. A
  token from a sign-in on a preview admin sits beside both. Drop the preview
  entry from `ALLOWED_ORIGINS` to refuse those sign-ins.
- **The e2e harness is unchanged.** Local lanes serve one origin, preview
  lanes drive preview admins, and the prod lanes go to `<apex>/admin/` and
  follow the 302: every spec seeds tokens with `page.addInitScript` (which
  runs on whatever origin the page lands on), and every `page.route` pattern
  is a host-agnostic glob. Admin-bundle parity fetches
  `<apex>/admin/…` with redirects followed, so it compares the same bytes.
  None of this has run against an opted-in site yet: the first prod loop
  after cut-over is the proof.

### Runbook, per site

Needs a release carrying this change, bumped into the site (`platform.lock`).
Run from the site repo with that site's AWS credentials.

```bash
# 0. The name is free (expect [])
aws route53 list-resource-record-sets --hosted-zone-id <zone-id> \
  --query "ResourceRecordSets[?Name=='admin.<apex>.']"

# 1. Site PR: _config.yml gains, under cms:
#      admin_origin: https://admin.<apex>
#    Merge and let it deploy. It is inert until the host serves the admin.

# 2. Proxy accepts BOTH origins during the switch. Edit it in
#    infrastructure/site-params.env (the deploy wrapper sources that file, so
#    it wins over an exported value), then deploy:
#      ALLOWED_ORIGINS="https://<apex>,https://admin.<apex>,https://preview-*.<apex>"
bash oauth-proxy/deploy.sh

# 3. Add ADMIN_DOMAIN=admin.<apex> to infrastructure/site-params.env (every
#    later bootstrap redeploy needs it too, or the host is turned off), then
#    redeploy the bootstrap stack the way docs/MEDIA-ARCHIVE.md step 3 does for
#    that site: a live apex keeps CREATE_APEX_DNS_RECORDS=true (a redeploy
#    without it DELETES the apex records), and STACK_NAME must name the
#    bootstrap stack, not the proxy's. The production certificate is replaced
#    (new SAN): allow several minutes.
bash infrastructure/bootstrap/deploy.sh

# 4. Verify with GET (curl -I sends HEAD, which the admin host serves on purpose)
hdr() { curl -s -o /dev/null -D - "$1" | grep -i -E '^(HTTP|location)'; }
hdr "https://<apex>/admin/"                    # 302, location: https://admin.<apex>/admin/
hdr "https://www.<apex>/admin/reviews/?q=a%26b" # 302, location keeps ?q=a%26b as sent
hdr "https://admin.<apex>/admin/"              # 200
hdr "https://admin.<apex>/blog/"               # 302, location: https://<apex>/blog/
hdr "https://admin.<apex>/"                    # 302, location: https://admin.<apex>/admin/
curl -s "https://admin.<apex>/admin/" | grep -o 'window.CMS_ADMIN_ORIGIN="[^"]*"'
echo | openssl s_client -connect admin.<apex>:443 -servername admin.<apex> 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName    # lists admin.<apex>

# 5. One real sign-in at https://admin.<apex>/admin/ and one at /admin/reviews/;
#    open a published post: "View page on site" names https://<apex>/...

# 6. Take the apex out of the proxy's list in site-params.env, then deploy:
#      ALLOWED_ORIGINS="https://admin.<apex>,https://preview-*.<apex>"
bash oauth-proxy/deploy.sh
```

7. **Every editor signs in again**: `localStorage` belongs to an origin, so
   nothing carries over. The old tokens are still in the apex's storage,
   readable by its scripts and valid (OAuth App tokens do not expire), so each
   editor also revokes the app at `https://github.com/settings/applications`
   before signing in on the new host.

**Rollback**: put the apex back in `ALLOWED_ORIGINS` and deploy the proxy,
then remove `ADMIN_DOMAIN` and rerun step 3 (the alias, record and function go;
the certificate is replaced again). The redirects are 302s, so no browser keeps
them. `cms.admin_origin` can stay: it is inert while the editor is served from
the apex. Editors sign in again on the apex.

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
