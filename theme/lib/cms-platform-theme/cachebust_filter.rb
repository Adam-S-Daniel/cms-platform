# frozen_string_literal: true

#
# Liquid filter `cachebust` — appends a short content-hash query string
# to a site-relative asset path so browsers re-fetch when the file's
# bytes change, but keep the cached copy when they don't.
#
# Usage in templates:
#   <link rel="stylesheet" href="{{ '/assets/css/main.css' | cachebust }}">
#
# Why a filter and not fingerprinted filenames: this site has one CSS
# file and a couple of JS files. Filename fingerprinting would require
# rewriting references at build time and a sync rule for the produced
# files; a hash query string is functionally equivalent for cache
# invalidation purposes (the browser keys cache entries by full URL
# including query) and adds zero build complexity.
#
# The hash is read from the site source — or, for a gem theme, from the
# theme gem's own asset tree (site.theme.root), since assets/ then lives
# in the gem rather than the consuming site — so it works in every Jekyll
# phase. It silently degrades to the bare path if the file is missing in
# both, so layouts don't crash on a typo'd path.

require 'digest'

module Jekyll
  module CachebustFilter
    def cachebust(input)
      return input if input.nil? || input.empty?

      site = @context.registers[:site]
      base = site.config['baseurl'].to_s
      # Strip baseurl + leading slash to resolve against the source tree.
      relative = input.sub(/^#{Regexp.escape(base)}/, '').sub(%r{^/}, '')
      url = File.join(base, '/', relative)
      # Resolve against the SITE source first; for a gem theme the asset
      # lives under the gem (site.theme.root), not the consuming site —
      # fall back there so cache-busting keeps working for gem-provided
      # assets (a bare path = no busting, which the dogfood surfaced).
      file_path = File.join(site.source, relative)
      unless File.file?(file_path)
        theme = site.respond_to?(:theme) ? site.theme : nil
        theme_root = theme && theme.respond_to?(:root) ? theme.root : nil
        candidate = theme_root ? File.join(theme_root, relative) : nil
        file_path = candidate if candidate && File.file?(candidate)
      end
      return url unless File.file?(file_path)

      digest = Digest::SHA1.hexdigest(File.read(file_path))[0, 8]
      "#{url}?v=#{digest}"
    end
  end
end

Liquid::Template.register_filter(Jekyll::CachebustFilter)
