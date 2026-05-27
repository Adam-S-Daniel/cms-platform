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
# The hash is read from the source tree (not _site) so it works in
# every Jekyll phase. It silently degrades to the bare path if the
# file is missing, so layouts don't crash on a typo'd path.

require 'digest'

module Jekyll
  module CachebustFilter
    def cachebust(input)
      return input if input.nil? || input.empty?

      site = @context.registers[:site]
      base = site.config['baseurl'].to_s
      # Strip baseurl + leading slash to resolve against the source tree.
      relative = input.sub(/^#{Regexp.escape(base)}/, '').sub(%r{^/}, '')
      file_path = File.join(site.source, relative)
      url = File.join(base, '/', relative)
      return url unless File.file?(file_path)

      digest = Digest::SHA1.hexdigest(File.read(file_path))[0, 8]
      "#{url}?v=#{digest}"
    end
  end
end

Liquid::Template.register_filter(Jekyll::CachebustFilter)
