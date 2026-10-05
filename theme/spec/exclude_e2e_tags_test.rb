# frozen_string_literal: true

#
# Unit tests for lib/cms-platform-theme/exclude_e2e_tags.rb. Run with:
#
#   ruby spec/exclude_e2e_tags_test.rb
#
# Like exclude_e2e_posts_test.rb: plain Ruby, no Jekyll on the load path,
# so only the pure module methods are exercised. The real build is
# covered by spec/exclude_e2e_tags_build_test.rb.

require_relative '../lib/cms-platform-theme/exclude_e2e_tags'
require_relative 'support/jekyll_slugify'

# Minimal stand-in for a `_tags/` Jekyll::Document.
class FakeTagDoc
  attr_reader :data, :relative_path

  def initialize(data:, relative_path:)
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

T = Jekyll::ExcludeE2ETags
SLUGIFY = ->(name) { SpecJekyllSlugify.slugify(name) }

# ── effective_slug ─────────────────────────────────────────────────────────

run('effective_slug: filename basename when no explicit slug') do
  slug = T.effective_slug({ 'name' => 'E2E Tags Canary 1' }, '_tags/e2e-tags-canary-1786027176024.md')
  check(slug == 'e2e-tags-canary-1786027176024', "expected the filename slug, got #{slug.inspect}")
end

run('effective_slug: explicit non-empty slug wins, blank falls back') do
  check(T.effective_slug({ 'slug' => 'real-tag' }, '_tags/e2e-x.md') == 'real-tag', 'explicit slug must win')
  check(T.effective_slug({ 'slug' => ' ' }, '_tags/e2e-x.md') == 'e2e-x', 'blank slug must fall back')
end

run('effective_slug: a date-looking tag filename is NOT stripped (not a post)') do
  slug = T.effective_slug({}, '_tags/2024-01-01-e2e-x.md')
  check(slug == '2024-01-01-e2e-x', "expected the whole basename, got #{slug.inspect}")
end

run('effective_slug: blank path → nil') do
  check(T.effective_slug({}, nil).nil?, 'expected nil for nil path')
  check(T.effective_slug({}, '').nil?, 'expected nil for blank path')
end

# ── e2e_name? ──────────────────────────────────────────────────────────────

run('e2e_name?: the canary name slugifies to an e2e- slug') do
  check(T.e2e_name?('E2E Tags Canary 1786027176024', slugify: SLUGIFY), 'canary name must match')
  check(T.e2e_name?('e2e-x', slugify: SLUGIFY), 'a slug-shaped e2e name must match')
end

run('e2e_name?: real names and mid-name e2e do not match') do
  check(!T.e2e_name?('Machine Learning', slugify: SLUGIFY), 'a real tag must not match')
  check(!T.e2e_name?('Notes on e2e testing', slugify: SLUGIFY), 'e2e mid-name must not match')
  check(!T.e2e_name?(nil, slugify: SLUGIFY), 'nil must not match')
end

# ── excluded_names ─────────────────────────────────────────────────────────

run('excluded_names: flagged curated entries plus e2e-slug names') do
  curated = [
    { 'name' => 'Flagged Fixture', 'feed_exclude' => true },
    { 'name' => 'Real Tag', 'feed_exclude' => nil },
  ]
  names = ['Flagged Fixture', 'Real Tag', 'E2E Orphan', 'Shared']
  got = T.excluded_names(curated: curated, names: names, slugify: SLUGIFY).sort
  check(got == ['E2E Orphan', 'Flagged Fixture'], "unexpected excluded names #{got.inspect}")
end

run('excluded_names: feed_exclude only counts when literally true') do
  curated = [{ 'name' => 'Stringy', 'feed_exclude' => 'true' }]
  got = T.excluded_names(curated: curated, names: ['Stringy'], slugify: SLUGIFY)
  check(got.empty?, "string 'true' must not exclude, got #{got.inspect}")
end

# ── apply ──────────────────────────────────────────────────────────────────

def assert_stamped(doc, label)
  check(doc.data['sitemap'] == false, "#{label}: expected sitemap=false, got #{doc.data['sitemap'].inspect}")
  check(doc.data['feed_exclude'] == true, "#{label}: expected feed_exclude=true")
  check(doc.data['robots'] == 'noindex,nofollow', "#{label}: expected robots noindex,nofollow, got #{doc.data['robots'].inspect}")
end

run('apply: the leftover Decap canary (e2e- filename, no flag) gets stamped') do
  doc = FakeTagDoc.new(
    data: { 'name' => 'E2E Tags Canary 1786027176024' },
    relative_path: '_tags/e2e-tags-canary-1786027176024.md',
  )
  T.apply(doc)
  assert_stamped(doc, 'canary')
end

run('apply: test_fixture:true with a non-e2e filename gets stamped') do
  doc = FakeTagDoc.new(data: { 'name' => 'Fixture', 'test_fixture' => true }, relative_path: '_tags/fixture.md')
  T.apply(doc)
  assert_stamped(doc, 'flagged')
end

run('apply: an ordinary tag is untouched') do
  doc = FakeTagDoc.new(data: { 'name' => 'Python' }, relative_path: '_tags/python.md')
  T.apply(doc)
  check(doc.data == { 'name' => 'Python' }, "real tag must gain no keys, got #{doc.data.inspect}")
end

run('apply: explicit non-e2e slug overrides an e2e-looking filename') do
  doc = FakeTagDoc.new(data: { 'slug' => 'real-tag' }, relative_path: '_tags/e2e-misnamed.md')
  T.apply(doc)
  check(!doc.data.key?('feed_exclude'), 'explicit non-e2e slug must win over the filename')
end

run('apply: object without a data Hash is a no-op') do
  T.apply(Object.new)
end

# ── result ─────────────────────────────────────────────────────────────────

if @failures.empty?
  puts 'exclude_e2e_tags: all checks passed'
else
  warn "exclude_e2e_tags: #{@failures.length} failure(s)"
  @failures.each { |m| warn "  - #{m}" }
  exit 1
end
