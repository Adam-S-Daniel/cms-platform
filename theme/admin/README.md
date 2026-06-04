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
3. Injects `<script>window.CMS_REPO=…;window.CMS_SITE_ORIGIN=…;window.CMS_APEX=…</script>`
   into the built `admin/index*.html`. The admin JS reads these globals instead
   of hardcoded site identity.
4. Deletes the `*.base.yml` templates from the build output.

The theme gem (see `../theme`) wires this in as a Jekyll generator, so no
per-site or per-workflow step is needed.

## window.CMS_* contract

| Global | From | Used by |
|---|---|---|
| `CMS_REPO` | `cms.repository` | deploy-status-pill, publish-via-auto-merge, live-url-banner, posts-list-enhance |
| `CMS_SITE_ORIGIN` | `url` | posts-list-enhance |
| `CMS_APEX` | host of `url` | live-url-banner, posts-list-enhance (preview-host construction) |

`config-test.yml` is domain-agnostic (local/test backend) and ships as-is.
