# frozen_string_literal: true
# Plain-ruby test for theme/admin/not-found.html, the page the opt-in admin
# host answers every miss with (cms-platform#517; AdminDistribution's
# CustomErrorResponses in infrastructure/bootstrap/template.yaml). Run:
#   ruby theme/spec/admin_not_found_page_test.rb
#
# The page is served on the same origin as the editor's GitHub tokens, so it
# must not be able to run anything or pull anything in. Rather than search the
# text for things that look dangerous, the test PARSES the page (REXML, stdlib;
# the page is written as well-formed polyglot HTML) and checks every node
# against an allowlist. An XML parse is not an HTML parse: a comment opened
# as `<!-->` or a doctype with an internal subset hides markup from XML that a
# browser runs, so those node shapes are rejected too. Elements:
# known inert elements only, a handful of attributes, and one same-origin link.
# Anything not listed fails, so a new <script>, onload=, style=, <link>,
# <meta http-equiv=refresh> or off-origin href cannot slip in under a name
# nobody thought to forbid.
#
# It also drives the real build hook to prove the page reaches _site/admin
# byte for byte: the CMS_* injection targets index*.html and reviews/*.html
# only, and must never add a <script> here.

require "minitest/autorun"
require "rexml/document"
require "tmpdir"
require "fileutils"

module Jekyll
  module Hooks
    def self.register(*)
    end
  end
end

require_relative "../lib/cms-platform-theme/decap_config_hook"

class AdminNotFoundPageTest < Minitest::Test
  THEME_ROOT = File.expand_path("..", __dir__)
  PAGE = File.join(THEME_ROOT, "admin", "not-found.html")

  # element => attributes it may carry
  ALLOWED = {
    "html" => %w[lang],
    "head" => [],
    "meta" => %w[charset name content],
    "title" => [],
    "body" => [],
    "h1" => [],
    "p" => [],
    "a" => %w[href],
  }.freeze
  META_NAMES = %w[viewport robots].freeze

  def doc
    @doc ||= REXML::Document.new(File.read(PAGE, encoding: "utf-8"))
  end

  def each_node(node, &blk)
    node.children.each do |child|
      yield child
      each_node(child, &blk) if child.is_a?(REXML::Parent)
    end
  end

  def test_the_page_parses_as_one_html_element
    assert_equal "html", doc.root&.name
    assert_match(/\A<!DOCTYPE html>\n/, File.read(PAGE, encoding: "utf-8"), "standards mode, not quirks")
  end

  # Every element, attribute or node kind the allowlist does not name, as
  # strings; empty means the tree is inert.
  def offenders(tree)
    found = []
    each_node(tree) do |node|
      case node
      when REXML::Element
        allowed = ALLOWED[node.name]
        next found << "<#{node.name}>" if allowed.nil?
        node.attributes.each_attribute do |attr|
          found << "<#{node.name} #{attr.expanded_name}>" unless allowed.include?(attr.expanded_name)
        end
      when REXML::Text
        next
      when REXML::DocType
        # A browser ends the doctype token at its first ">", so an internal
        # subset (`<!DOCTYPE html [<!-- > <script>…</script> -->]>`) that XML
        # reads as a comment is markup to HTML. Only the bare `html` doctype.
        found << "DOCTYPE #{node}" unless node.name == "html" && node.external_id.nil? && node.children.empty?
      when REXML::Comment
        # `<!-->` and `<!--->` close an HTML comment on the spot, so a
        # `<script>` XML sees inside the comment is live markup to a browser.
        # (`--!>`, the other HTML-only ending, is already an XML parse error.)
        found << "comment opening #{node.string[0, 2].inspect}" if node.string.start_with?(">", "->")
      else
        found << node.class.name # CDATA, processing instruction, entity declaration...
      end
    end
    found
  end

  def test_every_node_is_an_allowlisted_inert_one
    assert_equal [], offenders(doc)
    assert REXML::XPath.first(doc, "//body/p/a"), "the walk must have a body to visit"
  end

  def test_meta_only_sets_charset_viewport_and_robots
    REXML::XPath.each(doc, "//meta") do |meta|
      next if meta.attributes["charset"]
      assert_includes META_NAMES, meta.attributes["name"], "no http-equiv, no other meta behavior"
    end
  end

  def test_the_only_link_stays_on_this_origin_inside_the_editor
    hrefs = REXML::XPath.match(doc, "//a").map { |a| a.attributes["href"] }
    refute_empty hrefs
    hrefs.each do |href|
      assert_match(%r{\A/admin/[A-Za-z0-9._/-]*\z}, href, "a same-origin path under /admin/, no scheme, no //host")
    end
  end

  # Negative control: the walk above must reject the things it exists for.
  def test_the_allowlist_rejects_script_handlers_and_external_resources
    [
      %(<html><body><script>x()</script></body></html>),
      %(<html><body onload="x()"></body></html>),
      %(<html><head><link rel="stylesheet" href="https://example.com/a.css" /></head></html>),
      %(<html><head><meta http-equiv="refresh" content="0;url=https://example.com/" /></head></html>),
      %(<html><body><p style="background:url(https://example.com/x)">x</p></body></html>),
      %(<html><body><img src="https://example.com/x.png" /></body></html>),
      # Well-formed XML whose only <script> is inside a comment or doctype as
      # XML reads it, but live markup as a browser's HTML parser reads it.
      %(<html><body><!--><script>x()</script>--></body></html>),
      %(<html><body><!---><script>x()</script>--></body></html>),
      %(<!DOCTYPE html [<!-- > <script>x()</script> -->]>\n<html><body></body></html>),
      %(<?xml version="1.0"?>\n<html><body></body></html>),
    ].each do |html|
      offending = offenders(REXML::Document.new(html))
      refute_empty offending, "the allowlist failed to reject: #{html}"
    end
  end

  FakeTheme = Struct.new(:root)
  FakeSite = Struct.new(:source, :dest, :theme, :config)

  def test_the_build_hook_ships_the_page_unchanged
    Dir.mktmpdir("admin-not-found") do |tmp|
      src = File.join(tmp, "site")
      dest = File.join(tmp, "_site")
      FileUtils.mkdir_p([src, dest])
      config = {
        "url" => "https://example.test",
        "title" => "Example",
        "cms" => { "repository" => "example/example", "admin_origin" => "https://admin.example.test" },
      }
      site = FakeSite.new(src, dest, FakeTheme.new(THEME_ROOT), config)
      CmsPlatformTheme::DecapConfig.run(site)
      built = File.join(dest, "admin", "not-found.html")
      assert File.exist?(built), "the hook copies every depth-1 admin file"
      assert_equal File.binread(PAGE), File.binread(built)
    end
  end
end
