# frozen_string_literal: true
# Plain-ruby unit test for the gem-shipped admin logo placeholder. Run:
#   ruby theme/spec/neutral_logo_test.rb
#
# BRANDING POLICY (issue #25): the cms-platform-theme gem ships only MACHINERY
# plus a NEUTRAL, wordless placeholder logo — never a specific site's brand.
# The render hooks default `cms.logo_url` to `<url>/assets/images/logo.svg`, and
# Jekyll lets a site SHADOW the gem asset by shipping its own
# `assets/images/logo.svg` (or setting `cms.logo_url`). So the gem asset is the
# fallback every consumer that ships NO logo will display in /admin — it must
# carry no site identity. This test locks that: the bundled logo must be a
# well-formed SVG, must NOT embed a site-specific monogram (e.g. "AD"/"CMS"/
# initials), and must carry the placeholder comment telling sites to override
# it. (The scaffolder's seeded copy is locked separately by
# e2e/scaffold-seeds-neutral-logo.test.js.)

require "minitest/autorun"

class NeutralLogoTest < Minitest::Test
  LOGO = File.expand_path("../assets/images/logo.svg", __dir__)

  def setup
    assert File.exist?(LOGO), "gem must ship #{LOGO}"
    @svg = File.read(LOGO)
  end

  def test_is_well_formed_svg
    assert_match(/\A\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--.*?-->\s*)*<svg\b/m, @svg,
                 "must begin with an <svg> root (optionally after an XML decl / comment)")
    assert_match(%r{</svg>\s*\z}m, @svg, "must close the <svg> root")
    assert_includes @svg, "xmlns=\"http://www.w3.org/2000/svg\"", "must declare the SVG namespace"
    # Balanced angle brackets — no obviously truncated/garbled markup.
    assert_equal @svg.count("<"), @svg.count(">"), "unbalanced angle brackets"
  end

  def test_layout_unchanged_viewbox_preserved
    # Admin chrome sizes the logo box off the viewBox; keep it 0 0 120 40 so the
    # neutral swap doesn't reflow the admin header.
    assert_includes @svg, 'viewBox="0 0 120 40"', "viewBox must stay 0 0 120 40 to preserve admin layout"
  end

  def test_carries_placeholder_override_comment
    comment = @svg[/<!--(.*?)-->/m, 1]
    refute_nil comment, "must carry an XML comment marking it a neutral placeholder"
    c = comment.downcase
    assert_includes c, "placeholder", "comment must say this is a placeholder"
    assert(c.include?("override") || c.include?("logo_url") || c.include?("own"),
           "comment must tell sites to override it (their own logo / cms.logo_url)")
  end

  def test_no_site_specific_monogram
    # The leaked brand was the "AD" (Adam Daniel) monogram rendered via <text>.
    # A neutral placeholder must carry no rendered word/initials at all.
    refute_match(/<text\b/i, @svg, "neutral placeholder must not render any <text> (no monogram/initials)")
    # Belt-and-suspenders: no site-identity tokens anywhere in the markup.
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
