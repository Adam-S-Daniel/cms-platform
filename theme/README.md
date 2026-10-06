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
- `assets/` — `css/main.css`, `js/marked.min.js`, the CloudWatch RUM client
  `js/aws-rum-web/cwr-<version>.js` (vendored, hash-locked; see
  `docs/ADMIN-AUTH-SECURITY.md`), a **neutral, wordless
  placeholder** `images/logo.svg`, plus an empty `widgets/` directory (reserved
  for future Decap custom-widget assets; unused today). Site-uploaded media
  (Decap's `media_folder`) lives in the consuming SITE, not the gem.
  The logo is **site-owned**: the gem ships only a generic placeholder (never a
  specific site's brand), and the Decap render defaults `cms.logo_url` to
  `<url>/assets/images/logo.svg`. A site brands its `/admin` by shipping its own
  `assets/images/logo.svg` (Jekyll **shadows** the gem asset with the site's
  file) or by setting `cms.logo_url` in `_config.yml`. The `npx` scaffolder seeds
  a "replace me" copy of the placeholder into every new site.
- `lib/cms-platform-theme/` — the plugins (`auto_tag_pages`, `cachebust_filter`,
  `exclude_e2e_posts`, `feed_stylesheet`, `normalize_empty_slug`, `seo_image`, `tag_feeds`) and
  `decap_config_hook` (a `post_write` hook that runs the Decap render — see
  `admin/README.md`). `feed_stylesheet` adds an
  `<?xml-stylesheet?>` instruction to every Atom feed (the per-tag feeds, jekyll-feed's
  `/feed.xml` and a site-owned one) pointing at the gem's same-origin `assets/feed.xsl`, so a visitor who
  clicks the RSS icon sees a "copy this address into your feed reader" page instead of
  raw XML (#728); readers ignore it, and a feed that already names a stylesheet keeps it
  ([build regression](spec/feed_stylesheet_test.rb)). `seo_image` maps a post's `featured_image:` to the `image:`
  jekyll-seo-tag reads (og:image / twitter:image, large card), falling back to an optional
  site-wide `default_image:` in `_config.yml`; an explicit `image:` wins.
  `exclude_e2e_posts` keeps e2e / test-fixture posts (slug
  starts with `e2e-` or `test_fixture: true`) out of every public aggregation
  surface (feed, sitemap, tag archives + per-tag feeds, listings) by stamping a
  shared `feed_exclude`/`sitemap: false` marker, while the post still serves at
  its own `/blog/<slug>/` URL. The marker is stamped at the site's `post_read`
  hook, after front matter is loaded and before generators run, so an explicit
  `slug` or `test_fixture: true` is honored. The
  [real Jekyll build regression](spec/exclude_e2e_posts_build_test.rb) checks
  both discriminators, public aggregation, and direct post output.
  It applies the same rule to `_tags/` entries (#689): an `e2e-` or
  `test_fixture: true` tag stays out of `site.all_tags` (the tag cloud and
  `/tags/`), the sitemap and the per-tag feeds, and its page still builds with
  `robots: noindex,nofollow`. A tag that is only a name in a post's `tags:`
  list, with no `_tags/` entry, is judged by its slugified name: an `e2e-` one
  gets the same treatment, even on a real post
  ([build regression](spec/exclude_e2e_tags_build_test.rb)).

Updates flow to sites via a gem-version bump — `platform-bump`'s job, not
Dependabot's: since #242, Dependabot's `bundler` ecosystem carries an explicit
`ignore` for this gem (see `docs/SYNC.md` in cms-platform).
