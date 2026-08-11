# frozen_string_literal: true
Gem::Specification.new do |spec|
  spec.name        = "cms-platform-theme"
  # DELIBERATELY FROZEN at 0.1.4 — do NOT "fix" this to match the platform
  # release. It looks stale (we are 75+ releases past v0.1.4) and it is not.
  # Consumers resolve this gem by GIT tag + revision, never by version, and
  # bumping the string would break BOTH production sites' CI at bundle install:
  #
  #   1. Each consumer's Gemfile.lock records the version TWICE — in the GIT
  #      block's `specs:` and again under CHECKSUMS — as `cms-platform-theme
  #      (0.1.4)`.
  #   2. Consumer CI installs gems in DEPLOYMENT (frozen) mode: ruby/setup-ruby
  #      sets `bundle config deployment true` whenever a lockfile exists, and
  #      both consumers commit Gemfile.lock. Frozen bundler materializes a
  #      git-source spec by [name, VERSION] and refuses to rewrite the lock
  #      ("Cannot write a changed lockfile while frozen"), so a gemspec version
  #      that disagrees with the lock is a hard GemNotFound, not a re-resolve.
  #   3. platform-bump.yml cannot repair it: it rewrites Gemfile.lock TEXTUALLY
  #      (a literal CUR->LATEST replace plus OLD_SHA->NEW_SHA) and never runs
  #      bundler. CUR comes from platform.lock's `platform_ref:`, so it is
  #      v-prefixed ("v0.1.79") and can never match the bare "0.1.4".
  #
  # So the frozen version is what keeps the gemspec and every consumer lockfile
  # in agreement. If you ever genuinely need to bump it, the version and BOTH
  # lockfile occurrences in BOTH consumers have to move in the same change, and
  # platform-bump.yml needs to learn to do that (or to run `bundle lock`).
  # Locked by e2e/gemspec-version-frozen.test.js.
  #
  # This is inert for publication: the gem has never been pushed to RubyGems
  # (rubygems.org/api/v1/gems/cms-platform-theme.json → 404). Publishing would
  # be the one thing that makes the value externally visible — and it would
  # need the coordinated change above anyway.
  spec.version     = "0.1.4"
  spec.authors     = ["Adam Daniel"]
  spec.summary     = "Jekyll theme, plugins, and Decap render hook for cms-platform sites."
  spec.homepage    = "https://github.com/Adam-S-Daniel/cms-platform"
  spec.license     = "MIT"
  # admin/ now lives under the gem root (theme/admin) so the Decap machinery
  # ships WITH the gem instead of being vendored byte-for-byte into every site.
  # Exclude the site-owned seam (collections.site.yml) and the build-generated
  # files (config.yml/config-local.yml/commit.json) — those are never packaged.
  # NB: Dir[] has no "!" negation, so exclude via array subtraction.
  spec.files       = Dir["_layouts/**/*", "_includes/**/*", "assets/**/*", "lib/**/*", "README.md",
                         "admin/**/*"] -
                     Dir["admin/collections.site.yml", "admin/config.yml",
                         "admin/config-local.yml", "admin/commit.json"]
  spec.required_ruby_version = ">= 3.0"
  spec.add_runtime_dependency "jekyll", ">= 4.0", "< 5.0"
  spec.add_runtime_dependency "jekyll-seo-tag"
  spec.add_runtime_dependency "jekyll-feed"
  spec.add_runtime_dependency "jekyll-sitemap"
end
