# frozen_string_literal: true

#
# Surface every tag referenced by a post — even ones the editor never
# created a `_tags/` entry for — as a real `/tags/<slug>/` archive page,
# and expose a sorted master list to templates as `site.all_tags`.
#
# Without this, a post that ships with `tags: [AI Engineering]` but no
# matching `_tags/ai-engineering.md` produces a tag pill that 404s and
# leaves the tag invisible on the `/tags/` index. The CMS strongly
# encourages picking from `_tags/` entries (the post-side widget is a
# `relation`), but historical posts and YAML edits can still introduce
# orphan tags — generating the page makes the site self-healing.
#
# `site.all_tags` is `[{name, slug, url, description, count}, ...]` sorted
# case-insensitively by name. `description` comes from the `_tags/` entry
# when one exists, else nil. `count` is the number of posts referencing
# that tag under any spelling.
#
# Tags that differ only in case (`quotes` / `Quotes`) slugify alike, so
# they are ONE tag (#754): one row, one archive page, one combined count.
# The display name is the `_tags/` entry's when there is one, else the
# spelling the most posts use, a tie going to the one seen first (see
# `AutoTagPages.group`). `site.tag_posts_by_slug` (slug => posts, built once
# here) is what `_layouts/tag.html` and `_layouts/atom_feed.xml` list: every
# post whose tags slugify to the page's slug.
#
# Unit tests: _plugins_test/auto_tag_pages_test.rb

# Jekyll::ExcludeE2EPosts.excluded_tag_names (#689 e2e / fixture tags).
require_relative 'exclude_e2e_posts'

module Jekyll
  module AutoTagPages
    # Group every spelling of a tag under its slug (#754). `Quotes` and
    # `quotes` slugify alike, so they share one `/tags/<slug>/` URL: they are
    # ONE tag, with one archive, one card and one count, whatever spelling a
    # post used. Returns `{ slug => { 'name', 'variants', 'curated' } }` in
    # first-seen order (curated entries first, then posts in the order given).
    #
    # The display `name` is deterministic:
    #   1. a `_tags/` entry's name wins (the editor chose it, and the archive
    #      page it builds is headed with it); the first such entry in a
    #      collision;
    #   2. else the spelling used by the MOST posts;
    #   3. a tie goes to the spelling seen first.
    # `variants` lists every spelling, first seen first.
    def self.group(curated_names:, post_tag_lists:, slugify:)
      groups = {}
      curated_names.compact.each do |name|
        group = groups[slugify.call(name)] ||= { 'variants' => [], 'curated' => [] }
        group['curated'] << name unless group['curated'].include?(name)
        group['variants'] << name unless group['variants'].include?(name)
      end

      uses = Hash.new(0)
      post_tag_lists.each do |list|
        Array(list).compact.uniq.each do |name|
          uses[name] += 1
          group = groups[slugify.call(name)] ||= { 'variants' => [], 'curated' => [] }
          group['variants'] << name unless group['variants'].include?(name)
        end
      end

      groups.transform_values do |group|
        # max_by returns the first maximum, which is the first seen.
        most_used = group['variants'].max_by { |name| uses[name] }
        {
          'name' => group['curated'].first || most_used,
          'variants' => group['variants'],
          'curated' => !group['curated'].empty?,
        }
      end
    end

    # Every public post under each tag slug: `{ slug => [post, ...] }`, posts
    # in the order given, each once per slug even when it carries both
    # spellings. The Jekyll generator stores it as `site.tag_posts_by_slug`
    # so `_layouts/tag.html` and `atom_feed.xml` list a tag's posts with one
    # lookup, not by slugifying every tag of every post on every tag page.
    def self.posts_by_slug(posts, slugify:)
      posts.each_with_object({}) do |post, index|
        Array(post.data['tags']).compact.map { |name| slugify.call(name) }.uniq.each do |slug|
          (index[slug] ||= []) << post
        end
      end
    end

    # Pure data shaping — kept Jekyll-free so the unit tests can call it
    # without booting a Jekyll site. The `slugify` proc lets the test
    # double in a stub; the real generator below passes Jekyll::Utils.slugify.
    #
    # Returns `[missing, details]`: `missing` is the display name of every tag
    # that has no `_tags/` entry (one per slug, so one archive page to mint),
    # `details` the `site.all_tags` rows, one per slug (see `group`).
    def self.summarise(curated:, post_tag_lists:, slugify:)
      curated_names = curated.filter_map { |c| c['name'] }
      groups = group(curated_names: curated_names, post_tag_lists: post_tag_lists, slugify: slugify)
      missing = groups.values.reject { |g| g['curated'] }.map { |g| g['name'] }

      details = groups.map do |slug, g|
        curated_entry = curated.find { |c| c['name'] == g['name'] }
        {
          'name' => g['name'],
          'slug' => slug,
          'url' => "/tags/#{slug}/",
          'description' => curated_entry && curated_entry['description'],
          # Posts, not mentions: a post carrying both spellings counts once.
          'count' => post_tag_lists.count do |list|
            Array(list).any? { |n| g['variants'].include?(n) }
          end,
        }
      end
      details.sort_by! { |d| [d['name'].to_s.downcase, d['slug']] }

      [missing, details]
    end
  end
