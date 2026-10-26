# frozen_string_literal: true

#
# Unit tests for lib/cms-platform-theme/auto_tag_pages.rb. Run with:
#
#   ruby spec/auto_tag_pages_test.rb
#
# Same conventions as exclude_e2e_posts_test.rb — kept outside lib/ so
# Jekyll doesn't auto-load it. The plugin's Jekyll-integration path is
# guarded behind `defined?(Jekyll::Generator)` so loading without Jekyll
# only registers the pure `summarise` helper.

require_relative '../lib/cms-platform-theme/auto_tag_pages'

# Jekyll::Utils.slugify's "default" mode without loading Jekyll — the shared,
# golden-tested port (support/jekyll_slugify.rb).
require_relative 'support/jekyll_slugify'
SLUGIFY = ->(name) { raise TypeError, 'slugify requires String' unless name.is_a?(String); SpecJekyllSlugify.slugify(name) }

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

# ── cases ──────────────────────────────────────────────────────────────────

run('tags-only-in-posts are flagged as missing') do
  curated = [{ 'name' => 'Python', 'description' => 'Snakes' }]
  posts = [['Python', 'AI Engineering'], ['RAG']]
  missing, _all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts, slugify: SLUGIFY,
  )
  check(missing.sort == ['AI Engineering', 'RAG'].sort,
        "expected AI Engineering + RAG missing, got #{missing.inspect}",)
end

run('curated tags never marked missing even when no post uses them') do
  curated = [{ 'name' => 'LangChain' }, { 'name' => 'Python' }]
  posts = [['Python']]
  missing, = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts, slugify: SLUGIFY,
  )
  check(missing.empty?,
        "expected no missing tags, got #{missing.inspect}",)
end

run('all_tags is sorted case-insensitively and deduplicated') do
  curated = [{ 'name' => 'rag' }, { 'name' => 'LangChain' }]
  posts = [['Python', 'LangChain'], ['Best Practices']]
  _missing, all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts, slugify: SLUGIFY,
  )
  names = all.map { |t| t['name'] }
  check(names == ['Best Practices', 'LangChain', 'Python', 'rag'],
        "expected case-insensitive sorted unique list, got #{names.inspect}",)
end

run('count reflects how many post tag-lists reference each name') do
  curated = []
  posts = [
    ['Python', 'RAG'],
    ['Python'],
    ['Best Practices'],
    [],
  ]
  _missing, all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts, slugify: SLUGIFY,
  )
  by_name = all.to_h { |t| [t['name'], t['count']] }
  check(by_name['Python'] == 2,
        "expected Python count=2, got #{by_name['Python']}",)
  check(by_name['RAG'] == 1,
        "expected RAG count=1, got #{by_name['RAG']}",)
  check(by_name['Best Practices'] == 1,
        "expected Best Practices count=1, got #{by_name['Best Practices']}",)
end

run('description carries through from curated entry') do
  curated = [{ 'name' => 'Python', 'description' => 'Programming language' }]
  posts = [['Python', 'AI Engineering']]
  _missing, all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts, slugify: SLUGIFY,
  )
  py = all.find { |t| t['name'] == 'Python' }
  ai = all.find { |t| t['name'] == 'AI Engineering' }
  check(py['description'] == 'Programming language',
        "expected Python description from curated entry, got #{py['description'].inspect}",)
  check(ai['description'].nil?,
        'expected AI Engineering description=nil (no curated entry), ' \
        "got #{ai['description'].inspect}",)
end

run('url uses slugified name regardless of case/punctuation') do
  curated = []
  posts = [['AI Engineering', 'C++ Tricks', 'RAG']]
  _missing, all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts, slugify: SLUGIFY,
  )
  by_name = all.to_h { |t| [t['name'], t['url']] }
  check(by_name['AI Engineering'] == '/tags/ai-engineering/',
        "expected /tags/ai-engineering/, got #{by_name['AI Engineering'].inspect}",)
  check(by_name['C++ Tricks'] == '/tags/c-tricks/',
        "expected /tags/c-tricks/, got #{by_name['C++ Tricks'].inspect}",)
  check(by_name['RAG'] == '/tags/rag/',
        "expected /tags/rag/, got #{by_name['RAG'].inspect}",)
