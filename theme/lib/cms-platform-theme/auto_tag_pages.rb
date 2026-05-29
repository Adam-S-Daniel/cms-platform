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
# that tag.
#
# Unit tests: _plugins_test/auto_tag_pages_test.rb

module Jekyll
  module AutoTagPages
    # Pure data shaping — kept Jekyll-free so the unit tests can call it
    # without booting a Jekyll site. The `slugify` proc lets the test
    # double in a stub; the real generator below passes Jekyll::Utils.slugify.
    def self.summarise(curated:, post_tag_lists:, slugify:)
      curated_names = curated.filter_map { |c| c['name'] }
      in_posts = post_tag_lists.flatten.compact.uniq
      missing = in_posts - curated_names
      all_names = (curated_names + in_posts).uniq.sort_by { |n| n.to_s.downcase }

      details = all_names.map do |name|
        curated_entry = curated.find { |c| c['name'] == name }
        {
          'name' => name,
          'slug' => slugify.call(name),
          'url' => "/tags/#{slugify.call(name)}/",
          'description' => curated_entry && curated_entry['description'],
          'count' => post_tag_lists.count { |list| Array(list).include?(name) },
        }
      end

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
          missing, all_tags = AutoTagPages.summarise(
            curated: curated_tags(site),
            # Skip e2e / test-fixture posts (feed_exclude stamped by
            # _plugins/exclude_e2e_posts.rb): their tags must not mint a
            # public /tags/<slug>/ archive, inflate a tag's count, or add a
            # tag-cloud pill. A canary tagged like a real post still serves
            # at /blog/<slug>/ — it just doesn't surface in tag aggregation.
            post_tag_lists: public_posts(site).map { |p| Array(p.data['tags']) },
            slugify: ->(name) { Jekyll::Utils.slugify(name) },
          )

          missing.each { |name| site.pages << TagPage.new(site, name) }
          site.config['all_tags'] = all_tags
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
