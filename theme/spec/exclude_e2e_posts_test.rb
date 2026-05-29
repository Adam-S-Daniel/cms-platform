# frozen_string_literal: true

#
# Unit tests for lib/cms-platform-theme/exclude_e2e_posts.rb. Run with:
#
#   ruby spec/exclude_e2e_posts_test.rb
#
# Kept outside lib/ so Jekyll doesn't auto-load this at build time. The
# plugin file guards its hook registration behind `defined?(Jekyll::Hooks)`
# so loading it here (no Jekyll on the load path) doesn't blow up — only
# the pure module methods are exercised.
#
# Plain Ruby rather than minitest to avoid adding a test-only gem to the
# site Gemfile (matches the other theme spec files).

require_relative '../lib/cms-platform-theme/exclude_e2e_posts'

# Minimal stand-in for a Jekyll::Document. The plugin only reads `.data`
# (a Hash) and `.relative_path` (a String) and mutates `.data` in place.
class FakeDoc
  attr_reader :data, :relative_path

  def initialize(data:, relative_path: '_posts/2026-04-21-fixture.md')
    @data = data
    @relative_path = relative_path
  end
end

@failures = []

def check(condition, message)
  @failures << message unless condition
end

def run(label)
  yield
rescue StandardError => e
  @failures << "#{label}: raised #{e.class}: #{e.message}"
end

E = Jekyll::ExcludeE2EPosts

# ── effective_slug ─────────────────────────────────────────────────────────

run('effective_slug: explicit non-empty slug wins') do
  slug = E.effective_slug({ 'slug' => 'my-post' }, '_posts/2026-01-01-whatever.md')
  check(slug == 'my-post', "expected 'my-post', got #{slug.inspect}")
end

run('effective_slug: empty/whitespace explicit slug falls back to filename') do
  slug = E.effective_slug({ 'slug' => '  ' }, '_posts/2099-12-31-e2e-media-roundtrip-abc.md')
  check(slug == 'e2e-media-roundtrip-abc', "expected derived slug, got #{slug.inspect}")
end

run('effective_slug: no slug key → filename minus date prefix') do
  slug = E.effective_slug({}, '_posts/2024-01-02-e2e-unpublish-canary.md')
  check(slug == 'e2e-unpublish-canary', "expected 'e2e-unpublish-canary', got #{slug.inspect}")
end

run('effective_slug: non-dated path (no prefix to strip)') do
  slug = E.effective_slug({}, '_posts/e2e-no-date.md')
  check(slug == 'e2e-no-date', "expected 'e2e-no-date', got #{slug.inspect}")
end

run('effective_slug: blank path → nil') do
  check(E.effective_slug({}, '').nil?, 'expected nil for blank path')
  check(E.effective_slug({}, nil).nil?, 'expected nil for nil path')
end

# ── e2e_fixture? ───────────────────────────────────────────────────────────

run('e2e_fixture?: e2e- slug with NO flag is a fixture (the UI-created case)') do
  check(E.e2e_fixture?(slug: 'e2e-mutation-canary', test_fixture: nil),
        'e2e- slug alone must classify as fixture',)
end

run('e2e_fixture?: test_fixture:true with non-e2e slug is a fixture') do
  check(E.e2e_fixture?(slug: 'some-real-looking-slug', test_fixture: true),
        'test_fixture: true must classify as fixture regardless of slug',)
end

run('e2e_fixture?: e2e- prefix anchored at start only') do
  check(E.e2e_fixture?(slug: 'e2e-foo', test_fixture: nil), 'e2e- prefix should match')
  check(!E.e2e_fixture?(slug: 'my-e2e-notes', test_fixture: nil),
        'e2e- in the MIDDLE of a slug must NOT match (anchored prefix)',)
  check(!E.e2e_fixture?(slug: 'e2', test_fixture: nil), 'partial prefix must not match')
end

run('e2e_fixture?: ordinary published post is NOT a fixture') do
  check(!E.e2e_fixture?(slug: 'introducing-gha-bench', test_fixture: false),
        'a real post must not be classified as a fixture',)
  check(!E.e2e_fixture?(slug: 'introducing-gha-bench', test_fixture: nil),
        'a real post with no flag must not be classified as a fixture',)
end

run('e2e_fixture?: test_fixture only treated as true when literally true') do
  # Guard against a stray string "false" or "true" being mis-read; the
  # plugin compares to the boolean true, and YAML parses `test_fixture: true`
  # to a real boolean.
  check(!E.e2e_fixture?(slug: 'plain', test_fixture: 'false'),
        "string 'false' must not be a fixture",)
  check(!E.e2e_fixture?(slug: 'plain', test_fixture: 'true'),
        "string 'true' (not boolean) must not flip a non-e2e slug",)
  check(E.e2e_fixture?(slug: nil, test_fixture: true),
        'boolean true must classify even with a nil slug',)
end

# ── apply (end-to-end stamping on a doc) ─────────────────────────────────────

run('apply: UI-created e2e post (e2e- slug, no flag, no sitemap key) gets stamped') do
  doc = FakeDoc.new(
    data: { 'title' => 'E2E Media Roundtrip abc', 'published' => true },
    relative_path: '_posts/2099-12-31-e2e-media-roundtrip-abc.md',
  )
  E.apply(doc)
  check(doc.data['sitemap'] == false, "expected sitemap=false, got #{doc.data['sitemap'].inspect}")
  check(doc.data['feed_exclude'] == true,
        "expected feed_exclude=true, got #{doc.data['feed_exclude'].inspect}",)
end

run('apply: flagged canary (test_fixture:true) gets stamped, idempotent with existing keys') do
  doc = FakeDoc.new(
    data: { 'test_fixture' => true, 'sitemap' => false },
    relative_path: '_posts/2024-01-02-e2e-unpublish-canary.md',
  )
  E.apply(doc)
  check(doc.data['sitemap'] == false, 'sitemap should remain false')
  check(doc.data['feed_exclude'] == true, 'feed_exclude should be set true')
end

run('apply: ordinary post is untouched (no markers added)') do
  doc = FakeDoc.new(
    data: { 'title' => 'Introducing GHA-bench', 'published' => true },
    relative_path: '_posts/2026-05-12-introducing-gha-bench.md',
  )
  E.apply(doc)
  check(!doc.data.key?('feed_exclude'),
        "real post must not gain feed_exclude, got #{doc.data.inspect}",)
  check(!doc.data.key?('sitemap'),
        "real post must not gain sitemap key, got #{doc.data.inspect}",)
end

run('apply: explicit slug overrides an e2e-looking filename') do
  # If an author files a post under an e2e-looking name but sets a real
  # slug, the effective slug (what the URL uses) governs — so it is NOT
  # treated as a fixture. (No fixture in the repo does this; the test
  # pins the slug-is-authoritative contract.)
  doc = FakeDoc.new(
    data: { 'slug' => 'real-post' },
    relative_path: '_posts/2026-01-01-e2e-misnamed.md',
  )
  E.apply(doc)
  check(!doc.data.key?('feed_exclude'),
        'explicit non-e2e slug must win over an e2e-looking filename',)
end

run('apply: object without a data Hash is a no-op (StaticFile et al.)') do
  E.apply(Object.new)
end

# ── result ─────────────────────────────────────────────────────────────────

if @failures.empty?
  puts 'exclude_e2e_posts: all checks passed'
else
  warn "exclude_e2e_posts: #{@failures.length} failure(s)"
  @failures.each { |m| warn "  - #{m}" }
  exit 1
end
