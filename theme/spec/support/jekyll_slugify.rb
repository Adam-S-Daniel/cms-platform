# frozen_string_literal: true

# Jekyll::Utils.slugify, "default" mode, for specs that run WITHOUT Jekyll
# loaded (this lane is stdlib-only by design — see self-ci.yml's
# ruby-theme-specs). It is Jekyll's own algorithm, line for line
# (jekyll-4.4.1/lib/jekyll/utils.rb: SLUGIFY_DEFAULT_REGEXP, then the
# leading/trailing-hyphen strip, then downcase), and
# jekyll_slugify_golden_test.rb holds it to the real Jekyll's output in
# e2e/jekyll-slugify-golden.json. One copy for every spec; never a local
# ASCII-only approximation, which drops letters Jekyll keeps ("Café").
module SpecJekyllSlugify
  DEFAULT_REGEXP = Regexp.new('[^\p{M}\p{L}\p{Nd}]+').freeze

  def self.slugify(string)
    return nil if string.nil?

    slug = string.to_s.gsub(DEFAULT_REGEXP, '-')
    slug.gsub!(/^-|-$/i, '')
    slug.downcase!
    slug
  end
end
