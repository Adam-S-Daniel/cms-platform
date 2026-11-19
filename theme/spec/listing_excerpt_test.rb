# frozen_string_literal: true

# `listing_excerpt` (#1067): one post's excerpt must not be able to break, or
# run code on, the listing pages it is printed into.
#
# Two layers. The unit cases pin the rule (a typed excerpt is escaped text; one
# cut from the body is reduced to an allowlist). The build cases run a real
# Jekyll build of the theme's tag archive with hostile posts and read the
# built page with REXML, not a regex: every post is still listed, the footer
# is still there, and nothing executable survived.
# Run with: ruby theme/spec/listing_excerpt_test.rb

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
require_relative '../lib/cms-platform-theme/listing_excerpt'

class ListingExcerptSeoStandIn < Liquid::Tag
  def render(_context)
    ''
  end
end

Liquid::Template.register_tag('seo', ListingExcerptSeoStandIn)

class ListingExcerptUnitTest < Minitest::Test
  L = Jekyll::ListingExcerpt

  def test_a_typed_excerpt_is_escaped_text_whatever_it_mentions
    post = { 'excerpt' => 'Why I stopped using <script async> tags & "quotes"', 'excerpt_typed' => true }
    assert_equal 'Why I stopped using &lt;script async&gt; tags &amp; &quot;quotes&quot;', L.render(post)
  end

  def test_a_typed_excerpt_with_a_comment_opener_or_style_tag_stays_text
    post = { 'excerpt' => 'A note on <style> blocks and the <!-- comment syntax', 'excerpt_typed' => true }
    out = L.render(post)
    refute_includes out, '<'
    assert_includes out, '&lt;style&gt;'
    assert_includes out, '&lt;!-- comment'
  end

  def test_a_cut_excerpt_keeps_summary_formatting
    html = "<blockquote>\n  <p>“Quoted” with <em>emphasis</em>, <strong>strong</strong>, " \
           "<code>code &lt;b&gt;</code> &amp; a <a href=\"https://example.com/?a=1&amp;b=2\">link</a>.</p>\n</blockquote>"
    out = L.sanitize(html)
    assert_equal html, out
  end

  def test_scripts_styles_and_embeds_are_dropped_with_their_contents
    {
      '<script>document.title="x"</script>' => '',
      '<style>.site-header{display:none}</style>' => '',
      '<iframe src="https://example.com/embed" width="560" height="315"></iframe>' => '',
      '<p>Before <script>alert(1)</script> after</p>' => '<p>Before  after</p>',
      '<p><svg onload="alert(1)"><script>1</script></svg><base href="https://example.net/"></p>' => '<p></p>',
    }.each do |input, expected|
      assert_equal expected, L.sanitize(input), input
    end
  end

  def test_attributes_other_than_a_safe_href_src_and_alt_are_removed
    out = L.sanitize('<p class="c" style="position:fixed" onclick="x()">Look ' \
                     '<img src="/a.png" alt="x" onload="alert(1)" style="width:9000px"> ' \
                     '<a href="/blog/x/" onclick="x()" class="c" target="_blank">ok</a></p>')
    assert_equal '<p>Look <img src="/a.png" alt="x" /> <a href="/blog/x/">ok</a></p>', out
  end

  def test_a_link_or_image_with_an_unsafe_address_loses_it
    out = L.sanitize('<p><a href="javascript:alert(1)">one</a> <a href="//example.net/x">two</a> ' \
                     '<a href="data:text/html,x">three</a> <img src="javascript:alert(1)" alt="x"> ' \
                     '<a href="mailto:a@example.com">mail</a> <a href="#frag">frag</a></p>')
    assert_equal '<p>one two three  <a href="mailto:a@example.com">mail</a> <a href="#frag">frag</a></p>', out
  end

  def test_a_wrapper_that_is_not_on_the_list_is_unwrapped_and_its_text_kept
    assert_equal 'Spoiler<p>Hidden <strong>text</strong></p>',
                 L.sanitize('<details><summary>Spoiler</summary><p>Hidden <b>text</b></p></details>')
    assert_equal 'Heading first', L.sanitize('<h2 id="main-content">Heading first</h2>')
    assert_equal 'Oops  never closed',
                 L.sanitize('<div style="position:fixed;inset:0">Oops <!-- c --> never closed')
  end

  def test_text_is_escaped_on_the_way_out
    assert_equal '<p>a &lt; b &amp; 5 &gt; 3</p>', L.sanitize('<p>a &lt; b &amp; 5 &gt; 3</p>')
  end

  def test_blank_and_missing_excerpts_print_nothing
    assert_equal '', L.render({ 'excerpt' => '' })
    assert_equal '', L.render({ 'excerpt' => "  \n" })
    assert_equal '', L.render(nil)
  end

  def test_a_bare_string_is_treated_as_cut_markup
    assert_equal '<p>Plain</p>', L.render('<p>Plain</p><script>x()</script>')
  end
