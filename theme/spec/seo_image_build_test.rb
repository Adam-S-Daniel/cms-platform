# frozen_string_literal: true

# Real Jekyll build with the real jekyll-seo-tag and the theme's seo_image hook
# against the real _layouts/default.html (#655). jekyll-seo-tag reads only
# `image:`, but posts carry `featured_image:`, so no page had og:image /
# twitter:image and shared links showed no picture.
# Run with: ruby theme/spec/seo_image_build_test.rb
# Needs jekyll 4.4.1 and jekyll-seo-tag 2.9.0 (the ruby-theme-specs lane installs both).

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'rexml/document'
require 'rexml/parsers/pullparser'
require 'jekyll'
require 'jekyll-seo-tag'
require_relative '../lib/cms-platform-theme/seo_image'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

class SeoImageBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)

  POSTS = {
    'with-featured' => "title: With featured\nfeatured_image: /assets/images/uploads/photo.jpg\n",
    'with-explicit-image' => "title: With explicit image\nfeatured_image: /assets/images/uploads/photo.jpg\nimage: /assets/images/uploads/card.jpg\n",
    'with-blank-featured' => "title: With blank featured\nfeatured_image: \"\"\n",
    'without-image' => "title: Without image\n",
  }.freeze

  def build(extra_config = {})
    source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    FileUtils.mkdir_p(File.join(source, '_posts'))
    FileUtils.mkdir_p(File.join(source, '_layouts'))
    %w[default.html post.html].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(source, '_layouts', layout))
    end
    %w[feed-link.html favicon.html rel-me.html header.html footer.html share-row.html analytics/cloudwatch-rum.html].each do |include|
      destination = File.join(source, '_includes', include)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', include), destination)
    end
    POSTS.each do |slug, front_matter|
      File.write(File.join(source, '_posts', "2024-01-01-#{slug}.md"),
                 "---\nlayout: post\n#{front_matter}---\nBody for #{slug}.\n")
    end
    File.write(File.join(source, 'index.html'), "---\nlayout: default\ntitle: Home\n---\n<p>Home</p>\n")

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

  def setup
    @tmpdir = Dir.mktmpdir('seo-image-build-')
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  # Attribute hashes of every <meta> directly inside <head>, from a parse (not a
  # pattern match). Void tags are closed first so the XML pull parser accepts them.
  def head_meta(path)
    html = File.read(File.join(@destination, path))
    xml = html.gsub(/<!--.*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/m) do |token|
      token.match?(/\A<(?:meta|link)\b/i) && !token.end_with?('/>') ? token.sub(/>\z/, '/>') : token
    end
    parser = REXML::Parsers::PullParser.new(xml)
    stack = []
    metas = []
    while parser.has_next?
      event = parser.pull
      if event.start_element?
        stack << event[0]
        metas << event[1] if stack.first(2) == %w[html head] && event[0] == 'meta'
      elsif event.end_element?
        return metas if stack == %w[html head] && event[0] == 'head'

        stack.pop
      end
    end
    flunk "#{path} must have an html/head element"
  end

  def values(path, key, name)
    head_meta(path).select { |meta| meta[key] == name }.map { |meta| meta['content'] }
  end

  def card(path)
    values(path, 'name', 'twitter:card')
  end

  def test_featured_image_becomes_an_absolute_og_and_twitter_image_with_a_large_card
    path = 'blog/with-featured/index.html'
    build
    url = 'https://example.com/assets/images/uploads/photo.jpg'
    assert_equal [url], values(path, 'property', 'og:image')
    assert_equal [url], values(path, 'name', 'twitter:image')
    assert_equal ['summary_large_image'], card(path)
  end

  def test_an_explicit_image_wins_over_featured_image
    build
    path = 'blog/with-explicit-image/index.html'
    assert_equal ['https://example.com/assets/images/uploads/card.jpg'], values(path, 'property', 'og:image')
  end

  def test_no_image_and_no_default_keeps_the_summary_card
    build
    %w[blog/without-image/index.html blog/with-blank-featured/index.html index.html].each do |path|
      assert_empty values(path, 'property', 'og:image'), path
      assert_empty values(path, 'name', 'twitter:image'), path
      assert_equal ['summary'], card(path), path
    end
  end

  def test_the_site_default_image_covers_pages_and_posts_without_their_own
    build('default_image' => '/assets/images/default-share.png')
    default = 'https://example.com/assets/images/default-share.png'
    %w[blog/without-image/index.html blog/with-blank-featured/index.html index.html].each do |path|
      assert_equal [default], values(path, 'property', 'og:image'), path
      assert_equal ['summary_large_image'], card(path), path
    end
    assert_equal ['https://example.com/assets/images/uploads/photo.jpg'],
                 values('blog/with-featured/index.html', 'property', 'og:image')
    assert_equal ['https://example.com/assets/images/uploads/card.jpg'],
                 values('blog/with-explicit-image/index.html', 'property', 'og:image')
  end
end
