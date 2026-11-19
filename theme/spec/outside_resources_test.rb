# frozen_string_literal: true

# scripts/outside-resources.rb: a built page loads nothing from another site.
#
# The rule as a table (which addresses are this site's, which elements load),
# then the script run as `site-verify.yml` runs it, over real files in a
# temporary directory: clean sites exit 0, each kind of outside load exits 1
# and names the page and the address.
# Needs nokogiri (the ruby-theme-specs lane installs it with sanitize).
# Run with: ruby theme/spec/outside_resources_test.rb

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'open3'
require 'rbconfig'
require 'nokogiri'

SCRIPT = File.expand_path('../../scripts/outside-resources.rb', __dir__)
load SCRIPT

class OutsideResourcesJudgeTest < Minitest::Test
  HOST = 'example.com'

  def test_addresses_that_are_this_site
    ['/assets/a.js', 'a.js', '../a.js', './a.js', '#frag', '', '  ', 'https://example.com/a.js',
     'http://EXAMPLE.com/a.js', 'blob:https://example.com/1', 'about:blank'].each do |address|
      assert_equal :same, judge(address, 'script', HOST), address.inspect
    end
  end

  def test_addresses_that_are_not
    ['https://example.net/a.js', 'http://cdn.example.com/a.js', '//example.net/a.js', '//example.com/a.js',
     'javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/javascript,alert(1)', 'ftp://example.com/a',
     'https://example.com.example.net/a.js'].each do |address|
      refute_equal :same, judge(address, 'script', HOST), address.inspect
    end
  end

  def test_a_data_address_is_allowed_only_where_the_policy_allows_it
    assert_equal :same, judge('data:image/png;base64,AAAA', 'img', HOST)
    assert_equal :same, judge('data:image/png;base64,AAAA', 'source', HOST)
    assert_equal :same, judge('data:image/png;base64,AAAA', 'video', HOST), 'a poster is an image'
    assert_equal :same, judge('data:,', 'link-icon', HOST), 'an icon link is an image'
    %w[script iframe embed object link audio].each do |element|
      refute_equal :same, judge('data:text/html,x', element, HOST), element
    end
  end

  # Addresses a browser accepts and Ruby's own URI refuses: each used to be
  # reported as "does not parse" and would have failed a publish that is fine.
  def test_a_same_site_address_a_browser_accepts_is_this_site
    ['https://example.com/a b.png', 'https://example.com/café.png', 'https://example.com/x|y.png',
     'https://example.com:443/a.png', 'https://user@example.com/a.png'].each do |address|
      assert_equal :same, judge(address, 'img', HOST), address.inspect
    end
  end

  # Read as a browser reads them: a backslash is a slash, and a tab or a
  # newline inside the address is dropped before it is resolved.
  def test_spellings_a_browser_resolves_to_another_host_are_not_this_site
    ['\\\\example.net/x.png', '/\\example.net/x.png', "ht\ttps://example.net/x.png",
     "h\nttps://example.net/x.png", "\u0001https://example.net/x.png", "  //example.net/x.png",
     'https:/example.net/x.png', 'https:example.net/x.png'].each do |address|
      refute_equal :same, judge(address, 'img', HOST), address.inspect
    end
  end

  def test_with_no_site_host_only_a_relative_address_is_this_site
    assert_equal :same, judge('/a.js', 'script', nil)
    refute_equal :same, judge('https://example.com/a.js', 'script', nil)
  end

  def test_the_site_host_comes_from_the_config_url
    assert_equal 'example.com', site_host('url' => 'https://Example.com')
    assert_nil site_host('url' => '')
    assert_nil site_host({})
    assert_nil site_host(nil)
  end

  def findings(html)
    findings_in(Nokogiri::HTML5.parse(html), HOST).map { |what, address, _why| [what, address] }
  end

  def test_every_loading_element_is_read
    {
      '<script src="https://example.net/a.js"></script>' => '<script src>',
      '<iframe src="https://example.net/embed"></iframe>' => '<iframe src>',
      '<embed src="https://example.net/a.pdf">' => '<embed src>',
      '<object data="https://example.net/a.pdf"></object>' => '<object data>',
      '<video src="https://example.net/a.mp4"></video>' => '<video src>',
      '<video poster="https://example.net/a.png"></video>' => '<video poster>',
      '<audio src="https://example.net/a.mp3"></audio>' => '<audio src>',
      '<video><source src="https://example.net/a.mp4"><track src="https://example.net/a.vtt"></video>' =>
        '<source src>',
      '<img src="https://example.net/a.png" alt="">' => '<img src>',
      '<form action="https://example.net/collect"></form>' => '<form action>',
      '<input type="image" src="https://example.net/a.png">' => '<input src>',
    }.each do |html, expected|
      assert_includes findings(html).map(&:first), expected, html
    end
  end

  def test_loads_the_first_table_missed
    {
      '<svg><image href="https://example.net/a.png"/></svg>' => '<image href>',
      '<svg><image xlink:href="https://example.net/a.png"/></svg>' => '<image href>',
      '<svg><use href="https://example.net/s.svg#x"/></svg>' => '<use href>',
      '<body background="https://example.net/b.png">' => '<body background>',
      '<table background="https://example.net/b.png"><tr><td>x</td></tr></table>' => '<table background>',
      '<link rel="preload" as="image" imagesrcset="/a.png 1x, https://example.net/b.png 2x">' =>
        '<link rel=preload>',
      '<iframe srcdoc="&lt;img src=https://example.net/a.png&gt;"></iframe>' => '<iframe srcdoc> <img src>',
      '<meta http-equiv="refresh" content="0; https://example.net/">' => '<meta http-equiv=refresh>',
    }.each do |html, expected|
      assert_includes findings(html).map(&:first), expected, html
    end
  end

  # A browser reads the plain `href` when an SVG element has both.
  def test_the_plain_href_wins_over_xlink_href
    found = findings('<svg><image xlink:href="/x.png" href="https://example.net/x.png"/></svg>')
    assert_equal [['<image href>', 'https://example.net/x.png']], found
    assert_empty findings('<svg><image xlink:href="https://example.net/x.png" href="/x.png"/></svg>')
  end

  def test_an_icon_may_be_a_data_address_and_a_stylesheet_may_not
    assert_empty findings('<link rel="icon" href="data:,">')
    assert_empty findings('<video poster="data:image/png;base64,AAAA"></video>')
    assert_equal 1, findings('<link rel="stylesheet" href="data:text/css,body{}">').size
  end

  def test_srcset_is_read_as_a_list
    found = findings('<img src="/a.png" srcset="/a.png 1x, https://example.net/b.png 2x" alt="">')
    assert_equal [['<img srcset>', 'https://example.net/b.png']], found
  end

  def test_a_link_counts_only_when_its_rel_fetches
    assert_empty findings('<link rel="canonical" href="https://example.net/x">' \
                          '<link rel="alternate" href="https://example.net/feed.xml">' \
                          '<link rel="me" href="https://example.net/@someone">')
    assert_equal [['<link rel=stylesheet>', 'https://example.net/a.css']],
                 findings('<link rel="stylesheet" href="https://example.net/a.css">')
    assert_equal 1, findings('<link rel="preload" as="font" href="https://example.net/a.woff2">').size
    assert_equal 1, findings('<link rel="shortcut icon" href="https://example.net/a.ico">').size
  end

  def test_a_link_the_reader_may_click_is_not_a_load
    assert_empty findings('<a href="https://example.net/">elsewhere</a>')
  end

  def test_any_base_element_is_a_finding_even_one_naming_this_site
    assert_equal [['<base href>', 'https://example.net/']], findings('<p><base href="https://example.net/"></p>')
    assert_equal [['<base href>', '/blog/']], findings('<base href="/blog/">')
  end

  def test_a_refresh_is_a_finding_only_when_it_leaves_the_site
    assert_equal [['<meta http-equiv=refresh>', 'https://example.net/']],
                 findings('<meta http-equiv="Refresh" content="0; URL=https://example.net/">')
    assert_empty findings('<meta http-equiv="refresh" content="0; url=/blog/new/">')
    assert_empty findings('<meta http-equiv="refresh" content="30">')
    assert_empty findings('<meta http-equiv="refresh" content="0;url=/x">')
    # The separator may be whitespace alone.
    assert_equal [['<meta http-equiv=refresh>', 'https://example.net/x']],
                 findings('<meta http-equiv="refresh" content="0 url=https://example.net/x">')
  end

  def test_markup_is_judged_as_a_browser_parses_it
    # In a comment, in a <template> and as text, nothing loads.
    assert_empty findings('<!-- <script src="https://example.net/a.js"></script> -->')
    assert_empty findings('<p>&lt;script src="https://example.net/a.js"&gt;</p>')
    assert_empty findings('<pre><code>&lt;iframe src="https://example.net/"&gt;</code></pre>')
    # Attribute spelling a regex would miss.
    assert_equal 1, findings("<SCRIPT\n  SRC = 'https://example.net/a.js'></SCRIPT>").size
  end
