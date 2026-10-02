# frozen_string_literal: true
# Renders theme/_includes/analytics/cloudwatch-rum.html through REAL Liquid.
# Run:
#   ruby theme/spec/cloudwatch_rum_include_render_test.rb
#
# Locks what only the template engine decides: the include emits the RUM
# loader on a production build with an app monitor configured and nothing
# otherwise, prints the configured values into it, and loads the client from
# the gem-shipped file at the exact version provenance.json records (#517).
# It also renders _layouts/default.html, which every page layout chains to, to
# see that the layout puts the loader in <head>.
# What the loader then does in a browser (the webdriver and opt-out gates, the
# one same-origin <script> it inserts) is e2e/analytics-rum-client-vendored.test.js,
# which runs the rendered body in a node:vm sandbox.
#
# Liquid 4, the major Jekyll 4 depends on, is the only gem this needs; the
# ruby-theme-specs lane in .github/workflows/self-ci.yml installs that exact
# version. No Jekyll and no site build: Jekyll's include tag parses the file
# and renders it with the page's context, which is what render_include does
# with the two variables Jekyll provides here (`site`, `jekyll.environment`).
# The one Jekyll filter the include uses, relative_url, is stood in for below;
# any other filter fails the render (strict_filters). The layout render also
# stands in for Jekyll's include tag, jekyll-seo-tag's seo tag and the theme's
# cachebust filter.

require "minitest/autorun"
require "json"
require "liquid"

THEME = File.expand_path("..", __dir__)
INCLUDE = File.join(THEME, "_includes", "analytics", "cloudwatch-rum.html")
PROVENANCE = JSON.parse(File.read(File.join(THEME, "assets", "js", "aws-rum-web", "provenance.json")))

APP_MONITOR = "11111111-2222-3333-4444-555555555555"
POOL = "us-west-2:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

# Jekyll's relative_url for a root-relative input: the site's baseurl in
# front of it. Only that much is needed to see that the include sends its
# client path through the filter.
module RelativeUrlStandIn
  def relative_url(input)
    "#{@context["site"]["baseurl"]}#{input}"
  end
end

LAYOUT = File.join(THEME, "_layouts", "default.html")

# Jekyll's include tag, for the layout render: parses the named file under
# _includes and renders it in the page's context. Only the RUM include is
# under test; every other include renders empty.
class IncludeStandIn < Liquid::Tag
  def initialize(tag_name, markup, parse_context)
    super
    @name = markup.strip
  end

  def render(context)
    return "" unless @name == "analytics/cloudwatch-rum.html"

    Liquid::Template.parse(File.read(INCLUDE, encoding: "utf-8"), error_mode: :strict).render!(context)
  end
end

# jekyll-seo-tag's {% seo %}: not under test.
class SeoStandIn < Liquid::Tag
  def render(_context)
    ""
  end
end

# The theme's cachebust filter: not under test.
module CachebustStandIn
  def cachebust(input)
    input
  end
end

Liquid::Template.register_tag("include", IncludeStandIn)
Liquid::Template.register_tag("seo", SeoStandIn)

class CloudwatchRumIncludeRenderTest < Minitest::Test
  def render_include(env:, rum:, baseurl: "")
    site = { "baseurl" => baseurl }
    site["analytics"] = { "cloudwatch_rum" => rum } unless rum.nil?
    template = Liquid::Template.parse(File.read(INCLUDE, encoding: "utf-8"), error_mode: :strict)
    template.render!(
      { "site" => site, "jekyll" => { "environment" => env } },
      filters: [RelativeUrlStandIn],
      strict_filters: true
    )
  end

  def configured(region: "us-west-2")
    rum = { "app_monitor_id" => APP_MONITOR, "identity_pool_id" => POOL }
    rum["region"] = region if region
    rum
  end

  def client_path
    "/assets/js/aws-rum-web/cwr-#{PROVENANCE.fetch("version")}.js"
  end

  def test_production_with_an_app_monitor_emits_the_loader_with_its_values
    html = render_include(env: "production", rum: configured)
    assert_equal 1, html.scan("<script").length, html
    assert_includes html, "window.AwsRumClient"
    assert_includes html, "'#{APP_MONITOR}'"
    assert_includes html, %(identityPoolId: "#{POOL}")
    assert_includes html, "'us-west-2'"
    assert_includes html, %(endpoint: "https://dataplane.rum.us-west-2.amazonaws.com")
  end

  def test_the_client_loads_same_origin_at_the_vendored_version
    assert_equal "cwr-#{PROVENANCE.fetch("version")}.js", PROVENANCE.fetch("file")
    html = render_include(env: "production", rum: configured, baseurl: "/sub")
    assert_includes html, "'/sub#{client_path}'"
    refute_includes html, "client.rum."
    refute_match %r{https?://[^'"]*cwr}, html
  end

  def test_region_defaults_to_us_east_1
    html = render_include(env: "production", rum: configured(region: nil))
    assert_includes html, %(endpoint: "https://dataplane.rum.us-east-1.amazonaws.com")
  end

  def test_production_with_an_empty_app_monitor_renders_nothing
    rum = configured.merge("app_monitor_id" => "")
    assert_equal "", render_include(env: "production", rum: rum).strip
  end

  def test_production_without_a_rum_block_renders_nothing
    assert_equal "", render_include(env: "production", rum: nil).strip
  end

  def render_layout(env:)
    site = { "baseurl" => "", "analytics" => { "cloudwatch_rum" => configured } }
    template = Liquid::Template.parse(File.read(LAYOUT, encoding: "utf-8"), error_mode: :strict)
    template.render!(
      { "site" => site, "jekyll" => { "environment" => env }, "page" => {}, "content" => "" },
      filters: [RelativeUrlStandIn, CachebustStandIn],
      strict_filters: true
    )
  end

  # Every page layout chains to default.html, so this is what puts the
  # loader on a built page at all.
  def test_the_default_layout_puts_the_loader_in_the_head
    html = render_layout(env: "production")
    head = html[%r{<head>.*</head>}m]
    refute_nil head, html
    assert_includes head, "window.AwsRumClient"
    assert_includes head, "'#{client_path}'"
    refute_includes render_layout(env: "development"), "AwsRumClient"
  end

  def test_a_configured_monitor_outside_production_renders_nothing
    # `preview` is what deploy-preview builds with; `development` is Jekyll's
    # default.
    %w[development preview].each do |env|
      assert_equal "", render_include(env: env, rum: configured).strip, env
    end
  end
end
