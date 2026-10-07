# frozen_string_literal: true

# Real Liquid regression for the post-layout tag-pill href. Run:
#   ruby theme/spec/post_tag_pill_url_test.rb
#
# Jekyll's Liquid parser and filters are used so the test exercises the same
# assign, strip, slugify and relative_url behavior as the rendered layout.

require 'minitest/autorun'
require 'rexml/document'
require 'jekyll'

class PostTagPillUrlTest < Minitest::Test
  LAYOUT = File.expand_path('../_layouts/post.html', __dir__)

  def setup
    assert File.exist?(LAYOUT), "layout must exist at #{LAYOUT}"
    @src = File.read(LAYOUT)
  end

  def tag_loop(node)
    if node.is_a?(Liquid::For)
      collection = node.collection_name
      return node if node.variable_name == 'tag' && collection.name == 'page' && collection.lookups == ['tags']
    end

    children = []
    children.concat(node.nodelist) if node.respond_to?(:nodelist) && node.nodelist.is_a?(Array)
    children.concat(node.blocks.map(&:attachment)) if node.respond_to?(:blocks)
    children.each do |child|
      found = tag_loop(child)
      return found if found
    end
    nil
  end

  def tag_pill_href_for(tag_value)
    loop_node = tag_loop(Liquid::Template.parse(@src).root)
    refute_nil loop_node, "could not find the page.tags loop in #{LAYOUT}"

    template = Liquid::Template.new
    template.root = loop_node
    site = Struct.new(:config, :filter_cache).new({ 'baseurl' => '' }, {})
    rendered = template.render!({ 'page' => { 'tags' => [tag_value] } }, registers: { site: site })
    document = REXML::Document.new("<div>#{rendered}</div>")
    anchor = REXML::XPath.first(document, "//a[@class='tag-pill']")
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
end
