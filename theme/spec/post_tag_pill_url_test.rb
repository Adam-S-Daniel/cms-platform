# frozen_string_literal: true
# Plain-ruby unit test for the post-layout tag-pill href. Run:
#   ruby theme/spec/post_tag_pill_url_test.rb
#
# BUG (measured live on adamdaniel.ai via e2e/site-link-crawler.spec.js, 3/66
# internal links broken): the tag-pill line in theme/_layouts/post.html used to
# read
#
#   {{ '/tags/' | append: tag | slugify | relative_url }}
#
# Liquid applies a filter chain left-to-right over the WHOLE accumulated value,
# so `slugify` ran on the string "/tags/quotes" (the '/tags/' prefix already
# appended), not on "quotes" alone. Jekyll::Utils.slugify collapses the
# non-alphanumeric run — including the two slashes — into a single dash, so
# every tag pill on every post linked to "/tags-quotes", a page that does not
# exist (the tags collection's actual permalink is "/tags/:slug/"). The two
# sibling usages in default.html and atom_feed.xml already avoided this by
# slugifying the tag into a variable FIRST, then appending it to the prefix.
#
# This test is BEHAVIOURAL, not a text match: it extracts the tag-pill href's
# Liquid expression straight out of post.html and evaluates it with a small
# faithful Liquid-filter-chain evaluator, so it fails against the original
# buggy line and passes once the fix (slugify-into-a-variable-first, append a
# trailing slash) lands — and it re-reds automatically if the bug ever comes
# back in a different guise.

require "minitest/autorun"

# ---------------------------------------------------------------------------
# Tiny Liquid evaluator, scoped to exactly what the tag-pill href expressions
# in post.html use: `append: <arg>`, `slugify`, `relative_url`. Not a general
# Liquid interpreter — just enough to prove/disprove this one bug.
# ---------------------------------------------------------------------------
module MiniLiquid
  # Mirror Jekyll::Utils.slugify's default mode: downcase, collapse every run
  # of non [a-z0-9] characters to a single dash, strip leading/trailing dashes.
  def self.slugify(value)
    value.to_s.downcase.gsub(/[^a-z0-9]+/, "-").sub(/\A-+/, "").sub(/-+\z/, "")
  end

  # relative_url prepends site.baseurl (empty on these sites) and then, per
  # Jekyll::Filters::URLFilters#relative_url, ENSURES a leading slash on the
  # result. That leading-slash guarantee is exactly why the real defect
  # surfaced as "/tags-quotes" (with a leading slash) rather than
  # "tags-quotes": slugify strips the leading dash left behind by the
  # already-appended "/tags/" prefix, and relative_url puts a slash right
  # back. Modelling relative_url as a bare identity function would make the
  # regression assertion below vacuously true against the unfixed layout.
  def self.relative_url(value)
    s = value.to_s
    s.start_with?("/") ? s : "/#{s}"
  end

  # Evaluate a `{{ ... }}` Liquid output expression's filter chain against a
  # variable scope (name => value). Supports a leading string literal
  # ('...') or a bare variable name, then zero or more `| filter[: arg]`
  # stages.
  def self.evaluate(expr, scope)
    parts = expr.strip.split("|").map(&:strip)
    seed = parts.shift
    value =
      if seed.start_with?("'") && seed.end_with?("'")
        seed[1..-2]
      elsif scope.key?(seed)
        scope.fetch(seed)
      else
        raise "unknown seed #{seed.inspect} (scope has #{scope.keys.inspect})"
      end

    parts.each do |stage|
      name, _sep, arg = stage.partition(":")
      name = name.strip
      case name
      when "append"
        arg_token = arg.strip
        appended =
          if arg_token.start_with?("'") && arg_token.end_with?("'")
            arg_token[1..-2]
          elsif scope.key?(arg_token)
            scope.fetch(arg_token)
          else
            raise "append arg #{arg_token.inspect} is neither a single-quoted " \
                  "literal nor a known scope variable (scope has #{scope.keys.inspect})"
          end
        value = value.to_s + appended.to_s
      when "slugify"
        value = slugify(value)
      when "relative_url"
        value = relative_url(value)
      else
        raise "unsupported filter #{name.inspect} in expression #{expr.inspect}"
      end
    end
    value
  end
end

class PostTagPillUrlTest < Minitest::Test
  LAYOUT = File.expand_path("../_layouts/post.html", __dir__)

  def setup
    assert File.exist?(LAYOUT), "layout must exist at #{LAYOUT}"
    @src = File.read(LAYOUT)
  end

  # Pulls the `{% for tag in page.tags %} ... {% endfor %}` block, then finds
  # (a) an optional preceding `{%- assign <name> = <expr> -%}` (the fixed form
  # binds a slug variable before the <a> tag) and (b) the tag-pill <a>'s href
  # `{{ ... }}` expression. Both the buggy and fixed layouts parse under this.
  def tag_pill_href_for(tag_value)
    for_block = @src[/\{%\s*for\s+tag\s+in\s+page\.tags\s*%\}(.*?)\{%\s*endfor\s*%\}/m, 1]
    refute_nil for_block, "could not find the `for tag in page.tags` block in #{LAYOUT}"

    scope = { "tag" => tag_value }

    assign_match = for_block.match(/\{%-?\s*assign\s+(\w+)\s*=\s*(.+?)\s*-?%\}/)
    if assign_match
      assigned_name = assign_match[1]
      assigned_expr = assign_match[2]
      scope[assigned_name] = MiniLiquid.evaluate(assigned_expr, scope)
    end

    href_match = for_block.match(/class="tag-pill"\s+href="\{\{\s*(.+?)\s*\}\}"/)
    refute_nil href_match, 'could not find the tag-pill <a> href="{{ ... }}" expression'

    MiniLiquid.evaluate(href_match[1], scope)
  end

  def test_simple_tag_links_to_its_tags_page_with_trailing_slash
    href = tag_pill_href_for("quotes")
    assert_equal "/tags/quotes/", href,
                 "tag pill for 'quotes' must link to /tags/quotes/ " \
                 "(the tags collection's permalink is /tags/:slug/)"
  end

  def test_multiword_mixed_case_tag_is_slugified_correctly
    href = tag_pill_href_for("AI Engineering")
    assert_equal "/tags/ai-engineering/", href,
                 "tag pill for 'AI Engineering' must link to /tags/ai-engineering/"
  end

  def test_regression_slugify_must_not_see_the_tags_prefix
    # The original defect: slugify ran on the whole "/tags/quotes" string
    # (both slashes collapsed into the prefix), producing "/tags-quotes" --
    # a page that does not exist. Assert that specific shape can never recur.
    href = tag_pill_href_for("quotes")
    refute_match(%r{\A/tags-}, href,
                 "href must not start with '/tags-' -- that shape means slugify " \
                 "was applied AFTER '/tags/' was already appended, which is the " \
                 "exact regression this test exists to catch")
  end

  def test_href_ends_with_trailing_slash
    href = tag_pill_href_for("quotes")
    assert href.end_with?("/"),
           "href must end with '/' because the tags collection permalink is " \
           "/tags/:slug/ -- a build without the trailing slash writes " \
           "tags/<slug>/index.html but the pill would link to a different path"
  end
end
