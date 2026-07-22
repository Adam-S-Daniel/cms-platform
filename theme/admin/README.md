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
   `<script>window.CMS_REPO=…;window.CMS_SITE_ORIGIN=…;window.CMS_APEX=…;window.CMS_OAUTH_BASE_URL=…;window.CMS_SITE_TITLE=…</script>`
   into the built `admin/index*.html` **and** `admin/reviews/*.html`. The admin
   JS (and reviews dashboards) read these globals instead of hardcoded site
   identity.
5. Deletes the `*.base.yml` templates from the build output.

The theme gem (see `../theme`) wires this in as a Jekyll `:site, :post_write`
hook, so no per-site or per-workflow step is needed.

## window.CMS_* contract

| Global | From | Used by |
|---|---|---|
| `CMS_REPO` | `cms.repository` | deploy-status-pill, publish-via-auto-merge, live-url-banner, posts-list-enhance, oauth-app-restriction-detector, reviews dashboards |
| `CMS_SITE_ORIGIN` | `url` | posts-list-enhance |
| `CMS_APEX` | host of `url` | live-url-banner, posts-list-enhance (preview-host construction), reviews dashboards |
| `CMS_OAUTH_BASE_URL` | `cms.oauth_base_url` | the Decap config itself (`config.base.yml` backend `base_url`), reviews dashboards (OAuth login flow) |
| `CMS_SITE_TITLE` | the site's `_config.yml` `title` | admin shell `document.title` (index.html, index-local.html), reviews dashboards `document.title` |
| `CMS_BACKEND_BRANCH` | `commit.json` `branch` — set at runtime by index.html's commit-pill script, NOT by the render inject (the deploy workflows write commit.json at deploy time: `main` on prod, the PR head ref on a preview) | publish-via-auto-merge (scopes the delete-ref matcher's multi-segment recovery to the deployed backend branch, #114); unset (no/unreadable commit.json) ⇒ multi-segment recovery is disabled (fail closed) |

`config-test.yml` is domain-agnostic (local/test backend) and ships as-is.
