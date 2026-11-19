# frozen_string_literal: true

# scripts/destination-conflicts.rb: two source files written to one address
# must fail the site check (cms-platform issue 1061). A page saved from the CMS
# with permalink `/tags/` replaced the tags index, and a second post with an
# older post's slug took the older post's URL; Jekyll only warns, and every
# check a content pull request gets stayed green.
#
# The script is run as `site-verify.yml` runs it, as a child process over a
# real site directory, so its exit code and its printed lines are what is
# tested. Run with: ruby theme/spec/destination_conflicts_test.rb
# Needs jekyll 4.4.1 (the ruby-theme-specs lane installs it).

require 'minitest/autorun'
require 'fileutils'
require 'open3'
require 'rbconfig'
require 'tmpdir'
require 'jekyll'

class DestinationConflictsTest < Minitest::Test
  SCRIPT = File.expand_path('../../scripts/destination-conflicts.rb', __dir__)

  def setup
    @site = Dir.mktmpdir('destination-conflicts-')
    write('_config.yml', "title: Example\npermalink: /blog/:slug/\n")
    write('index.html', "---\ntitle: Home\n---\nhome\n")
    write('tags/index.html', "---\ntitle: Tags\n---\ntags index\n")
    write('blog/index.html', "---\ntitle: Blog\n---\nblog index\n")
    write('_posts/2026-01-01-first.md', "---\ntitle: First\n---\nfirst\n")
    write('assets/css/main.css', "body{}\n")
  end

  def teardown
    FileUtils.remove_entry(@site) if @site
  end

  def write(rel, content)
    full = File.join(@site, rel)
    FileUtils.mkdir_p(File.dirname(full))
    File.write(full, content)
  end

  # Jekyll must not pick up a Gemfile or a JEKYLL_ENV from the shell running
  # the suite; the script itself is what is under test.
  def run_script(dir = @site)
    out, status = Open3.capture2e({ 'JEKYLL_ENV' => 'production' }, RbConfig.ruby, SCRIPT, dir)
    [out, status.exitstatus]
  end

  def test_a_site_with_no_shared_address_passes
    out, code = run_script
    assert_equal 0, code, out
    assert_match(/\Aok   no two files share an address \(\d+ files checked\)\n\z/, out)
  end

  def test_a_page_that_claims_the_tags_index_fails_and_names_both_files
    write('pages/sneaky.md', "---\ntitle: Sneaky\npermalink: /tags/\n---\nmine now\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, 'FAIL 2 files are written to "/tags/index.html"'
    assert_includes out, '"pages/sneaky.md"'
    assert_includes out, '"tags/index.html"'
    assert_includes out, '1 address(es) are claimed by more than one file'
  end

  def test_a_page_that_claims_the_blog_index_fails
    write('pages/blog-takeover.md', "---\ntitle: Blog\npermalink: /blog/\n---\nx\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, 'FAIL 2 files are written to "/blog/index.html"'
  end

  def test_a_second_post_with_an_older_posts_slug_fails
    write('_posts/2026-06-01-another.md', "---\ntitle: First again\nslug: first\n---\nreplacement\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, 'FAIL 2 files are written to "/blog/first/index.html"'
    assert_includes out, '"_posts/2026-01-01-first.md"'
    assert_includes out, '"_posts/2026-06-01-another.md"'
  end

  def test_a_page_that_claims_a_static_files_address_fails
    write('pages/css.md', "---\ntitle: CSS\npermalink: /assets/css/main.css\n---\nbody{display:none}\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, '"/assets/css/main.css"'
  end

  def test_every_shared_address_is_reported_not_only_the_first
    write('pages/sneaky.md', "---\ntitle: Sneaky\npermalink: /tags/\n---\nx\n")
    write('_posts/2026-06-01-another.md', "---\ntitle: First again\nslug: first\n---\nx\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_equal 2, out.lines.grep(/\AFAIL /).size, out
    assert_includes out, '2 address(es) are claimed by more than one file'
  end

  # The build-time warning is silenced by `quiet: true`; this check must not be.
  def test_a_site_that_sets_quiet_cannot_hide_a_shared_address
    write('_config.yml', "title: Example\npermalink: /blog/:slug/\nquiet: true\n")
    write('pages/sneaky.md', "---\ntitle: Sneaky\npermalink: /tags/\n---\nx\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, '"/tags/index.html"'
  end

  # An unpublished or draft entry is not written, so it claims nothing.
  def test_an_unpublished_entry_claims_no_address
    write('pages/sneaky.md', "---\ntitle: Sneaky\npermalink: /tags/\npublished: false\n---\nx\n")
    write('_posts/2026-06-01-another.md', "---\ntitle: First again\nslug: first\npublished: false\n---\nx\n")
    out, code = run_script
    assert_equal 0, code, out
  end

  # A file name is printed JSON-quoted, so a newline in it cannot start a log
  # line (and so cannot forge a workflow command such as `::error::`).
  def test_file_names_are_printed_quoted_on_one_line
    write("pages/a\n::error::forged.md", "---\ntitle: Sneaky\npermalink: /tags/\n---\nx\n")
    out, code = run_script
    assert_equal 1, code, out
    refute(out.lines.any? { |line| line.start_with?('::') }, out)
    assert_includes out, 'a\n::error::forged.md'
  end

  # A consumer gets the theme gem, and so its generated tag pages and its
  # empty-slug repair, from the Gemfile's `:jekyll_plugins` group. `jekyll
  # build` loads that group (PluginManager.require_from_bundler); a bare
  # `Jekyll::Site.new` does not, and the first version of the script therefore
  # missed a page taking over a generated tag page and reported a false
  # collision for a post saved with `slug: ""`. This site carries a tiny local
  # plugin gem that does both jobs, loaded ONLY through that group, and the
  # script is run from the site directory as `site-verify.yml` runs it.
  def with_plugin_gem
    write('Gemfile', <<~GEMFILE)
      source 'https://rubygems.org'
      gem 'jekyll', '#{Jekyll::VERSION}'
      group :jekyll_plugins do
        gem 'conflict-fixture-plugin', path: '_fixture_plugin'
      end
    GEMFILE
    write('_fixture_plugin/conflict-fixture-plugin.gemspec', <<~GEMSPEC)
      Gem::Specification.new do |spec|
        spec.name = 'conflict-fixture-plugin'
        spec.version = '0.0.1'
        spec.summary = 'test fixture'
        spec.authors = ['fixture']
        spec.files = ['lib/conflict-fixture-plugin.rb']
        spec.require_paths = ['lib']
      end
    GEMSPEC
    write('_fixture_plugin/lib/conflict-fixture-plugin.rb', <<~PLUGIN)
      require 'jekyll'

      # A generated page, like the theme's per-tag archive.
      class FixtureTagPages < Jekyll::Generator
        def generate(site)
          page = Jekyll::PageWithoutAFile.new(site, site.source, 'tags/ai', 'index.html')
          page.content = 'generated tag page'
          site.pages << page
        end
      end

      # The theme's empty-slug repair (normalize_empty_slug.rb): after the
      # site is read, `slug: ""` falls back to the file name.
      Jekyll::Hooks.register :site, :post_read do |site|
        site.documents.each do |doc|
          next unless doc.data['slug'].is_a?(String) && doc.data['slug'].strip.empty?

          doc.data['slug'] = File.basename(doc.relative_path, '.*').sub(/\\A\\d{4}-\\d{2}-\\d{2}-/, '')
        end
      end
    PLUGIN
    write('_config.yml', "title: Example\npermalink: /blog/:slug/\nexclude: [_fixture_plugin, Gemfile, Gemfile.lock]\n")
  end

  # Bundler resolves from the gems already installed (no network); a stray
  # BUNDLE_GEMFILE or RUBYOPT from the shell must not choose the bundle.
  def run_script_in_site
    env = { 'JEKYLL_ENV' => 'production', 'BUNDLE_GEMFILE' => File.join(@site, 'Gemfile'),
            'RUBYOPT' => nil, 'JEKYLL_NO_BUNDLER_REQUIRE' => nil }
    out, status = Open3.capture2e(env, RbConfig.ruby, SCRIPT, '.', chdir: @site)
    [out, status.exitstatus]
  end

  def test_pages_generated_by_a_bundler_plugin_are_counted
    before, = run_script_in_site_without_gemfile
    with_plugin_gem
    out, code = run_script_in_site
    assert_equal 0, code, out
    count = ->(text) { text[/\((\d+) files checked\)/, 1].to_i }
    assert_equal count.call(before) + 1, count.call(out),
                 "the generated tag page must be one of the files checked: #{before} then #{out}"
  end

  def test_a_page_that_takes_over_a_generated_page_fails
    with_plugin_gem
    write('pages/tag-takeover.md', "---\ntitle: Mine\npermalink: /tags/ai/\n---\nx\n")
    out, code = run_script_in_site
    assert_equal 1, code, out
    assert_includes out, 'FAIL 2 files are written to "/tags/ai/index.html"'
    assert_includes out, '"pages/tag-takeover.md"'
  end

  # Without the plugin's hook this post's address would be /blog/ itself.
  def test_a_post_whose_empty_slug_a_plugin_repairs_is_not_a_false_collision
    with_plugin_gem
    write('_posts/2026-06-01-blank-slug.md', "---\ntitle: Blank slug\nslug: \"\"\n---\nx\n")
    out, code = run_script_in_site
    assert_equal 0, code, out
  end

  # The site's own `source:` is honored, not overridden.
  def test_a_configured_source_directory_is_honored
    write('_config.yml', "title: Example\npermalink: /blog/:slug/\nsource: site\n")
    write('site/index.html', "---\ntitle: Home\n---\nhome\n")
    write('site/tags/index.html', "---\ntitle: Tags\n---\ntags\n")
    write('site/pages/sneaky.md', "---\ntitle: Sneaky\npermalink: /tags/\n---\nx\n")
    out, code = run_script_in_site_without_gemfile
    assert_equal 1, code, out
    assert_includes out, 'FAIL 2 files are written to "/tags/index.html"'
    assert_includes out, '"pages/sneaky.md"'
    refute_includes out, '/blog/index.html', 'files outside the configured source are not the site'
  end

  def run_script_in_site_without_gemfile
    env = { 'JEKYLL_ENV' => 'production', 'BUNDLE_GEMFILE' => nil, 'RUBYOPT' => nil,
            'JEKYLL_NO_BUNDLER_REQUIRE' => nil }
    out, status = Open3.capture2e(env, RbConfig.ruby, SCRIPT, '.', chdir: @site)
    [out, status.exitstatus]
  end

  # A check that cannot run must not read as a pass.
  def test_a_site_that_cannot_be_loaded_fails_with_one_plain_line
    write('_config.yml', "title: [unclosed\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_match(/\AFAIL the address check could not load this site \(/, out)
    refute_match(/\.rb:\d+:in /, out, 'no Ruby backtrace')
  end
end
