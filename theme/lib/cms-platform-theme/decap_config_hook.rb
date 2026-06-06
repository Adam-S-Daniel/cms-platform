# frozen_string_literal: true
# Renders the live Decap admin config from the site's _config.yml at the end of
# every build, so a site never hand-authors the ~400-line config. Mirrors
# scripts/render-decap-config.rb but reads site.config directly.
#
# As of v0.1.4 the admin/ machinery (base configs + the JS/HTML shells +
# reviews dashboards) ships INSIDE this gem (theme/admin), so a consuming site
# no longer vendors byte-copies. This hook therefore:
#   - resolves the machinery INPUTS from the gem (site.theme.root/admin),
#     falling back to a vendored site/admin for backward-compat during the
#     migration window (and for the platform's own e2e fixture);
#   - COPIES the gem-resident machinery into _site/admin (Jekyll won't, since
#     the site tree no longer contains admin/); and
#   - still reads the SITE-OWNED seam (admin/collections.site.yml) from the
#     site source, never the gem.
# No-op for sites with neither a gem-shipped nor a vendored admin/config.base.yml.
require "uri"
require "fileutils"
# Shared field_library $ref resolver — the SINGLE source of truth, also
# required by scripts/render-decap-config.rb, so the two render paths expand
# $refs byte-identically (parity-locked by e2e/decap-config-render-parity.test.js).
require_relative "field_library"

module CmsPlatformTheme
  module DecapConfig
    def self.run(site)
      site_admin = File.join(site.source, "admin")
      gem_root   = site.theme && site.theme.respond_to?(:root) ? site.theme.root : nil
      gem_admin  = gem_root ? File.join(gem_root, "admin") : nil
      # Inputs come from the gem when present (the canonical source); fall back
      # to a vendored site/admin during migration / for the platform fixture.
      from_gem = gem_admin && Dir.exist?(gem_admin) && File.exist?(File.join(gem_admin, "config.base.yml"))
      src  = from_gem ? gem_admin : site_admin
      base = File.join(src, "config.base.yml")
      return unless File.exist?(base)

      out = File.join(site.dest, "admin")
      FileUtils.mkdir_p(out)

      # When the machinery comes from the gem, Jekyll didn't copy it into
      # _site/admin (it isn't in the site tree) — copy it now. Skip the base
      # templates (rendered below), the site-owned seam, and docs.
      # NB: copies depth-1 files + the reviews/ subdir only. If you add another
      # subdirectory under theme/admin, extend this copy AND its parity sibling
      # scripts/render-decap-config.rb (locked by decap-config-render-parity.test.js).
      if from_gem
        skip = ["collections.site.yml", "collections.site.yml.example", "README.md"]
        Dir.glob(File.join(src, "*")).each do |f|
          next if File.directory?(f)
          bn = File.basename(f)
          next if bn.end_with?(".base.yml") || skip.include?(bn)
          # Atomic copy: write a temp then rename, so a concurrent reader during
          # an in-test rebuild never sees a truncated/partial admin asset (#1815-flake).
          dst = File.join(out, bn)
          tmp = "#{dst}.tmp.#{Process.pid}"
          FileUtils.cp(f, tmp)
          File.rename(tmp, dst)
        end
        rev = File.join(src, "reviews")
        if Dir.exist?(rev)
          FileUtils.mkdir_p(File.join(out, "reviews"))
          Dir.glob(File.join(rev, "*")).each do |f|
            FileUtils.cp(f, File.join(out, "reviews", File.basename(f))) unless File.directory?(f)
          end
        end
      end

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

      # The collections seam is ALWAYS site-owned — read it from the site
      # source, never the gem (the gem ships no collections.site.yml).
      site_collections = File.join(site_admin, "collections.site.yml")

      # Optional base-collection opt-out. `cms.base_collections` is a KEEP-LIST
      # of the platform's built-in collection names; UNSET keeps them all
      # (default, back-compat). A single-page site can set it to a subset, or
      # to [] to hide them all so /admin shows ONLY the site's own collections.
      # Each unwanted top-level collection block is deleted from the rendered
      # config (matched at 2-space indent, through to the next top-level
      # `- name:` or EOF — nested fields are deeper-indented, so untouched).
      base_names = %w[posts tags projects pages e2e]
      base_keep  = cms["base_collections"]

      # The platform field_library (reusable field/widget defs the seam may
      # $ref) is PLATFORM-owned — it ships with the base machinery, so resolve
      # it next to config.base.yml (src), never the site source.
      field_library_path = File.join(src, "field_library.yml")

      render = lambda do |b, o|
        t = File.read(b)
        tokens.each { |k, v| t = t.gsub("{{#{k}}}", v) }
        raw = File.exist?(site_collections) ? File.read(site_collections) : ""
        # Expand any `$ref: "#/field_library/<name>"` in the seam BEFORE
        # splicing. No-op (byte-identical to the legacy splice) when no $ref.
        inject = CmsPlatformTheme::FieldLibrary.expand_seam_text(raw, field_library_path)
        t = t.sub(/^  # __SITE_COLLECTIONS__.*$/, inject)
        unless base_keep.nil?
          keepset = Array(base_keep).map(&:to_s)
          (base_names - keepset).each do |n|
            t = t.sub(/^  - name: #{Regexp.escape(n)}\n.*?(?=^  - name: |\z)/m, "")
          end
        end
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
        # Skip only if the file already DEFINES the identity (a prior render,
        # or a self-defining shell) — NOT if it merely USES window.CMS_REPO
        # (the commit-pill + reviews dashboards read it; matching a use here
        # would wrongly skip injecting the definition they depend on).
        next if s =~ /window\.CMS_REPO\s*=\s*["']/
        File.write(h, s.sub(/<head>/i, "<head>\n#{js}"))
      end
      Dir.glob(File.join(out, "*.base.yml")).each { |f| File.delete(f) }
    end
  end
end

Jekyll::Hooks.register(:site, :post_write) { |site| CmsPlatformTheme::DecapConfig.run(site) }
