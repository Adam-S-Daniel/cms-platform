# frozen_string_literal: true
Gem::Specification.new do |spec|
  spec.name        = "cms-platform-theme"
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