end

run('empty inputs produce empty outputs without raising') do
  missing, all = Jekyll::AutoTagPages.summarise(
    curated: [], post_tag_lists: [], slugify: SLUGIFY,
  )
  check(missing.empty? && all.empty?,
        "expected empty outputs, got missing=#{missing.inspect}, all=#{all.inspect}",)
end

run('nil and empty post tag lists are tolerated and blank names are ignored') do
  curated = [{ 'name' => 'Python' }]
  blank_object = Object.new
  def blank_object.to_s
    " \t"
  end
  posts = [nil, [], ['Python', nil], ['', ' ', "\t", blank_object]]
  missing, all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts.map { |p| Array(p) }, slugify: SLUGIFY,
  )
  check(missing.empty? && all == [{
    'name' => 'Python', 'slug' => 'python', 'url' => '/tags/python/',
    'description' => nil, 'count' => 1,
  }], "expected only Python with count=1 and no missing tags, got missing=#{missing.inspect}, all=#{all.inspect}")
  check(missing.is_a?(Array),
        'expected missing to be an Array',)
end

run('blank curated names are ignored even when the curated list has only blanks') do
  blank_object = Object.new
  def blank_object.to_s
    "\n "
  end
  missing, all = Jekyll::AutoTagPages.summarise(
    curated: [{ 'name' => '' }, { 'name' => '  ' }, { 'name' => nil }, { 'name' => blank_object }],
    post_tag_lists: [], slugify: SLUGIFY,
  )
  check(missing.empty? && all.empty?,
        "expected blank curated names to contribute nothing, got missing=#{missing.inspect}, all=#{all.inspect}",)
end

run('tags differing only in case are one tag: one row, one missing name, combined count (#754)') do
  posts = [['quotes'], ['Quotes'], ['Quotes', 'RAG']]
  missing, all = Jekyll::AutoTagPages.summarise(
    curated: [], post_tag_lists: posts, slugify: SLUGIFY,
  )
  check(all.map { |t| t['slug'] } == ['quotes', 'rag'],
        "expected one row per slug, got #{all.inspect}",)
  quotes = all.find { |t| t['slug'] == 'quotes' }
  check(quotes['count'] == 3, "expected combined count=3, got #{quotes['count']}")
  check(quotes['url'] == '/tags/quotes/', "expected /tags/quotes/, got #{quotes['url']}")
  check(missing.sort == ['Quotes', 'RAG'],
        "expected ONE missing name per slug (one page to mint), got #{missing.inspect}",)
end

run('display name: the most-used spelling, a tie going to the one seen first (#754)') do
  most_used = Jekyll::AutoTagPages.summarise(
    curated: [], post_tag_lists: [['quotes'], ['Quotes'], ['Quotes']], slugify: SLUGIFY,
  ).last.first['name']
  check(most_used == 'Quotes', "expected the most-used spelling Quotes, got #{most_used.inspect}")
  tie = Jekyll::AutoTagPages.summarise(
    curated: [], post_tag_lists: [['quotes'], ['Quotes']], slugify: SLUGIFY,
  ).last.first['name']
  check(tie == 'quotes', "expected the first-seen spelling on a tie, got #{tie.inspect}")
end

run('a curated name wins the display name and its slug is never missing (#754)') do
  curated = [{ 'name' => 'Release', 'description' => 'Ships' }]
  missing, all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: [['release'], ['release']], slugify: SLUGIFY,
  )
  check(missing.empty?, "the _tags/ entry already serves the slug, got missing=#{missing.inspect}")
  check(all.size == 1 && all.first['name'] == 'Release' && all.first['count'] == 2,
        "expected one Release row with count=2, got #{all.inspect}",)
  check(all.first['description'] == 'Ships',
        "expected the entry's description, got #{all.first['description'].inspect}",)
