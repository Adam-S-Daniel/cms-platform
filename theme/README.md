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
- `assets/` — `css/main.css`, `js/marked.min.js`, a placeholder `images/logo.svg`
  (override per site), plus the `images/uploads` + `widgets` dirs.
- `lib/cms-platform-theme/` — the plugins (`auto_tag_pages`, `cachebust_filter`,
  `normalize_empty_slug`, `tag_feeds`) and `decap_config_hook` (a `post_write`
  hook that runs the Decap render — see `admin/README.md`).

Updates flow to sites via a gem-version bump (Dependabot, `bundler` ecosystem).
