# Decap CMS admin (platform base)

The site never hand-authors the ~400-line Decap config. The platform ships the
**base** config + the admin JS/HTML shell; a build step renders the live config
from the site's `_config.yml`.

## What the site provides (`_config.yml`)

```yaml
url: https://example.com
cms:
  repository: Adam-S-Daniel/example.com
  oauth_base_url: https://abc123.execute-api.us-east-1.amazonaws.com
  # logo_url: optional, defaults to <url>/assets/images/logo.svg
```

**The /admin logo is SITE-OWNED.** The gem ships only a NEUTRAL, wordless
placeholder at `assets/images/logo.svg` (never a specific site's brand). The
render below defaults `logo_url` to `<url>/assets/images/logo.svg`, so a site
that ships nothing shows that generic mark. To brand your `/admin`, ship your
own `assets/images/logo.svg` (it **shadows** the gem asset — `npx` scaffolds a
"replace me" placeholder there for you) or set `cms.logo_url` in `_config.yml`.

## Render

`scripts/render-decap-config.rb <site_root> <build_dir>` runs **after** the
Jekyll build and:

1. Renders `config.base.yml` → `config.yml` (and `config-local.base.yml` →
   `config-local.yml`) by substituting `{{CMS_REPO}}`, `{{CMS_OAUTH_BASE_URL}}`,
   `{{CMS_SITE_URL}}`, `{{CMS_DISPLAY_URL}}`, `{{CMS_LOGO_URL}}`. Text
   substitution keeps the base config's invariant comments intact.
2. Splices `admin/collections.site.yml` (if present) into the collections list
   at the `# __SITE_COLLECTIONS__` marker — the **opt-in structure** seam.
   Before splicing, any `$ref: "#/field_library/<name>"` entries in the seam
   are expanded against the platform-owned `field_library.yml` (see AGENTS.md
   "field_library + `$ref` reuse").
3. Applies the `cms.base_collections` keep-list (from the site's `_config.yml`),
   deleting unwanted top-level base collection blocks (`posts`/`tags`/`projects`/
   `pages`/`e2e`) before the config is written out (see AGENTS.md
   "base_collections opt-out").
4. Injects
   `<script>window.CMS_REPO=…;window.CMS_SITE_ORIGIN=…;window.CMS_ADMIN_ORIGIN=…;window.CMS_APEX=…;window.CMS_OAUTH_BASE_URL=…;window.CMS_SITE_TITLE=…;window.CMS_SITE_GATE=…;window.CMS_PRODUCTION_BRANCH=…</script>`
   into the built `admin/index*.html` **and** `admin/reviews/*.html`. The admin
   JS (and reviews dashboards) read these globals instead of hardcoded site
   identity. `not-found.html` is deliberately outside both globs: it is the
   opt-in admin host's answer to every miss (#517), shares an origin with the
   tokens, and must stay plain, script-free HTML
   (`theme/spec/admin_not_found_page_test.rb`).
5. Deletes the `*.base.yml` templates from the build output.

The theme gem (see `../theme`) wires this in as a Jekyll `:site, :post_write`
hook, so no per-site or per-workflow step is needed.

## window.CMS_* contract

| Global | From | Used by |
|---|---|---|
| `CMS_REPO` | `cms.repository` | deploy-status-pill, publish-via-auto-merge, live-url-banner, posts-list-enhance, oauth-app-restriction-detector, draft-media-fallback (only when the served config names no `backend.repo`), reviews dashboards |
| `CMS_SITE_ORIGIN` | `url` | site-hostname (`canonical()`, the production destination), posts-list-enhance, publish-button |
| `CMS_ADMIN_ORIGIN` | `cms.admin_origin`, lowercased, no trailing slash (`""` when unset) — the editor's own origin when it is not the site's (#517) | site-hostname (`publicOrigin()`, and `current()` names the site, not the admin host), live-url-derive (live URLs), index.html / index-local.html (hide Live Preview, whose `/preview/` tab is out of reach of a cross-origin Save broadcast); inert on `""` and on any other origin, so a preview admin is unchanged |
| `CMS_APEX` | host of `url` | site-hostname fallback, live-url-banner (preview-aware URL construction), posts-list-enhance (preview-host construction), reviews dashboards |
| `CMS_OAUTH_BASE_URL` | `cms.oauth_base_url` | the Decap config itself (`config.base.yml` backend `base_url`), reviews dashboards (OAuth login flow) |
| `CMS_SITE_TITLE` | the site's `_config.yml` `title` | admin shell `document.title` (index.html, index-local.html), reviews dashboards `document.title` |
| `CMS_SITE_GATE` | `cms.site_gate` (an OBJECT, serialized with `JSON.generate`; `null` when the site declares no gate) | site-gate-banner (the "`<host>` is in coming-soon mode" banner, read at the branch this admin is bound to; inert on `null`) |
| `CMS_PRODUCTION_BRANCH` | `backend.branch` of the config.yml the render path just wrote, read back with a real YAML parse (`""` if unreadable) — the branch the admin binds to when served UNPATCHED, i.e. from production | branch-binding-banner (compares it with the SERVED config.yml's `backend.branch`, which deploy-preview patches to the PR head, and says which branch a preview admin edits — #412; inert on `""`) |
| `CMS_BACKEND_BRANCH` | `commit.json` `branch` — set at runtime by index.html's commit-pill script, NOT by the render inject (the deploy workflows write commit.json at deploy time: `main` on prod, the PR head ref on a preview) | publish-via-auto-merge (scopes the delete-ref matcher's multi-segment recovery to the deployed backend branch, #114); unset (no/unreadable commit.json) ⇒ multi-segment recovery is disabled (fail closed) |

`config-test.yml` is domain-agnostic (local/test backend) and ships as-is.

Field labels and hints owned by the platform use the literal
`{{CMS_CURRENT_HOST}}` token. It deliberately survives both Ruby render paths:
preview deploys retain the canonical injected globals while serving the admin
from a different host. `site-hostname.js` replaces it only inside Decap's own
`FieldLabel` and `ControlHint` nodes (never in authored content), and it
means **the publishing destination** — where a publish from this admin goes —
not the address the admin was opened on (#533). The name is kept because a
site's own `collections.site.yml` may carry it.

`window.CMSHostname` (from `site-hostname.js`) keeps the three hosts apart:

| Function | Means | Production (apex, `www.`, CloudFront hostname) | Preview | Local shells |
|---|---|---|---|---|
| `current()` | the access host: where this tab was opened (the site's, on a separate admin origin) | that host, e.g. `www.<apex>` | `preview-prN.<apex>` | `localhost` |
| `canonical()` | the production destination, from `CMS_SITE_ORIGIN`, then `CMS_APEX`, and `current()` when neither is injected | `<apex>` | `<apex>` | `<apex>` |
| `destination()` | the destination of THIS admin: the host of `site_url` in the config.yml it serves (the site's `url`; `patch-preview-config.sh` rewrites it on a preview). `{{CMS_CURRENT_HOST}}` resolves to this | `<apex>` | `preview-prN.<apex>` | `localhost` |
| `destinationOrigin()` | the HTTP(S) origin of that same `site_url`, including protocol and port, with paths and credentials removed | `https://<apex>` | `https://preview-prN.<apex>` | `http://localhost:4000` |

The local and test shells name `localhost` on purpose: their configs
(`config-local.base.yml`, `config-test.yml`) set `site_url:
http://localhost:4000`, and a publish there writes to the working tree that
localhost serves. Until the served config has been read the token is left in
place rather than guessed (Decap needs the same file before it renders any
field, so the read settles first in practice). When it cannot be read, or has
not answered within 10 seconds, `destination()` is `current()`: right on a
preview, where `canonical()` would name production, and only cosmetically off
on a production `www.` or distribution hostname.

Publication URLs use `destinationOrigin()`. The publish button passes its
canonical fallback explicitly: `CMS_SITE_ORIGIN`, then `https://` plus
`CMS_APEX`. A served preview or local origin takes precedence; if the config
has not settled, is unreadable, or is not HTTP(S), the supplied site fallback
is used. Other callers that omit the argument retain the `publicOrigin()`
default (the injected public
site on a separate admin origin, otherwise this tab's origin). All callers
share the same cached config read. New-post slug-collision probes use the tab's
own origin so the browser can read the `HEAD` response; a cross-origin CORS
failure would otherwise silently treat an occupied address as free.

`CMSHostname.binding()` returns that same single read as `{ branch,
destination, destinationOrigin }` — `branch` is the served `backend.branch` at the line anchor
the patch script writes, `null` unless it is a plain git ref name.
`site-gate-banner.js` reads its flag at that branch (#528), names
`canonical()` when it is `CMS_PRODUCTION_BRANCH` and `destination()`
otherwise, caches per repository, branch, file and field, and shows nothing
when the branch or the flag cannot be read.

## Runtime override globals (test seams)

These are NOT injected by the render hook — they are optional `window.*`
overrides a shim reads at runtime (default when unset). They exist so the e2e
suite can exercise a slow real-time behaviour without waiting on the clock.

| Global | Read by | Default | Purpose |
|---|---|---|---|
| `__AUTOSAVE_IDLE_MS` | `autosave-on-hide.js` | `120000` (2 min) | Idle threshold (ms) after which a dirty entry autosaves. The `@admin-write` e2e spec sets it low via `addInitScript` to drive the idle path. Autosave (idle, tab-hide, pagehide) is skipped while a required text field is empty, so Decap's Save never paints "… IS REQUIRED." errors on an entry the owner has not tried to save (#625 item 3). |

The confirm-wrap (`confirm-wrap-local-backup.js`) + autosave
(`autosave-on-hide.js`) shims (#161) also expose read-only test surfaces —
`window.__confirmWrapLocalBackup` and `window.__autosaveOnHide` — for specs to
assert install / trigger the save-click. The confirm-wrap also puts the URL back
when an editor cancels Decap's leave prompt on a browser Back (#733): Decap
cannot restore a hash it did not push itself, and its Posts list rows are plain
anchors.
