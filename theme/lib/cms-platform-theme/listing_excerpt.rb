# frozen_string_literal: true

#
# Liquid filter `listing_excerpt` — a post's excerpt, safe to print in a
# LISTING (the tag archive here; a site's home page and blog index).
#
#   <p class="post-excerpt">{{ post | listing_excerpt }}</p>
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
#   * A TYPED excerpt (front matter) is text. It is HTML-escaped with Ruby's
#     own `CGI.escapeHTML`, nothing else.
#   * A CUT excerpt (from the body) keeps the formatting a summary needs and
#     loses everything else. That is HTML sanitizing, and it is done by the
#     Sanitize gem (https://github.com/rgrove/sanitize), not by code here: the
#     owner's rule is an established library for this, never a hand-rolled
#     filter. Sanitize parses with Nokogiri's HTML5 parser, the same algorithm
#     a browser uses, so what it judges is what the browser will build. This
#     file holds only the allowlist, as Sanitize configuration (EXCERPT below).
#
# Kept: paragraphs, block quotes, line breaks, emphasis, strong, inline
# code, links (`href` only: http, https, mailto or a relative address) and
# images (`src` on http, https or a relative address, plus `alt`). An element
# that is not on the list is removed and its text kept (<div>, <span>,
# <details>, a heading, a list). Lists are NOT kept on purpose: a listing is
# itself a list, and an `<li>` in an excerpt closes the listing's own item in
# a browser (the HTML parser's rule for `li`), so one post's excerpt split
# into extra rows of the list. Its text stays. Removed WITH their contents: script, style, iframe,
# object, embed, svg, math, video, audio, canvas, template, noscript, form
# controls and the head-only elements. Every other attribute goes: `style`,
# `class`, `id`, `on…`. Comments go.
#
# Which kind an excerpt is cannot be told from `post.excerpt` in Liquid (both
# are strings by then), so a `:site, :post_read` hook marks each document whose
# front matter (or a `_config.yml` default) set `excerpt:` with
# `excerpt_typed: true`, and the filter takes the POST, not its excerpt. Given
# a bare string it treats it as cut markup: reading it as text would
# double-escape a rendered excerpt, and both readings are safe.

require 'cgi'
require 'sanitize'

module Jekyll
  module ListingExcerpt
    # The allowlist, in Sanitize's own terms. Anything not named here is not
    # printed. `:relative` is Sanitize's token for an address with no scheme.
    EXCERPT = Sanitize::Config.freeze_config(
      elements: %w[p blockquote br em strong b i code a img],
      attributes: {
        'a' => %w[href],
        'img' => %w[src alt],
      },
      protocols: {
        'a' => { 'href' => ['http', 'https', 'mailto', :relative] },
        'img' => { 'src' => ['http', 'https', :relative] },
      },
      allow_comments: false,
      allow_doctype: false,
      remove_contents: %w[
        script style iframe object embed svg math video audio canvas template
        noscript form input button select textarea title head frame frameset
        applet
      ],
      whitespace_elements: {}
    )

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
      Sanitize.fragment(html, EXCERPT).strip
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
    # Always set, never only to true: a post's own `excerpt_typed:` front
    # matter must not decide how its excerpt is read.
    doc.data['excerpt_typed'] = doc.data['excerpt'].is_a?(String)
  end
end
