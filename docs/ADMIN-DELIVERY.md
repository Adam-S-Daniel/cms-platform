# Admin delivery: the gem-shipped Decap config

What this is: how the `/admin` Decap config is built — the gem-shipped
machinery under `theme/admin/`, the `:post_write` render hook that copies it
into `_site/admin` and renders `config.yml`, the site-owned collections seam,
the `base_collections` keep-list opt-out, and the `field_library` + `$ref`
reuse mechanism. Read this before touching `theme/admin/`, either render path
(`theme/lib/cms-platform-theme/decap_config_hook.rb` or
`scripts/render-decap-config.rb`), `theme/admin/field_library.yml`, or a
site's `admin/collections.site.yml` seam. See also the `admin-config-render`
skill.

This is also the doc that carries the two other gem-shipped-asset patterns
below — the favicon (#325) and the seeded 404 page (#326) — because it's the
one doc a change to `theme/**` is scoped to edit; neither is `/admin`
machinery, but both extend the same "gem ships a neutral, site-shadowable
default" pattern this file already documents for the logo.

## Admin delivery (gem-shipped, v0.1.4+) — the render hook, the seam, base_collections

The Decap admin (`/admin`) is the ~400-line invariant-heavy CMS config plus a
set of JS/HTML/CSS shells and the `reviews/` dashboards. Two facts drive the
whole design:

1. **The gem root is `theme/`** (the gemspec lives there). For the gem to ship
   the admin machinery, `admin/` had to live **under** the gem root, so it was
   relocated from the repo root to `theme/admin/` in **v0.1.4**. (RubyGems drops
   `..` paths and won't follow symlinks, so a sibling `admin/` couldn't be
   packaged.) The gemspec packages `admin/**/*` **minus** the site-owned seam and
   the build-generated files (`collections.site.yml`, `config.yml`,
   `config-local.yml`, `commit.json`) — via `Dir[] - Dir[]` array subtraction,
   because `Dir[]` has no `!` negation.

2. **Consumers stop vendoring `admin/`.** A consuming site deletes its vendored
   `admin/` and keeps **only** the seam `admin/collections.site.yml` (+
   `.example`). The down-sync path is a gem bump via `platform-bump` — since
   #242, Dependabot's `bundler` ecosystem carries an explicit `ignore` for the
   `cms-platform-theme` gem and never touches it (see `docs/SYNC.md`).
   `platform-drift-guard` was narrowed to **skills-only** when admin stopped
   being byte-guarded, and was deleted outright in v0.1.83 along with the skills
   mirror it was left guarding — nothing byte-compares a consumer's tree today.

**The render hook** (`theme/lib/cms-platform-theme/decap_config_hook.rb`, a
`:site, :post_write` Jekyll hook) does, at the end of every build:

- **Resolve machinery inputs from the gem** (`site.theme.root/admin`), falling
  back to a vendored `site.source/admin` (migration window + the platform's own
  e2e fixture). No-op if neither has a `config.base.yml`.
- **Copy the gem-resident machinery into `_site/admin`** — Jekyll won't, since
  the site tree no longer contains `admin/`. It copies depth-1 files + the
  `reviews/` subdir only (skipping `*.base.yml`, the seam, `README.md`). **If you
  add another subdirectory under `theme/admin/`, extend this copy AND its parity
  sibling `scripts/render-decap-config.rb`.**
- **Render `config.yml` AND `config-local.yml` from their `.base.yml`
  templates** by token-substituting the `window.CMS_*` identity
  (`{{CMS_REPO}}`, `{{CMS_OAUTH_BASE_URL}}`, `{{CMS_SITE_URL}}`,
  `{{CMS_DISPLAY_URL}}`, `{{CMS_LOGO_URL}}`) and **splicing the SITE-OWNED
  seam** `admin/collections.site.yml` at each template's own
  `# __SITE_COLLECTIONS__` marker — both `config.base.yml` and
  `config-local.base.yml` carry one, so a site's own collections reach LOCAL
  dev too, not just prod. The seam is read from the **SITE source**, never
  the gem. Before the splice, the seam's `$ref`s are expanded against the
  platform `field_library` (see "field_library + `$ref` reuse" below) — the
  base config itself stays TEXT and is spliced byte-for-byte as today.
- **Inject `window.CMS_*` globals** into the admin shells (`index*.html`) AND the
  reviews dashboards (`reviews/*.html`) — skipping a file only if it already
  *defines* the identity, not merely uses it.
  `CMS_REPO` / `CMS_SITE_ORIGIN` / `CMS_APEX` / `CMS_OAUTH_BASE_URL` /
  `CMS_SITE_TITLE` are strings; **`CMS_SITE_GATE` (v0.1.95) is an OBJECT or
  `null`** — the site-level publish gate a site optionally declares as
  `cms.site_gate`, read by `admin/site-gate-banner.js`. It is the one global
  that must be serialised with `JSON.generate` rather than the `.inspect` the
  others use: Ruby's `Hash#inspect` emits `{"a"=>1}`, which is a JavaScript
  syntax error, and it lands *inside* the shell's `<script>` block — so
  getting it wrong takes the whole admin down rather than degrading. A site
  with no gate injects `null` and the banner is inert.
- **Delete `*.base.yml`** from the output (the templates aren't published).

`scripts/render-decap-config.rb` is the **deploy-time CLI mirror** of the hook
(same copy + render + inject + cleanup; resolves the gem via
`Gem.loaded_specs['cms-platform-theme']`). The two are **parity-locked** by
`e2e/decap-config-render-parity.test.js` — keep the injected globals and the
`index*` / `reviews/*` globs **identical** in both, or the lint fails.

**`write-commit-json.sh`** writes `_site/admin/commit.json` (the commit pill's
`fetch('commit.json')` resolves under `_site/admin/` now that admin is served
from there; CI deploys do this automatically — the script is for local dev).

### base_collections opt-out (v0.1.7)

`_config.yml` `cms.base_collections` is a **KEEP-LIST** of the platform's
built-in collections (`posts tags projects pages e2e`):

- **UNSET** → keep all (default, back-compat).
- `[]` → hide them all, so `/admin` shows ONLY the site's own collections.
- a subset → keep only those.

The renderers delete each unwanted top-level collection block by regex —
matched at **2-space indent**, through to the next top-level `- name:` or EOF;
nested fields are deeper-indented so they survive. **Spec-locked** by
`theme/spec/base_collections_filter_test.rb` (asserts nil keeps all, `[]` hides
all base collections but keeps site collections, partial keep works, survivors'
nested fields and a field literally named like a base collection are untouched,
output stays valid YAML). Used by single-page sites (jodidaniel.com).

### field_library + `$ref` reuse (#5 GOAL 2)

A site's seam `admin/collections.site.yml` can **reuse** platform-defined
field/widget defs instead of re-authoring them, by writing a `$ref` where a
field (or fields) would go:

```yaml
  - name: articles
    folder: _articles
    fields:
      - { name: title, label: Title, widget: string }   # inline still works
      - $ref: "#/field_library/body_markdown"            # → ONE field
      - $ref: "#/field_library/image_widget"             # → ONE field
      - $ref: "#/field_library/published_pair"           # → TWO fields (spliced)
```

- **The platform OWNS the library:** `theme/admin/field_library.yml` (ships in
  the gem next to `config.base.yml`, packaged by the `admin/**/*` glob). It
  defines `body_markdown` (markdown body, modes rich_text+raw), `published_pair`
  (the published + publish_date pair — a **list** of 2 fields), `date_widget`,
  `image_widget` (flat-public_folder contract). The datetime `format:` token
  (`"YYYY-MM-DD HH:mm:ss ZZ"`) is copied **verbatim** from `config.base.yml`
  (the dayjs/INVALID-DATE cross-engine contract) — keep them in lockstep.
- **Resolved at RENDER time, in BOTH paths.** The shared resolver
  `theme/lib/cms-platform-theme/field_library.rb`
  (`CmsPlatformTheme::FieldLibrary`) is `require`d by **both** render paths and
  invoked identically — `expand_seam_text(raw, field_library_path)` — so they
  stay byte-in-lockstep. It parses the seam, replaces each
  `{"$ref" => "#/field_library/<name>"}` with a **deep copy** of the lib entry
  (single field → one item; list → spliced in place, 2-space list indent
  preserved), then re-emits YAML and splices at the marker. **Decap never sees a
  `$ref`** — it loads only fully-resolved field defs. An unknown / malformed
  `$ref` **fails HARD** (the render aborts; a `$ref` must never leak).
- **The base config stays TEXT.** This is a LOW-RISK increment: only the
  **seam** is YAML-round-tripped (and only when it actually contains a `$ref`).
  `config.base.yml` is byte-unchanged and still spliced verbatim, so every
  load-bearing comment + verbatim-asserted base line (posts.summary, the format
  token, media_folder/public_folder, preview_context) is preserved.
- **Backward-compatible.** A seam with **no** `$ref` (inline fields — the status
  quo, e.g. adamdaniel's notes, jodidaniel's collections) is returned UNCHANGED
  by `expand_seam_text` and spliced exactly as before — **byte-identical**
  renders. Proven by diffing the new vs origin/main render of jodidaniel's real
  inline `collections.site.yml`.
- **Spec-locked** by `theme/spec/field_library_resolution_test.rb` (the resolver:
  single + multi-field refs, deep-copy isolation, hard-fail on unknown/malformed)
  + `e2e/field-library-ref-render.test.js` (drives `render-decap-config.rb` on a
  `$ref` fixture → resolved output, no `$ref` leak, base unchanged, hard-fail,
  no-ref backward-compat). The `$ref`-render spec reads platform `scripts/` +
  `theme/` source, so it's registered in `PLATFORM_META_SPECS` (playwright.config.js).
- **OUT OF SCOPE / future work:** the full base-collection-override **deep-merge**
  (a site overriding/reordering a base collection's fields) is deferred. Today
  the seam is still **append-only** (collections are spliced after the base);
  `$ref` only delivers shared-field REUSE, not base override.

## Site favicon (gem-shipped, brand-free — issue #325)

The gem ships zero favicon references (no `<link rel="icon">` anywhere in
`theme/_layouts/`, no icon asset), so every consumer page carries no
declared icon and the browser falls back to an automatic same-origin
`GET /favicon.ico` — which 404s, on both consumers, on every page view.

**Same shadowing pattern as the `/admin` logo above**, applied to a page-level
asset instead of an admin-only one:

- **The gem ships a neutral, brand-free favicon**: `theme/assets/favicon.svg`
  — wordless, no initials/wordmark, carrying an override comment (mirrors
  `theme/assets/images/logo.svg`; locked by `theme/spec/neutral_favicon_test.rb`
  the same way `neutral_logo_test.rb` locks the logo).
- **A gem-owned, standalone include emits the `<link>` tag**:
  `theme/_includes/favicon.html`. It reads only `site.cms.favicon_url` (falls
  back to `<baseurl>/assets/favicon.svg` via `relative_url`, honoring an
  explicit override verbatim — same own-value-wins semantics as `cms.logo_url`
  in `decap_config_hook.rb`) and `site.baseurl`. Because it depends on nothing
  else `default.html` provides, it also works from a **site-owned layout with
  its own `<head>`** — just add:

  ```liquid
  {% include favicon.html %}
  ```

  inside that layout's `<head>`. This is the piece a single-page,
  custom-design consumer (jodidaniel.com's `home.html`) needs, since its
  layout never extends the gem's `default.html`.
- **`theme/_layouts/default.html`'s `<head>` includes it once**, which is
  sufficient coverage for every gem layout: `post.html`, `page.html`,
  `project.html`, `tag.html`, `canary.html`, and `preview.html` all declare
  `layout: default` in their own front matter, so they inherit it —
  `e2e/scaffold-seeds-favicon.test.js` asserts this is actually true (parses
  every non-`default.html` layout's front matter) rather than assuming it.
- **A site brands it by shadowing `assets/favicon.svg`** (Jekyll site files
  win over same-path gem files) or by setting `cms.favicon_url`. The
  scaffolder seeds a "replace me" copy at `assets/favicon.svg`, byte-derived
  from the gem asset so the two can't drift (`seedFavicon()` in
  `scaffold/create-site.js`, mirroring `seedLogo()`).
- **Fallback strategy, deliberately SVG-only**: once the `<link rel="icon">`
  tag is present, on-spec browsers stop the automatic `/favicon.ico` probe
  that was 404ing (that request only fires when the page declares no icon at
  all) — so the SVG-only asset already closes the reported gap for every
  currently-supported browser (Chromium/Firefox since ~2021, Safari 16.4+).
  We do NOT also ship an `.ico`/`.png` fallback, for the same reason the logo
  placeholder is SVG-only: it would be the only raster asset type the gem
  ships. A site that needs pre-2021-browser or platform-icon (e.g.
  `apple-touch-icon`) support can add those tags itself alongside the include.

**Locked by**: `theme/spec/neutral_favicon_test.rb` (gem asset is wordless,
square viewBox, carries the override comment) and
`e2e/scaffold-seeds-favicon.test.js` (scaffold output + neutrality + the
actual `<head>` emission — both the include's own content and its real
presence in `default.html`'s `<head>`, not just documented intent). Existing
consumers (adamdaniel.ai, jodidaniel.com) will not retroactively pick this
up — a `platform_ref` bump gets them the gem's `favicon.html` include and
`assets/favicon.svg` default automatically (nothing to change on their end for
the default to work), but the fix for jodidaniel.com's own `<head>`
(`_layouts/home.html`) is the one-line `{% include favicon.html %}` add above,
made in that repo.

## Seeded 404 page: self-contained and neutral, not gem-styled (issue #326)

`404.html` is, and always was, **site-owned** — the scaffolder seeds it
(`SEED_404` in `scaffold/create-site.js`), but a consuming site's own repo
commits and can freely edit its own copy. What changed in #326 is the LOOK the
*seed* ships with.

**The problem the redesign fixes**: the old seed carried `layout: default`, so
its look came from the gem's `default` layout + `assets/css/main.css` — the
"Cobalt Thermal" dark, monospace-accented design that IS adamdaniel.ai's whole
site. That's invisible on adamdaniel.ai (it's the same look everywhere) and
jarring on a consumer with its own design system (jodidaniel.com's light
blue-gradient, Raleway/Source-Sans bio) whose 404 page was the ONLY gem-styled
surface left in a visitor's path — two independent testers flagged it
unprompted as reading like a different project. This is a **platform pattern
problem**: every future design-custom consumer inherits the same brand break
from the seed, not just this one site.

**The fix**: the seeded `404.html` now carries **no `layout:` field at all**.
It is its own complete, self-contained `<!DOCTYPE html>` document — no
dependence on `default.html`, no `{% include header.html %}` /
`{% include footer.html %}`, no `assets/css/main.css` — with its own minimal,
neutral, system-font inline `<style>`. Brandability is a SMALL, explicit
surface: a `:root { --nf-bg; --nf-fg; --nf-muted; --nf-accent; --nf-font; }`
block at the top of that `<style>` a site can retune (in its own committed
copy — there's no gem asset to shadow here, since 404.html was never
gem-owned) without needing to redesign the whole page. The defaults are
neutral enough to sit acceptably next to either the gem's own look or a fully
custom one.

**LOCKED regardless of any future restyle** (`e2e/scaffold-preview-and-404.test.js`
enforces every one of these):

- `permalink: /404.html` (the correct-HTTP-404 contract — unchanged),
- `robots: "noindex,nofollow"` + `sitemap: false` — and since no layout
  renders `page.robots` for this page anymore, it emits its own
  `<meta name="robots" content="{{ page.robots }}">` directly,
- a working link home (`{{ '/' | relative_url }}`),
- generic, site-agnostic copy (no site identity baked into the seed).

The lint also now asserts the *shape* of the redesign itself, not just the
locked bits: the seed has NO `layout:` field (self-contained), is a full
`<!DOCTYPE html>…</html>` document, does not reference
`assets/css/main.css` or the gem header/footer includes, and exposes at least
a few `--*` CSS custom properties. `e2e/fixture-site/404.html` is kept
byte-identical to the scaffolder's own output (assertion (b) in that spec).

As a byproduct, the redesign also dropped a dead "browse the blog" link the
old seed carried unconditionally — a single-page-bio consumer with no `_posts/`
had a 404 page linking to a blog index that itself 404s (the same class of bug
`header.html`'s conditional Blog nav link exists to avoid — see the comment
there).

**Existing consumers do not retroactively pick this up.** `404.html` is
site-owned and already committed in both adamdaniel.ai and jodidaniel.com; a
`platform_ref` bump changes nothing about it, because the scaffolder only runs
once, at site creation. A site that wants the new neutral shape has to copy
the new `SEED_404` template (or hand-author an equivalent) into its own
`404.html` itself. For jodidaniel.com specifically, this is a low-risk,
high-value adopt: replace its `404.html` body with the new self-contained
template (adjusting `--nf-*` to its own palette if desired) in a normal PR —
nothing else in the seeding contract changes, and the render-neutral check in
"Approving `regression-review` on a render-neutral PR" above does not apply
here (`404.html` is not under `theme/`, so that specific gate is irrelevant;
the PR will still go through the ordinary visual-regression lane like any
other content change).
