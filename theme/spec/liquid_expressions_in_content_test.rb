# frozen_string_literal: true

# scripts/liquid-expressions-in-content.rb: a post body holding `${{ secrets.X }}`
# (GitHub Actions syntax) builds green and Liquid prints `$` (cms-platform
# issue 1061). The check refuses it, naming the file, and accepts the fix.
#
# Run with: ruby theme/spec/liquid_expressions_in_content_test.rb
# Needs jekyll 4.4.1 (the ruby-theme-specs lane installs it).

require 'minitest/autorun'
require 'fileutils'
require 'open3'
require 'rbconfig'
require 'tmpdir'
require 'jekyll'

class LiquidExpressionsInContentTest < Minitest::Test
  SCRIPT = File.expand_path('../../scripts/liquid-expressions-in-content.rb', __dir__)

  def setup
    @site = Dir.mktmpdir('liquid-expressions-')
    write('_config.yml', "title: Example\npermalink: /blog/:slug/\n")
    write('index.html', "---\ntitle: Home\n---\n{{ site.title }} ${{ not-checked }}\n")
    write('_posts/2026-01-01-first.md', "---\ntitle: First\n---\nplain {{ site.title }}\n")
  end

  def teardown
    FileUtils.remove_entry(@site) if @site
  end

  def write(rel, content)
    full = File.join(@site, rel)
    FileUtils.mkdir_p(File.dirname(full))
    File.write(full, content)
  end

  def run_script
    out, status = Open3.capture2e({ 'JEKYLL_ENV' => 'production' }, RbConfig.ruby, SCRIPT, @site)
    [out, status.exitstatus]
  end

  def test_a_site_without_the_token_passes_and_its_templates_are_not_read
    out, code = run_script
    assert_equal 0, code, out
    assert_match(/\Aok   no post or page body holds `\$\{\{` \(\d+ bodies checked\)\n\z/, out)
  end

  def test_a_post_holding_an_actions_expression_fails_naming_file_and_line
    write('_posts/2026-02-01-ci.md', "---\ntitle: CI\n---\nline one\n\nrun: echo ${{ secrets.X }}\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, 'FAIL "_posts/2026-02-01-ci.md" line 6 holds `${{`'
    assert_includes out, '1 file(s) need a change'
  end

  def test_a_page_under_pages_fails_too
    write('pages/about.md', "---\ntitle: About\npermalink: /about/\n---\n${{ github.sha }}\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, '"pages/about.md"'
  end

  def test_the_token_inside_a_raw_block_is_the_fix_and_passes
    write('_posts/2026-02-01-ci.md',
          "---\ntitle: CI\n---\n{% raw %}\n```yaml\nrun: echo ${{ secrets.X }}\n```\n{% endraw %}\n")
    out, code = run_script
    assert_equal 0, code, out
  end

  def test_a_raw_block_does_not_hide_a_later_token
    write('_posts/2026-02-01-ci.md',
          "---\ntitle: CI\n---\n{% raw %}${{ a }}{% endraw %}\nthen ${{ b }}\n")
    out, code = run_script
    assert_equal 1, code, out
    assert_includes out, 'line 5'
  end

  def test_a_document_opting_out_of_liquid_is_skipped
    write('_posts/2026-02-01-ci.md',
          "---\ntitle: CI\nrender_with_liquid: false\n---\nrun: echo ${{ secrets.X }}\n")
    out, code = run_script
    assert_equal 0, code, out
  end

  def test_jekyll_really_drops_the_expression_from_the_page
    write('_posts/2026-02-01-ci.md', "---\ntitle: CI\n---\nx ${{ secrets.X }} y\n")
    dest = File.join(@site, '_site')
    Jekyll::Site.new(Jekyll.configuration('source' => @site, 'destination' => dest, 'quiet' => true)).process
    html = File.read(Dir[File.join(dest, '**', 'ci', 'index.html')].first)
    refute_includes html, 'secrets.X'
  end
end
