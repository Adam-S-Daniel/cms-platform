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
- **Render `config.yml` from `config.base.yml`** by token-substituting the
  `window.CMS_*` identity (`{{CMS_REPO}}`, `{{CMS_OAUTH_BASE_URL}}`,
  `{{CMS_SITE_URL}}`, `{{CMS_DISPLAY_URL}}`, `{{CMS_LOGO_URL}}`) and **splicing
  the SITE-OWNED seam** `admin/collections.site.yml` at the `# __SITE_COLLECTIONS__`
  marker. The seam is read from the **SITE source**, never the gem. Before the
  splice, the seam's `$ref`s are expanded against the platform `field_library`
  (see "field_library + `$ref` reuse" below) — the base config itself stays
  TEXT and is spliced byte-for-byte as today.
- **Inject `window.CMS_*` globals** into the admin shells (`index*.html`) AND the
  reviews dashboards (`reviews/*.html`) — skipping a file only if it already
  *defines* the identity, not merely uses it.
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
