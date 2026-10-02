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
origin, and it is an OAuth App token: scope `repo,user,workflow` (or
`repo,read:user,workflow` from a proxy deployed after #516), every repository
the editor can reach, no expiry. A script that should not be there
is therefore expensive. What was weighed:

| Measure | Status | Why |
|---|---|---|
| Subresource Integrity on the Decap bundle | **Shipped.** All three shells load `decap-cms` from unpkg with `integrity` + `crossorigin`; `e2e/admin-pin-invariant.test.js` locks it. | It is the only third-party script in the admin, and it runs with the token in reach. The browser now refuses a bundle whose bytes differ from the release that was reviewed. |
| Security headers | Deferred — [#515](https://github.com/Adam-S-Daniel/cms-platform/issues/515) | CloudFront serves none. HSTS, `nosniff` and `frame-ancestors` are cheap; a CSP for `/admin` has to live with Decap's `new Function` and inline styles. Needs a bootstrap-stack deploy per site and a live publish loop to prove it. |
| Narrower permissions | Evaluated, spike pending — [#516](https://github.com/Adam-S-Daniel/cms-platform/issues/516); `read:user` replaces `user` in the proxy's default scope | An OAuth App cannot be limited to one repository. The real narrowing is a GitHub App user token (site repo only, fine-grained, optionally expiring), which changes how every editor signs in. The source evaluation, the minimal permission set and the spike kit are in [GitHub App sign-in](#github-app-sign-in-516) below. |
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
