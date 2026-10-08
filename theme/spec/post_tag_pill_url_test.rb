# frozen_string_literal: true

# Real Liquid regression for the shared tag-pill include. Run:
#   ruby theme/spec/post_tag_pill_url_test.rb
#
# Jekyll's Liquid parser and filters are used so the test exercises the same
# assign, strip, slugify and relative_url behavior as theme and site templates.

require 'minitest/autorun'
require 'rexml/document'
require 'jekyll'
require 'tmpdir'
require 'fileutils'

class PostTagPillUrlTest < Minitest::Test
  def setup
    @tmpdir = Dir.mktmpdir('tag-pills-liquid-')
    FileUtils.mkdir_p(File.join(@tmpdir, '_includes'))
    include_path = File.expand_path('../_includes/tag-pills.html', __dir__)
    FileUtils.cp(include_path, File.join(@tmpdir, '_includes')) if File.exist?(include_path)
    @site = Jekyll::Site.new(Jekyll.configuration(
      'source' => @tmpdir, 'destination' => File.join(@tmpdir, '_site'),
      'baseurl' => '', 'quiet' => true, 'plugins' => []
    ))
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  def render_pills(tags, limit: nil)
    source = if limit.nil?
               "{% include tag-pills.html tags=tags %}"
             else
               "{% include tag-pills.html tags=tags limit=limit %}"
             end
    rendered = Liquid::Template.parse(source).render!(
      { 'tags' => tags, 'limit' => limit }, registers: { site: @site }
    )
    REXML::XPath.match(REXML::Document.new("<div>#{rendered}</div>"), "//a[@class='tag-pill']")
  end

  def tag_pill_href_for(tag_value)
    anchor = render_pills([tag_value]).first
    anchor && anchor.attributes['href']
  end

  def test_simple_tag_links_to_its_tags_page_with_trailing_slash
    href = tag_pill_href_for('quotes')
    assert_equal '/tags/quotes/', href,
                 "tag pill for 'quotes' must link to /tags/quotes/ (the tags collection permalink is /tags/:slug/)"
  end

  def test_multiword_mixed_case_tag_is_slugified_correctly
    href = tag_pill_href_for('AI Engineering')
    assert_equal '/tags/ai-engineering/', href,
                 "tag pill for 'AI Engineering' must link to /tags/ai-engineering/"
  end

  def test_regression_slugify_must_not_see_the_tags_prefix
    href = tag_pill_href_for('quotes')
    refute_match(%r{\A/tags-}, href,
                 "href must not start with '/tags-' -- that shape means slugify was applied " \
                 'after /tags/ was already appended')
  end

  def test_href_ends_with_trailing_slash
    href = tag_pill_href_for('quotes')
    assert href.end_with?('/'),
           'href must end with / because the tags collection permalink is /tags/:slug/'
  end

  def test_empty_and_whitespace_tags_render_no_pill
    assert_nil tag_pill_href_for('')
    assert_nil tag_pill_href_for(" \t")
  end

  def test_nil_tag_renders_no_pill
    assert_nil tag_pill_href_for(nil)
  end

  def test_number_tag_is_stringified_before_slugify
    anchor = render_pills([2024]).first
    assert_equal '/tags/2024/', anchor.attributes['href']
    assert_equal '2024', anchor.text
  end

  def test_empty_slug_tags_render_no_pill
    assert_empty render_pills(["\u00a0", '!!!', '🙂', '', nil])
  end

  def test_limit_counts_input_tags_including_invalid_tags
    anchors = render_pills(['quotes', '', 'AI Tools', 'release'], limit: 3)
    assert_equal ['/tags/quotes/', '/tags/ai-tools/'], anchors.map { |anchor| anchor.attributes['href'] }
    assert_empty render_pills(['quotes'], limit: 0)
  end

  def test_omitting_limit_renders_all_valid_tags_and_preserves_labels
    anchors = render_pills(['quotes', ' AI Tools ', 'release', 2024])
    assert_equal ['quotes', ' AI Tools ', 'release', '2024'], anchors.map(&:text)
  end
end
