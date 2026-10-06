# frozen_string_literal: true

# Real Jekyll build regression for the public-site accessibility polish
# (cms-platform#657): skip link, decorative featured image, footer follow
# links. The rendered page is parsed with REXML, not matched with a regex.
# Run with: ruby theme/spec/public_a11y_polish_build_test.rb

require 'minitest/autorun'
require 'fileutils'
require 'rexml/document'
require 'tmpdir'
require 'jekyll'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

# jekyll-seo-tag is unrelated to these checks and is not a test dependency.
class A11yPolishSeoStandIn < Liquid::Tag
  def render(_context)
    ''
  end
end

Liquid::Template.register_tag('seo', A11yPolishSeoStandIn)

class PublicA11yPolishBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  TITLE = 'A post whose image repeats its title'
  PROFILES = {
    'mastodon' => 'https://hachyderm.io/@someone',
    'substack' => 'https://someone.substack.com',
    'linkedin' => 'https://www.linkedin.com/in/someone',
    'github' => 'https://github.com/someone',
    'bluesky' => '', # a target left unset must not render an empty link
  }.freeze

  def setup
    @tmpdir = Dir.mktmpdir('public-a11y-polish-')
    @destination = build_site('site', blog_index: false)
    @doc = parse(File.read(File.join(@destination, 'blog', 'featured', 'index.html')))
  end

  # Builds a small site under @tmpdir/<name> and returns its output directory.
  # `blog_index: true` adds the /blog/ page a header "Blog" link points at.
  def build_site(name, blog_index:)
    source = File.join(@tmpdir, name, 'source')
    destination = File.join(@tmpdir, name, 'output')
    FileUtils.mkdir_p(File.join(source, '_posts'))
    FileUtils.mkdir_p(File.join(source, '_layouts'))
    FileUtils.mkdir_p(File.join(source, 'blog'))
    %w[default.html post.html].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(source, '_layouts', layout))
    end
    %w[favicon.html rel-me.html header.html footer.html share-row.html analytics/cloudwatch-rum.html].each do |inc|
      target = File.join(source, '_includes', inc)
      FileUtils.mkdir_p(File.dirname(target))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', inc), target)
    end
    File.write(File.join(source, '_posts', '2024-01-01-featured.md'), <<~MD)
      ---
      title: "#{TITLE}"
      layout: post
      featured_image: /assets/images/uploads/hero.png
      ---
      Body.
    MD
    File.write(File.join(source, 'blog', 'index.html'), <<~HTML) if blog_index
      ---
      layout: default
      title: Blog
      permalink: /blog/
      ---
      Blog index
    HTML
    File.write(File.join(source, '404.html'), <<~HTML)
      ---
      layout: default
      title: Not found
      permalink: /404.html
      ---
      Not found
    HTML
    Jekyll::Site.new(Jekyll.configuration(
      'source' => source,
      'destination' => destination,
      'url' => 'https://example.com',
      'title' => 'Example',
      'permalink' => '/blog/:slug/',
      'timezone' => 'UTC',
      'quiet' => true,
      'plugins' => [],
      'cross_post' => { 'profiles' => PROFILES },
    )).process
    destination
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  # Void tags, one named entity and bare ampersands in share-link URLs are
  # the only non-XML tokens; normalize those lexically, then let REXML build the tree.
  def parse(html)
    xml = html.gsub(/<!--.*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/m) do |token|
      token.match?(/\A<(?:meta|link|img|br|hr|input)\b/i) && !token.end_with?('/>') ? token.sub(/>\z/, '/>') : token
    end
    xml = xml.sub(/\A\s*<!DOCTYPE[^>]*>/i, '').gsub('&copy;', '&#169;')
    xml = xml.gsub(/&(?!(?:#\d+|[a-z]+);)/i, '&amp;') # bare & in share-link query strings
    REXML::Document.new(xml)
  end

  def elements(xpath)
    REXML::XPath.match(@doc, xpath)
  end

  def test_skip_link_is_first_body_child_and_targets_main
    first = elements('/html/body/*').first
    assert_equal 'a', first.name
    assert_includes first.attributes['class'].split, 'skip-link'
    assert_equal '#main-content', first.attributes['href']
    main = elements('/html/body//main').first
    assert_equal 'main-content', main.attributes['id']
    # Without tabindex a fragment jump moves the scroll position but not
    # keyboard focus, so the next Tab would land back in the header.
    assert_equal '-1', main.attributes['tabindex']
  end

  def test_featured_image_is_decorative_not_a_repeat_of_the_title
    imgs = elements("//img[@class='featured-image']")
    assert_equal 1, imgs.length
    assert_equal '', imgs.first.attributes['alt'], 'alt must be present and empty'
    refute_includes imgs.first.attributes['alt'], TITLE
  end

  def test_footer_links_to_feed_and_each_configured_profile
    links = elements("//footer//nav[@class='footer-follow']/a")
    assert_equal %w[RSS Mastodon Substack LinkedIn GitHub], links.map { |a| a.texts.join }
    assert_equal ['/feed.xml', PROFILES['mastodon'], PROFILES['substack'], PROFILES['linkedin'], PROFILES['github']],
                 links.map { |a| a.attributes['href'] }
    assert_equal 'Follow', elements("//footer//nav[@class='footer-follow']").first.attributes['aria-label']
  end

  # A site with no /blog/ has no header link, so a "Main navigation" landmark
  # would be empty. Covers the 404 page, which every theme site renders.
  def test_header_has_no_navigation_landmark_without_a_link
    [@doc, parse(File.read(File.join(@destination, '404.html')))].each do |doc|
      assert_equal 1, REXML::XPath.match(doc, "//header[@class='site-header']/div/a[@class='site-logo']").length
      assert_empty REXML::XPath.match(doc, "//header//nav"), 'an empty landmark must not render'
      assert_empty REXML::XPath.match(doc, "//*[@aria-label='Main navigation']")
    end
  end

  def test_header_keeps_the_navigation_landmark_when_the_blog_exists
    destination = build_site('with-blog', blog_index: true)
    doc = parse(File.read(File.join(destination, '404.html')))
    nav = REXML::XPath.match(doc, "//header//nav[@aria-label='Main navigation']")
    assert_equal 1, nav.length
    links = REXML::XPath.match(nav.first, 'a')
    assert_equal ['Blog'], links.map { |a| a.texts.join }
    assert_equal ['/blog/'], links.map { |a| a.attributes['href'] }
  end

  def test_footer_keeps_the_copyright
    assert_match(/© \d{4} Example/, elements('//footer/div/p').first.texts.map(&:value).join)
  end
end
