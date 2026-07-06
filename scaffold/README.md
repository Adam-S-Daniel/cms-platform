# Scaffolder

Creates a new cms-platform site (thin shell):

```bash
npx github:Adam-S-Daniel/cms-platform <target-dir> \
  --owner Adam-S-Daniel --repo example.com --domain example.com --title "Example"
# or interactively:
node scaffold/create-site.js <target-dir>
```

Generates `_config.yml` (identity + `cms:` block + `theme:`), `Gemfile` (pins the
theme gem in `:jekyll_plugins`), the thin workflow callers + `dependabot.yml`
(placeholders filled from your domain), seeds the site-owned seam reference
`admin/collections.site.yml.example` (the admin machinery itself ships inside the
`cms-platform-theme` gem — see `theme/admin/README.md` — so nothing else under
`admin/` is vendored per-site) and copies `.claude/skills`, seeds minimal content
(a post, an about page, the e2e canary, an index), writes
`infrastructure/site-params.env` and `platform.lock`, and prints the bootstrap +
DNS next steps.

## Seeded `preview.md` + `404.html` (issue #23)

Every new site is seeded with two consuming-site pages so the admin works out of
the box:

- **`preview.md`** (`permalink: /preview/`) — the live-preview surface the admin
  "Live Preview" button targets. It's **front-matter only**: the
  `cms-platform-theme` gem ships `theme/_layouts/preview.html`, which IS the
  preview shell (it hosts the hidden post/page/project layout variants the admin
  `preview-bridge` / `native-preview-href` scripts stream draft content into).
  Without this page the button dead-ends on a raw S3 404. The gem layout
  hardcodes `<meta name="robots" content="noindex, nofollow">`, so the seeded
  front-matter deliberately omits `robots` (a second one would duplicate the
  meta).
- **`404.html`** (`permalink: /404.html`) — a friendly, site-agnostic not-found
  page on the gem `default` layout, linking back to home + the blog, with
  `robots: noindex,nofollow` and `sitemap: false`.

The contract (scaffold output + the `e2e/fixture-site` carrying both, and the
built `_site/preview/index.html` + `_site/404.html` rendering the gem preview
shell) is locked by `e2e/scaffold-preview-and-404.test.js`.

**Single-page-site caveat:** for a single-page bio (e.g. jodidaniel.com) Decap's
per-item *live* preview is limited — there isn't a per-section route to drive
the bridge against. The seeded `preview.md` still gives a working `/preview/`
shell (so the admin button resolves) and the seeded `404.html` still gives a
graceful not-found page.
