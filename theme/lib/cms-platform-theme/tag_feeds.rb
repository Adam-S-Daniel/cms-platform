# frozen_string_literal: true

require_relative 'exclude_e2e_tags'

#
# Emit an Atom feed at /tags/<slug>/feed.xml for every tag referenced by
# any post. Mirrors jekyll-feed's shape so the same readers parse both.
#
# The actual XML body lives in _layouts/atom_feed.xml so we can iterate
# on the markup in Liquid; this generator only registers a Jekyll::Page
# per tag pointing at that layout.
#
# Tags are collected straight from posts (rather than reading
# `site.config["all_tags"]` left by auto_tag_pages.rb) so this plugin is
# order-independent and works even if auto_tag_pages runs after us.

if defined?(Jekyll::Generator)
  module Jekyll
    module TagFeeds
      class FeedPage < Jekyll::Page
        def initialize(site, name)
          @site = site
          @base = site.source
          slug = Jekyll::Utils.slugify(name)
          @dir = "tags/#{slug}/"
          @name = 'feed.xml'
          @basename = 'feed'
          @ext = '.xml'
          process(@name)
          @data = {
            'layout' => 'atom_feed',
            'tag_name' => name,
            'permalink' => "/tags/#{slug}/feed.xml",
            'sitemap' => false,
          }
        end

        def url_placeholders
          { path: @dir, basename: @basename, output_ext: @ext }
        end
      end

      class Generator < Jekyll::Generator
        safe true
        priority :low

        def generate(site)
          curated_docs = site.collections['tags']&.docs || []
          curated = curated_docs.filter_map { |d| d.data['name'] }
          # Skip e2e / test-fixture posts (feed_exclude stamped by
          # _plugins/exclude_e2e_posts.rb) so a tag carried ONLY by a
          # published canary never mints a public /tags/<slug>/feed.xml.
          # The per-tag feed body (_layouts/atom_feed.xml) also filters
          # feed_exclude, so even a tag shared with a real post never
          # lists the canary.
          public_posts = site.posts.docs.reject { |p| p.data['feed_exclude'] == true }
          from_posts = public_posts.flat_map { |p| Array(p.data['tags']) }.compact
          names = (curated + from_posts).uniq
          # No feed for an e2e / test-fixture tag (exclude_e2e_tags.rb):
          # a `_tags/` entry it stamped, or a name with the e2e- slug.
          excluded = ExcludeE2ETags.excluded_names(
            curated: curated_docs.map { |d| { 'name' => d.data['name'], 'feed_exclude' => d.data['feed_exclude'] } },
            names: names,
            slugify: ->(name) { Jekyll::Utils.slugify(name) },
          )
          (names - excluded).each do |name|
            site.pages << FeedPage.new(site, name)
          end
        end
      end
    end
  end
end
