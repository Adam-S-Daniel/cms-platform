#!/usr/bin/env ruby
# frozen_string_literal: true

# Fail when two source files of a Jekyll site are written to one address.
#
#   bundle exec ruby destination-conflicts.rb [site-dir]
#
# WHY. Two files that claim one URL build without error: Jekyll prints a
# `Conflict:` warning, writes one of them and carries on, so one page is
# silently not published. A page saved from the CMS with permalink `/tags/`
# replaces the tags index; one with `/blog/` empties the blog; a second post
# whose slug equals an older post's takes the older post's URL. Every check a
# content pull request gets stayed green on all three (cms-platform issue
# 1061), and a content pull request no longer runs the browser matrix that
# caught the first of them. Two files on one URL is a broken build, never an
# authoring choice, so `site-verify.yml` runs this on every pull request.
#
# HOW. It asks Jekyll, never predicts: it loads the site the way `jekyll
# build` does, reads and generates without rendering or writing, and groups
# everything Jekyll itself writes (`Site#each_site_file`: pages, generated
# pages, documents, static files) by `destination`. That is the enumeration
# Jekyll's own build-time warning uses (`Jekyll::Commands::Doctor`), including
# its one exemption for jekyll-redirect-from's pages. Reading the result here,
# not the warning in the build log, means a site that sets `quiet: true`
# cannot hide it and a reworded warning cannot disarm it.
#
# "The way `jekyll build` does" has one step that is easy to lose:
# `Jekyll::PluginManager.require_from_bundler`. The `jekyll` executable calls
# it before anything else; `Jekyll::Site.new` does NOT, and `bundle exec` only
# sets up load paths. Without it the gems in the Gemfile's `:jekyll_plugins`
# group never load, and that is where a consumer gets the theme gem: its
# generated tag pages were not counted (a page that took over `/tags/<tag>/`
# passed), and its hook that repairs an empty `slug:` did not run (a post the
# CMS really saves read as a collision with the blog index and would have
# blocked a legitimate publish). The independent review of the release found
# both before it shipped. The site's own `source:` and `destination:` are
# honored too: this runs from the site's directory and overrides neither.
#
# NOT COVERED: files a plugin copies into `_site` from a post-write hook, such
# as the theme's `admin/`. Jekyll does not know their destinations, so a page
# claiming `/admin/` is not reported here.
#
# Output: one `FAIL` line per shared address naming the address and every
# file, JSON-quoted (a file name may hold a newline, which must not start a
# log line), then exit 1. Exit 0 and one `ok` line when there is none. A site
# this cannot load is a FAIL with the error's class and first line, exit 1:
# a check that cannot run must not read as a pass.

require "json"

begin
  require "jekyll"

  # From the site's own directory, like the build: `_config.yml`, the Gemfile
  # and a configured `source:` all resolve from there.
  Dir.chdir(File.expand_path(ARGV[0] || "."))
  Jekyll::PluginManager.require_from_bundler
  site = Jekyll::Site.new(Jekyll.configuration("quiet" => true))
  source = site.source
  destination = site.dest
  site.reset
  site.read
  site.generate

  by_destination = Hash.new { |hash, key| hash[key] = [] }
  site.each_site_file do |item|
    next if defined?(JekyllRedirectFrom) && item.is_a?(JekyllRedirectFrom::RedirectPage)

    by_destination[item.destination(site.dest)] << item
  end

  relative = lambda do |path, root|
    path = path.to_s
    path.start_with?("#{root}/") ? path[(root.length + 1)..] : path
  end
  describe = lambda do |item|
    path = item.respond_to?(:relative_path) ? item.relative_path : item.path
    relative.call(path, source).sub(%r{\A/}, "")
  end

  conflicts = by_destination.select { |_dest, items| items.size > 1 }
  if conflicts.empty?
    puts "ok   no two files share an address (#{by_destination.size} files checked)"
    exit 0
  end

  conflicts.sort_by(&:first).each do |dest, items|
    address = "/#{relative.call(dest, destination)}"
    files = items.map { |item| JSON.generate(describe.call(item)) }.sort.join(", ")
    puts "FAIL #{items.size} files are written to #{JSON.generate(address)}, so only one of them is " \
         "published: #{files}"
  end
  puts
  puts "#{conflicts.size} address(es) are claimed by more than one file. Give each its own " \
       "permalink or slug (or delete the one that should not exist)."
  exit 1
rescue SystemExit
  raise
rescue StandardError, LoadError => e
  puts "FAIL the address check could not load this site (#{e.class}: " \
       "#{JSON.generate(e.message.lines.first.to_s.strip)}), so it cannot say that no two files share " \
       "an address"
  exit 1
end
