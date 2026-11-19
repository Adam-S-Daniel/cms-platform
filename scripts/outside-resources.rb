#!/usr/bin/env ruby
# frozen_string_literal: true

# Fail when a built page loads something from another site.
#
#   bundle exec jekyll build
#   bundle exec ruby outside-resources.rb [site-dir]
#
# WHY. The owner's rule (2026-11-19): a page on these sites loads nothing from
# another host. No outside script, frame, plugin, video, stylesheet, font or
# image; the public Content-Security-Policy in
# infrastructure/bootstrap/template.yaml enforces exactly that in the reader's
# browser. A policy blocks silently: the post publishes green and the embed is
# simply blank. This check is the same rule at publish time, where the author
# can still act on it, with a line naming the page and the address.
#
# It is also the cheap half of "one post cannot break the pages around it"
# (cms-platform issue 1067): a `<base>` element pasted into a post body sent
# every menu link on that page to another site, and nothing caught it.
#
# WHAT IT READS. The BUILT site, never the source: every `.html` file under
# the site's destination except two folders that carry their own policy:
# `admin/` (the editor; it loads Decap from a pinned CDN) and `assets/tools/`
# (a site's embedded tool apps, whole applications the site vendors, which may
# fetch live data: adamdaniel.ai's evals explorer reads its results from
# GitHub). Posts, pages and every listing are read. Each file is parsed with Nokogiri's HTML5
# parser, the algorithm a browser uses, so what is judged is the tree the
# browser builds; nothing here matches markup with a regex. Nokogiri reaches a
# site's bundle through the theme gem's `sanitize` dependency.
#
# WHAT COUNTS AS A LOAD. The elements and attributes in LOADS below: things a
# browser fetches or submits to by itself when it renders the page. A link the
# reader may click (`<a href>`) is not one. For `<link>`, only the `rel` values
# that fetch (a stylesheet, a preload, an icon, a manifest); `canonical`,
# `alternate` and `me` name another page and fetch nothing.
#
# WHAT COUNTS AS THIS SITE. An address with no host (relative, or `#frag`), or
# an http(s) address whose host is the `url:` host in `_config.yml`. `data:` is
# allowed where the policy allows it (images, fonts through CSS are not read
# here); `blob:` and `about:` name no other site. Anything else is a finding:
# another host, a protocol-relative `//host`, or a scheme such as
# `javascript:` in a place that loads.
#
# Two elements are findings wherever they appear in a page body or head with
# an outside target, because their effect is page-wide: `<base href>` (ANY
# value; the theme never emits one) and `<meta http-equiv="refresh">` that
# sends the reader to another host.
#
# NOT COVERED: an `@import` or `url()` inside CSS (a `<style>` block or a
# `style=` attribute), and anything a script fetches at run time. The browser policy covers both; this check is the early
# warning for what an author writes, which is markup.
#
# Exit 0 clean (or no built site to read), 1 on any finding or if the site
# cannot be read.

require "date"
require "json"
require "yaml"
require "addressable/uri"

# element => attributes that load. `srcset` is a list; the rest are one address.
# Elements are matched by local name, so an SVG <image> or <use> inside an
# inline <svg> counts, and so does `xlink:href` (its local name is `href`).
LOADS = {
  "script" => %w[src],
  "iframe" => %w[src],
  "frame" => %w[src],
  "embed" => %w[src],
  "object" => %w[data],
  "video" => %w[src poster],
  "audio" => %w[src],
  "source" => %w[src srcset],
  "track" => %w[src],
  "img" => %w[src srcset],
  "image" => %w[href],
  "use" => %w[href],
  "input" => %w[src],
  "form" => %w[action],
  "body" => %w[background],
  "table" => %w[background],
  "tr" => %w[background],
  "td" => %w[background],
  "th" => %w[background],
}.freeze

# `rel` tokens of a <link> that make the browser fetch its `href`.
FETCHING_RELS = %w[
  stylesheet preload modulepreload prefetch prerender icon apple-touch-icon
  apple-touch-icon-precomposed mask-icon manifest
].freeze

# Folders of the built site that carry their own policy (see the header).
SKIPPED = %w[admin/ assets/tools/].freeze

# `rel` tokens that fetch something other than an image. A <link> with none of
# these is an icon link, which the policy's `img-src` governs.
NON_IMAGE_RELS = %w[stylesheet preload modulepreload prefetch prerender manifest].freeze

# Elements whose address may be a `data:` URI (the policy's `img-src data:`
# covers an image, a video poster, an SVG image and an icon link; a stylesheet
# or preload link is NOT on it).
DATA_OK = %w[img source image video link-icon].freeze

def site_host(config)
  url = config.is_a?(Hash) ? config["url"].to_s.strip : ""
  return nil if url.empty?

  Addressable::URI.parse(url).host&.downcase
rescue Addressable::URI::InvalidURIError
  nil
end

# An address as a browser reads it before resolving it (the URL Standard's
# first steps): leading and trailing C0 controls and spaces go, every tab and
# newline goes wherever it is, and a backslash is a slash. Without this
# `\\host/x`, `/\host/x` and `ht<tab>tps://host/x` read as relative here and
# as another host in the browser.
def normalize(address)
  address.to_s.gsub(/[\t\r\n]/, "").gsub(/\A[\u0000-\u0020]+|[\u0000-\u0020]+\z/, "").tr("\\", "/")
end

