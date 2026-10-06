# frozen_string_literal: true

# Make an Atom feed readable in a browser (#728).
#
# A visitor who clicks the RSS icon lands on the raw XML tree, which looks like
# an error and does not say what to do with it. This adds an
# `<?xml-stylesheet?>` processing instruction pointing at the theme's
# same-origin `/assets/feed.xsl`, which renders a "copy this address into your
# feed reader" page. Feed readers ignore the instruction and still parse the
# same Atom document.
#
# It is a post_render hook rather than a line in each feed template because the
# feeds come from three owners: the theme's per-tag `_layouts/atom_feed.xml`,
# jekyll-feed's generated `/feed.xml`, and the site-owned `feed.xml` a site
# ships to filter e2e posts. One hook covers all of them with no consumer edit.
# A feed that already carries a stylesheet (jekyll-feed's own `feed.xslt.xml`
# hook, or a site's) is left alone.
#
# Tests: spec/feed_stylesheet_test.rb

module Jekyll
  module FeedStylesheet
    # Root-relative to the site, like every other theme asset, so a preview
    # served from another origin or under a baseurl still loads the stylesheet
    # from the same origin as the feed (browsers refuse a cross-origin XSL).
    ASSET_PATH = '/assets/feed.xsl'

    DECLARATION = /\A<\?xml\b[^>]*\?>/
    ATOM_ROOT = %r{<feed\b[^>]*\sxmlns="http://www\.w3\.org/2005/Atom"}
    # Only the prolog is inspected, so a feed entry that merely mentions the
    # instruction in its text does not count as already styled.
    PROLOG_LENGTH = 512

    def self.href(baseurl)
      base = baseurl.to_s.gsub(%r{\A/+|/+\z}, '')
      path = base.empty? ? ASSET_PATH : "/#{base}#{ASSET_PATH}"
      path.gsub('&', '&amp;').gsub('<', '&lt;').gsub('"', '&quot;')
    end

    # Returns `output` with the processing instruction added after the XML
    # declaration, or `output` unchanged when it is not an unstyled Atom feed.
    def self.apply(output, baseurl)
      return output unless output.is_a?(String)

      declaration = output[DECLARATION]
      return output unless declaration

      prolog = output[0, PROLOG_LENGTH]
      return output unless prolog.match?(ATOM_ROOT)
      return output if prolog.include?('<?xml-stylesheet')

      instruction = %(<?xml-stylesheet type="text/xsl" href="#{href(baseurl)}"?>)
      "#{declaration}\n#{instruction}#{output[declaration.length..]}"
    end
  end
end

if defined?(Jekyll::Hooks)
  Jekyll::Hooks.register :pages, :post_render do |page|
    page.output = Jekyll::FeedStylesheet.apply(page.output, page.site.config['baseurl'])
  end
end
