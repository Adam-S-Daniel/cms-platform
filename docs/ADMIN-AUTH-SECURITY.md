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
| Security headers | **In the template, not yet deployed** — [#515](https://github.com/Adam-S-Daniel/cms-platform/issues/515) | Both distributions send HSTS, `nosniff`, `Referrer-Policy` and same-origin framing once a site redeploys its bootstrap stack; `/admin/*` adds a CSP, Report-Only until `AdminCspMode=enforce`. Decap's `new Function` and the per-site inline scripts keep `script-src` loose; the gain is `connect-src`, `object-src`, `base-uri` and `frame-ancestors`. See [Security headers](#security-headers) below. |
| Narrower permissions | Deferred — [#516](https://github.com/Adam-S-Daniel/cms-platform/issues/516) | An OAuth App cannot be limited to one repository. The real narrowing is a GitHub App user token (site repo only, fine-grained, optionally expiring), which changes how every editor signs in. |
| A separate origin for the editor | Deferred — [#517](https://github.com/Adam-S-Daniel/cms-platform/issues/517) | Public pages share the origin, and so do their scripts (the CloudWatch RUM client is loaded from a floating `1.x` path). Moving `/admin` to its own host takes the token out of their reach, and moves a URL most of the e2e harness depends on. |
| Dashboards keeping their own copy (`gh_reviews_token`) | Left as is | Decap's own `decap-cms-user` sits beside it on the same origin, so dropping or moving the second copy would not shrink what a script can read. |

## Security headers

`infrastructure/bootstrap/template.yaml` attaches two response headers
policies, `<prefix>-baseline-headers` on each distribution's default behavior
and `<prefix>-admin-headers` on an `/admin/*` behavior that is otherwise a
copy of the default (same origin, cache policy and functions;
`e2e/cloudfront-security-headers.test.js` holds them equal).

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