# :same, or a short reason the address is not this site's.
def judge(address, element, host)
  value = normalize(address)
  return :same if value.empty? || value.start_with?("#")
  return "a protocol-relative address names another host" if value.start_with?("//")

  scheme = value[/\A([A-Za-z][A-Za-z0-9+.-]*):/, 1]&.downcase
  return :same if scheme.nil?
  return :same if %w[blob about].include?(scheme)
  return :same if scheme == "data" && DATA_OK.include?(element)
  return "the #{scheme}: scheme is not allowed here" unless %w[http https].include?(scheme)

  # Addressable, not Ruby's URI: URI.parse refuses addresses a browser
  # accepts (a space, a non-ASCII letter, a `|`), and each refusal would fail
  # a publish that is fine.
  target = begin
    Addressable::URI.parse(value).host&.downcase
  rescue Addressable::URI::InvalidURIError
    nil
  end
  return "the address does not parse" if target.nil? || target.empty?
  return :same if host && target == host

  "it is on another host"
end

def srcset_addresses(value)
  value.to_s.split(",").map { |candidate| candidate.strip.split(/\s+/).first }.compact
end

# `5; url=/x`, `5;URL='/x'` and the bare `5; /x` all name a target.
def refresh_target(content)
  content.to_s[/\A\s*[\d.]*\s*[;,]\s*(?:url\s*=\s*)?['"]?([^'"]+)/i, 1]&.strip
end

# attribute local name => value, so `xlink:href` is found as `href`.
def attributes_of(node)
  node.attribute_nodes.each_with_object({}) { |a, h| h[a.name.downcase] ||= a.value }
end

def findings_in(doc, host)
  found = []
  doc.xpath("//*").each do |node|
    element = node.name.downcase
    attrs = attributes_of(node)

    (LOADS[element] || []).each do |attribute|
      next unless attrs.key?(attribute)

      addresses = attribute == "srcset" ? srcset_addresses(attrs[attribute]) : [attrs[attribute]]
      addresses.each do |address|
        verdict = judge(address, element, host)
        found << ["<#{element} #{attribute}>", address, verdict] unless verdict == :same
      end
    end

    case element
    when "link"
      rels = attrs["rel"].to_s.downcase.split
      unless (rels & FETCHING_RELS).empty?
        addresses = []
        addresses << attrs["href"] if attrs.key?("href")
        addresses.concat(srcset_addresses(attrs["imagesrcset"])) if attrs.key?("imagesrcset")
        kind = (rels & NON_IMAGE_RELS).empty? ? "link-icon" : "link"
        addresses.each do |address|
          verdict = judge(address, kind, host)
          found << ["<link rel=#{rels.join(' ')}>", address, verdict] unless verdict == :same
        end
      end
    when "base"
      if attrs.key?("href")
        found << ["<base href>", attrs["href"], "a <base> element redirects every relative link on the page"]
      end
    when "meta"
      if attrs["http-equiv"].to_s.strip.casecmp?("refresh") && (target = refresh_target(attrs["content"]))
        verdict = judge(target, "meta", host)
        found << ["<meta http-equiv=refresh>", target, verdict] unless verdict == :same
      end
    when "iframe"
      # A srcdoc is a whole document the frame renders: read it the same way.
      if attrs.key?("srcdoc")
        inner = Nokogiri::HTML5.parse(attrs["srcdoc"].to_s, max_tree_depth: -1)
        findings_in(inner, host).each { |what, address, why| found << ["<iframe srcdoc> #{what}", address, why] }
      end
    end
  end
  found
end

def page_address(relative)
  path = "/#{relative}"
  path.end_with?("/index.html") ? path.delete_suffix("index.html") : path
end

if $PROGRAM_NAME == __FILE__
  begin
    require "nokogiri"

    root = File.expand_path(ARGV[0] || ".")
    config_path = File.join(root, "_config.yml")
    # Jekyll's own loader accepts dates, times and symbols in `_config.yml`
    # (`launched: 2024-01-01`), so this must too: refusing one would fail
    # every publish on a site whose config is valid.
    config = if File.file?(config_path)
               YAML.safe_load(File.read(config_path), permitted_classes: [Date, Time, Symbol], aliases: true)
             else
               {}
             end
    config = {} unless config.is_a?(Hash)
    destination = File.expand_path(config["destination"].to_s.empty? ? "_site" : config["destination"].to_s, root)
    unless File.directory?(destination)
      puts "note no built site at #{JSON.generate(destination)}; nothing to read (build it first)"
      exit 0
    end

    host = site_host(config)
    files = Dir.glob("**/*.html", base: destination).reject { |f| SKIPPED.any? { |dir| f.start_with?(dir) } }.sort
    total = 0
    files.each do |relative|
      html = File.read(File.join(destination, relative), encoding: "UTF-8").scrub
      # No depth limit: a deeply nested page is a page, not an error.
      findings_in(Nokogiri::HTML5.parse(html, max_tree_depth: -1), host).each do |what, address, why|
        total += 1
        puts "FAIL #{JSON.generate(page_address(relative))} loads #{what} from #{JSON.generate(address.to_s)}: #{why}"
      end
    end

    if total.zero?
      puts "ok   no page loads anything from another site (#{files.size} pages read" \
           "#{host ? ", this site is #{JSON.generate(host)}" : ', no `url:` in _config.yml so only relative addresses count as this site'})"
      exit 0
    end
    puts
    puts "#{total} outside load(s). These sites load nothing from another host, and the browser policy " \
         "blocks it: upload the file to the site (an image, a script, a font), or link to the other " \
         "site instead of embedding it."
    exit 1
  rescue SystemExit
    raise
  rescue StandardError, LoadError => e
    puts "FAIL the outside-resource check could not read this site (#{e.class}: " \
         "#{JSON.generate(e.message.lines.first.to_s.strip)}), so it cannot say that no page loads from another site"
    exit 1
  end
end
