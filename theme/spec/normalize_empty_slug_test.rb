# frozen_string_literal: true

#
# Unit tests for lib/cms-platform-theme/normalize_empty_slug.rb. Run with:
#
#   ruby spec/normalize_empty_slug_test.rb
#
# Kept outside lib/ so Jekyll doesn't auto-load this at build time.
# The plugin file guards its hook registration behind `defined?(Jekyll)`
# so loading it here doesn't blow up without Jekyll on the load path.
#
# Plain Ruby rather than minitest to avoid adding a test-only gem to the
# site Gemfile.

require_relative '../lib/cms-platform-theme/normalize_empty_slug'

# Minimal stand-in for a Jekyll::Document. The plugin only touches
# `.data` (a Hash) and `.relative_path` (a String).
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

# ── cases ──────────────────────────────────────────────────────────────────

run('empty-string slug → derived from filename (date stripped)') do
  doc = FakeDoc.new(
    data: { 'slug' => '' },
    relative_path: '_posts/2026-04-21-test-1.md',
  )
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(doc.data['slug'] == 'test-1',
        "expected 'test-1', got #{doc.data['slug'].inspect}",)
end

run('whitespace-only slug → derived from filename') do
  doc = FakeDoc.new(
    data: { 'slug' => "  \t\n" },
    relative_path: '_posts/2024-01-15-test-cms-workflow.md',
  )
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(doc.data['slug'] == 'test-cms-workflow',
        "expected 'test-cms-workflow', got #{doc.data['slug'].inspect}",)
end

run('concrete slug preserved') do
  doc = FakeDoc.new(data: { 'slug' => 'my-custom-slug' })
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(doc.data['slug'] == 'my-custom-slug',
        "expected preserved, got #{doc.data['slug'].inspect}",)
end

run('absent slug preserved') do
  doc = FakeDoc.new(data: { 'title' => 'No slug key' })
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(!doc.data.key?('slug'),
        'absent slug: key should stay absent',)
end

run('nil slug preserved (Jekyll already falls back)') do
  doc = FakeDoc.new(data: { 'slug' => nil })
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(doc.data.key?('slug') && doc.data['slug'].nil?,
        "expected nil preserved, got #{doc.data.inspect}",)
end

run('non-string slug preserved (let Jekyll raise)') do
  doc = FakeDoc.new(data: { 'slug' => 123 })
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(doc.data['slug'] == 123,
        "expected 123 preserved, got #{doc.data['slug'].inspect}",)
end

run('non-dated filename: date-strip regex is a no-op') do
  # Pages (outside _posts/) don't have a date prefix. The plugin should
  # still derive a sane slug from the raw basename.
  doc = FakeDoc.new(
    data: { 'slug' => '' },
    relative_path: 'pages/about.md',
  )
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(doc.data['slug'] == 'about',
        "expected 'about', got #{doc.data['slug'].inspect}",)
end

run('empty slug and pathological filename → key deleted, Jekyll fallback wins') do
  # If we can't derive anything, drop the key so Jekyll's own `:slug`
  # placeholder uses whatever it normally would. Better to produce an
  # ugly URL than silently serve at `/blog//`.
  doc = FakeDoc.new(
    data: { 'slug' => '' },
    relative_path: '',
  )
  Jekyll::NormalizeEmptySlug.apply(doc)
  check(!doc.data.key?('slug'),
        "expected key deleted, got #{doc.data.inspect}",)
end

run('object without .data is a no-op (StaticFile et al.)') do
  Jekyll::NormalizeEmptySlug.apply(Object.new)
end

# ── result ─────────────────────────────────────────────────────────────────

if @failures.empty?
  puts 'normalize_empty_slug: all 9 checks passed'
else
  warn "normalize_empty_slug: #{@failures.length} failure(s)"
  @failures.each { |m| warn "  - #{m}" }
  exit 1
end
