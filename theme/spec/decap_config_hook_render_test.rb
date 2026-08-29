# frozen_string_literal: true
# Plain-ruby end-to-end unit test for the Decap render hook
# (lib/cms-platform-theme/decap_config_hook.rb). Run:
#   ruby theme/spec/decap_config_hook_render_test.rb
#
# Locks two regressions found together while investigating a single-page
# consumer's local-dev /admin:
#
#   Bug A — config.base.yml ends with the `# __SITE_COLLECTIONS__` splice
#   marker; config-local.base.yml does NOT. The hook's `t.sub(/^  #
#   __SITE_COLLECTIONS__.*$/, inject)` therefore matches nothing when
#   rendering config-local.yml, so a site's own admin/collections.site.yml
#   collections never reach it — only prod's config.yml. On a
#   `base_collections: []` consumer (jodidaniel.com's shape) local dev's
#   /admin then shows ZERO collections, not even the site's own custom ones,
#   because the base_collections keep-list deletion runs unconditionally
#   right after the (no-op) splice and strips every built-in collection with
#   nothing spliced in to survive it.
#
#   Bug B — the hook's three bare `File.read` calls inherit
#   Encoding.default_external. Under a non-UTF-8 locale (this sandbox's own
#   ambient default is US-ASCII: LANG/LC_ALL are unset, see test 1/2 below)
#   the FIRST `.sub` over the UTF-8 base config raises "ArgumentError:
#   invalid byte sequence in US-ASCII" — reproduced directly against the real
#   theme/admin/config.base.yml while writing this test. cms-platform #213 hit
#   the identical class of bug in scripts/render-decap-config.rb and fixed it
#   by pinning Encoding.default_external — wrong for a library (a Jekyll hook
#   must not mutate its host's process-global state), so the fix here is
#   per-read `encoding: "utf-8"` instead.
#
# Drives the REAL renderer (CmsPlatformTheme::DecapConfig.run) end-to-end
# against a synthetic site + a throwaway collections.site.yml seam, with
# `theme.root` pointed at the REAL theme/ dir — so it exercises the actual
# theme/admin/config*.base.yml templates, not copies. No Jekyll, no bundler:
# minitest/autorun + stdlib only, matching base_collections_filter_test.rb /
# field_library_resolution_test.rb.

require "minitest/autorun"
require "yaml"
require "tmpdir"
require "fileutils"

# decap_config_hook.rb calls Jekyll::Hooks.register at the BOTTOM of the file,
# unguarded — unlike sibling plugins (exclude_e2e_posts.rb,
# normalize_empty_slug.rb), which gate hook registration behind
# `defined?(Jekyll::Hooks)`. So it must be stubbed before the require below,
# the same way exclude_e2e_posts_test.rb / auto_tag_pages_test.rb stub the
# Jekyll surface their own plugin under test touches. CI runs this file with
# plain ruby: no bundler, no Jekyll on the load path.
module Jekyll
  module Hooks
    def self.register(*)
    end
  end
end

require_relative "../lib/cms-platform-theme/decap_config_hook"

# Minimal stand-ins for what DecapConfig.run reads off `site` — a Jekyll::Site
# in production. Only .source/.dest/.theme.root/.config are ever touched.
FakeTheme = Struct.new(:root)
FakeSite = Struct.new(:source, :dest, :theme, :config)

