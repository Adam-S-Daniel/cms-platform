# frozen_string_literal: true

#
# Keep e2e / test-fixture posts out of every PUBLIC aggregation surface
# while still serving them at their own /blog/<slug>/ URL.
#
# Why this exists (the leak it closes)
# ------------------------------------
# The dedicated `_e2e/` COLLECTION is deliberately excluded from public
# aggregation (see `_config.yml`: separate `/e2e/:slug/` permalink,
# `sitemap: false`, `robots: noindex,nofollow`). But the CMS publish-loop
# specs ALSO drive ephemeral fixtures through the PUBLIC `posts`
# collection — `_posts/2099-12-31-e2e-prod-mutate-<runId>.md`,
# `_posts/2099-12-31-e2e-media-roundtrip-<runId>.md`, and the persistent
# `_posts/2024-01-02-e2e-unpublish-canary.md`. Those live in `site.posts`,
# so once a spec flips `published: true` they leak into the Atom feed
# (`/feed.xml`), the homepage / blog listings, the tag archives + per-tag
# feeds, and the sitemap. The site owner saw "E2E Media Roundtrip <runId>"
# and "E2E Unpublish Canary" land in their RSS reader.
#
# The discriminator
# -----------------
# A post is an e2e / test fixture if EITHER:
#   * its slug begins with `e2e-`  (the Jekyll slug of
#     `_posts/<date>-e2e-….md` is `e2e-…`), OR
#   * its front matter sets `test_fixture: true`.
#
# The SLUG SIGNATURE is the reliable one: a Decap "+ New Post" UI create
# only writes the `posts`-collection fields and CANNOT set the
# `test_fixture` / `hidden` field, so a UI-created e2e fixture has the
# `e2e-`-prefixed slug but no flag. Matching on the slug catches it.
# This mirrors the codebase-wide fixture detector used in the e2e specs
# (e.g. `e2e/prod-mutate-fixture.js`, `e2e/visual-regression.spec.js`'s
# `slug.startsWith("e2e-")`, and `e2e/sitemap.spec.js`).
#
# What it stamps
# --------------
# For every matching post this sets, on the post's own front-matter data:
#   * `sitemap`      => false  — jekyll-sitemap drops any page with this.
#   * `feed_exclude` => true   — the marker every other PUBLIC surface
#                                filters on (the custom `feed.xml`, the
#                                per-tag `_layouts/atom_feed.xml`, the
#                                homepage `index.html`, `blog/index.html`,
#                                `_layouts/tag.html`, and the tag
#                                generators in `_plugins/auto_tag_pages.rb`
#                                / `_plugins/tag_feeds.rb`).
#
# Stamping a single shared marker is what lets all those surfaces agree
# without each re-deriving the slug rule and drifting apart. Posts that
# already ship `sitemap: false` / `test_fixture: true` are still stamped
# (idempotent), which is how the UI-created fixtures that lack the flag
# get covered too.
#
# The matching post still BUILDS and SERVES at /blog/<slug>/ — nothing
# here touches `published`, the permalink, or whether Jekyll renders the
# page. The prod-loop specs rely on the published canary returning 200 at
# its direct URL (then 404 after delete); this plugin must not change
# that, and does not.
#
# Unit tests: spec/exclude_e2e_posts_test.rb

module Jekyll
  module ExcludeE2EPosts
    # Jekyll strips a `_posts/YYYY-MM-DD-` filename prefix to form the
    # default slug. Mirror that here so we can derive the slug from the
    # path without depending on Jekyll having computed `data['slug']` yet.
    DATE_PREFIX = /\A\d{4}-\d{2}-\d{2}-/
    E2E_SLUG_PREFIX = /\Ae2e-/

    # The effective slug for a post, matching what `permalink: /blog/:slug/`
    # resolves to:
    #   * a non-empty explicit `slug:` in front matter wins; otherwise
    #   * the filename basename with the date prefix stripped.
    # `data` is the post's front-matter Hash; `relative_path` is the
    # repo-relative source path (e.g. `_posts/2099-12-31-e2e-foo.md`).
    def self.effective_slug(data, relative_path)
      explicit = data.is_a?(Hash) ? data['slug'] : nil
      return explicit.strip if explicit.is_a?(String) && !explicit.strip.empty?

      return nil unless relative_path.is_a?(String) && !relative_path.empty?

      basename = File.basename(relative_path, File.extname(relative_path))
      basename.sub(DATE_PREFIX, '')
    end

    # True when a post is an e2e / test fixture and must be excluded from
    # public aggregation. `slug` is the effective slug (may be nil);
    # `test_fixture` is the raw front-matter value.
    def self.e2e_fixture?(slug:, test_fixture:)
      return true if test_fixture == true
      return false unless slug.is_a?(String)

      E2E_SLUG_PREFIX.match?(slug)
    end

    # Stamp the exclusion markers onto a post-like object in place.
    # `doc` is anything exposing `.data` (a mutable Hash) and
    # `.relative_path` (a String) — a Jekyll::Document, or a test double.
    # No-ops for non-fixtures and for objects without a data Hash.
    def self.apply(doc)
      return unless doc.respond_to?(:data) && doc.data.is_a?(Hash)

      slug = effective_slug(doc.data, doc.respond_to?(:relative_path) ? doc.relative_path : nil)
      return unless e2e_fixture?(slug: slug, test_fixture: doc.data['test_fixture'])

      # Drop from sitemap.xml (jekyll-sitemap honours `sitemap: false`)
      # and mark for every Liquid-driven public surface to filter on.
      doc.data['sitemap'] = false
      doc.data['feed_exclude'] = true
    end
  end
end

# Register the hook only when Jekyll is actually loaded — the unit test
# require_relatives this file without Jekyll on the load path, and the
# pure module methods above must stay callable in that context.
#
# `:posts, :post_init` fires once per post as its Document is initialised
# (front matter parsed). Stamping here, before any generator runs or any
# template renders, guarantees every downstream surface — the feed page,
# the sitemap plugin, the tag generators, and the listing templates —
# sees the marker.
if defined?(Jekyll::Hooks)
  Jekyll::Hooks.register :posts, :post_init do |post|
    Jekyll::ExcludeE2EPosts.apply(post)
  end
end
