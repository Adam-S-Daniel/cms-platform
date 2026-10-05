# frozen_string_literal: true

# Real Jekyll read/generate/render regression for the e2e tag exclusion
# (cms-platform#689). The pure tests in exclude_e2e_tags_test.rb cannot
# catch a hook that runs too late for the generators or the sitemap.
# Run with: ruby theme/spec/exclude_e2e_tags_build_test.rb

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'yaml'
require 'rexml/document'
require 'jekyll'
require 'jekyll-sitemap'
require_relative '../lib/cms-platform-theme/exclude_e2e_posts'
require_relative '../lib/cms-platform-theme/exclude_e2e_tags'
require_relative '../lib/cms-platform-theme/auto_tag_pages'
require_relative '../lib/cms-platform-theme/tag_feeds'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

# jekyll-seo-tag is unrelated to fixture visibility and is not a test dependency.
class TagBuildSeoStandIn < Liquid::Tag
  def render(_context)
    ''
  end
end

Liquid::Template.register_tag('seo', TagBuildSeoStandIn)

class ExcludeE2ETagsBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  TAGS = {
    # The leftover from adamdaniel.ai#4081: a Decap-created canary with the
    # e2e- filename and no flag.
    'e2e-tags-canary-1786027176024' => { 'name' => 'E2E Tags Canary 1786027176024' },
    'flagged-fixture' => { 'name' => 'Flagged Fixture', 'test_fixture' => true },
    'python' => { 'name' => 'Python', 'description' => 'A real tag.' },
  }.freeze
  # A real post carrying an e2e tag NAME with no `_tags/` entry: its page is
  # minted by auto_tag_pages.rb, so the pill does not 404, but stays unlisted.
  POSTS = {
    'normal-post' => { 'tags' => ['Python', 'E2E Orphan', 'Flagged Fixture'] },
    'other-post' => { 'tags' => ['Public Only'] },
  }.freeze
  EXCLUDED_SLUGS = %w[e2e-tags-canary-1786027176024 flagged-fixture e2e-orphan].freeze
  PUBLIC_SLUGS = %w[python public-only].freeze

  def setup
    @tmpdir = Dir.mktmpdir('exclude-e2e-tags-build-')
    source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    %w[_posts _tags _layouts _includes].each { |dir| FileUtils.mkdir_p(File.join(source, dir)) }

    %w[default.html post.html tag.html atom_feed.xml].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(source, '_layouts', layout))
    end
    %w[feed-link.html favicon.html rel-me.html header.html footer.html share-row.html analytics/cloudwatch-rum.html].each do |include|
      destination = File.join(source, '_includes', include)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', include), destination)
    end

    TAGS.each do |slug, data|
      File.write(File.join(source, '_tags', "#{slug}.md"), "#{data.to_yaml}---\n")
    end
    POSTS.each do |filename, data|
      front_matter = { 'title' => filename, 'published' => true, 'layout' => 'post' }.merge(data)
      File.write(File.join(source, '_posts', "2024-01-01-#{filename}.md"),
                 "#{front_matter.to_yaml}---\nPost body for #{filename}.\n")
    end
    # The shape both consumer listings use (adamdaniel.ai's home page tag
    # cloud and /tags/ iterate site.all_tags).
    File.write(File.join(source, 'tag-cloud.html'), <<~LIQUID)
      ---
      layout: null
      permalink: /tag-cloud.html
      ---
      {% for tag in site.all_tags %}{{ tag.url }};{% endfor %}
    LIQUID

    @site = Jekyll::Site.new(Jekyll.configuration(
      'source' => source,
      'destination' => @destination,
      'url' => 'https://example.com',
      'title' => 'Example',
      'permalink' => '/blog/:slug/',
      'timezone' => 'UTC',
      'time' => Time.utc(2025, 1, 1),
      'quiet' => true,
      'plugins' => [],
      'collections' => { 'tags' => { 'output' => true, 'permalink' => '/tags/:slug/' } },
      'defaults' => [{ 'scope' => { 'path' => '', 'type' => 'tags' }, 'values' => { 'layout' => 'tag' } }],
    ))
    @site.process
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

  def tag_url(slug)
    "https://example.com/tags/#{slug}/"
  end

  def robots_metas(html)
    head = html.split('</head>', 2).first
    head.scan(/<meta name="robots" content="([^"]*)">/).flatten
  end

  def test_tag_listings_omit_e2e_tags
    assert_equal %w[/tags/public-only/ /tags/python/], @site.config.fetch('all_tags').map { |tag| tag.fetch('url') }
    assert_equal '/tags/public-only/;/tags/python/;', output('tag-cloud.html').strip
  end

  def test_sitemap_omits_e2e_tag_pages_and_keeps_real_ones
    sitemap = REXML::Document.new(output('sitemap.xml'))
    namespaces = { 'sitemap' => 'http://www.sitemaps.org/schemas/sitemap/0.9' }
    urls = REXML::XPath.match(sitemap, '/sitemap:urlset/sitemap:url/sitemap:loc', namespaces).map(&:text)
    EXCLUDED_SLUGS.each { |slug| refute_includes urls, tag_url(slug) }
    PUBLIC_SLUGS.each { |slug| assert_includes urls, tag_url(slug) }
  end

  def test_no_tag_feed_for_e2e_tags
    EXCLUDED_SLUGS.each { |slug| refute built?("tags/#{slug}/feed.xml"), slug }
    PUBLIC_SLUGS.each { |slug| assert built?("tags/#{slug}/feed.xml"), slug }
  end

  # The tags lifecycle specs wait for /tags/<slug>/ to return 200, so the
  # canary's page must still build: noindex, and with no feed link to a
  # feed that is not minted.
  def test_e2e_tag_pages_still_build_with_noindex_and_no_feed_link
    {
      'e2e-tags-canary-1786027176024' => 'E2E Tags Canary 1786027176024',
      'flagged-fixture' => 'Flagged Fixture',
      'e2e-orphan' => 'E2E Orphan',
    }.each do |slug, name|
      html = output("tags/#{slug}/index.html")
      assert_includes html, "<h1>#{name}</h1>"
      assert_equal ['noindex,nofollow'], robots_metas(html), slug
      refute_includes html, "/tags/#{slug}/feed.xml"
    end
    assert_includes output('tags/e2e-orphan/index.html'), '/blog/normal-post/'
  end

  def test_real_tag_pages_are_untouched
    PUBLIC_SLUGS.each do |slug|
      html = output("tags/#{slug}/index.html")
      assert_empty robots_metas(html), slug
      assert_includes html, "/tags/#{slug}/feed.xml"
    end
    refute @site.collections.fetch('tags').docs.find { |doc| doc.data['name'] == 'Python' }.data.key?('feed_exclude')
  end
end