class DecapConfigHookRenderTest < Minitest::Test
  THEME_ROOT = File.expand_path("..", __dir__)

  # A site-owned seam with ONE custom collection. The label carries a
  # non-ASCII character (an em dash) so Bug B is exercised through the SEAM's
  # own File.read call too, not just through the (already non-ASCII) base
  # template — a fix that only pinned the base-template read would still pass
  # a seam-free test but crash on any real seam.
  #
  # Written at 0-indent here (the natural shape of a standalone collections
  # fragment) and reindented +2 in `setup`, matching how a real
  # admin/collections.site.yml is authored on disk (2-space `- name:`, per
  # admin/collections.site.yml.example).
  SEAM_FRAGMENT = <<~YAML
    - name: site_probe
      label: "Site Probe — Regression Fixture"
      label_singular: Probe
      folder: _site_probe
      create: true
      delete: true
      slug: "{{slug}}"
      fields:
        - name: title
          label: Title
          widget: string
          required: true
  YAML

  def setup
    @source = Dir.mktmpdir("decap-hook-source-")
    @dest = Dir.mktmpdir("decap-hook-dest-")
    admin_dir = File.join(@source, "admin")
    FileUtils.mkdir_p(admin_dir)
    seam = SEAM_FRAGMENT.each_line.map { |l| l.strip.empty? ? l : "  #{l}" }.join
    File.write(File.join(admin_dir, "collections.site.yml"), seam)
    @site = FakeSite.new(@source, @dest, FakeTheme.new(THEME_ROOT), {
      "url" => "https://example.test",
      "title" => "Example Site",
      "cms" => {
        "repository" => "acme/example",
        "oauth_base_url" => "https://oauth.example.test",
        "base_collections" => [],
      },
    },)
  end

  def teardown
    FileUtils.remove_entry(@source) if @source && Dir.exist?(@source)
    FileUtils.remove_entry(@dest) if @dest && Dir.exist?(@dest)
  end

  # Save + restore Encoding.default_external (and $VERBOSE, which Ruby checks
  # before warning on a default_external reassignment) around a block.
  #
  # Tests 1/2 call this with UTF_8 before every render. That is NOT
  # incidental: this sandbox's own ambient default_external is US-ASCII
  # (LANG/LC_ALL unset, confirmed while writing this test), so without
  # pinning UTF-8 first, `.run` raises Bug B's ArgumentError regardless of
  # whether Bug A is fixed — entangling the two regressions so neither can be
  # locked in isolation. Test 3 uses the same helper to go the OTHER way, into
  # US_ASCII, to reproduce Bug B on purpose.
  def with_default_external(encoding)
    prior_verbose = $VERBOSE
    prior_encoding = Encoding.default_external
    $VERBOSE = nil
    Encoding.default_external = encoding
    yield
  ensure
    Encoding.default_external = prior_encoding
    $VERBOSE = prior_verbose
  end

  def rendered(name)
    YAML.load_file(File.join(@dest, "admin", name))
  end

  def collection_names(cfg)
    (cfg["collections"] || []).map { |c| c["name"] }
  end

  # Bug A lock. MUST FAIL before the fix: with no marker to replace in
  # config-local.base.yml, the site collection never gets spliced in, and the
  # base_collections:[] keep-list filter (which runs unconditionally right
  # after the splice attempt) then strips every built-in collection through
  # to EOF, leaving `collections:` empty.
  def test_config_local_splices_site_collections_and_strips_base_collections
    with_default_external(Encoding::UTF_8) { CmsPlatformTheme::DecapConfig.run(@site) }
    assert_equal ["site_probe"], collection_names(rendered("config-local.yml"))
  end

  # Parity sanity: the identical assertion against the prod config, which
  # already carries the marker today — passes before and after the fix.
  def test_config_splices_site_collections_and_strips_base_collections
    with_default_external(Encoding::UTF_8) { CmsPlatformTheme::DecapConfig.run(@site) }
    assert_equal ["site_probe"], collection_names(rendered("config.yml"))
  end

  # Bug B lock. MUST FAIL (raise) before the fix: forces the render to run
  # under a non-UTF-8 default_external, reproducing the sandboxed/CI-container
  # shape (LC_ALL=POSIX) directly rather than relying on this process's
  # ambient locale.
  def test_render_survives_a_non_utf8_default_external_encoding
    with_default_external(Encoding::US_ASCII) { CmsPlatformTheme::DecapConfig.run(@site) }
    assert File.exist?(File.join(@dest, "admin", "config-local.yml")),
           "config-local.yml must be produced"
    assert File.exist?(File.join(@dest, "admin", "config.yml")),
           "config.yml must be produced"
    assert_equal ["site_probe"], collection_names(rendered("config-local.yml"))
    assert_equal ["site_probe"], collection_names(rendered("config.yml"))
  end

  # Bug A lock, source-level: both templates must carry the marker EXACTLY
  # once. Fails before the fix for config-local.base.yml (0 matches, not 1).
  def test_both_base_templates_carry_exactly_one_splice_marker
    %w[config.base.yml config-local.base.yml].each do |name|
      path = File.join(THEME_ROOT, "admin", name)
      matches = File.read(path, encoding: "utf-8").lines.grep(/^  # __SITE_COLLECTIONS__/)
      assert_equal 1, matches.length,
                   "#{name} must carry exactly one splice marker, found #{matches.length}"
    end
  end
end
