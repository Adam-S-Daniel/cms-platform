#!/usr/bin/env ruby
# frozen_string_literal: true

# Fail when a post or page body holds `${{`, which Liquid would eat.
#
#   bundle exec ruby liquid-expressions-in-content.rb [site-dir]
#
# WHY. Jekyll runs Liquid over every post and page body, so a body that quotes
# GitHub Actions syntax, `${{ secrets.X }}`, builds green and prints `$`: the
# expression is evaluated, comes out empty, and the reader sees a sentence with
# the middle missing (cms-platform issue 1061). Nothing in the build, the site
# verifier or the parity specs notices, and the author is not told. Rewriting
# the author's text would change what they wrote without saying so, so this
# refuses the publish and names the file and line instead. The fix is the
# author's, in the Markdown: wrap the text in `{% raw %}` ... `{% endraw %}`.
#
# SCOPE. Only `${{`: a `$` directly before `{{` is how Actions, shell-in-YAML
# and JavaScript template text are written, and in a body it is never meant as
# Liquid. A bare `{{ site.title }}` in a post can be deliberate, so it is not
# flagged. Checked: every document of every collection (posts included) and
# every page under `pages/`, the CMS's pages collection. The site's own
# templates and layouts are not content and are not read. A `${{` inside a
# `{% raw %}` block is fine and skipped, which is the fix this message offers.
#
# HOW. It loads the site the way `jekyll build` does (see
# destination-conflicts.rb for why `require_from_bundler` matters), reads
# without rendering or writing, and scans each body's raw text, before Liquid.
# This is a lexical token, not code shape, so a pattern is the right tool.
#
# Output: one `FAIL` line per file naming it, JSON-quoted, and the first line
# number, then exit 1. Exit 0 and one `ok` line when there is none. A site this
# cannot load is a FAIL, exit 1: a check that cannot run must not read as a pass.

require "json"

begin
  require "jekyll"

  Dir.chdir(File.expand_path(ARGV[0] || "."))
  Jekyll::PluginManager.require_from_bundler
  site = Jekyll::Site.new(Jekyll.configuration("quiet" => true))
  source = site.source
  site.reset
  site.read

  relative = lambda do |path|
    path = path.to_s
    (path.start_with?("#{source}/") ? path[(source.length + 1)..] : path).sub(%r{\A/}, "")
  end

  items = site.documents.map { |doc| [relative.call(doc.relative_path), doc.content.to_s] }
  site.pages.each do |page|
    name = relative.call(page.relative_path)
    items << [name, page.content.to_s] if name.start_with?("pages/")
  end

  raw_block = /\{%-?\s*raw\s*-?%\}.*?\{%-?\s*endraw\s*-?%\}/m
  findings = items.sort.filter_map do |name, body|
    # Blank the raw blocks, keeping their newlines, so line numbers hold.
    scanned = body.gsub(raw_block) { |block| block.gsub(/[^\n]/, " ") }
    offset = scanned.index("${{")
    [name, scanned[0, offset].count("\n") + 1] if offset
  end

  if findings.empty?
    puts "ok   no post or page body holds `${{` (#{items.size} bodies checked)"
    exit 0
  end

  findings.each do |name, line|
    puts "FAIL #{JSON.generate(name)} line #{line} holds `${{`, which Liquid evaluates and prints as " \
         "`$`, so the text would be published with the expression missing"
  end
  puts
  puts "#{findings.size} file(s) need a change. Wrap the text in {% raw %} ... {% endraw %} " \
       "in the Markdown, or reword it."
  exit 1
rescue SystemExit
  raise
rescue StandardError, LoadError => e
  puts "FAIL the Liquid check could not load this site (#{e.class}: " \
       "#{JSON.generate(e.message.lines.first.to_s.strip)}), so it cannot say that no body holds `${{`"
  exit 1
end
