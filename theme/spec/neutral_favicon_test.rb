# frozen_string_literal: true
# Plain-ruby unit test for the gem-shipped favicon placeholder (issue #325).
# Run: ruby theme/spec/neutral_favicon_test.rb
#
# BRANDING POLICY (mirrors issue #25's logo pattern): the cms-platform-theme
# gem ships only MACHINERY plus a NEUTRAL, wordless placeholder favicon —
# never a specific site's brand. theme/_includes/favicon.html defaults
# `favicon_url` to `<baseurl>/assets/favicon.svg`, and Jekyll lets a site
# SHADOW the gem asset by shipping its own `assets/favicon.svg` (or setting
# `cms.favicon_url`). So the gem asset is the fallback every consumer that
# ships NO favicon will show in the browser tab — it must carry no site
# identity. This test locks that: the bundled favicon must be a well-formed
# SVG, must NOT embed a site-specific monogram (e.g. "AD"/"CMS"/initials),
# and must carry the placeholder comment telling sites to override it. (The
# scaffolder's seeded copy is locked separately by
# e2e/scaffold-seeds-favicon.test.js, which also asserts head emission.)

require "minitest/autorun"

class NeutralFaviconTest < Minitest::Test
  FAVICON = File.expand_path("../assets/favicon.svg", __dir__)

  def setup
    assert File.exist?(FAVICON), "gem must ship #{FAVICON}"
    @svg = File.read(FAVICON, encoding: "utf-8")
  end

  def test_is_well_formed_svg
    assert_match(/\A\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--.*?-->\s*)*<svg\b/m, @svg,
                 "must begin with an <svg> root (optionally after an XML decl / comment)")
    assert_match(%r{</svg>\s*\z}m, @svg, "must close the <svg> root")
    assert_includes @svg, "xmlns=\"http://www.w3.org/2000/svg\"", "must declare the SVG namespace"
    # Balanced angle brackets — no obviously truncated/garbled markup.
    assert_equal @svg.count("<"), @svg.count(">"), "unbalanced angle brackets"
  end

  def test_viewbox_is_square_and_favicon_sized
    # A favicon is rendered at very small sizes (16-32px in a browser tab) —
    # keep the source viewBox square so it doesn't get squashed/cropped.
    assert_match(/viewBox="0 0 (\d+) \1"/, @svg, "viewBox must be square (equal width/height)")
  end

  def test_carries_placeholder_override_comment
    comment = @svg[/<!--(.*?)-->/m, 1]
    refute_nil comment, "must carry an XML comment marking it a neutral placeholder"
    c = comment.downcase
    assert_includes c, "placeholder", "comment must say this is a placeholder"
    assert(c.include?("override") || c.include?("favicon_url") || c.include?("own"),
           "comment must tell sites to override it (their own favicon / cms.favicon_url)")
  end

  def test_no_site_specific_monogram
    # Mirrors the logo policy: a neutral placeholder must carry no rendered
    # word/initials at all, and no site-identity tokens anywhere in the markup.
    refute_match(/<text\b/i, @svg, "neutral placeholder must not render any <text> (no monogram/initials)")
    %w[AD Adam Daniel jodidaniel adamdaniel].each do |brand|
      refute_match(/\b#{Regexp.escape(brand)}\b/i, strip_comment(@svg),
                   "neutral placeholder must not contain the brand token #{brand.inspect}")
    end
  end

  # Search everything EXCEPT the override comment (which may legitimately mention
  # cms-platform as the shipper of the placeholder).
  def strip_comment(svg)
    svg.gsub(/<!--.*?-->/m, "")
  end
end