end

# ── Jekyll integration ─────────────────────────────────────────────────────
#
# Guarded so the unit-test harness can `require_relative` this file
# without Jekyll on the load path.
if defined?(Jekyll::Generator)
  module Jekyll
    module AutoTagPages
      class TagPage < Jekyll::Page
        def initialize(site, name)
          @site = site
          @base = site.source
          slug = Jekyll::Utils.slugify(name)
          @dir = "tags/#{slug}/"
          @name = 'index.html'
          @basename = 'index'
          @ext = '.html'
          process(@name)
          @data = {
            'layout' => 'tag',
            'tag_name' => name,
            'title' => name,
            'permalink' => "/tags/#{slug}/",
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
          excluded = Jekyll::ExcludeE2EPosts.excluded_tag_names(site)
          # Judged by slug, like the grouping: a case variant of an excluded
          # `_tags/` entry is the same tag and must not mint a second page at
          # the entry's own /tags/<slug>/ (#754).
          excluded_slugs = excluded.map { |name| Jekyll::Utils.slugify(name) }
          excluded_tag = ->(name) { excluded_slugs.include?(Jekyll::Utils.slugify(name)) }
          missing, all_tags = AutoTagPages.summarise(
            curated: curated_tags(site).reject { |c| excluded_tag.call(c['name']) },
            # Skip e2e / test-fixture posts (feed_exclude stamped by
            # _plugins/exclude_e2e_posts.rb): their tags must not mint a
            # public /tags/<slug>/ archive, inflate a tag's count, or add a
            # tag-cloud pill. A canary tagged like a real post still serves
            # at /blog/<slug>/ — it just doesn't surface in tag aggregation.
            # e2e / test-fixture `_tags/` entries (#689) are dropped the same
            # way: no tag-cloud or /tags/ entry, and no count.
            post_tag_lists: public_posts(site).map { |p| Array(p.data['tags']).reject { |n| excluded_tag.call(n) } },
            slugify: ->(name) { Jekyll::Utils.slugify(name) },
          )

          # A name with no `_tags/` entry whose slug starts `e2e-` (#689)
          # still gets its archive, so a real post's pill does not 404, but
          # stamped noindex / out of the sitemap and left out of
          # `site.all_tags` (the tag cloud and /tags/).
          slugify = ->(name) { Jekyll::Utils.slugify(name) }
          e2e_names = missing.select { |name| Jekyll::ExcludeE2EPosts.e2e_tag_name?(name, slugify: slugify) }
          missing.each do |name|
            page = TagPage.new(site, name)
            Jekyll::ExcludeE2EPosts.stamp_tag_page(page.data) if e2e_names.include?(name)
            site.pages << page
          end
          # Not minus `excluded`: an excluded `_tags/` entry's page still builds
          # and lists the posts that carry its tag. Newest first, the order
          # Liquid's `site.posts` has (`docs` is oldest first).
          site.config['tag_posts_by_slug'] = AutoTagPages.posts_by_slug(
            public_posts(site).reverse, slugify: slugify,
          )
          site.config['all_tags'] = all_tags.reject { |tag| e2e_names.include?(tag['name']) }
        end

        private

        # Posts that count for PUBLIC tag aggregation — every post minus
        # the e2e / test fixtures marked `feed_exclude` by
        # _plugins/exclude_e2e_posts.rb.
        def public_posts(site)
          site.posts.docs.reject { |p| p.data['feed_exclude'] == true }
        end

        # Shape the `_tags/` collection (if any) into the `[{name,
        # description}, ...]` list `summarise` expects.
        def curated_tags(site)
          collection = site.collections['tags']
          return [] unless collection

          collection.docs.map do |doc|
            {
              'name' => doc.data['name'],
              'description' => doc.data['description'],
            }
          end
        end
      end
    end
  end
end
