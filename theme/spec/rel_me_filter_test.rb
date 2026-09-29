# frozen_string_literal: true
# Plain-ruby unit test for the rel_me_urls Liquid filter. Run: ruby theme/spec/rel_me_filter_test.rb
#
# The filter turns a site's `cross_post.profiles` map (target => profile URL)
# into the ordered list of URLs the head renders as <link rel="me">. A value
# that is not an absolute https URL fails the build rather than shipping a
# broken or unsafe link.

module Liquid
  module Template
    def self.register_filter(*); end
  end
end

require_relative "../lib/cms-platform-theme/rel_me_filter"

FAILURES = []
def check(desc)
  ok = begin
    yield
  rescue StandardError => e
    puts "     raised #{e.class}: #{e.message}"
    false
  end
  puts((ok ? "ok   " : "FAIL ") + desc)
  FAILURES << desc unless ok
end

F = Object.new.extend(Jekyll::RelMeFilter)

check("nil (no cross_post.profiles configured) renders nothing") { F.rel_me_urls(nil) == [] }
check("empty map renders nothing") { F.rel_me_urls({}) == [] }

check("URLs come back ordered by target name") do
  F.rel_me_urls(
    "substack" => "https://example.substack.com",
    "mastodon" => "https://hachyderm.example/@someone",
    "linkedin" => "https://www.linkedin.com/in/someone"
  ) == [
    "https://www.linkedin.com/in/someone",
    "https://hachyderm.example/@someone",
    "https://example.substack.com"
  ]
end

check("blank and nil values are skipped (a target left unset)") do
  F.rel_me_urls("mastodon" => "", "linkedin" => nil, "substack" => "  ") == []
end

check("surrounding whitespace is trimmed") do
  F.rel_me_urls("mastodon" => "  https://example.com/@me  ") == ["https://example.com/@me"]
end

def raises?(value)
  F.rel_me_urls("mastodon" => value)
  false
rescue ArgumentError => e
  e.message.include?("cross_post.profiles.mastodon")
end

check("http:// URL fails the build, naming the key") { raises?("http://example.com/@me") }
check("javascript: URL fails the build") { raises?("javascript:alert(1)") }
check("relative path fails the build") { raises?("/about/") }
check("URL without a host fails the build") { raises?("https:///x") }
check("non-string value fails the build") { raises?(42) }

check("a non-map profiles value fails the build") do
  F.rel_me_urls(["https://example.com/@me"])
  false
rescue ArgumentError => e
  e.message.include?("cross_post.profiles")
end

if FAILURES.empty?
  puts "all rel_me_urls checks passed"
else
  warn "#{FAILURES.size} rel_me_urls check(s) failed"
  exit 1
end
