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

      image = [item.data['featured_image'], default_image].find { |value| value.is_a?(String) && !value.strip.empty? }
      item.data['image'] = image if image
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
