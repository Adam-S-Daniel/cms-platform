# frozen_string_literal: true

# Real Jekyll build regressions for tags that differ only in case (#754) and
# blank tag names (#812).
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
    @config = Jekyll.configuration(
      'source' => @source, 'destination' => @destination, 'url' => 'https://example.com',
      'title' => 'Example', 'permalink' => '/blog/:slug/', 'timezone' => 'UTC',
      'quiet' => true, 'plugins' => [], 'time' => Time.utc(2024, 2, 1),
      'collections' => { 'tags' => { 'output' => true, 'permalink' => '/tags/:slug/' } },
      'defaults' => [{ 'scope' => { 'path' => '', 'type' => 'tags' }, 'values' => { 'layout' => 'tag' } }]
    )
    rebuild_site
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

  def add_post_and_rebuild(tags:, title: 'Blank tag edge')
    front_matter = { 'title' => title, 'layout' => 'post', 'published' => true, 'tags' => tags }
    File.write(File.join(@source, '_posts', "2024-01-10-#{title.downcase.tr(' ', '-')}.md"),
               "#{front_matter.to_yaml}---\nBody of #{title}.\n")
    rebuild_site
  end

  def rebuild_site
    @site = Jekyll::Site.new(@config).tap(&:process)
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

  def test_layouts_slugify_only_current_post_categories_inside_loops
    %w[tag.html atom_feed.xml].each do |layout|
      root = Liquid::Template.parse(File.read(File.join(ROOT, 'theme', '_layouts', layout)).sub(/\A---.*?---\n/m, '')).root
      assigns = slugify_assigns_in_loops(root)
      if layout == 'tag.html'
        assert_empty assigns
      else
        assert_operator assigns.size, :<=, 1
        assigns.each do |assign, loops|
          assert_equal 't', assign.from.name.name
          assert_equal 'post', loops.last.collection_name.name
          assert_equal ['tags'], loops.last.collection_name.lookups
          assert_equal ['tag_posts', 'post'], loops.map { |loop| loop.collection_name.name }
        end
      end
    end
  end

  def slugify_assigns_in_loops(node, loops: [])
    found = []
    if node.is_a?(Liquid::Assign) && !loops.empty? && node.from.filters.any? { |f| f.first == 'slugify' }
      found << [node, loops]
    end
    loops = loops + [node] if node.is_a?(Liquid::For)
    children = []
    children.concat(node.nodelist) if node.respond_to?(:nodelist) && node.nodelist.is_a?(Array)
    children.concat(node.blocks.map(&:attachment)) if node.respond_to?(:blocks)
    children.each { |c| found.concat(slugify_assigns_in_loops(c, loops: loops)) }
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

  def test_blank_post_names_do_not_add_a_tag_row_or_inflate_quotes
    add_post_and_rebuild(tags: ['quotes', '', ' '])

    rows = @site.config.fetch('all_tags')
    assert_equal 4, rows.find { |tag| tag['slug'] == 'quotes' }.fetch('count')
    refute rows.any? { |tag| tag['name'].to_s.strip.empty? }, "blank tag rows: #{rows.inspect}"
  end

  def test_blank_post_names_mint_no_empty_archive_or_feed_and_keep_the_valid_tag
    add_post_and_rebuild(tags: ['quotes', '', ' '])

    refute @site.pages.any? { |page| page.url == '/tags//' }, 'no page at the empty tag URL'
    refute @site.pages.any? { |page| page.url == '/tags//feed.xml' }, 'no feed page at the empty tag URL'
    refute @site.pages.any? { |page| page.data['permalink'] == '/tags//' }, 'no raw empty archive permalink'
    refute @site.pages.any? { |page| page.data['permalink'] == '/tags//feed.xml' }, 'no raw empty feed permalink'
    refute File.exist?(File.join(@destination, 'tags', 'feed.xml')), 'no generated empty-tag feed file'
    assert_includes @site.config.fetch('tag_posts_by_slug').fetch('quotes').map { |post| post.data['title'] },
                    'Blank tag edge'
    assert_includes listed_titles('tags/quotes'), 'Blank tag edge'
    quotes_feed = REXML::Document.new(File.read(File.join(@destination, 'tags/quotes/feed.xml')))
    titles = REXML::XPath.match(quotes_feed, '//a:entry/a:title', ATOM).map { |node| node.texts.join }
    assert_includes titles, 'Blank tag edge'
  end

  def test_post_pills_render_only_nonblank_names
    add_post_and_rebuild(tags: ['quotes', '', ' '])

    post = @site.posts.docs.find { |doc| doc.data['title'] == 'Blank tag edge' }
    post_doc = html(post.url.delete_prefix('/').chomp('/'))
    pill_hrefs = REXML::XPath.match(post_doc, "//a[@class='tag-pill']").map { |node| node.attributes['href'] }
    assert_equal ['/tags/quotes/'], pill_hrefs
  end

  def test_atom_categories_render_only_nonblank_names
    add_post_and_rebuild(tags: ['quotes', '', ' '])

    feed = REXML::Document.new(File.read(File.join(@destination, 'tags/quotes/feed.xml')))
    entry = REXML::XPath.first(feed, "//a:entry[a:title='Blank tag edge']", ATOM)
    categories = REXML::XPath.match(entry, 'a:category', ATOM).map { |node| node.attributes['term'] }
    assert_equal ['quotes'], categories
  end

  def test_blank_curated_names_do_not_add_rows_feeds_or_suppress_quotes
    File.write(File.join(@source, '_tags', 'blank-name.md'), "---\nname: ''\n---\n")
    File.write(File.join(@source, '_tags', 'null-name.md'), "---\nname: null\n---\n")
    add_post_and_rebuild(tags: ['quotes', '', ' '])

    rows = @site.config.fetch('all_tags')
    refute rows.any? { |tag| tag['name'].to_s.strip.empty? }, "blank curated rows: #{rows.inspect}"
    assert rows.any? { |tag| tag['slug'] == 'quotes' }, 'blank curated entries did not suppress quotes'
    refute @site.pages.any? { |page| page.url == '/tags//' }, 'no auto archive at the empty tag URL'
    refute @site.pages.any? { |page| page.url == '/tags//feed.xml' }, 'no feed page at the empty tag URL'
    refute @site.pages.any? { |page| page.data['permalink'] == '/tags//' }, 'no raw empty archive permalink'
    refute @site.pages.any? { |page| page.data['permalink'] == '/tags//feed.xml' }, 'no raw empty feed permalink'
    refute File.exist?(File.join(@destination, 'tags', 'feed.xml')), 'no generated empty-tag feed file'
    assert File.exist?(File.join(@destination, 'tags/quotes/feed.xml')), 'quotes feed remains generated'
  end

  def test_blank_curated_documents_are_not_kept_or_rendered
    File.write(File.join(@source, '_tags', 'blank-name.md'), "---\nname: ''\n---\n")
    File.write(File.join(@source, '_tags', 'null-name.md'), "---\nname: null\n---\n")
    rebuild_site

    blank_docs = @site.collections['tags'].docs.select { |doc| doc.data['name'].to_s.strip.empty? }
    assert_empty blank_docs, 'blank curated documents must not remain in the public tags collection'
    refute File.exist?(File.join(@destination, 'tags/blank-name/index.html')),
           'blank-name collection document has no rendered output'
    refute File.exist?(File.join(@destination, 'tags/null-name/index.html')),
           'null-name collection document has no rendered output'
  end

  def test_blank_curated_document_does_not_overwrite_a_valid_archive
    File.write(File.join(@source, '_tags', 'quotes.md'), "---\nname: ''\n---\n")
    rebuild_site

    archive_docs = @site.collections['tags'].docs.count { |doc| doc.url == '/tags/quotes/' }
    archive_pages = @site.pages.count { |page| page.url == '/tags/quotes/' }
    assert_equal 1, archive_docs + archive_pages, 'only one actual document or generated page owns the quotes URL'
    assert_equal ['Quote three', 'Quote two', 'Quote one'], listed_titles('tags/quotes')
    heading = REXML::XPath.first(html('tags/quotes'), "//h1[@class='tag-title']")
    assert_equal 'Quotes', heading.texts.join
  end

  def test_blank_excluded_curated_name_does_not_suppress_quotes
    File.write(File.join(@source, '_tags', 'blank-fixture.md'), "---\nname: ' '\ntest_fixture: true\n---\n")
    add_post_and_rebuild(tags: ['quotes', '', ' '])

    assert Jekyll::ExcludeE2EPosts.excluded_tag_names(@site).none? { |name| name.to_s.strip.empty? },
           'blank fixture name must not enter the exclusion list'
    rows = @site.config.fetch('all_tags')
    refute rows.any? { |tag| tag['name'].to_s.strip.empty? }, "blank excluded tag rows: #{rows.inspect}"
    assert rows.any? { |tag| tag['slug'] == 'quotes' }, 'blank fixture entry did not suppress quotes'
    refute @site.pages.any? { |page| page.data['permalink'] == '/tags//' }, 'no raw empty archive permalink'
    refute @site.pages.any? { |page| page.data['permalink'] == '/tags//feed.xml' }, 'no raw empty feed permalink'
    assert File.exist?(File.join(@destination, 'tags/quotes/feed.xml')), 'quotes feed remains generated'
  end
  # Exact rendered bytes from dc0b3429 for the same normal tags.
  def test_normal_post_tag_region_preserves_base_bytes
    add_post_and_rebuild(tags: ['quotes', 'AI Tools'], title: 'Normal tags')
    rendered = File.read(File.join(@destination, 'blog/normal-tags/index.html'))
    region = rendered.split('<div class="post-tags">', 2).last.split('</div>', 2).first
    expected = "\n          <a class=\"tag-pill\" href=\"/tags/quotes/\">quotes</a>\n          <a class=\"tag-pill\" href=\"/tags/ai-tools/\">AI Tools</a>\n          \n        "
    assert_equal expected, region
  end

  def test_normal_feed_categories_preserve_base_bytes
    add_post_and_rebuild(tags: ['quotes', 'AI Tools'], title: 'Normal tags')
    rendered = File.read(File.join(@destination, 'tags/quotes/feed.xml'))
    entry = rendered.split('<title type="html">Normal tags</title>', 2).last
    region = entry.split('</content>', 2).last.split('<summary', 2).first
    assert_equal "\n    <category term=\"quotes\" />\n    <category term=\"AI Tools\" />\n    ", region
  end

  def assert_only_valid_tags(tags)
    add_post_and_rebuild(tags: ['quotes', *tags])
    refute @site.config.fetch('all_tags').any? { |tag| tag['slug'].empty? }
    refute @site.config.fetch('tag_posts_by_slug').key?('')
    refute @site.pages.any? { |page| ['/tags//', '/tags//feed.xml'].include?(page.data['permalink']) }
    refute File.exist?(File.join(@destination, 'tags/feed.xml'))
    assert_equal [['quotes', '/tags/quotes/', '4']], cards(html('tags')).select { |_, href, _| href == '/tags/quotes/' }
    post = html('blog/blank-tag-edge')
    assert_equal ['/tags/quotes/'], REXML::XPath.match(post, "//a[@class='tag-pill']").map { |node| node.attributes['href'] }
    feed = REXML::Document.new(File.read(File.join(@destination, 'tags/quotes/feed.xml')))
    entry = REXML::XPath.first(feed, "//a:entry[a:title='Blank tag edge']", ATOM)
    assert_equal ['quotes'], REXML::XPath.match(entry, 'a:category', ATOM).map { |node| node.attributes['term'] }
  end

  def test_empty_slug_post_names_are_skipped_everywhere
    assert_only_valid_tags(["\u00a0", '!!!', '🙂'])
  end

  def test_empty_slug_curated_and_excluded_names_are_removed
    ["\u00a0", '!!!', '🙂'].each_with_index do |name, i|
      [false, true].each do |excluded|
        File.write(File.join(@source, '_tags', "invalid-#{i}-#{excluded}.md"), "#{{ 'name' => name, 'test_fixture' => excluded }.to_yaml}---\n")
      end
    end
    assert_only_valid_tags(["\u00a0", '!!!', '🙂'])
    refute @site.collections['tags'].docs.any? { |doc| Jekyll::Utils.slugify(doc.data['name'].to_s).empty? }
    refute Dir.glob(File.join(@destination, 'tags/invalid-*/index.html')).any?
  end

  def assert_scalar_tag_builds(value, tags: ['quotes', value])
    add_post_and_rebuild(tags: tags)
    slug = value.to_s
    assert_includes listed_titles("tags/#{slug}"), 'Blank tag edge'
    assert File.exist?(File.join(@destination, "tags/#{slug}/feed.xml"))
    assert_includes cards(html('tags')).map { |_, href, _| href }, "/tags/#{slug}/"
    assert_includes REXML::XPath.match(html('blog/blank-tag-edge'), "//a[@class='tag-pill']").map { |node| node.attributes['href'] }, "/tags/#{slug}/"
    feed = REXML::Document.new(File.read(File.join(@destination, "tags/#{slug}/feed.xml")))
    assert_includes REXML::XPath.match(feed, '//a:category', ATOM).map { |node| node.attributes['term'] }, slug
  end

  def test_integer_tag_builds_an_archive_feed_index_row_and_pill
    assert_scalar_tag_builds(2024)
  end

  def test_boolean_tag_builds_an_archive_feed_index_row_and_pill
    assert_scalar_tag_builds(true)
    # Jekyll normalizes a bare boolean tags value to an empty array.
    add_post_and_rebuild(tags: true)
    post = @site.posts.docs.find { |doc| doc.data['title'] == 'Blank tag edge' }
    assert_empty post.data['tags']
    refute @site.config.fetch('all_tags').any? { |tag| tag['slug'] == 'true' }
    assert File.exist?(File.join(@destination, 'blog/blank-tag-edge/index.html'))
  end
end
