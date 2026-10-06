# frozen_string_literal: true

# Real Jekyll build regression for tags that differ only in case (#754).
# `quotes` and `Quotes` slugify alike, so they share /tags/quotes/. Before the
# fix /tags/ showed two identical cards, two pages were minted at one URL (the
# later one won) and its layout matched the exact spelling, so the page
# dropped every post under the other spelling. Now they are one tag: one card
# with the combined count, one archive and one feed listing every post.
# Rendered pages are parsed with REXML, not matched with a regex.
# Run with: ruby theme/spec/tag_case_variants_build_test.rb

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'yaml'
require 'rexml/document'
require 'jekyll'
require_relative '../lib/cms-platform-theme/exclude_e2e_posts'
require_relative '../lib/cms-platform-theme/auto_tag_pages'
require_relative '../lib/cms-platform-theme/tag_feeds'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

# jekyll-seo-tag is unrelated to tag grouping and is not a test dependency.
class TagCaseSeoStandIn < Liquid::Tag
  def render(_context)
    ''
  end
end

Liquid::Template.register_tag('seo', TagCaseSeoStandIn)

class TagCaseVariantsBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  ATOM = { 'a' => 'http://www.w3.org/2005/Atom' }.freeze

  # filename date => [title, tags]. Jekyll orders posts by date, so "first seen"
  # is the earliest post.
  POSTS = {
    '2024-01-01' => ['Quote one', ['quotes']],
    '2024-01-02' => ['Quote two', ['Quotes']],
    '2024-01-03' => ['Quote three', ['Quotes']],
    # A tie (one post each): the spelling seen first, `ai tools`, is the name.
    '2024-01-04' => ['Tool one', ['ai tools']],
    '2024-01-05' => ['Tool two', ['AI Tools']],
    # Both spellings on ONE post: it counts once and appears once.
    '2024-01-06' => ['Both spellings', %w[Mixed mixed]],
    # The `_tags/release.md` entry names the tag `Release`; this post differs.
    '2024-01-07' => ['Release notes', ['release']],
    '2024-01-08' => ['Plain', ['Plain']],
    # A case variant of an excluded `_tags/` entry (test_fixture: true).
    '2024-01-09' => ['Fixture post', ['fixture tag']],
  }.freeze

  def setup
    @tmpdir = Dir.mktmpdir('tag-case-variants-build-')
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
    FileUtils.cp(File.join(ROOT, 'e2e', 'fixture-site', 'tags', 'index.html'),
                 File.join(@source, 'tags', 'index.html'))
    {
      'release' => { 'name' => 'Release' },
      'fixture-tag' => { 'name' => 'Fixture Tag', 'test_fixture' => true },
      'empty-tag' => { 'name' => 'Empty Tag' },
    }.each do |slug, data|
      File.write(File.join(@source, '_tags', "#{slug}.md"), "#{data.to_yaml}---\n")
    end
    POSTS.each do |date, (title, tags)|
      # The CMS always writes `published: true`; the per-tag feed filters on it.
      front_matter = { 'title' => title, 'layout' => 'post', 'published' => true, 'tags' => tags }
      File.write(File.join(@source, '_posts', "#{date}-#{title.downcase.tr(' ', '-')}.md"),
                 "#{front_matter.to_yaml}---\nBody of #{title}.\n")
    end
    @site = Jekyll::Site.new(Jekyll.configuration(
      'source' => @source, 'destination' => @destination, 'url' => 'https://example.com',
      'title' => 'Example', 'permalink' => '/blog/:slug/', 'timezone' => 'UTC',
      'quiet' => true, 'plugins' => [],
      'collections' => { 'tags' => { 'output' => true, 'permalink' => '/tags/:slug/' } },
      'defaults' => [{ 'scope' => { 'path' => '', 'type' => 'tags' }, 'values' => { 'layout' => 'tag' } }]
    )).tap(&:process)
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  # Void tags, a few named entities and bare ampersands are the only non-XML
  # tokens in the rendered HTML; normalize those lexically, then let REXML
  # build the tree.
  def html(rel)
    source = File.read(File.join(@destination, rel, 'index.html'))
    xml = source.gsub(/<!--.*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/m) do |token|
      token.match?(/\A<(?:meta|link|img|br|hr|input)\b/i) && !token.end_with?('/>') ? token.sub(/>\z/, '/>') : token
    end
    xml = xml.sub(/\A\s*<!DOCTYPE[^>]*>/i, '').gsub('&copy;', '&#169;').gsub('&larr;', '&#8592;')
    REXML::Document.new(xml.gsub(/&(?!(?:#\d+|[a-z]+);)/i, '&amp;'))
  end

  def cards(doc)
    REXML::XPath.match(doc, "//li[@class='tag-list-item']").map do |li|
      [REXML::XPath.first(li, ".//span[@class='tag-list-name']").texts.join,
       REXML::XPath.first(li, ".//a[@class='tag-list-link']").attributes['href'],
       REXML::XPath.first(li, ".//span[@class='tag-list-count']").texts.join]
    end
  end

  def listed_titles(rel)
    REXML::XPath.match(html(rel), "//li[@class='post-item']//h2[@class='post-title']/a").map { |a| a.texts.join }
  end

  def test_all_tags_has_one_row_per_slug_with_the_combined_count
    rows = @site.config.fetch('all_tags').to_h { |t| [t['slug'], t] }
    assert_equal %w[ai-tools empty-tag mixed plain quotes release], rows.keys.sort
    assert_equal 3, rows.fetch('quotes').fetch('count')
    assert_equal 2, rows.fetch('ai-tools').fetch('count')
    assert_equal 1, rows.fetch('mixed').fetch('count'), 'one post carrying both spellings counts once'
  end

  def test_display_name_is_the_entry_then_the_most_used_then_the_first_seen
    names = @site.config.fetch('all_tags').to_h { |t| [t['slug'], t['name']] }
    assert_equal 'Quotes', names.fetch('quotes'), 'two posts use Quotes, one uses quotes'
    assert_equal 'ai tools', names.fetch('ai-tools'), 'a tie goes to the spelling seen first'
    assert_equal 'Release', names.fetch('release'), 'a _tags/ entry wins over the posts spelling'
  end

  def test_tags_index_shows_one_card_per_tag
    quotes = cards(html('tags')).select { |_, href, _| href == '/tags/quotes/' }
    assert_equal [['Quotes', '/tags/quotes/', '3']], quotes
    hrefs = cards(html('tags')).map { |_, href, _| href }
    assert_equal hrefs.uniq, hrefs, 'no two cards share a link'
  end

  # What e2e/tags.spec.js asserts on a live site: a card's count is the number
  # of posts its archive lists.
  def test_every_card_count_equals_its_archive_post_count
    cards(html('tags')).each do |name, href, count|
      listed = listed_titles(href.delete_prefix('/').chomp('/')).size
      assert_equal count.to_i, listed, "#{name} (#{href}) counts #{count} but lists #{listed}"
    end
  end

  # The slug-based exclusion (auto_tag_pages.rb): `fixture tag` is a case
  # variant of the excluded `Fixture Tag` entry, so it is that tag, not a new
  # one. Matching the exact name would put it in all_tags and mint a second
  # page at the entry's own URL.
  def test_a_case_variant_of_an_excluded_tags_entry_is_excluded_too
    slugs = @site.config.fetch('all_tags').map { |t| t['slug'] }
    refute_includes slugs, 'fixture-tag'
    minted = @site.pages.select { |p| p.url.start_with?('/tags/fixture-tag/') }
    assert_empty minted.map(&:url), 'no auto page or feed at the excluded entry URL'
    assert_equal 1, @site.collections['tags'].docs.count { |d| d.url == '/tags/fixture-tag/' }
  end

  # A tag with no post: both layouts must cope with the empty lookup.
  def test_a_tag_with_no_posts_renders_empty_page_and_feed
    assert_empty listed_titles('tags/empty-tag')
    assert_includes File.read(File.join(@destination, 'tags/empty-tag/index.html')), 'No posts yet'
    feed = REXML::Document.new(File.read(File.join(@destination, 'tags/empty-tag/feed.xml')))
    assert_empty REXML::XPath.match(feed, '//a:entry', ATOM)
  end

  # The layouts read a list built once by the generator; slugifying every
  # post's tags on every tag page made a 2,000-post, 300-tag build 4x slower.
  def test_posts_by_slug_is_built_once_and_matches_the_archives
    index = @site.config.fetch('tag_posts_by_slug')
    assert_equal ['Quote three', 'Quote two', 'Quote one'], index.fetch('quotes').map { |p| p.data['title'] }
    assert_equal ['Both spellings'], index.fetch('mixed').map { |p| p.data['title'] }
    assert_equal ['Fixture post'], index.fetch('fixture-tag').map { |p| p.data['title'] }
  end

  def test_layouts_do_not_slugify_inside_a_loop
    %w[tag.html atom_feed.xml].each do |layout|
      root = Liquid::Template.parse(File.read(File.join(ROOT, 'theme', '_layouts', layout)).sub(/\A---.*?---\n/m, '')).root
      assert_empty slugify_assigns_in_loops(root), "#{layout} slugifies inside a for loop"
    end
  end

  # Walks a parsed Liquid tree; returns the `assign`s that pipe through
  # `slugify` while inside a `for` body.
  def slugify_assigns_in_loops(node, in_loop: false)
    found = []
    if node.is_a?(Liquid::Assign) && in_loop && node.from.filters.any? { |f| f.first == 'slugify' }
      found << node
    end
    in_loop ||= node.is_a?(Liquid::For)
    children = []
    children.concat(node.nodelist) if node.respond_to?(:nodelist) && node.nodelist.is_a?(Array)
    children.concat(node.blocks.map(&:attachment)) if node.respond_to?(:blocks)
    children.each { |c| found.concat(slugify_assigns_in_loops(c, in_loop: in_loop)) }
    found
  end

  def test_one_archive_page_per_slug
    urls = @site.pages.map(&:url).grep(%r{\A/tags/[^/]+/\z})
    assert_equal urls.uniq, urls, 'two pages minted at one URL'
    assert_includes urls, '/tags/quotes/'
  end

  def test_tag_page_lists_every_post_under_any_spelling
    assert_equal ['Quote three', 'Quote two', 'Quote one'], listed_titles('tags/quotes')
    assert_equal ['Tool two', 'Tool one'], listed_titles('tags/ai-tools')
    assert_equal ['Both spellings'], listed_titles('tags/mixed')
  end

  def test_tag_page_heading_is_the_display_name
    h1 = REXML::XPath.first(html('tags/quotes'), "//h1[@class='tag-title']")
    assert_equal 'Quotes', h1.texts.join
  end

  def test_a_tags_entry_page_lists_posts_under_a_different_spelling
    assert_equal ['Release notes'], listed_titles('tags/release')
  end

  def test_one_feed_per_slug_with_every_post
    feeds = @site.pages.select { |p| p.url == '/tags/quotes/feed.xml' }
    assert_equal 1, feeds.size
    feed = REXML::Document.new(File.read(File.join(@destination, 'tags/quotes/feed.xml')))
    titles = REXML::XPath.match(feed, '//a:entry/a:title', ATOM).map { |t| t.texts.join }
    assert_equal ['Quote three', 'Quote two', 'Quote one'], titles
    assert_equal 'Example: Quotes', REXML::XPath.first(feed, '/a:feed/a:title', ATOM).texts.join
  end
end
