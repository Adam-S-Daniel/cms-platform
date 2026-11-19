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

  # A check that cannot run must not read as a pass.
  def test_a_site_that_cannot_be_loaded_fails_with_one_plain_line
    write('_config.yml', "title: [unclosed\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_match(/\AFAIL the address check could not load this site \(/, out)
    refute_match(/\.rb:\d+:in /, out, 'no Ruby backtrace')
  end
end