end

class OutsideResourcesCliTest < Minitest::Test
  def setup
    @root = Dir.mktmpdir('outside-resources-')
    File.write(File.join(@root, '_config.yml'), "url: https://example.com\n")
  end

  def teardown
    FileUtils.remove_entry(@root) if @root
  end

  def page(relative, body)
    path = File.join(@root, '_site', relative)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, "<!DOCTYPE html><html><head><title>t</title></head><body>#{body}</body></html>")
  end

  def run_check
    out, status = Open3.capture2e(RbConfig.ruby, SCRIPT, @root)
    [out, status.exitstatus]
  end

  def test_a_site_that_loads_only_from_itself_passes
    page('index.html', '<script src="/assets/js/a.js"></script><img src="https://example.com/a.png" alt="">' \
                       '<iframe src="/assets/tools/app/"></iframe><a href="https://example.net/">out</a>')
    page('blog/post/index.html', '<img src="data:image/png;base64,AAAA" alt="">')
    out, code = run_check
    assert_equal 0, code, out
    assert_includes out, 'ok   no page loads anything from another site (2 pages read'
  end

  def test_an_outside_embed_fails_and_names_the_page_and_the_address
    page('index.html', '<p>fine</p>')
    page('blog/video/index.html', '<iframe src="https://www.example.net/embed/xyz"></iframe>')
    out, code = run_check
    assert_equal 1, code, out
    assert_includes out, 'FAIL "/blog/video/" loads <iframe src> from "https://www.example.net/embed/xyz"'
    assert_includes out, '1 outside load(s).'
  end

  def test_a_base_element_in_a_post_body_fails
    page('blog/base/index.html', '<p><base href="https://example.net/"></p>')
    out, code = run_check
    assert_equal 1, code, out
    assert_includes out, 'FAIL "/blog/base/" loads <base href> from "https://example.net/"'
  end

  def test_the_editor_and_the_embedded_tool_apps_are_not_read
    page('admin/index.html', '<script src="https://unpkg.com/decap-cms/dist/decap-cms.js"></script>')
    page('assets/tools/app/index.html', '<script src="https://cdn.example.net/lib.js"></script>')
    page('tools/app/index.html', '<iframe src="/assets/tools/app/"></iframe>')
    out, code = run_check
    assert_equal 0, code, out
    assert_includes out, '(1 pages read'
  end

  def test_a_site_with_no_build_is_a_note_not_a_failure
    out, code = run_check
    assert_equal 0, code, out
    assert_includes out, 'note no built site'
  end

  def test_the_configured_destination_is_honored
    File.write(File.join(@root, '_config.yml'), "url: https://example.com\ndestination: public\n")
    path = File.join(@root, 'public', 'index.html')
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, '<script src="https://example.net/a.js"></script>')
    out, code = run_check
    assert_equal 1, code, out
    assert_includes out, 'FAIL "/" loads <script src>'
  end

  # Jekyll loads a date, a time or a symbol in `_config.yml`; refusing one
  # would fail every publish on a site whose config is valid.
  def test_a_config_jekyll_accepts_is_read
    File.write(File.join(@root, '_config.yml'),
               "url: https://example.com\nlaunched: 2024-01-01\nat: 2024-01-01 10:00:00 -0500\nmode: :fast\n")
    page('index.html', '<img src="https://example.com/a b.png" alt="">')
    out, code = run_check
    assert_equal 0, code, out
    assert_includes out, 'ok   no page loads anything from another site'
  end

  # The CMS page permalink field requires a trailing slash, so a legacy
  # `/resume.html` address is typed `/resume.html/` and built as a DIRECTORY
  # named `resume.html`. Reading it as a file failed every publish.
  def test_a_page_whose_address_ends_in_dot_html_slash_is_read
    page('legacy/resume.html/index.html', '<p>fine</p>')
    page('index.html', '<p>fine</p>')
    out, code = run_check
    assert_equal 0, code, out
    assert_includes out, '(2 pages read'
    page('legacy/resume.html/index.html', '<script src="https://example.net/a.js"></script>')
    out, code = run_check
    assert_equal 1, code, out
    assert_includes out, 'FAIL "/legacy/resume.html/" loads <script src>'
  end

  def test_an_element_with_hundreds_of_attributes_is_read_not_refused
    attributes = (1..450).map { |i| "data-a#{i}=\"x\"" }.join(' ')
    page('index.html', "<div #{attributes}><img src=\"https://example.net/a.png\" alt=\"\"></div>")
    out, code = run_check
    assert_equal 1, code, out
    assert_includes out, 'FAIL "/" loads <img src>'
    refute_includes out, 'could not read this site'
  end

  def test_a_deeply_nested_page_is_read_not_refused
    page('index.html', "#{'<div>' * 600}<img src=\"https://example.net/a.png\" alt=\"\">#{'</div>' * 600}")
    out, code = run_check
    assert_equal 1, code, out
    assert_includes out, 'FAIL "/" loads <img src> from "https://example.net/a.png"'
    refute_includes out, 'could not read this site'
  end

  def test_an_unreadable_config_fails_closed
    File.write(File.join(@root, '_config.yml'), "url: [unterminated\n")
    page('index.html', '<p>fine</p>')
    out, code = run_check
    assert_equal 1, code, out
    assert_includes out, 'could not read this site'
  end
end
