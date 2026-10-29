# frozen_string_literal: true

# Give jekyll-seo-tag the preview image it can't find on its own (#655).
#
# jekyll-seo-tag reads only a page's `image:` key for og:image / twitter:image
# (and picks twitter:card=summary_large_image only when one exists). The CMS's
# post collection writes `featured_image:`, so no page had an image and shared
# links (LinkedIn, Mastodon, Bluesky) showed no picture.
#
# For every page and document without its own `image:`, this sets it from:
#   1. `featured_image:`            (the post's own image), else
#   2. `default_image:` in _config.yml (a site-wide fallback; optional).
# An explicit `image:` always wins, and nothing is set when neither exists, so
# a site with no images keeps its summary card. jekyll-seo-tag makes the path
# absolute against `url` + `baseurl`.
#
# When the image comes from `featured_image:` and the item also has a
# non-blank `featured_image_alt:`, `image` is set to the hash form
# `{ 'path' => ..., 'alt' => ... }` instead, which jekyll-seo-tag reads for
# og:image:alt / twitter:image:alt (og:image is the same absolute URL either
# way). The site-wide `default_image` never takes a post's alt. Only on
# jekyll-seo-tag 2.9.1 or later: 2.9.0 writes image.alt into the meta tags and
# JSON-LD unescaped, so a quote in the alt would break them; on 2.9.0 the image
# stays a plain path and only the post's hero <img> (escaped by the layout)
# carries the alt.
#
# Tests: spec/seo_image_build_test.rb

module Jekyll
  module SeoImage
    def self.blank?(value)
      value.nil? || (value.respond_to?(:empty?) && value.empty?)
    end

    # `item` is a Jekyll::Page or Jekyll::Document; `default_image` is the
    # site-wide fallback (or nil).
    def self.apply(item, default_image)
      return unless blank?(item.data['image'])

      featured = item.data['featured_image']
      if present_string?(featured)
        alt = item.data['featured_image_alt']
        item.data['image'] =
          present_string?(alt) && image_alt_supported? ? { 'path' => featured, 'alt' => alt.strip } : featured
      elsif present_string?(default_image)
        item.data['image'] = default_image
      end
    end

    # 2.9.1 added escape_once / seo_json_escape around image.alt.
    def self.image_alt_supported?
      spec = Gem.loaded_specs['jekyll-seo-tag']
      !spec.nil? && spec.version >= Gem::Version.new('2.9.1')
    end

    def self.present_string?(value)
      value.is_a?(String) && !value.strip.empty?
    end
  end
end

if defined?(Jekyll::Hooks)
  # :post_read fires once per site after front matter is parsed and before
  # rendering, so seo-tag sees `image` when the layout's {% seo %} runs.
  Jekyll::Hooks.register :site, :post_read do |site|
    default_image = site.config['default_image']
    (site.pages + site.documents).each { |item| Jekyll::SeoImage.apply(item, default_image) }
  end
end
