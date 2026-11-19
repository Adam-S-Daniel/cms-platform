# frozen_string_literal: true

# The theme gemspec pins sanitize and nokogiri EXACTLY, and names nokogiri
# itself. That is what makes every consumer lock the identical version of
# both: a site gets them from the platform and from nowhere else (owner
# decision 2026-11-19). A range here would let each site's lockfile resolve on
# its own day, and platform-bump's relock is `--conservative`, so two sites
# would stay on different versions for good.
#
# Read through RubyGems' own loader, not by matching the file's text. The
# fixture lockfiles are read through Bundler's parser.
# Run with: ruby theme/spec/gemspec_pins_test.rb

require 'minitest/autorun'
require 'rubygems'
require 'bundler'

class GemspecPinsTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  PINNED = %w[sanitize nokogiri].freeze

  def gemspec
    @gemspec ||= Dir.chdir(File.join(ROOT, 'theme')) { Gem::Specification.load('cms-platform-theme.gemspec') }
  end

  def pinned_version(name)
    dependency = gemspec.runtime_dependencies.find { |d| d.name == name }
    refute_nil dependency, "the theme gemspec must declare #{name} itself"
    requirements = dependency.requirement.requirements
    assert_equal 1, requirements.size, "#{name} takes one requirement, an exact version"
    operator, version = requirements.first
    assert_equal '=', operator, "#{name} must be pinned exactly, not #{dependency.requirement}"
    version.to_s
  end

  def test_both_gems_are_declared_and_pinned_exactly
    PINNED.each { |name| assert_match(/\A\d+\.\d+\.\d+\z/, pinned_version(name), name) }
  end

  def test_the_pinned_nokogiri_satisfies_the_pinned_sanitize
    sanitize = Gem::Specification.find_by_name('sanitize', pinned_version('sanitize'))
    need = sanitize.runtime_dependencies.find { |d| d.name == 'nokogiri' }
    refute_nil need, 'sanitize is expected to depend on nokogiri'
    assert need.requirement.satisfied_by?(Gem::Version.new(pinned_version('nokogiri'))),
           "nokogiri #{pinned_version('nokogiri')} does not satisfy sanitize's #{need.requirement}"
  end

  # The fixture sites take the theme by path, so their lockfiles are what a
  # consumer's lockfile becomes at its next bump.
  def test_both_fixture_lockfiles_lock_exactly_the_pinned_versions
    %w[fixture-site fixture-site-singlepage].each do |site|
      dir = File.join(ROOT, 'e2e', site)
      # Bundler resolves the lockfile's PATH source against the Gemfile's
      # directory, so the parse runs from there.
      lock = Dir.chdir(dir) { Bundler::LockfileParser.new(File.read('Gemfile.lock')) }
      PINNED.each do |name|
        versions = lock.specs.select { |s| s.name == name }.map { |s| s.version.to_s }.uniq
        assert_equal [pinned_version(name)], versions, "#{site}/Gemfile.lock #{name}"
      end
    end
  end
end
