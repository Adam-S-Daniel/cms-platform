# frozen_string_literal: true

#
# Unit tests for lib/cms-platform-theme/tag_feeds.rb. Run with:
#
#   ruby spec/tag_feeds_test.rb
#
# Same plain-Ruby convention as the other theme spec files. Unlike
# exclude_e2e_posts / auto_tag_pages, tag_feeds has no Jekyll-free pure
# helper: the whole plugin lives behind `if defined?(Jekyll::Generator)`.
# So we define the *minimal* Jekyll surface the plugin touches BEFORE
# requiring it — just enough to instantiate the Generator and run
# `generate(site)` against doubles. This pins the behavioural delta we
# ported from adamdaniel.ai@main: e2e / test-fixture posts marked
# `feed_exclude: true` must NOT mint a per-tag /tags/<slug>/feed.xml.

# ── Minimal Jekyll stubs (defined before the require so the guard passes) ────
require_relative 'support/jekyll_slugify'
module Jekyll
  # FeedPage subclasses this and calls `process(@name)` + reads `site.source`.
  class Page
    attr_accessor :data

    def process(_name); end
  end

  class Generator
    def self.safe(_value = nil); end
    def self.priority(_value = nil); end
  end

  module Utils
    # Jekyll's "default" mode — the shared, golden-tested port.
    def self.slugify(name)
      raise TypeError, 'slugify requires String' unless name.is_a?(String)
      SpecJekyllSlugify.slugify(name)
    end
  end
end

require_relative '../lib/cms-platform-theme/tag_feeds'

# ── Test doubles for a Jekyll site ───────────────────────────────────────────
FakePostDoc = Struct.new(:data)

class FakeCollection
  attr_reader :docs

  def initialize(docs)
    @docs = docs
  end
end

class FakePosts
  attr_reader :docs

  def initialize(docs)
    @docs = docs
  end
end

class FakeSite
  attr_reader :pages, :collections, :source

  def initialize(posts:, tags: nil)
    @source = '/tmp/site'
    @posts = posts
    @collections = {}
    @collections['tags'] = tags if tags
    @pages = []
  end

  attr_reader :posts
end

@failures = []
@checks = 0
@runs = 0

def check(condition, message)
  @checks += 1
  @failures << message unless condition
end

def run(label)
  @runs += 1
  yield
rescue StandardError => e
  @failures << "#{label}: raised #{e.class}: #{e.message}"
end

# Pull the slugs that the generator decided to mint a feed page for.
def feed_slugs(site)
  site.pages.map { |p| Jekyll::Utils.slugify(p.data['tag_name'].to_s) }
end

# ── cases ──────────────────────────────────────────────────────────────────

run('a tag carried ONLY by a feed_exclude canary mints no feed page') do
  posts = FakePosts.new([
    FakePostDoc.new({ 'tags' => ['Real Tag'] }),
    FakePostDoc.new({ 'tags' => ['Canary Only'], 'feed_exclude' => true }),
  ])
  site = FakeSite.new(posts: posts)
  Jekyll::TagFeeds::Generator.new.generate(site)
  slugs = feed_slugs(site)
  check(slugs.include?('real-tag'), "expected real-tag feed, got #{slugs.inspect}")
  check(!slugs.include?('canary-only'),
        "canary-only tag must not mint a feed page, got #{slugs.inspect}",)
end

run('a tag SHARED by a real post and a canary still mints exactly one page') do
  posts = FakePosts.new([
    FakePostDoc.new({ 'tags' => ['Shared'] }),
    FakePostDoc.new({ 'tags' => ['Shared'], 'feed_exclude' => true }),
  ])
  site = FakeSite.new(posts: posts)
  Jekyll::TagFeeds::Generator.new.generate(site)
  slugs = feed_slugs(site)
  check(slugs.count { |s| s == 'shared' } == 1,
        "expected exactly one 'shared' feed page, got #{slugs.inspect}",)
end

run('curated _tags entries always mint a feed even with no public post') do
  tags = FakeCollection.new([FakePostDoc.new({ 'name' => 'Curated' })])
  posts = FakePosts.new([
    FakePostDoc.new({ 'tags' => ['Canary Only'], 'feed_exclude' => true }),
  ])
  site = FakeSite.new(posts: posts, tags: tags)
  Jekyll::TagFeeds::Generator.new.generate(site)
  slugs = feed_slugs(site)
  check(slugs.include?('curated'),
        "curated tag must mint a feed page, got #{slugs.inspect}",)
  check(!slugs.include?('canary-only'),
        "canary-only tag must not mint a feed page, got #{slugs.inspect}",)
end

run('blank post tag names mint no feed while valid tags remain') do
  blank_object = Object.new
  def blank_object.to_s
    " \t"
  end
  posts = FakePosts.new([
    FakePostDoc.new({ 'tags' => ['Quotes', '', ' ', nil, blank_object] }),
    FakePostDoc.new({ 'tags' => [nil, "\n"] }),
  ])
  site = FakeSite.new(posts: posts)
  Jekyll::TagFeeds::Generator.new.generate(site)
  slugs = feed_slugs(site)
  check(slugs == ['quotes'], "expected only the quotes feed, got #{slugs.inspect}")
end

run('blank curated names mint no feed while nonblank curated names remain') do
  blank_object = Object.new
  def blank_object.to_s
    "\n "
  end
  tags = FakeCollection.new([
    FakePostDoc.new({ 'name' => '' }),
    FakePostDoc.new({ 'name' => '  ' }),
    FakePostDoc.new({ 'name' => nil }),
    FakePostDoc.new({ 'name' => blank_object }),
    FakePostDoc.new({ 'name' => 'Curated' }),
  ])
  site = FakeSite.new(posts: FakePosts.new([]), tags: tags)
  Jekyll::TagFeeds::Generator.new.generate(site)
  slugs = feed_slugs(site)
  check(slugs == ['curated'], "expected only the nonblank curated feed, got #{slugs.inspect}")
