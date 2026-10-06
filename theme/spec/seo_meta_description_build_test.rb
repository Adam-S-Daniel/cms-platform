# frozen_string_literal: true

# Real Jekyll build with the real jekyll-seo-tag against the theme's real
# _layouts/default.html (#654). The layout used to hard-code a
# `<meta name="description">` of the site tagline ahead of `{% seo %}`, so every
# page carried two and crawlers, which take the first, never saw a post's
# excerpt. jekyll-seo-tag owns the tag (page.description, else the excerpt,
# else site.description), so the layout must add none of its own.
# Run with: ruby theme/spec/seo_meta_description_build_test.rb
# Needs jekyll 4.4.1 and jekyll-seo-tag 2.9.0 (the ruby-theme-specs lane installs both).

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'rexml/document'
require 'rexml/parsers/pullparser'
require 'jekyll'
require 'jekyll-seo-tag'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

class SeoMetaDescriptionBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  SITE_DESCRIPTION = 'Example site tagline'

  def setup
    @tmpdir = Dir.mktmpdir('seo-meta-description-build-')
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
    File.write(File.join(source, '_posts', '2024-01-01-with-excerpt.md'),
               "---\ntitle: With excerpt\nlayout: post\n---\nThe excerpt of the post.\n\nThe rest of the body.\n")
    File.write(File.join(source, '_posts', '2024-01-02-with-description.md'),
               "---\ntitle: With description\nlayout: post\ndescription: A hand-written description.\n---\nBody paragraph.\n")
    File.write(File.join(source, 'index.html'), "---\nlayout: default\ntitle: Home\n---\n<p>Home</p>\n")

    Jekyll::Site.new(Jekyll.configuration(
      'source' => source,
      'destination' => @destination,
      'url' => 'https://example.com',
      'title' => 'Example',
      'description' => SITE_DESCRIPTION,
      'permalink' => '/blog/:slug/',
      'timezone' => 'UTC',
      'quiet' => true,
      'plugins' => [],
    )).process
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

  def descriptions(path)
    head_meta(path).select { |meta| meta['name'] == 'description' }.map { |meta| meta['content'] }
  end

  def test_a_post_has_exactly_one_description_and_it_is_the_excerpt
    assert_equal ['The excerpt of the post.'], descriptions('blog/with-excerpt/index.html')
  end

  def test_a_post_front_matter_description_is_the_only_one
    assert_equal ['A hand-written description.'], descriptions('blog/with-description/index.html')
  end

  def test_a_page_without_its_own_description_falls_back_to_the_site_description_once
    assert_equal [SITE_DESCRIPTION], descriptions('index.html')
  end
end
