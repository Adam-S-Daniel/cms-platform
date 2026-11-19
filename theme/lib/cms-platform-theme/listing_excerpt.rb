# frozen_string_literal: true

#
# Liquid filter `listing_excerpt` — a post's excerpt, safe to print in a
# LISTING (the tag archive here; a site's home page and blog index).
#
#   <div class="post-excerpt">{{ post | listing_excerpt }}</div>
#
# WHY (#1067). A listing prints many posts' excerpts into one page, so an
# excerpt is one post's content landing on a page that is not that post's. It
# was printed raw, as "HTML the post's own Markdown produced". Two things made
# that wrong:
#
#   * The editor's Excerpt field is plain text (`widget: text`), and Jekyll
#     returns a front-matter `excerpt:` exactly as typed. An excerpt that only
#     MENTIONS a tag ("Why I stopped using <script async> tags") opened that
#     element on the home page, the blog index and every tag archive, and the
#     page lost every post after it, the tag cloud and the footer.
#   * An excerpt Jekyll cuts from the body is the post's first block, rendered.
#     A post that opens with a <style> block, a <script> or an embed put that
#     on every listing page too: one post's CSS and JavaScript ran site-wide.
#
# THE RULE.
#   * A TYPED excerpt (front matter) is text. It is HTML-escaped, nothing else.
#   * A CUT excerpt (from the body) keeps the formatting a summary needs and
#     loses everything else. It is parsed with kramdown's HTML parser (kramdown
#     is Jekyll's own Markdown engine, so this adds no dependency), reduced to
#     an allowlist of element types, and written back out by kramdown's HTML
#     converter, which escapes every text node and attribute value. The output
#     is built from the allowlisted tree and never from the input string, so
#     nothing that is not on the list can reach the page however the input is
#     spelled.
#
# Kept: paragraphs, block quotes, lists, line breaks, emphasis, strong, inline
# code, links (`href` only, and only http, https, mailto or a site path) and
# images (`src` on the same rule, plus `alt`). Wrappers that are not on the
# list (<div>, <span>, <details>, a heading) are unwrapped: their text stays.
# Dropped with their contents: script, style, iframe, object, embed, svg,
# video, audio, canvas, form controls, <base>, <link>, <meta>, comments and
# raw blocks. Every other attribute goes: `style`, `class`, `id`, `on…`.
#
# If the excerpt cannot be parsed, the fallback is its text with every tag
# removed, escaped. A listing never gets raw markup.
#
# Which kind an excerpt is cannot be told from `post.excerpt` in Liquid (both
# are strings by then), so a `:site, :post_read` hook marks each document whose
# front matter (or a `_config.yml` default) set `excerpt:` with
# `excerpt_typed: true`, and the filter takes the POST, not its excerpt. Given
# a bare string it treats it as cut markup: the stricter reading of "is this
# text?" would double-escape a rendered excerpt, and both are safe.

require 'cgi'
require 'kramdown'

module Jekyll
  module ListingExcerpt
    # kramdown element types written back out as they are.
    KEEP = %i[
      root p blockquote ul ol li br blank text entity smart_quote typographic_sym
      em strong codespan a img
    ].freeze

    # Elements removed WITH their contents. Anything else that is not in KEEP
    # is unwrapped (its children are kept).
    DROP_HTML = %w[
      script style iframe object embed svg math video audio canvas template
      noscript form input button select textarea base link meta title head
      frame frameset applet
    ].freeze

    SAFE_URL = %r{\A(?:https?://|mailto:|/(?!/)|\#|\./|\.\./|[A-Za-z0-9_-][^:]*\z)}i.freeze

    module_function

    def typed?(post)
      post.respond_to?(:[]) && !post.is_a?(String) && post['excerpt_typed'] == true
    end

    def excerpt_of(post)
      return post if post.is_a?(String)
      return '' unless post.respond_to?(:[])

      post['excerpt'].to_s
    end

    def render(post)
      text = excerpt_of(post)
      return '' if text.strip.empty?
      return CGI.escapeHTML(text.strip) if typed?(post)

      sanitize(text)
    end

    def sanitize(html)
      doc = Kramdown::Document.new(html, input: 'html', html_to_native: true, auto_ids: false)
      doc.root.children = filter(doc.root.children)
      doc.to_html.strip
    rescue StandardError
      CGI.escapeHTML(html.gsub(/<[^>]*>?/m, ' ').gsub(/\s+/, ' ').strip)
    end

    def filter(children)
      children.flat_map { |el| filter_element(el) }
    end

    def filter_element(el)
      case el.type
      when :html_element
        return [] if DROP_HTML.include?(el.value.to_s.downcase)

        filter(el.children)
      when :a
        href = el.attr['href'].to_s.strip
        el.children = filter(el.children)
        return el.children unless SAFE_URL.match?(href)

        el.attr.replace('href' => href)
        [el]
      when :img
        src = el.attr['src'].to_s.strip
        return [] unless SAFE_URL.match?(src)

        el.attr.replace('src' => src, 'alt' => el.attr['alt'].to_s)
        [el]
      when *KEEP
        el.attr.clear
        el.children = filter(el.children)
        [el]
      when :header, :codeblock, :hr, :table, :thead, :tbody, :tfoot, :tr, :td, :dl, :dt, :dd, :abbreviation, :footnote
        el.type == :codeblock ? [Kramdown::Element.new(:text, el.value.to_s)] : filter(el.children)
      else
        # :raw, :comment, :xml_comment, :xml_pi, :html_doctype, :math and any
        # type a later kramdown adds: not on the list.
        []
      end
    end
  end

  module ListingExcerptFilter
    def listing_excerpt(post)
      Jekyll::ListingExcerpt.render(post)
    end
  end
end

Liquid::Template.register_filter(Jekyll::ListingExcerptFilter)

Jekyll::Hooks.register :site, :post_read do |site|
  site.documents.each do |doc|
    doc.data['excerpt_typed'] = true if doc.data['excerpt'].is_a?(String)
  end
end
