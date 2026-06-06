# frozen_string_literal: true

#
# Sveltia CMS saves `slug: ''` (empty string) to front matter when the
# editor leaves the URL Slug field blank, rather than omitting the key.
# Jekyll's `:slug` permalink placeholder reads the literal empty string
# and serves the post at `/blog//`, breaking the round-trip between the
# CMS's preview_path template (which correctly falls back to the title
# and so produces e.g. `/blog/test-1/`) and Jekyll's output URL.
#
# Jekyll's built-in fallback when `slug` is absent is the full basename
# including the `YYYY-MM-DD-` prefix, which would land the post at
# `/blog/2026-04-21-test-1/` — also not what the CMS advertises.
#
# This hook replaces empty/whitespace slug values with the filename
# basename minus the date prefix, matching the slug the CMS used when
# it built the filename in the first place. Non-empty slugs (authors
# setting a custom URL) are left alone.
#
# Unit tests: spec/normalize_empty_slug_test.rb

module Jekyll
  module NormalizeEmptySlug
    DATE_PREFIX = /\A\d{4}-\d{2}-\d{2}-/

    # `doc` is anything with `.data` (a Hash) and `.relative_path` (a String).
    # StaticFiles and other oddballs without `.data` are ignored.
    def self.apply(doc)
      return unless doc.respond_to?(:data) && doc.data.is_a?(Hash)
      return unless doc.data.key?('slug')

      slug = doc.data['slug']
      return unless slug.is_a?(String) && slug.strip.empty?

      derived = derive_from_path(doc)
      if derived && !derived.empty?
        doc.data['slug'] = derived
      else
        # Can't derive (unexpected shape) — delete the key so Jekyll's own
        # fallback kicks in rather than leaving `slug: ''` in place.
        doc.data.delete('slug')
      end
    end

    def self.derive_from_path(doc)
      return nil unless doc.respond_to?(:relative_path)

      path = doc.relative_path
      return nil unless path.is_a?(String) && !path.empty?

      basename = File.basename(path, File.extname(path))
      basename.sub(DATE_PREFIX, '')
    end
  end
end

# Register the hook only when Jekyll is actually loaded — the unit test
# require_relatives this file without Jekyll on the load path.
#
# :post_read fires once per site, after every collection has been read
# and front matter parsed, but before URL generation. This is the right
# moment: `doc.data['slug']` is populated, and nothing downstream has
# baked the empty value into a URL yet.
if defined?(Jekyll::Hooks)
  Jekyll::Hooks.register :site, :post_read do |site|
    site.documents.each { |doc| Jekyll::NormalizeEmptySlug.apply(doc) }
  end
end
