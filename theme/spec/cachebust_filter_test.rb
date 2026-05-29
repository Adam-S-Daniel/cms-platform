# frozen_string_literal: true
# Plain-ruby unit test for the cachebust Liquid filter. Run: ruby theme/spec/cachebust_filter_test.rb
#
# Locks the dogfood-surfaced fix: for a GEM theme the asset (e.g.
# assets/css/main.css) lives under site.theme.root, NOT the consuming
# site's source — the filter must hash it there, or cache-busting
# silently degrades to a bare path for every consumer.

# Stub the Liquid hook the filter registers on load, so we can require it
# without a full Liquid runtime.
module Liquid
  module Template
    def self.register_filter(*); end
  end
end

require "fileutils"
require "tmpdir"
require_relative "../lib/cms-platform-theme/cachebust_filter"

FAILURES = []
def check(desc)
  ok = yield
  puts((ok ? "ok   " : "FAIL ") + desc)
  FAILURES << desc unless ok
end

tmp = File.join(Dir.tmpdir, "cachebust-test-#{Process.pid}")
site_src = File.join(tmp, "site")
gem_root = File.join(tmp, "gem")
FileUtils.mkdir_p(File.join(site_src, "assets/css"))
FileUtils.mkdir_p(File.join(gem_root, "assets/css"))

# Fakes mirroring the bits the filter reads off the Jekyll site + Liquid context.
FakeTheme = Struct.new(:root)
FakeSite = Struct.new(:source, :config, :theme)
FakeContext = Struct.new(:registers)

def filter_for(site)
  obj = Object.new.extend(Jekyll::CachebustFilter)
  obj.instance_variable_set(:@context, FakeContext.new({ site: site }))
  obj
end

CSS = "body{color:#abc}\n"

# Case 1: asset present in the SITE source -> hashed there.
File.write(File.join(site_src, "assets/css/main.css"), CSS)
site1 = FakeSite.new(site_src, { "baseurl" => "" }, FakeTheme.new(gem_root))
out1 = filter_for(site1).cachebust("/assets/css/main.css")
check("site-source asset gets a ?v= hash") { out1 =~ %r{^/assets/css/main\.css\?v=[0-9a-f]{8}$} }

# Case 2: asset ABSENT from site source, PRESENT in the theme gem -> still hashed (the fix).
empty_site = File.join(tmp, "empty-site")
FileUtils.mkdir_p(empty_site)
File.write(File.join(gem_root, "assets/css/main.css"), CSS)
site2 = FakeSite.new(empty_site, { "baseurl" => "" }, FakeTheme.new(gem_root))
out2 = filter_for(site2).cachebust("/assets/css/main.css")
check("gem-provided asset gets a ?v= hash (cache-busting works for gem themes)") do
  out2 =~ %r{^/assets/css/main\.css\?v=[0-9a-f]{8}$}
end
# Same bytes in site vs gem -> identical hash (so a gem cutover is byte-identical HTML).
check("identical bytes in site vs gem produce the SAME hash") { out1 == out2 }

# Case 3: asset in neither -> bare path (graceful degrade, no crash).
site3 = FakeSite.new(empty_site, { "baseurl" => "" }, FakeTheme.new(File.join(tmp, "nope")))
out3 = filter_for(site3).cachebust("/assets/css/missing.css")
check("missing asset degrades to the bare path") { out3 == "/assets/css/missing.css" }

FileUtils.rm_rf(tmp)
if FAILURES.empty?
  puts "\nALL PASS"
else
  puts "\n#{FAILURES.size} FAILED"
  exit 1
end