end

run('blank feed_exclude curated names do not add exclusions; valid exclusions still apply') do
  tags = FakeCollection.new([
    FakePostDoc.new({ 'name' => '' }),
    FakePostDoc.new({ 'name' => '  ', 'feed_exclude' => true }),
    FakePostDoc.new({ 'name' => nil }),
    FakePostDoc.new({ 'name' => 'Hidden', 'feed_exclude' => true }),
  ])
  posts = FakePosts.new([
    FakePostDoc.new({ 'tags' => ['', 'Visible'] }),
    FakePostDoc.new({ 'tags' => ['Hidden'] }),
  ])
  site = FakeSite.new(posts: posts, tags: tags)
  Jekyll::TagFeeds::Generator.new.generate(site)
  slugs = feed_slugs(site)
  excluded_names = Jekyll::ExcludeE2EPosts.excluded_tag_names(site)
  check(slugs == ['visible'], "expected only visible feed, got #{slugs.inspect}")
  check(excluded_names.none? { |name| name.to_s.strip.empty? },
        "blank curated names must not enter the exclusion list, got #{excluded_names.inspect}",)
end

run('feed_exclude only excludes when literally true (not a string)') do
  posts = FakePosts.new([
    FakePostDoc.new({ 'tags' => ['Stringy'], 'feed_exclude' => 'true' }),
  ])
  site = FakeSite.new(posts: posts)
  Jekyll::TagFeeds::Generator.new.generate(site)
  slugs = feed_slugs(site)
  check(slugs.include?('stringy'),
        "string 'true' must not exclude (only boolean true), got #{slugs.inspect}",)
end

run('FeedPage carries the atom_feed layout + sitemap:false marker') do
  posts = FakePosts.new([FakePostDoc.new({ 'tags' => ['Real Tag'] })])
  site = FakeSite.new(posts: posts)
  Jekyll::TagFeeds::Generator.new.generate(site)
  page = site.pages.first
  check(page.data['layout'] == 'atom_feed', "expected atom_feed layout, got #{page.data['layout'].inspect}")
  check(page.data['sitemap'] == false, "expected sitemap=false, got #{page.data['sitemap'].inspect}")
  check(page.data['permalink'] == '/tags/real-tag/feed.xml',
        "expected per-tag feed permalink, got #{page.data['permalink'].inspect}",)
end

run('tags differing only in case mint ONE feed page, named like the archive (#754)') do
  posts = FakePosts.new([
    FakePostDoc.new({ 'tags' => ['quotes'] }),
    FakePostDoc.new({ 'tags' => ['Quotes'] }),
    FakePostDoc.new({ 'tags' => ['Quotes'] }),
  ])
  site = FakeSite.new(posts: posts)
  Jekyll::TagFeeds::Generator.new.generate(site)
  check(site.pages.size == 1, "expected one feed page, got #{feed_slugs(site).inspect}")
  check(site.pages.first.data['tag_name'] == 'Quotes',
        "expected the most-used spelling, got #{site.pages.first.data['tag_name'].inspect}",)
  check(site.pages.first.data['permalink'] == '/tags/quotes/feed.xml',
        "expected one permalink, got #{site.pages.first.data['permalink'].inspect}",)
end

run('a case variant of an excluded _tags entry mints no feed (#754)') do
  tags = FakeCollection.new([FakePostDoc.new({ 'name' => 'E2E Canary', 'feed_exclude' => true })])
  posts = FakePosts.new([FakePostDoc.new({ 'tags' => ['e2e canary'] })])
  site = FakeSite.new(posts: posts, tags: tags)
  Jekyll::TagFeeds::Generator.new.generate(site)
  check(site.pages.empty?, "expected no feed pages, got #{feed_slugs(site).inspect}")
end

run('empty-slug post and curated names mint no feed') do
  invalid = ["\u00a0", '!!!', '🙂']
  tags = FakeCollection.new(invalid.map { |name| FakePostDoc.new({ 'name' => name }) })
  site = FakeSite.new(posts: FakePosts.new([FakePostDoc.new({ 'tags' => ['quotes', *invalid] })]), tags: tags)
  Jekyll::TagFeeds::Generator.new.generate(site)
  check(feed_slugs(site) == ['quotes'], 'empty-slug names must mint only the valid quotes feed')
end

run('empty-slug excluded names do not suppress valid feeds') do
  tags = FakeCollection.new(["\u00a0", '!!!', '🙂'].map { |name| FakePostDoc.new({ 'name' => name, 'feed_exclude' => true }) })
  site = FakeSite.new(posts: FakePosts.new([FakePostDoc.new({ 'tags' => ['quotes', '!!!'] })]), tags: tags)
  Jekyll::TagFeeds::Generator.new.generate(site)
  check(feed_slugs(site) == ['quotes'], 'empty-slug exclusions must not suppress quotes')
end

run('numeric and boolean tags mint string-slug feeds') do
  site = FakeSite.new(posts: FakePosts.new([FakePostDoc.new({ 'tags' => ['quotes', 2024, true] })]))
  Jekyll::TagFeeds::Generator.new.generate(site)
  check(feed_slugs(site).sort == ['2024', 'quotes', 'true'], 'scalar tags must mint their feeds')
end

# ── result ─────────────────────────────────────────────────────────────────

if @failures.empty?
  puts "tag_feeds: all #{@checks} checks passed across #{@runs} cases"
else
  warn "tag_feeds: #{@failures.length} failure(s) across #{@runs} cases and #{@checks} checks"
  @failures.each { |m| warn "  - #{m}" }
  exit 1
end
