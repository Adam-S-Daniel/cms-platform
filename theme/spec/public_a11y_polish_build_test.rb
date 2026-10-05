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
    'linkedin' => '', # a target left unset must not render an empty link
  }.freeze

  def setup
    @tmpdir = Dir.mktmpdir('public-a11y-polish-')
    source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    FileUtils.mkdir_p(File.join(source, '_posts'))
    FileUtils.mkdir_p(File.join(source, '_layouts'))
    %w[default.html post.html].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(source, '_layouts', layout))
    end
    %w[favicon.html rel-me.html header.html footer.html share-row.html analytics/cloudwatch-rum.html].each do |inc|
      destination = File.join(source, '_includes', inc)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', inc), destination)
    end
    File.write(File.join(source, '_posts', '2024-01-01-featured.md'), <<~MD)
      ---
      title: "#{TITLE}"
      layout: post
      featured_image: /assets/images/uploads/hero.png
      ---
      Body.
    MD
    Jekyll::Site.new(Jekyll.configuration(
      'source' => source,
      'destination' => @destination,
      'url' => 'https://example.com',
      'title' => 'Example',
      'permalink' => '/blog/:slug/',
      'timezone' => 'UTC',
      'quiet' => true,
      'plugins' => [],
      'cross_post' => { 'profiles' => PROFILES },
    )).process
    @doc = parse(File.read(File.join(@destination, 'blog', 'featured', 'index.html')))
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
    assert_equal ['RSS', 'Mastodon', 'Substack'], links.map { |a| a.texts.join }
    assert_equal ['/feed.xml', PROFILES['mastodon'], PROFILES['substack']],
                 links.map { |a| a.attributes['href'] }
    assert_equal 'Follow', elements("//footer//nav[@class='footer-follow']").first.attributes['aria-label']
  end

  def test_footer_keeps_the_copyright
    assert_match(/© \d{4} Example/, elements('//footer/div/p').first.texts.map(&:value).join)
  end
end
