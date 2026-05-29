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
    # Mirror slugify's "default" mode well enough for these fixtures.
    def self.slugify(name)
      name.to_s.downcase.gsub(/[^a-z0-9]+/, '-').sub(/\A-+/, '').sub(/-+\z/, '')
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

def check(condition, message)
  @failures << message unless condition
end

def run(label)
  yield
rescue StandardError => e
  @failures << "#{label}: raised #{e.class}: #{e.message}"
end

# Pull the slugs that the generator decided to mint a feed page for.
def feed_slugs(site)
  site.pages.map { |p| Jekyll::Utils.slugify(p.data['tag_name']) }
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

# ── result ─────────────────────────────────────────────────────────────────

if @failures.empty?
  puts 'tag_feeds: all 5 checks passed'
else
  warn "tag_feeds: #{@failures.length} failure(s)"
  @failures.each { |m| warn "  - #{m}" }
  exit 1
end
