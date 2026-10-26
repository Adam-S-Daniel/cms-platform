# frozen_string_literal: true

# Browser view of the Atom feeds (#728): clicking the RSS icon showed the raw
# XML tree ("This XML file does not appear to have any style information").
# The theme's feed_stylesheet hook adds an <?xml-stylesheet?> instruction to
# every Atom feed and ships the same-origin /assets/feed.xsl it points at.
# Feed readers ignore the instruction, so each feed must still be well-formed
# Atom with the same entries.
#
# The build half is a real Jekyll build with the real _layouts/atom_feed.xml
# and tag_feeds plugin, plus a site-owned feed.xml (the shape adamdaniel.ai
# ships) and one that already carries its own stylesheet.
# Run with: ruby theme/spec/feed_stylesheet_test.rb
# Needs jekyll 4.4.1 (the ruby-theme-specs lane installs it).

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'rexml/document'
require 'rexml/parsers/pullparser'
require 'jekyll'
require_relative '../lib/cms-platform-theme/feed_stylesheet'
require_relative '../lib/cms-platform-theme/exclude_e2e_posts'
require_relative '../lib/cms-platform-theme/tag_feeds'

ATOM = 'http://www.w3.org/2005/Atom'

class FeedStylesheetUnitTest < Minitest::Test
  FEED = %(<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="#{ATOM}"><title>T</title></feed>\n)

  def test_adds_the_instruction_after_the_declaration_and_before_the_root
    styled = Jekyll::FeedStylesheet.apply(FEED, '')
    assert_equal %(<?xml version="1.0" encoding="utf-8"?>\n<?xml-stylesheet type="text/xsl" href="/assets/feed.xsl"?>\n<feed xmlns="#{ATOM}"><title>T</title></feed>\n),
                 styled
  end

  def test_baseurl_prefixes_the_stylesheet_path
    ['/pr-7', '/pr-7/', 'pr-7'].each do |baseurl|
      assert_includes Jekyll::FeedStylesheet.apply(FEED, baseurl), 'href="/pr-7/assets/feed.xsl"', baseurl
    end
    assert_includes Jekyll::FeedStylesheet.apply(FEED, nil), 'href="/assets/feed.xsl"'
  end

  def test_a_baseurl_cannot_break_out_of_the_attribute
    styled = Jekyll::FeedStylesheet.apply(FEED, '/a"b&c')
    assert_includes styled, 'href="/a&quot;b&amp;c/assets/feed.xsl"'
    REXML::Document.new(styled)
  end

  def test_a_feed_that_already_has_a_stylesheet_is_left_alone
    own = %(<?xml version="1.0" encoding="utf-8"?>\n<?xml-stylesheet type="text/xml" href="/feed.xslt.xml"?>\n<feed xmlns="#{ATOM}"/>\n)
    assert_equal own, Jekyll::FeedStylesheet.apply(own, '')
  end

  def test_an_entry_that_mentions_the_instruction_does_not_count_as_styled
    long_title = 'x' * 2000
    feed = %(<?xml version="1.0"?>\n<feed xmlns="#{ATOM}"><title>#{long_title}</title><summary>&lt;?xml-stylesheet</summary></feed>)
    assert_includes Jekyll::FeedStylesheet.apply(feed, ''), '<?xml-stylesheet type="text/xsl"'
  end

  def test_anything_that_is_not_an_atom_feed_is_untouched
    html = "<!DOCTYPE html><html><body>feed xmlns=\"#{ATOM}\"</body></html>"
    sitemap = %(<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>)
    rss = %(<?xml version="1.0"?>\n<rss version="2.0"><channel/></rss>)
    [html, sitemap, rss, '', nil].each { |output| assert_equal output, Jekyll::FeedStylesheet.apply(output, '') }
  end
end

class FeedStylesheetBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)

  SITE_FEED = <<~'LIQUID'
    ---
    layout: null
    sitemap: false
    ---
    <?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <link href="{{ page.url | absolute_url }}" rel="self" type="application/atom+xml" />
      <updated>{{ site.time | date_to_xmlschema }}</updated>
      <id>{{ page.url | absolute_url | xml_escape }}</id>
      <title type="html">{{ site.title | xml_escape }}</title>
      {% for post in site.posts %}
      <entry>
        <title type="html">{{ post.title | smartify | xml_escape }}</title>
        <link href="{{ post.url | absolute_url }}" rel="alternate" type="text/html" />
        <id>{{ post.id | absolute_url | xml_escape }}</id>
        <updated>{{ post.date | date_to_xmlschema }}</updated>
        <content type="html"><![CDATA[{{ post.content | strip }}]]></content>
      </entry>
      {% endfor %}
    </feed>
  LIQUID

  OWN_STYLESHEET_FEED = <<~'LIQUID'
    ---
    layout: null
    sitemap: false
    ---
    <?xml version="1.0" encoding="utf-8"?>
    <?xml-stylesheet type="text/xml" href="/own.xsl"?>
    <feed xmlns="http://www.w3.org/2005/Atom"><title>Own</title></feed>
  LIQUID

  def setup
    @tmpdir = Dir.mktmpdir('feed-stylesheet-build-')
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  def build(extra_config = {})
    source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    FileUtils.mkdir_p([File.join(source, '_posts'), File.join(source, '_layouts')])
    FileUtils.cp(File.join(ROOT, 'theme', '_layouts', 'atom_feed.xml'), File.join(source, '_layouts', 'atom_feed.xml'))
    File.write(File.join(source, '_posts', '2024-01-01-one.md'),
               "---\ntitle: \"It's a post\"\ntags: [Alpha]\npublished: true\n---\nBody one.\n")
    File.write(File.join(source, 'feed.xml'), SITE_FEED)
    File.write(File.join(source, 'own.xml'), OWN_STYLESHEET_FEED)
    Jekyll::Site.new(Jekyll.configuration({
      'source' => source,
      'destination' => @destination,
      'url' => 'https://example.com',
      'title' => 'Example',
      'permalink' => '/blog/:slug/',
      'timezone' => 'UTC',
      'quiet' => true,
      'plugins' => [],
    }.merge(extra_config))).process
  end

  def output(path)
    File.read(File.join(@destination, path))
  end

  # The processing instructions that precede the root element, from a parse.
  def prolog_instructions(xml)
    parser = REXML::Parsers::PullParser.new(xml)
    instructions = []
    while parser.has_next?
      event = parser.pull
      break if event.start_element?

      instructions << [event[0], event[1]] if event.instruction?
    end
    instructions
  end

  def test_site_feed_and_tag_feed_both_link_the_stylesheet
    build
    ['feed.xml', 'tags/alpha/feed.xml'].each do |path|
      instructions = prolog_instructions(output(path)).reject { |target, _| target == 'xml' }
      assert_equal [['xml-stylesheet', 'type="text/xsl" href="/assets/feed.xsl"']], instructions, path
    end
  end

  def test_feeds_stay_well_formed_atom_with_the_same_entries
    build
    ['feed.xml', 'tags/alpha/feed.xml'].each do |path|
      doc = REXML::Document.new(output(path))
      assert_equal ATOM, doc.root.namespace, path
      assert_equal 'feed', doc.root.name, path
      titles = REXML::XPath.match(doc, '/a:feed/a:entry/a:title', 'a' => ATOM).map(&:text)
      assert_equal ["It\u2019s a post"], titles, path
    end
  end

  def test_the_declaration_is_still_the_first_bytes_of_the_file
    build
    assert output('tags/alpha/feed.xml').start_with?('<?xml version="1.0" encoding="utf-8"?>')
    assert output('feed.xml').start_with?('<?xml version="1.0" encoding="utf-8"?>')
  end

  def test_baseurl_is_honored
    build('baseurl' => '/preview')
    assert_includes output('feed.xml'), '<?xml-stylesheet type="text/xsl" href="/preview/assets/feed.xsl"?>'
  end

  def test_a_site_that_set_its_own_stylesheet_keeps_it
    build
    instructions = prolog_instructions(output('own.xml')).map(&:first)
    assert_equal 1, instructions.count('xml-stylesheet')
    assert_includes output('own.xml'), 'href="/own.xsl"'
    refute_includes output('own.xml'), 'feed.xsl'
  end

  def test_the_stylesheet_ships_with_the_theme_and_is_wellformed_xslt
    path = File.join(ROOT, 'theme', 'assets', 'feed.xsl')
    assert File.file?(path)
    doc = REXML::Document.new(File.read(path))
    assert_equal 'stylesheet', doc.root.name
    assert_equal 'http://www.w3.org/1999/XSL/Transform', doc.root.namespace
    assert_equal '1.0', doc.root.attributes['version']
    # The page tells a non-reader what to do with the address.
    assert_includes File.read(path), 'copy this address into your feed reader'
    # Same-origin and self-contained: no script, no external fetch.
    refute_match(%r{<script\b|https?://(?!www\.w3\.org/)}i, File.read(path).gsub(/<!--.*?-->/m, ''))
  end
end
