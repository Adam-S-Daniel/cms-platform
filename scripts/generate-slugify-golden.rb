# frozen_string_literal: true

# Regenerates e2e/jekyll-slugify-golden.json from the REAL Jekyll::Utils.slugify
# (default mode) — the one definition of a post's `/blog/<slug>/` address.
#
# Every other slugify in the platform (the admin's live-url-derive.js, the e2e
# harness's public-content.js, scripts/cross_post/cross_post.py, the theme
# spec mirrors) is a port, and each is tested against this file, never against
# a hand-written table. e2e/jekyll-slugify-oracle.test.js re-checks the file
# against the consuming site's own Jekyll on every consumer e2e run.
#
# Run from a site with Jekyll in its bundle, e.g.:
#   cd e2e/fixture-site && bundle exec ruby ../../scripts/generate-slugify-golden.rb
require "jekyll"
require "json"

CORPUS_PATH = File.expand_path("../e2e/jekyll-slugify-golden.json", __dir__)
existing = File.exist?(CORPUS_PATH) ? JSON.parse(File.read(CORPUS_PATH, encoding: "UTF-8")) : {}
inputs = (existing["cases"] || []).map(&:first)
inputs = JSON.parse(File.read(ARGV[0], encoding: "UTF-8")) if ARGV[0]

out = {
  "generated_by" => "scripts/generate-slugify-golden.rb",
  "jekyll_version" => Jekyll::VERSION,
  "mode" => "default",
  "cases" => inputs.map { |s| [s, Jekyll::Utils.slugify(s)] },
}
File.write(CORPUS_PATH, JSON.pretty_generate(out) + "\n", encoding: "UTF-8")
puts "wrote #{out["cases"].size} cases (Jekyll #{Jekyll::VERSION}) to #{CORPUS_PATH}"
