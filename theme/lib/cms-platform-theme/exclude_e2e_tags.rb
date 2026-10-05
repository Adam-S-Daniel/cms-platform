# frozen_string_literal: true

require_relative 'exclude_e2e_posts'

#
# Keep e2e / test-fixture TAGS out of every PUBLIC aggregation surface
# while still serving them at their own /tags/<slug>/ URL. The tag
# counterpart of exclude_e2e_posts.rb.
#
# Why this exists (the leak it closes)
# ------------------------------------
# The tags lifecycle specs (`e2e/cms-tags-lifecycle*.spec.js`) create a
# run-stamped `_tags/e2e-tags-canary-<runId>.md` through Decap and delete
# it again. When that cleanup was skipped (adamdaniel.ai#4081), the
# leftover canary was live on the home page tag cloud, `/tags/`,
# `/sitemap.xml` and its own per-tag feed, with no `noindex`
# (cms-platform#689).
#
# The discriminator
# -----------------
# The same rule as posts (`ExcludeE2EPosts.e2e_fixture?`): a tag is an
# e2e / test fixture if its slug begins with `e2e-` OR its front matter
# sets `test_fixture: true`. For a `_tags/` entry the slug is an explicit
# `slug:` or the filename (the collection's `/tags/:slug/` permalink). For
# a tag NAME (a post's `tags:` value, or the `name` that the listings key
# on) it is the slugified name, which is the `/tags/<slug>/` it would get.
#
# What it stamps
# --------------
# On every matching `_tags/` entry (and, from auto_tag_pages.rb, on any
# generated archive page for an e2e tag name):
#   * `sitemap`      => false              — jekyll-sitemap drops the page.
#   * `feed_exclude` => true               — the shared marker the public
#                                            surfaces filter on.
#   * `robots`       => 'noindex,nofollow' — rendered by _layouts/default.html,
#                                            the value the `_e2e/` canary
#                                            collection uses.
#
# The generators then keep excluded names out of `site.all_tags` (the home
# page tag cloud and `/tags/` both iterate it), and tag_feeds.rb mints no
# `/tags/<slug>/feed.xml` for them.
#
# The matching tag page still BUILDS and SERVES at /tags/<slug>/: the
# tags lifecycle specs wait for it to return 200 after the create and 404
# after the delete. Nothing here touches `published`, the permalink, or
# whether Jekyll renders the page.
#
# Tests: spec/exclude_e2e_tags_test.rb and spec/exclude_e2e_tags_build_test.rb

module Jekyll
  module ExcludeE2ETags
    ROBOTS = 'noindex,nofollow'

    # The effective slug of a `_tags/` entry, matching what
    # `permalink: /tags/:slug/` resolves to: a non-empty explicit `slug:`
    # wins, else the filename basename (a non-posts collection strips no
    # date prefix).
    def self.effective_slug(data, relative_path)
      explicit = data.is_a?(Hash) ? data['slug'] : nil
      return explicit.strip if explicit.is_a?(String) && !explicit.strip.empty?

      return nil unless relative_path.is_a?(String) && !relative_path.empty?

      File.basename(relative_path, File.extname(relative_path))
    end

    # True when a tag NAME is an e2e / test fixture by its slug alone.
    # `slugify` is Jekyll::Utils.slugify in the build, a stub in the tests.
    def self.e2e_name?(name, slugify:)
      return false unless name.is_a?(String)

      ExcludeE2EPosts.e2e_fixture?(slug: slugify.call(name), test_fixture: nil)
    end

    # The tag names to keep out of public aggregation: the `name` of every
    # `_tags/` entry stamped `feed_exclude` by `apply`, plus every name in
    # `names` whose slug carries the e2e prefix. `curated` is the
    # `[{name, feed_exclude}, ...]` shape of the `_tags/` collection.
    def self.excluded_names(curated:, names:, slugify:)
      flagged = curated.select { |entry| entry['feed_exclude'] == true }.map { |entry| entry['name'] }
      by_slug = names.select { |name| e2e_name?(name, slugify: slugify) }
      (flagged + by_slug).compact.uniq
    end

    # Stamp the exclusion markers onto a page's front-matter Hash in place.
    def self.stamp(data)
      data['sitemap'] = false
      data['feed_exclude'] = true
      data['robots'] = ROBOTS
    end

    # Stamp a `_tags/` entry in place when it is an e2e / test fixture.
    # `doc` is anything exposing `.data` (a mutable Hash) and
    # `.relative_path` (a String): a Jekyll::Document, or a test double.
    def self.apply(doc)
      return unless doc.respond_to?(:data) && doc.data.is_a?(Hash)

      slug = effective_slug(doc.data, doc.respond_to?(:relative_path) ? doc.relative_path : nil)
      return unless ExcludeE2EPosts.e2e_fixture?(slug: slug, test_fixture: doc.data['test_fixture'])

      stamp(doc.data)
    end
  end
end

# Register the hook only when Jekyll is loaded, so the unit test can
# require_relative this file without Jekyll. `:site, :post_read` runs after
# every document's front matter is read and before any generator, as in
# exclude_e2e_posts.rb.
if defined?(Jekyll::Hooks)
  Jekyll::Hooks.register :site, :post_read do |site|
    site.collections['tags']&.docs&.each { |tag| Jekyll::ExcludeE2ETags.apply(tag) }
  end
end
