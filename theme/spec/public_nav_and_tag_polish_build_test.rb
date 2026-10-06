# frozen_string_literal: true

# Real Jekyll build regression for two of the public-theme polish items in
# cms-platform#737: the header's current-page state and the tag page's parity
# with the blog index (reading time, a way back to /tags/). The rendered pages
# are parsed with REXML, not matched with a regex.
# Run with: ruby theme/spec/public_nav_and_tag_polish_build_test.rb

require 'minitest/autorun'
require 'fileutils'
require 'rexml/document'
require 'tmpdir'
require 'jekyll'
# tag.html reads the posts-by-slug list auto_tag_pages.rb builds (#754).
require_relative '../lib/cms-platform-theme/exclude_e2e_posts'
require_relative '../lib/cms-platform-theme/auto_tag_pages'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

# jekyll-seo-tag is unrelated to these checks and is not a test dependency.
class NavTagPolishSeoStandIn < Liquid::Tag
  def render(_context)
    ''
  end
end

Liquid::Template.register_tag('seo', NavTagPolishSeoStandIn)

class PublicNavAndTagPolishBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  LAYOUTS = %w[default.html post.html tag.html].freeze
  INCLUDES = %w[favicon.html rel-me.html header.html footer.html share-row.html feed-link.html
                analytics/cloudwatch-rum.html].freeze
  WORDS_FOR_TWO_MINUTES = ('word ' * 250).freeze # 250 / 200 + 1 == 2

  def setup
    @tmpdir = Dir.mktmpdir('public-nav-tag-polish-')
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  # Builds a small site and returns the output directory. `tags_index: true`
  # adds the site-owned /tags/ page.
  def build(tags_index:)
    source = File.join(@tmpdir, 'source')
    destination = File.join(@tmpdir, 'output')
    FileUtils.mkdir_p([File.join(source, '_posts'), File.join(source, '_layouts')])
    LAYOUTS.each { |l| FileUtils.cp(File.join(ROOT, 'theme', '_layouts', l), File.join(source, '_layouts', l)) }
    INCLUDES.each do |inc|
      dest = File.join(source, '_includes', inc)
      FileUtils.mkdir_p(File.dirname(dest))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', inc), dest)
    end
    write(source, '_posts/2024-01-01-first.md',
          "---\ntitle: First post\nlayout: post\ntags: [Quotes]\n---\n#{WORDS_FOR_TWO_MINUTES}\n")
    write(source, 'blog/index.html', "---\nlayout: default\ntitle: Blog\npermalink: /blog/\n---\nBlog index\n")
    write(source, 'blogger.html', "---\nlayout: default\ntitle: Blogger\npermalink: /blogger/\n---\nNot the blog\n")
    write(source, 'about.html', "---\nlayout: default\ntitle: About\npermalink: /about/\n---\nAbout\n")
    write(source, 'tags/quotes.html',
          "---\nlayout: tag\ntag_name: Quotes\npermalink: /tags/quotes/\nfeed_exclude: true\n---\n")
    if tags_index
      write(source, 'tags/index.html', "---\nlayout: default\ntitle: Tags\npermalink: /tags/\n---\nAll the tags\n")
    end
    Jekyll::Site.new(Jekyll.configuration(
      'source' => source, 'destination' => destination, 'url' => 'https://example.com',
      'title' => 'Example', 'permalink' => '/blog/:slug/', 'timezone' => 'UTC',
      'quiet' => true, 'plugins' => []
    )).process
    destination
  end

  def write(source, rel, body)
    path = File.join(source, rel)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, body)
  end

  # Void tags, one named entity and bare ampersands in share-link URLs are
  # the only non-XML tokens; normalize those lexically, then let REXML build the tree.
  def parse(dir, rel)
    html = File.read(File.join(dir, rel, 'index.html'))
    xml = html.gsub(/<!--.*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/m) do |token|
      token.match?(/\A<(?:meta|link|img|br|hr|input)\b/i) && !token.end_with?('/>') ? token.sub(/>\z/, '/>') : token
    end
    xml = xml.sub(/\A\s*<!DOCTYPE[^>]*>/i, '').gsub('&copy;', '&#169;').gsub('&larr;', '&#8592;')
    xml = xml.gsub(/&(?!(?:#\d+|[a-z]+);)/i, '&amp;')
    REXML::Document.new(xml)
  end

  def nav_link(doc)
    REXML::XPath.match(doc, "//nav[@class='site-nav']/a").first
  end

  def test_blog_link_is_the_current_page_on_the_blog_index
    link = nav_link(parse(build(tags_index: false), 'blog'))
    assert_equal 'Blog', link.texts.join
    assert_equal 'page', link.attributes['aria-current']
  end

  # A post is inside the section but is not the page the link points to, so
  # it is `true` (the current location), not `page`.
  def test_blog_link_is_current_true_on_a_post_under_it
    link = nav_link(parse(build(tags_index: false), 'blog/first'))
    assert_equal 'true', link.attributes['aria-current']
    assert_includes link.attributes['class'].split, 'active'
  end

  def test_blog_link_is_not_current_elsewhere
    out = build(tags_index: false)
    %w[about blogger tags/quotes].each do |rel|
      link = nav_link(parse(out, rel))
      assert_equal 'Blog', link.texts.join, rel
      assert_nil link.attributes['aria-current'], "#{rel} is not under /blog/"
    end
  end

  def test_tag_page_shows_reading_time_like_the_blog_index
    doc = parse(build(tags_index: false), 'tags/quotes')
    times = REXML::XPath.match(doc, "//li[@class='post-item']//span[@class='post-reading-time']")
    assert_equal ['2 min read'], times.map { |t| t.texts.join }
  end

  def test_tag_page_links_back_to_all_tags_when_the_site_has_that_page
    doc = parse(build(tags_index: true), 'tags/quotes')
    links = REXML::XPath.match(doc, "//p[@class='tag-back']/a")
    assert_equal ['/tags/'], links.map { |a| a.attributes['href'] }
    assert_match(/All tags/, links.first.texts.join)
  end

  def test_tag_page_has_no_dead_link_when_the_site_has_no_tags_index
    doc = parse(build(tags_index: false), 'tags/quotes')
    assert_empty REXML::XPath.match(doc, "//p[@class='tag-back']")
  end

  def test_tag_heading_keeps_the_stored_name_for_css_to_style
    doc = parse(build(tags_index: false), 'tags/quotes')
    h1 = REXML::XPath.match(doc, "//h1[@class='tag-title']").first
    assert_equal 'Quotes', h1.texts.join
  end
end
