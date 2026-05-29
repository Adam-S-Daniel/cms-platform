# frozen_string_literal: true
Gem::Specification.new do |spec|
  spec.name        = "cms-platform-theme"
  spec.version     = "0.1.0"
  spec.authors     = ["Adam Daniel"]
  spec.summary     = "Jekyll theme, plugins, and Decap render hook for cms-platform sites."
  spec.homepage    = "https://github.com/Adam-S-Daniel/cms-platform"
  spec.license     = "MIT"
  spec.files       = Dir["_layouts/**/*", "_includes/**/*", "assets/**/*", "lib/**/*", "README.md"]
  spec.required_ruby_version = ">= 3.0"
  spec.add_runtime_dependency "jekyll", ">= 4.0", "< 5.0"
  spec.add_runtime_dependency "jekyll-seo-tag"
  spec.add_runtime_dependency "jekyll-feed"
  spec.add_runtime_dependency "jekyll-sitemap"
end