end

run('a post carrying both spellings counts once (#754)') do
  _missing, all = Jekyll::AutoTagPages.summarise(
    curated: [], post_tag_lists: [['quotes', 'Quotes']], slugify: SLUGIFY,
  )
  check(all.size == 1 && all.first['count'] == 1, "expected one row, count=1, got #{all.inspect}")
end

run('posts_by_slug ignores blank names and preserves valid names on the same post') do
  doc = Struct.new(:data)
  a = doc.new({ 'tags' => ['quotes'] })
  b = doc.new({ 'tags' => ['Quotes', 'quotes', 'RAG'] })
  c = doc.new({})
  blank_object = Object.new
  def blank_object.to_s
    '  '
  end
  d = doc.new({ 'tags' => ['', ' ', nil, blank_object, 'Useful'] })
  e = doc.new({ 'tags' => [nil, "\t"] })
  slugified = []
  slugify = ->(name) { slugified << name; SLUGIFY.call(name) }
  index = Jekyll::AutoTagPages.posts_by_slug([a, b, c, d, e], slugify: slugify)
  check(index.keys == ['quotes', 'rag', 'useful'], "expected quotes + rag + useful, got #{index.keys.inspect}")
  check(index['quotes'].equal?(index['quotes']) && index['quotes'] == [a, b],
        'expected [a, b] under quotes, each once',)
  check(index['rag'] == [b], 'expected [b] under rag')
  check(index['useful'] == [d], 'expected the valid tag to remain indexed')
  check(!slugified.any? { |name| name.to_s.strip.empty? },
        "expected blank tag names not to be slugified, got #{slugified.inspect}",)
  check(!index.key?(''), "expected no blank slug key, got #{index.keys.inspect}")
end

run('empty slugs are ignored in grouping and indexing') do
  invalid = ["\u00a0", '!!!', '🙂']
  groups = Jekyll::AutoTagPages.group(curated_names: invalid, post_tag_lists: [['quotes', *invalid]], slugify: SLUGIFY)
  check(groups.keys == ['quotes'], "expected only quotes group, got #{groups.keys.inspect}")
  missing, all = Jekyll::AutoTagPages.summarise(curated: invalid.map { |name| { 'name' => name } }, post_tag_lists: [['quotes', *invalid]], slugify: SLUGIFY)
  check(missing == ['quotes'] && all.map { |tag| tag['slug'] } == ['quotes'], 'empty-slug names must not contribute rows or missing archives')
  doc = Struct.new(:data).new({ 'tags' => ['quotes', *invalid] })
  index = Jekyll::AutoTagPages.posts_by_slug([doc], slugify: SLUGIFY)
  check(index.keys == ['quotes'] && index['quotes'] == [doc], 'empty slugs must not be indexed')
end

run('numeric and boolean names reach slugify as strings') do
  groups = Jekyll::AutoTagPages.group(curated_names: [2024, true], post_tag_lists: [['quotes', 2024, true]], slugify: SLUGIFY)
  check(groups.keys == ['2024', 'true', 'quotes'], 'scalar names must group under their string slugs')
  doc = Struct.new(:data).new({ 'tags' => ['quotes', 2024, true] })
  check(Jekyll::AutoTagPages.posts_by_slug([doc], slugify: SLUGIFY).keys == ['quotes', '2024', 'true'], 'scalar names must be indexed')
  check(!Jekyll::ExcludeE2EPosts.e2e_tag_name?(2024, slugify: SLUGIFY), 'numeric tag is not an e2e fixture')
end

# ── result ─────────────────────────────────────────────────────────────────

if @failures.empty?
  puts "auto_tag_pages: all #{@checks} checks passed across #{@runs} cases"
else
  warn "auto_tag_pages: #{@failures.length} failure(s) across #{@runs} cases and #{@checks} checks"
  @failures.each { |m| warn "  - #{m}" }
  exit 1
end
