# cms-platform-theme

The Jekyll theme gem for cms-platform sites: layouts, includes, structural
assets, the platform plugins, and the Decap config render hook. Branding comes
from the site's `_config.yml` (`site.title`, `site.author.name`) via Liquid —
nothing is hardcoded to a specific site.

## Use in a site

`Gemfile`:

```ruby
group :jekyll_plugins do
  gem "cms-platform-theme"   # provides the theme AND loads its plugins + Decap hook
end
```

`_config.yml`:

```yaml
theme: cms-platform-theme
title: Example
author: { name: Example }
url: https://example.com
cms:
  repository: Adam-S-Daniel/example.com
  oauth_base_url: https://abc123.execute-api.us-east-1.amazonaws.com
```

## What it ships

- `_layouts/`, `_includes/` — merged in by Jekyll's theme support.
- `assets/` — `css/main.css`, `js/marked.min.js`, a **neutral, wordless
  placeholder** `images/logo.svg`, plus the `images/uploads` + `widgets` dirs.
  The logo is **site-owned**: the gem ships only a generic placeholder (never a
  specific site's brand), and the Decap render defaults `cms.logo_url` to
  `<url>/assets/images/logo.svg`. A site brands its `/admin` by shipping its own
  `assets/images/logo.svg` (Jekyll **shadows** the gem asset with the site's
  file) or by setting `cms.logo_url` in `_config.yml`. The `npx` scaffolder seeds
  a "replace me" copy of the placeholder into every new site.
- `lib/cms-platform-theme/` — the plugins (`auto_tag_pages`, `cachebust_filter`,
  `exclude_e2e_posts`, `normalize_empty_slug`, `tag_feeds`) and
  `decap_config_hook` (a `post_write` hook that runs the Decap render — see
  `admin/README.md`). `exclude_e2e_posts` keeps e2e / test-fixture posts (slug
  starts with `e2e-` or `test_fixture: true`) out of every public aggregation
  surface (feed, sitemap, tag archives + per-tag feeds, listings) by stamping a
  shared `feed_exclude`/`sitemap: false` marker, while the post still serves at
  its own `/blog/<slug>/` URL.

Updates flow to sites via a gem-version bump (Dependabot, `bundler` ecosystem).
