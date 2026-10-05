# frozen_string_literal: true

# Real Jekyll build regression for e2e / test-fixture TAGS (#689): a leftover
# `_tags/e2e-tags-canary-<runId>.md` reached the home page tag cloud, `/tags/`,
# `/sitemap.xml` and its own feed. Its page must still build (the tags
# lifecycle specs wait for a 200, then a 404 after the delete) but with
# noindex.
# Run with: ruby theme/spec/exclude_e2e_tags_build_test.rb

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'yaml'
require 'rexml/document'
require 'jekyll'
require 'jekyll-sitemap'
require_relative '../lib/cms-platform-theme/exclude_e2e_posts'
require_relative '../lib/cms-platform-theme/auto_tag_pages'
require_relative '../lib/cms-platform-theme/tag_feeds'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

# jekyll-seo-tag is unrelated to tag visibility and is not a test dependency.
class TagBuildSeoStandIn < Liquid::Tag
  def render(_context)
    ''
  end
end

Liquid::Template.register_tag('seo', TagBuildSeoStandIn)

class ExcludeE2ETagsBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  CANARY = 'e2e-tags-canary-1786027176024'
  CANARY_NAME = 'E2E Tags Canary 1786027176024'
  TAGS = {
    CANARY => { 'name' => CANARY_NAME },
    'flagged-fixture' => { 'name' => 'Flagged Fixture', 'test_fixture' => true },
    'real-tag' => { 'name' => 'Real Tag' },
  }.freeze
  EXCLUDED_SLUGS = [CANARY, 'flagged-fixture'].freeze

  def setup
    @tmpdir = Dir.mktmpdir('exclude-e2e-tags-build-')
    @source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    %w[_posts _tags _layouts _includes tags].each { |d| FileUtils.mkdir_p(File.join(@source, d)) }

    %w[default.html post.html tag.html atom_feed.xml].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(@source, '_layouts', layout))
    end
    %w[feed-link.html favicon.html rel-me.html header.html footer.html share-row.html
       analytics/cloudwatch-rum.html].each do |include|
      destination = File.join(@source, '_includes', include)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', include), destination)
    end
    # The consumers' home tag cloud and /tags/ index both read site.all_tags.
    FileUtils.cp(File.join(ROOT, 'e2e', 'fixture-site', 'tags', 'index.html'),
                 File.join(@source, 'tags', 'index.html'))

    TAGS.each do |slug, data|
      File.write(File.join(@source, '_tags', "#{slug}.md"), "#{data.to_yaml}---\n")
    end
    # A public post carrying the canary tag must not bring it back into the
    # listings or mint a second (indexable) archive for it.
    { 'normal-post' => ['Real Tag', CANARY_NAME] }.each do |slug, tags|
      front_matter = { 'title' => slug, 'layout' => 'post', 'tags' => tags }
      File.write(File.join(@source, '_posts', "2024-01-01-#{slug}.md"),
                 "#{front_matter.to_yaml}---\nPost body for #{slug}.\n")
    end

    Jekyll::Site.new(Jekyll.configuration(
      'source' => @source,
      'destination' => @destination,
      'url' => 'https://example.com',
      'title' => 'Example',
      'permalink' => '/blog/:slug/',
      'timezone' => 'UTC',
      'quiet' => true,
      'plugins' => [],
      'collections' => { 'tags' => { 'output' => true, 'permalink' => '/tags/:slug/' } },
      'defaults' => [{ 'scope' => { 'path' => '', 'type' => 'tags' }, 'values' => { 'layout' => 'tag' } }],
    )).tap { |site| @site = site }.process
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  def output(path)
    File.read(File.join(@destination, path))
  end

  def built?(path)
    File.exist?(File.join(@destination, path))
  end

  def test_tag_listings_leave_out_e2e_and_fixture_tags
    assert_equal ['Real Tag'], @site.config.fetch('all_tags').map { |t| t.fetch('name') }
    index = output('tags/index.html')
    assert_includes index, 'href="/tags/real-tag/"'
    EXCLUDED_SLUGS.each { |slug| refute_includes index, "/tags/#{slug}/" }
    refute_includes index, CANARY_NAME
  end

  def test_sitemap_leaves_out_e2e_and_fixture_tag_pages
    sitemap = REXML::Document.new(output('sitemap.xml'))
    namespaces = { 'sitemap' => 'http://www.sitemaps.org/schemas/sitemap/0.9' }
    urls = REXML::XPath.match(sitemap, '/sitemap:urlset/sitemap:url/sitemap:loc', namespaces).map(&:text)
    assert_includes urls, 'https://example.com/tags/real-tag/'
    EXCLUDED_SLUGS.each { |slug| refute_includes urls, "https://example.com/tags/#{slug}/" }
  end

  def test_e2e_and_fixture_tags_get_no_feed
    assert built?('tags/real-tag/feed.xml')
    EXCLUDED_SLUGS.each do |slug|
      refute built?("tags/#{slug}/feed.xml"), slug
      refute_includes output("tags/#{slug}/index.html"), "/tags/#{slug}/feed.xml"
    end
  end

  def test_e2e_and_fixture_tag_pages_still_build_with_noindex
    EXCLUDED_SLUGS.each do |slug|
      html = output("tags/#{slug}/index.html")
      assert_equal 1, html.scan('<meta name="robots"').length, slug
      assert_includes html, '<meta name="robots" content="noindex,nofollow">'
    end
    refute_includes output('tags/real-tag/index.html'), 'name="robots"'
  end
end
