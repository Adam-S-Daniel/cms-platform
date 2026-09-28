# frozen_string_literal: true

# The specs' Jekyll-free slugify (support/jekyll_slugify.rb) must equal the
# REAL Jekyll::Utils.slugify on every case in e2e/jekyll-slugify-golden.json,
# which scripts/generate-slugify-golden.rb writes from a real Jekyll run.
require 'json'
require 'minitest/autorun'
require_relative 'support/jekyll_slugify'

class JekyllSlugifyGoldenTest < Minitest::Test
  GOLDEN = File.expand_path('../../e2e/jekyll-slugify-golden.json', __dir__)

  def test_matches_real_jekyll_on_every_golden_case
    golden = JSON.parse(File.read(GOLDEN, encoding: 'UTF-8'))
    refute_empty golden['cases']
    mismatches = golden['cases'].reject { |given, want| SpecJekyllSlugify.slugify(given) == want }
    assert_empty mismatches, "specs' slugify drifted from Jekyll #{golden['jekyll_version']}"
  end
end
