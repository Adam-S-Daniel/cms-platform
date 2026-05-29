#!/usr/bin/env ruby
# Render the Decap admin config + inject CMS_* globals from the site's _config.yml.
#
# Runs as a post-build step (or from a theme-gem Jekyll generator): it reads the
# site identity from _config.yml and writes the live admin config into the build
# output, so a site never hand-authors the ~400-line Decap config — it only sets
# a few values in _config.yml.
#
#   _config.yml:
#     url: https://example.com
#     cms:
#       repository: Adam-S-Daniel/example.com
#       oauth_base_url: https://abc123.execute-api.us-east-1.amazonaws.com
#       # logo_url: optional; defaults to <url>/assets/images/logo.svg
#
# Usage: render-decap-config.rb <site_root> <build_dir>
#   site_root : dir with _config.yml + admin/*.base.yml   (default ".")
#   build_dir : Jekyll output dir whose admin/ is finalized (default "<site_root>/_site")
require 'yaml'
require 'uri'

site_root = ARGV[0] || '.'
build     = ARGV[1] || File.join(site_root, '_site')

cfg  = YAML.load_file(File.join(site_root, '_config.yml')) || {}
cms  = cfg['cms'] || {}
url  = (cfg['url'] || '').sub(%r{/+\z}, '')
title = (cfg['title'] || '').to_s
repo = cms['repository'] or abort 'render-decap-config: _config.yml needs cms.repository'
oauth = cms['oauth_base_url'] || ''
apex  = url.empty? ? '' : URI(url).host.to_s.sub(/\Awww\./, '')
logo  = cms['logo_url'] || (url.empty? ? '' : "#{url}/assets/images/logo.svg")

tokens = {
  'CMS_REPO' => repo, 'CMS_OAUTH_BASE_URL' => oauth, 'CMS_SITE_URL' => url,
  'CMS_DISPLAY_URL' => url, 'CMS_LOGO_URL' => logo,
}

admin_src = File.join(site_root, 'admin')
admin_out = File.join(build, 'admin')
abort "render-decap-config: #{admin_out} not found (run after the site build)" unless Dir.exist?(admin_out)

# 1. base config(s) -> live config(s); text gsub preserves the rich comments.
render = lambda do |base, out|
  txt = File.read(base)
  tokens.each { |k, v| txt = txt.gsub("{{#{k}}}", v) }
  site_cols = File.join(admin_src, 'collections.site.yml')
  inject = File.exist?(site_cols) ? File.read(site_cols) : ''
  txt = txt.sub(/^  # __SITE_COLLECTIONS__.*$/, inject)
  File.write(out, txt)
end
render.call(File.join(admin_src, 'config.base.yml'), File.join(admin_out, 'config.yml'))
lb = File.join(admin_src, 'config-local.base.yml')
render.call(lb, File.join(admin_out, 'config-local.yml')) if File.exist?(lb)

# 2. inject window.CMS_* into the built admin HTML shells (read by admin/*.js
#    and admin/reviews/*.html). Both the Decap shells (index*.html) and the
#    visual-regression review dashboards (reviews/index.html, reviews/health.html)
#    derive their site identity from these globals — REPO_OWNER/REPO_NAME from
#    CMS_REPO, APEX_DOMAIN from CMS_APEX, OAUTH_URL from CMS_OAUTH_BASE_URL,
#    document.title from CMS_SITE_TITLE (the site's _config.yml `title`) —
#    instead of hardcoding it, so the platform stays site-agnostic.
js = %{<script>window.CMS_REPO=#{repo.inspect};window.CMS_SITE_ORIGIN=#{url.inspect};window.CMS_APEX=#{apex.inspect};window.CMS_OAUTH_BASE_URL=#{oauth.inspect};window.CMS_SITE_TITLE=#{title.inspect};</script>}
shells = Dir.glob(File.join(admin_out, 'index*.html')) +
         Dir.glob(File.join(admin_out, 'reviews', '*.html'))
shells.each do |h|
  s = File.read(h)
  next if s.include?('window.CMS_REPO')
  File.write(h, s.sub(/<head>/i, "<head>\n#{js}"))
end

# 3. don't publish the templates themselves.
Dir.glob(File.join(admin_out, '*.base.yml')).each { |f| File.delete(f) }

puts "render-decap-config: wrote config.yml + injected CMS_* globals into #{admin_out}"
