---
name: admin-config-render
description: Understand and safely change how the Decap /admin config is built — the gem-shipped admin machinery, the build-time render hook, the site-owned collections seam, the window.CMS_* identity injection, and the base_collections opt-out. Use when editing theme/admin/* (config.base.yml, the JS/HTML shells, the reviews dashboards), changing the render hook or its CLI mirror, debugging why /admin renders wrong/missing collections or wrong identity, adding a per-site collection, or hiding the platform's built-in collections. Trigger on mentions of "admin config", "config.base.yml", "render-decap-config", "decap_config_hook", "collections.site.yml", "base_collections", "CMS_REPO / window.CMS_*", or "/admin shows the wrong collections".
---

# Admin config render (gem-shipped admin, v0.1.4+)

The Decap `/admin` UI is the ~400-line invariant-heavy CMS config plus JS/HTML
shells and the `reviews/` dashboards. As of **v0.1.4** it ships **inside the
`cms-platform-theme` gem** (`theme/admin/`) and is materialized into a site's
build output by a render step. A consuming site no longer vendors `admin/`; it
keeps only the seam `admin/collections.site.yml`.

Full mechanics live in **AGENTS.md -> "Admin delivery (gem-shipped, v0.1.4+)"**.
Read that before changing anything here. This skill is the working playbook.

## The two render paths (keep them in lockstep)

The live admin is produced by **two** code paths that MUST behave identically:

- **Build-time hook** — `theme/lib/cms-platform-theme/decap_config_hook.rb`, a
  Jekyll `:site, :post_write` hook. This is the path gem consumers use.
- **Deploy-time CLI** — `scripts/render-decap-config.rb <site_root> <build_dir>`,
  the mirror used by deploy workflows.

`e2e/decap-config-render-parity.test.js` **fails on drift** between them. If you
touch one, touch the other: the injected `window.CMS_*` globals must match, and
the copy globs (`index*` shells + the `reviews/*` subdir) must match.

Both do, in order:

1. **Resolve machinery inputs** — from the gem (`site.theme.root/admin` for the
   hook; `Gem.loaded_specs['cms-platform-theme']` for the CLI), falling back to a
   vendored `<site>/admin` for the migration window and the platform's own e2e
   fixture. No-op if neither has a `config.base.yml`.
2. **Copy gem-resident machinery into `_site/admin`** — Jekyll won't, since the
   site tree has no `admin/`. Copies depth-1 files + the `reviews/` subdir only,
   skipping `*.base.yml`, the seam, and `README.md`. **If you add a new
   subdirectory under `theme/admin/`, extend the copy in BOTH files** or it won't
   reach the served site.
3. **Render `config.yml` from `config.base.yml`** — `{{CMS_REPO}}`,
   `{{CMS_OAUTH_BASE_URL}}`, `{{CMS_SITE_URL}}`, `{{CMS_DISPLAY_URL}}`,
   `{{CMS_LOGO_URL}}` token-substituted from `_config.yml` (`url`, `cms.*`); then
   the site seam spliced at the `# __SITE_COLLECTIONS__` marker.
4. **Inject `window.CMS_*`** (`CMS_REPO`, `CMS_SITE_ORIGIN`, `CMS_APEX`,
   `CMS_OAUTH_BASE_URL`, `CMS_SITE_TITLE`) into `index*.html` AND `reviews/*.html`
   — skipping a file only if it already *defines* the identity, not merely uses
   it. Admin chrome reads identity from these globals; never hardcode it.
5. **Delete `*.base.yml`** from the output.

## The collections seam (site-owned, opt-in structure)

`admin/collections.site.yml` is read from the **SITE source**, never the gem
(the gem ships no `collections.site.yml`). A site adds/overrides content
collection types there; it's spliced at `# __SITE_COLLECTIONS__`. The platform's
e2e canary collection + editorial-workflow invariants stay platform-owned
(they're test infra, not content structure) and are NOT optional.

## base_collections opt-out (v0.1.7)

`_config.yml` `cms.base_collections` is a **KEEP-LIST** of the platform's
built-in collections (`posts tags projects pages e2e`):

- **UNSET** -> keep all (default, back-compat).
- `[]` -> hide all of them, so `/admin` shows ONLY the site's own collections
  (this is what single-page jodidaniel.com uses).
- a subset (e.g. `[posts]`) -> keep only those.

Both renderers delete each unwanted top-level collection block by regex —
matched at **2-space indent**, through to the next top-level `- name:` or EOF.
Nested fields are deeper-indented, so they survive (including a field literally
named like a base collection). **Spec-locked** by
`theme/spec/base_collections_filter_test.rb`. If the regex drifts (matches a
nested `- name:`, or eats a survivor's fields), `/admin` collections silently
break for every consumer that sets the option — run the spec after any change:
`ruby theme/spec/base_collections_filter_test.rb`.

## Consumer-context spec rule (don't read theme/admin in a consumer spec)

The e2e harness is reused by consumers (CONSUMER mode = `process.env.SITE_ROOT`
set). A spec that runs in consumer mode must NOT read admin from the platform
SOURCE tree (`theme/admin`) — consumers only have the gem-RENDERED `_site/admin`.
Read the **served bytes**: `await (await page.request.get('/admin/<file>')).text()`,
or `path.join(SITE_ROOT, '_site', 'admin', '<file>')`. Guarded by
`e2e/admin-spec-source-read-lint.test.js`; a genuinely platform-only spec goes
into `PLATFORM_META_SPECS` in `e2e/playwright.config.js`.

## Verify after changing the render

```bash
# CLI render against a throwaway site root that has _config.yml (+ optional seam)
ruby scripts/render-decap-config.rb <site_root> <site_root>/_site
# parity + base-collections specs
cd e2e && npx playwright test --project=chromium-light decap-config-render-parity.test.js
ruby theme/spec/base_collections_filter_test.rb
```

For local dev of the commit pill, `bash scripts/write-commit-json.sh` writes
`_site/admin/commit.json` (admin is served from `_site/admin/` now).

## Common symptoms -> cause

- **/admin shows collections the site shouldn't have** -> check `cms.base_collections`
  in `_config.yml`; UNSET keeps all the built-ins.
- **/admin missing the site's own collections** -> the seam
  `admin/collections.site.yml` isn't being read (it must live in the SITE source)
  or the `# __SITE_COLLECTIONS__` marker is gone from `config.base.yml`.
- **Wrong repo / OAuth URL / title in the admin chrome** -> `window.CMS_*` not
  injected (check the shell already-defines guard) or `_config.yml` identity wrong.
- **A new admin subdir doesn't reach the served site** -> the copy globs in the
  hook + CLI only copy depth-1 files and `reviews/`; extend BOTH.
- **A consumer e2e run ENOENTs on an admin file** -> a spec is reading `theme/admin`
  instead of the served/rendered bytes (see the consumer-context rule above).