end

class ListingExcerptBuildTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)

  # filename date => [title, extra front matter, body]. All carry the tag
  # `notes`, so /tags/notes/ lists every one of them.
  POSTS = {
    '2024-01-01' => ['Typed script mention', { 'excerpt' => 'Why I stopped using <script async> tags' }, 'Body.'],
    '2024-01-02' => ['Typed style and comment', { 'excerpt' => 'On <style> blocks and the <!-- comment syntax' },
                     'Body.'],
    '2024-01-03' => ['Typed complete script', { 'excerpt' => 'Tip <script>document.title="x"</script> done' },
                     'Body.'],
    '2024-01-04' => ['Body opens with a script', {}, "<script>document.title=\"x\"</script>\n\nSecond paragraph."],
    '2024-01-05' => ['Body opens with a style block', {},
                     "<style>.site-header{display:none}</style>\n\nSecond paragraph."],
    '2024-01-06' => ['Body opens with a handler and a script link', {},
                     "Look <img src=\"/a.png\" alt=\"x\" onload=\"document.title='x'\"> and " \
                     "[click](javascript:alert(1)).\n\nSecond paragraph."],
    '2024-01-07' => ['Body opens with an embed', {},
                     "<iframe src=\"https://example.com/embed\" width=\"560\" height=\"315\"></iframe>\n\nSecond."],
    '2024-01-08' => ['Ordinary quote', {}, "> A quoted *line* with a [link](https://example.com/).\n\nSecond."],
  }.freeze

  def setup
    @tmpdir = Dir.mktmpdir('listing-excerpt-build-')
    @source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    %w[_posts _tags _layouts _includes].each { |d| FileUtils.mkdir_p(File.join(@source, d)) }
    %w[default.html post.html tag.html atom_feed.xml].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(@source, '_layouts', layout))
    end
    %w[feed-link.html favicon.html rel-me.html header.html footer.html share-row.html tag-pills.html
       analytics/cloudwatch-rum.html].each do |include|
      destination = File.join(@source, '_includes', include)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', include), destination)
    end
    POSTS.each do |date, (title, extra, body)|
      front_matter = { 'title' => title, 'layout' => 'post', 'published' => true, 'tags' => ['notes'] }.merge(extra)
      File.write(File.join(@source, '_posts', "#{date}-#{title.downcase.tr(' ', '-')}.md"),
                 "#{front_matter.to_yaml}---\n#{body}\n")
    end
    config = Jekyll.configuration(
      'source' => @source, 'destination' => @destination, 'url' => 'https://example.com',
      'title' => 'Example', 'permalink' => '/blog/:slug/', 'timezone' => 'UTC',
      'quiet' => true, 'plugins' => [], 'time' => Time.utc(2024, 2, 1),
      'collections' => { 'tags' => { 'output' => true, 'permalink' => '/tags/:slug/' } },
      'defaults' => [{ 'scope' => { 'path' => '', 'type' => 'tags' }, 'values' => { 'layout' => 'tag' } }]
    )
    @site = Jekyll::Site.new(config)
    @site.process
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  # The archive is well-formed apart from void tags, a few named entities and
  # bare ampersands; normalize those lexically, then let REXML build the tree.
  # A page an excerpt broke does not survive this: REXML raises on the
  # mismatched tags, which is itself the failure this test exists for.
  def archive
    source = File.read(File.join(@destination, 'tags', 'notes', 'index.html'))
    xml = source.gsub(/<!--.*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/m) do |token|
      token.match?(/\A<(?:meta|link|img|br|hr|input)\b/i) && !token.end_with?('/>') ? token.sub(/>\z/, '/>') : token
    end
    xml = xml.sub(/\A\s*<!DOCTYPE[^>]*>/i, '').gsub('&copy;', '&#169;').gsub('&larr;', '&#8592;')
    REXML::Document.new(xml.gsub(/&(?!(?:#\d+|[a-z]+);)/i, '&amp;'))
  end

  def items
    REXML::XPath.match(archive, "//li[@class='post-item']")
  end

  def item(title)
    found = items.find { |li| REXML::XPath.first(li, ".//h2[@class='post-title']/a").texts.join == title }
    refute_nil found, "the archive must list #{title}"
    found
  end

  def text_of(node)
    REXML::XPath.match(node, './/text()').map(&:value).join.gsub(/\s+/, ' ').strip
  end

  def test_the_hook_marks_only_posts_whose_front_matter_set_an_excerpt
    typed = @site.posts.docs.select { |d| d.data['excerpt_typed'] == true }.map { |d| d.data['title'] }
    assert_equal ['Typed complete script', 'Typed script mention', 'Typed style and comment'], typed.sort
  end

  def test_every_post_is_still_listed_and_the_page_still_ends_with_its_footer
    assert_equal POSTS.size, items.size, 'one excerpt must not remove the posts listed after it'
    refute_nil REXML::XPath.first(archive, "//footer[@class='site-footer']"), 'the footer must survive'
  end

  def test_nothing_executable_or_page_wide_reaches_the_list
    list = REXML::XPath.first(archive, "//ul[@class='post-list']")
    %w[script style iframe base link meta object embed svg].each do |name|
      assert_empty REXML::XPath.match(list, ".//#{name}"), "<#{name}> must not be printed in a listing"
    end
    REXML::XPath.match(list, './/*').each do |el|
      handlers = el.attributes.keys.grep(/\Aon/i)
      assert_empty handlers, "an event handler survived on <#{el.name}>"
      assert_nil el.attributes['style'], "an inline style survived on <#{el.name}>" unless el.name == 'ul'
      href = el.attributes['href']
      refute_match(/\A\s*javascript:/i, href) if href
    end
  end

  def test_a_typed_excerpt_reads_exactly_as_typed
    assert_includes text_of(item('Typed script mention')), 'Why I stopped using <script async> tags'
    assert_includes text_of(item('Typed style and comment')), 'On <style> blocks and the <!-- comment syntax'
    assert_includes text_of(item('Typed complete script')), 'Tip <script>document.title="x"</script> done'
  end

  def test_an_ordinary_excerpt_keeps_its_formatting
    quote = item('Ordinary quote')
    refute_nil REXML::XPath.first(quote, './/blockquote/p/em'), 'emphasis inside the block quote is kept'
    link = REXML::XPath.first(quote, './/blockquote/p/a')
    assert_equal 'https://example.com/', link.attributes['href']
  end

  def test_a_safe_image_survives_without_its_handler
    img = REXML::XPath.first(item('Body opens with a handler and a script link'), './/img')
    assert_equal '/a.png', img.attributes['src']
    assert_equal 'x', img.attributes['alt']
    assert_equal %w[alt src], img.attributes.keys.sort
  end
end
