# frozen_string_literal: true
# Renders the live Decap admin config from the site's _config.yml at the end of
# every build, so a site never hand-authors the ~400-line config. Mirrors
# scripts/render-decap-config.rb but reads site.config directly. No-op for sites
# that don't ship admin/config.base.yml.
require "uri"

module CmsPlatformTheme
  module DecapConfig
    def self.run(site)
      src  = File.join(site.source, "admin")
      out  = File.join(site.dest, "admin")
      base = File.join(src, "config.base.yml")
      return unless File.exist?(base) && Dir.exist?(out)

      cms  = site.config["cms"] || {}
      url  = (site.config["url"] || "").sub(%r{/+\z}, "")
      repo = cms["repository"]
      return if repo.nil? || repo.empty?
      oauth = cms["oauth_base_url"] || ""
      apex  = url.empty? ? "" : URI(url).host.to_s.sub(/\Awww\./, "")
      logo  = cms["logo_url"] || (url.empty? ? "" : "#{url}/assets/images/logo.svg")
      title = (site.config["title"] || "").to_s
      tokens = { "CMS_REPO" => repo, "CMS_OAUTH_BASE_URL" => oauth,
                 "CMS_SITE_URL" => url, "CMS_DISPLAY_URL" => url, "CMS_LOGO_URL" => logo }

      render = lambda do |b, o|
        t = File.read(b)
        tokens.each { |k, v| t = t.gsub("{{#{k}}}", v) }
        sc = File.join(src, "collections.site.yml")
        t = t.sub(/^  # __SITE_COLLECTIONS__.*$/, File.exist?(sc) ? File.read(sc) : "")
        File.write(o, t)
      end
      render.call(base, File.join(out, "config.yml"))
      lb = File.join(src, "config-local.base.yml")
      render.call(lb, File.join(out, "config-local.yml")) if File.exist?(lb)

      # Inject the SAME window.CMS_* identity globals as scripts/render-decap-config.rb
      # into BOTH the Decap shells (index*.html) AND the review dashboards
      # (reviews/*.html). Kept in lockstep with the script by
      # e2e/decap-config-render-parity.test.js — update both or the lint fails.
      js = %{<script>window.CMS_REPO=#{repo.inspect};window.CMS_SITE_ORIGIN=#{url.inspect};window.CMS_APEX=#{apex.inspect};window.CMS_OAUTH_BASE_URL=#{oauth.inspect};window.CMS_SITE_TITLE=#{title.inspect};</script>}
      shells = Dir.glob(File.join(out, "index*.html")) + Dir.glob(File.join(out, "reviews", "*.html"))
      shells.each do |h|
        s = File.read(h)
        next if s.include?("window.CMS_REPO")
        File.write(h, s.sub(/<head>/i, "<head>\n#{js}"))
      end
      Dir.glob(File.join(out, "*.base.yml")).each { |f| File.delete(f) }
    end
  end
end

Jekyll::Hooks.register(:site, :post_write) { |site| CmsPlatformTheme::DecapConfig.run(site) }
