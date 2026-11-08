# frozen_string_literal: true

# scripts/liquid-escape-lint.rb: every Liquid output in a template ends in a
# filter that encodes for where it prints (_agent-guidance#467). These cases
# pin what it flags and what it lets through, and the last test runs it over
# this repo, so a theme layout that prints an unencoded value fails here.
#
#   ruby theme/spec/liquid_escape_lint_test.rb

require "minitest/autorun"
require "open3"
require "tmpdir"

ROOT = File.expand_path("../..", __dir__)
LINT = File.join(ROOT, "scripts", "liquid-escape-lint.rb")
require LINT
LiquidEscapeLint.install_inert_tags

class LiquidEscapeLintTest < Minitest::Test
  def findings(src, path = "t.html")
    LiquidEscapeLint::Checker.new(path, src).run.findings
  end

  def flagged(src, path = "t.html")
    findings(src, path).map(&:markup)
  end

  def test_an_unencoded_value_in_text_or_an_attribute_is_flagged
    assert_equal ["page.title"], flagged("<h1>{{ page.title }}</h1>")
    assert_equal ["page.url_link"], flagged(%(<a href="{{ page.url_link }}">x</a>))
  end

  def test_html_encoders_and_inert_filters_pass
    src = <<~LIQUID
      <h1>{{ page.title | escape }}</h1>
      <a href="{{ page.link | relative_url | escape }}" data-x="{{ q | url_encode }}">{{ t | xml_escape }}</a>
      <time>{{ page.date | date: "%Y" }}</time> {{ posts | size }} {{ t | slugify }}
    LIQUID
    assert_empty flagged(src)
  end

  def test_url_filters_are_not_html_encoders
    f = findings(%(<a href="{{ page.link | relative_url }}">x</a>))
    assert_equal 1, f.size
    assert_includes f.first.message, "`relative_url` does not HTML-encode"
  end

  def test_a_literal_passes_unless_a_filter_argument_carries_data
    assert_empty flagged(%(<a href="{{ '/blog/' | relative_url }}">b</a>))
    assert_equal ["'/tags/' | append: slug | relative_url"],
                 flagged(%(<a href="{{ '/tags/' | append: slug | relative_url }}">t</a>))
  end

  def test_content_and_same_file_captures_pass
    src = "{% capture row %}<b>{{ x | escape }}</b>{% endcapture %}{{ content }}{{ row }}"
    assert_empty flagged(src)
  end

  def test_nothing_but_a_number_prints_inside_a_script_body
    src = "<script>var a = {{ site.id | jsonify }}; var n = {{ posts | size }};</script>"
    assert_equal ["site.id | jsonify"], flagged(src)
    assert_includes findings(src).first.message, "data- attribute"
  end

  def test_json_in_a_script_body_is_jsonify_then_lt_escaped
    src = <<~'LIQUID'
      {%- capture ld -%}{"name":{{ page.title | jsonify }},"n":{{ ps | size }}}{%- endcapture -%}
      <script type="application/ld+json">{{ ld | replace: "<", "\u003c" }}</script>
      <script>var t = {{ page.title | jsonify | replace: "<", "\u003c" }};</script>
    LIQUID
    assert_empty flagged(src)
  end

  def test_a_json_capture_is_not_exempt_and_its_values_must_be_jsonify
    assert_equal ["ld"], flagged(%({% capture ld %}{"a":{{ x | jsonify }}}{% endcapture %}<script>{{ ld }}</script>))
    assert_equal ["y"], flagged(%({% capture ld %}{"a":{{ x | jsonify }},"b":"{{ y }}"}{% endcapture %}<p>{{ ld | escape }}</p>))
    assert_equal ["x | replace: \"<\", \"\\u003c\""],
                 flagged(%(<script>var a = {{ x | replace: "<", "\\u003c" }};</script>))
  end

  def test_a_script_tags_own_attributes_are_html_context
    assert_empty flagged(%(<script src="{{ x | relative_url | escape }}"></script><p>{{ y | escape }}</p>))
    assert_equal ["y"], flagged(%(<script src="a.js"></script><p>{{ y }}</p>))
  end

  def test_style_and_cdata_bodies_are_flagged
    assert_equal ["c | escape"], flagged("<style>a { color: {{ c | escape }}; }</style>")
    assert_equal ["post.content | xml_escape"],
                 flagged("<content><![CDATA[{{ post.content | xml_escape }}]]></content>", "feed.xml")
    assert_empty flagged("<content>{{ post.content | xml_escape }}</content>")
  end

  def test_jekyll_tags_parse_and_highlight_bodies_are_not_output
    src = <<~LIQUID
      {% include card.html title=page.title %}
      {% seo %}
      {% highlight html %}{{ not_output }}{% endhighlight %}
      {% raw %}{{ also_not }}{% endraw %}
    LIQUID
    assert_empty flagged(src)
  end

  def test_branches_and_loops_are_walked
    src = "{% if a %}{{ x }}{% else %}{{ y }}{% endif %}{% for p in ps %}{{ p.t }}{% endfor %}"
    assert_equal %w[x y p.t], flagged(src)
  end

  def test_front_matter_is_skipped_and_line_numbers_kept
    f = findings("---\ntitle: \"{{ nope }}\"\n---\n\n<p>{{ page.x }}</p>\n")
    assert_equal [5], f.map(&:line)
  end

  def run_all(dir)
    Open3.capture2e(RbConfig.ruby, LINT, "--all", dir)
  end

  def git_repo(files)
    dir = Dir.mktmpdir("liquid-escape-lint")
    files.each do |rel, body|
      FileUtils.mkdir_p(File.dirname(File.join(dir, rel)))
      File.write(File.join(dir, rel), body)
    end
    system("git", "-C", dir, "init", "-q", exception: true)
    system("git", "-C", dir, "add", "-A", exception: true)
    dir
  end

  def test_the_allowlist_suppresses_a_reasoned_entry_and_reports_a_stale_one
    dir = git_repo(
      "_layouts/a.html" => "<p>{{ post.excerpt }}</p>{{ about.lead | markdownify }}",
      ".liquid-escape-allowlist.txt" => "# c\n_layouts/a.html | post.excerpt | rendered excerpt\n" \
                                        "_layouts/a.html | about.lead | markdownify | the owner's Markdown\n"
    )
    out, st = run_all(dir)
    assert st.success?, out

    File.write(File.join(dir, ".liquid-escape-allowlist.txt"),
               "_layouts/a.html | post.excerpt | rendered excerpt\n" \
               "_layouts/a.html | about.lead | markdownify | the owner's Markdown\n_layouts/a.html | gone | old\n")
    out, st = run_all(dir)
    refute st.success?
    assert_includes out, "matches no output"

    File.write(File.join(dir, ".liquid-escape-allowlist.txt"), "_layouts/a.html | post.excerpt\n")
    out, st = run_all(dir)
    assert_equal 2, st.exitstatus, out
  ensure
    FileUtils.rm_rf(dir) if dir
  end

  def test_a_finding_fails_the_run_and_names_file_and_line
    dir = git_repo("_includes/x.html" => "\n<p>{{ page.title }}</p>\n", "_site/y.html" => "{{ skipped }}")
    out, st = run_all(dir)
    assert_equal 1, st.exitstatus
    assert_includes out, "_includes/x.html:2: `{{ page.title }}`"
    refute_includes out, "skipped"
  ensure
    FileUtils.rm_rf(dir) if dir
  end

  # The gate for this repo's own templates: the theme gem's layouts and
  # includes, and the e2e fixture sites that stand in for consumers.
  def test_this_repo_has_no_unencoded_output
    out, st = run_all(ROOT)
    assert st.success?, out
  end
end
