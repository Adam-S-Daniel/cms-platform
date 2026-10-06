# frozen_string_literal: true

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

# Jekyll::ExcludeE2EPosts.excluded_tag_names (#689 e2e / fixture tags).
require_relative 'exclude_e2e_posts'
# AutoTagPages.group: tags that differ only in case are ONE tag with ONE
# feed at /tags/<slug>/feed.xml, named like its archive page (#754).
require_relative 'auto_tag_pages'

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
          # e2e / test-fixture `_tags/` entries (#689, stamped by
          # exclude_e2e_posts.rb) get no public feed.
          excluded = Jekyll::ExcludeE2EPosts.excluded_tag_names(site)
          curated = (site.collections['tags']&.docs || [])
                    .filter_map { |d| d.data['name'] }
          # Skip e2e / test-fixture posts (feed_exclude stamped by
          # _plugins/exclude_e2e_posts.rb) so a tag carried ONLY by a
          # published canary never mints a public /tags/<slug>/feed.xml.
          # The per-tag feed body (_layouts/atom_feed.xml) also filters
          # feed_exclude, so even a tag shared with a real post never
          # lists the canary.
          public_posts = site.posts.docs.reject { |p| p.data['feed_exclude'] == true }
          post_tag_lists = public_posts.map { |p| Array(p.data['tags']) }
          slugify = ->(name) { Jekyll::Utils.slugify(name) }
          # One feed per slug, not per spelling (#754): `Quotes` and `quotes`
          # share a URL, and the second page would overwrite the first.
          groups = Jekyll::AutoTagPages.group(
            curated_names: curated, post_tag_lists: post_tag_lists, slugify: slugify,
          )
          excluded_slugs = excluded.map { |name| slugify.call(name) }
          groups.each do |slug, group|
            next if excluded_slugs.include?(slug)
            # A name with no `_tags/` entry whose slug starts `e2e-` (#689)
            # gets no feed either.
            next if !group['curated'] &&
                    Jekyll::ExcludeE2EPosts.e2e_tag_name?(group['name'], slugify: slugify)

            site.pages << FeedPage.new(site, group['name'])
          end
        end
      end
    end
  end
end
