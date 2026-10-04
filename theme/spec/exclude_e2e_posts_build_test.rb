# frozen_string_literal: true

# Real Jekyll read/generate/render regression for the fixture exclusion hook.
# The pure apply tests cannot catch a hook that runs before front matter is read.
# Run with: ruby theme/spec/exclude_e2e_posts_build_test.rb

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'yaml'
require 'jekyll'
require 'jekyll-sitemap'
require_relative '../lib/cms-platform-theme/exclude_e2e_posts'
require_relative '../lib/cms-platform-theme/auto_tag_pages'
require_relative '../lib/cms-platform-theme/tag_feeds'

class ExcludeE2EPostsBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  POSTS = {
    'ordinary-fixture' => {
      'test_fixture' => true,
      'sitemap' => true,
      'feed_exclude' => false,
      'tags' => ['Shared', 'Flag Only'],
    },
    'e2e-filename-fixture' => { 'tags' => ['Shared', 'Filename Only'] },
    'ordinary-slug-fixture' => {
      'slug' => 'e2e-explicit-slug',
      'sitemap' => true,
      'feed_exclude' => false,
      'tags' => ['Shared', 'Slug Only'],
    },
    'normal-post' => { 'tags' => ['Shared', 'Public Only'] },
    'e2e-overridden-filename' => { 'slug' => 'public-override', 'tags' => ['Shared'] },
  }.freeze
  FIXTURE_SLUGS = %w[ordinary-fixture e2e-filename-fixture e2e-explicit-slug].freeze
  PUBLIC_SLUGS = %w[normal-post public-override].freeze

  def setup
    @tmpdir = Dir.mktmpdir('exclude-e2e-posts-build-')
    source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    FileUtils.mkdir_p(File.join(source, '_posts'))
    FileUtils.mkdir_p(File.join(source, '_layouts'))
    FileUtils.mkdir_p(File.join(source, '_includes'))

    # Use the actual aggregation templates and generators, with a minimal
    # default layout so unrelated theme integrations need no test doubles.
    %w[tag.html atom_feed.xml].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(source, '_layouts', layout))
    end
    FileUtils.cp(File.join(ROOT, 'theme', '_includes', 'feed-link.html'), File.join(source, '_includes'))
    FileUtils.cp(File.join(ROOT, 'e2e', 'fixture-site', 'feed.xml'), File.join(source, 'feed.xml'))
    File.write(File.join(source, '_layouts', 'default.html'), "---\n---\n{{ content }}")

    POSTS.each do |filename, data|
      front_matter = { 'title' => filename, 'published' => true }.merge(data)
      File.write(File.join(source, '_posts', "2024-01-01-#{filename}.md"),
                 "#{front_matter.to_yaml}---\nPost body for #{filename}.\n")
    end

    listing = <<~LIQUID
      ---
      layout: null
      ---
      {% assign public_posts = site.posts | where_exp: 'p', 'p.feed_exclude != true' %}
      {% for post in public_posts %}{{ post.url }}{% endfor %}
    LIQUID
    File.write(File.join(source, 'index.html'), listing)
    FileUtils.mkdir_p(File.join(source, 'blog'))
    File.write(File.join(source, 'blog', 'index.html'), listing)
    File.write(File.join(source, 'collections.html'), <<~LIQUID)
      ---
      layout: null
      permalink: /collections.html
      ---
      {% assign posts_collection = site.collections | where: 'label', 'posts' | first %}
      {% assign public_posts = posts_collection.docs | where_exp: 'p', 'p.feed_exclude != true' %}
      {% for post in public_posts %}{{ post.url }}{% endfor %}
    LIQUID
    File.write(File.join(source, 'tag-cloud.html'), <<~LIQUID)
      ---
      layout: null
      permalink: /tag-cloud.html
      ---
      {% for tag in site.all_tags %}{{ tag.name }}:{{ tag.count }};{% endfor %}
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
    ))
    @site.process
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  def output(path)
    File.read(File.join(@destination, path))
  end

  def post(slug)
    @site.posts.docs.find { |doc| doc.data['slug'] == slug }
  end

  def assert_public_posts_only(content)
    FIXTURE_SLUGS.each { |slug| refute_includes content, "/blog/#{slug}/" }
    PUBLIC_SLUGS.each { |slug| assert_includes content, "/blog/#{slug}/" }
  end

  def test_front_matter_flag_stamps_exclusion_after_the_real_read
    fixture = post('ordinary-fixture')
    assert_equal true, fixture.data['test_fixture']
    assert_equal false, fixture.data['sitemap']
    assert_equal true, fixture.data['feed_exclude']
  end

  def test_filename_path_without_a_front_matter_flag_still_gets_excluded
    fixture = post('e2e-filename-fixture')
    refute fixture.data.key?('test_fixture')
    assert_equal false, fixture.data['sitemap']
    assert_equal true, fixture.data['feed_exclude']
  end

  def test_final_front_matter_slug_governs_exclusion_in_both_directions
    fixture = post('e2e-explicit-slug')
    assert_equal false, fixture.data['sitemap']
    assert_equal true, fixture.data['feed_exclude']
    PUBLIC_SLUGS.each do |slug|
      refute post(slug).data.key?('sitemap')
      refute post(slug).data.key?('feed_exclude')
    end
  end

  def test_documents_stay_in_posts_and_collections_and_serve_direct_urls
    expected = (FIXTURE_SLUGS + PUBLIC_SLUGS).sort
    assert_equal expected, @site.posts.docs.map { |doc| doc.data['slug'] }.sort
    assert_equal expected, @site.collections.fetch('posts').docs.map { |doc| doc.data['slug'] }.sort
    expected.each do |slug|
      assert_includes output("blog/#{slug}/index.html"), 'Post body for '
    end
  end

  def test_feed_and_sitemap_filter_fixtures_and_keep_normal_posts
    %w[feed.xml sitemap.xml].each { |path| assert_public_posts_only(output(path)) }
  end

  def test_site_posts_and_collection_listings_filter_fixtures
    %w[index.html blog/index.html collections.html].each { |path| assert_public_posts_only(output(path)) }
  end

  def test_shared_tag_archive_and_feed_filter_fixtures
    %w[tags/shared/index.html tags/shared/feed.xml].each { |path| assert_public_posts_only(output(path)) }
  end

  def test_fixture_only_tags_generate_no_archives_feeds_or_cloud_entries
    %w[flag-only filename-only slug-only].each do |slug|
      refute File.exist?(File.join(@destination, 'tags', slug, 'index.html')), slug
      refute File.exist?(File.join(@destination, 'tags', slug, 'feed.xml')), slug
    end
    assert_equal %w[Public\ Only Shared], @site.config.fetch('all_tags').map { |tag| tag.fetch('name') }
    assert_equal 'Public Only:1;Shared:2;', output('tag-cloud.html').strip
  end
end
