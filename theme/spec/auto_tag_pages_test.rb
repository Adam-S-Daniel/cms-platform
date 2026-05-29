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

# Mirror Jekyll::Utils.slugify's "default" mode for our test fixtures
# (lowercase, non-alphanumeric runs collapsed to a single dash, trimmed).
SLUGIFY = lambda { |name|
  name.to_s.downcase.gsub(/[^a-z0-9]+/, '-').sub(/\A-+/, '').sub(/-+\z/, '')
}

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

run('nil and empty post tag lists are tolerated') do
  curated = [{ 'name' => 'Python' }]
  posts = [nil, [], ['Python', nil], ['']]
  missing, all = Jekyll::AutoTagPages.summarise(
    curated: curated, post_tag_lists: posts.map { |p| Array(p) }, slugify: SLUGIFY,
  )
  # Empty string is technically a "tag" — treated as a separate entry. The
  # important invariant is that we don't crash and Python is found.
  check(all.any? { |t| t['name'] == 'Python' && t['count'] == 1 },
        "expected Python with count=1, got #{all.inspect}",)
  check(missing.is_a?(Array),
        'expected missing to be an Array',)
end

# ── result ─────────────────────────────────────────────────────────────────

if @failures.empty?
  puts 'auto_tag_pages: all 8 checks passed'
else
  warn "auto_tag_pages: #{@failures.length} failure(s)"
  @failures.each { |m| warn "  - #{m}" }
  exit 1
end
