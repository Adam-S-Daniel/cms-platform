/*
 * Shared SITE-CAPABILITY predicates for the e2e harness — the single source of
 * truth for "does THIS consuming site actually have the generic collection /
 * content a given spec asserts against?".
 *
 * Why this module exists (issue #33)
 * ----------------------------------
 * The platform ships five built-in ("base") collections — posts, tags,
 * projects, pages, e2e — plus the `_e2e/` canary fixtures the publish-loop
 * specs target. A consuming site can OPT OUT of any/all of them via the v0.1.7
 * `cms.base_collections` keep-list in `_config.yml` (see #5,
 * scripts/render-decap-config.rb + theme/lib/.../decap_config_hook.rb): UNSET
 * keeps all (back-compat default); a subset keeps only those names; `[]` hides
 * them all so /admin shows ONLY the site's own custom collections. A genuine
 * single-page consumer (e.g. jodidaniel.com) therefore has NO posts/blog, no
 * `_e2e` canaries, no `_tags`/`_projects`/`pages`.
 *
 * But ~a dozen platform e2e specs ASSUME those collections/content exist —
 * they read `_posts/`, `_e2e/canary-*.md`, the rendered `_site/admin/config.yml`
 * `posts`/`tags`/`projects`/`pages`/`e2e` collections, or the rendered
 * `_site/e2e/canary-<slug>/` pages — so an opted-out consumer's e2e was PERMANENTLY
 * RED on every branch. These predicates let each such spec self-skip PRECISELY
 * when the collection/content is genuinely absent, while still RUNNING FULLY
 * where it exists (the platform fixture-site + adamdaniel.ai).
 *
 * The discriminator is SITE_ROOT — the consuming site's repo root, the same
 * value playwright.config.js's webServer and e2e/cms-config.spec.js's
 * RENDERED_CONFIG resolve against. Every predicate takes an explicit
 * `siteRoot` (defaulting to `process.env.SITE_ROOT || <harness>/..`, the exact
 * fallback the rest of the harness uses) so the unit test can point it at
 * either fixture shape.
 *
 * Two independent signal sources, by design:
 *   1. SOURCE — `_config.yml` `cms.base_collections` (the editor's declared
 *      opt-out intent) + the presence of `_posts/`, `_e2e/canary-*.md` source
 *      files. Available WITHOUT a build (the node-unit-lints lane).
 *   2. RENDERED — the gem-emitted `_site/admin/config.yml` collections list +
 *      the built `_site/e2e/canary-<slug>/` pages. Available only after a local
 *      Jekyll build (the consumer e2e lane). The rendered admin config is the
 *      ground truth Decap actually loads, so the admin-collection predicates
 *      prefer it; the keep-list predicates work pre-build off the source.
 *
 * Pure Node — deliberately NO `require("./base")` — so it stays a plain,
 * unit-testable library (same discipline as public-content.js /
 * fixture-baseline.js). Parses YAML with the real `yaml` lib (AGENTS.md: no
 * regex config scraping).
 */
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

// The platform's five built-in collection names. The `cms.base_collections`
// keep-list is a subset of these (see render-decap-config.rb `base_names`).
const BASE_COLLECTION_NAMES = ["posts", "tags", "projects", "pages", "e2e"];

// The default SITE_ROOT: the consuming site's repo root. SITE_ROOT is exported
// by the e2e reusable workflow when the platform is consumed; in the platform's
// own self-CI it's unset and `<harness>/..` is the platform/site root — the
// same fallback playwright.config.js, base.js, and cms-config.spec.js use.
function defaultSiteRoot() {
  return process.env.SITE_ROOT || path.resolve(__dirname, "..");
}

function readYamlIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return YAML.parse(fs.readFileSync(file, "utf8")) || {};
}

// ── SOURCE signals (no build required) ───────────────────────────────────

// The site's `_config.yml` `cms.base_collections` keep-list, normalized:
//   - UNSET / missing  → null  (keep ALL base collections — the default)
//   - a YAML list      → array of string names (keep ONLY these)
//   - []               → []    (keep NONE — full single-page opt-out)
// Returns null when `_config.yml` can't be read so callers treat an
// unreadable config as "keep all" (the safe, behaviour-preserving default).
function baseCollectionsKeepList(siteRoot = defaultSiteRoot()) {
  const cfg = readYamlIfExists(path.join(siteRoot, "_config.yml"));
  const cms = (cfg && cfg.cms) || {};
  const keep = cms.base_collections;
  if (keep == null) return null; // unset ⇒ keep all
  return [].concat(keep).map((n) => String(n));
}

// Does the site KEEP the named base collection? UNSET keep-list ⇒ true for
// every base name (back-compat). A keep-list ⇒ membership test. A name that
// isn't a platform base collection is reported as kept (it's the site's own).
//
// Signature is (siteRoot, name) — siteRoot FIRST, so call sites read "does
// THIS site keep <name>". siteRoot defaults to the env-derived root when
// omitted, in which case the sole argument is the collection name.
function keepsBaseCollection(siteRoot, name) {
  if (name === undefined) {
    name = siteRoot;
    siteRoot = defaultSiteRoot();
  }
  const keep = baseCollectionsKeepList(siteRoot);
  if (!BASE_COLLECTION_NAMES.includes(name)) return true;
  if (keep == null) return true;
  return keep.includes(name);
}

// Is this a single-page consumer that opted out of ALL base collections
// (`cms.base_collections: []`)? This is the coarse "the generic-content specs
// don't apply at all" gate; finer-grained specs key on keepsBaseCollection /
// hasAdminCollection for the specific collection they touch.
function isSinglePageConsumer(siteRoot = defaultSiteRoot()) {
  const keep = baseCollectionsKeepList(siteRoot);
  return Array.isArray(keep) && keep.length === 0;
}

// Source `_posts/*.md` present? (A non-empty `_posts/` dir with at least one
// markdown file.) Single-page consumers ship no `_posts/`.
function hasSourcePosts(siteRoot = defaultSiteRoot()) {
  const dir = path.join(siteRoot, "_posts");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.endsWith(".md"));
}

// Source `_e2e/canary-*.md` canary fixtures present? These are the
// publish-loop targets; an opted-out consumer ships none.
function hasE2ECanaries(siteRoot = defaultSiteRoot()) {
  const dir = path.join(siteRoot, "_e2e");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => /^canary-.*\.md$/.test(f));
}

// The shared private-archive PDF fields (theme/admin/field_library.yml →
// `archived_pdf_fields`, issue #527). A collection opts in with ONE field item,
// `$ref: "#/field_library/archived_pdf_fields"`, which the render expands into
// these three names; a site may also author the three fields inline.
const ARCHIVED_PDF_FIELDS_REF = "#/field_library/archived_pdf_fields";
const ARCHIVED_PDF_FIELD_NAMES = ["pdf_archive_file", "pdf_public", "pdf_label"];

// The FOLDER collections the site's OWN seam (`admin/collections.site.yml`)
// opts into the shared PDF fields — by `$ref` or by authoring all three inline.
// A SOURCE signal (no build needed): it is what the site DECLARES, so a
// rendered config that lacks the fields while this is non-empty means the
// fields were lost between the seam and the render, not that the site opted
// out. The seam is a bare 2-space-indented sequence fragment (it is spliced
// into the base collections list), which the real `yaml` parser reads as a
// top-level sequence. Returns [] when the seam is absent or holds no list.
function archivedPdfSourceCollections(siteRoot = defaultSiteRoot()) {
  const seam = path.join(siteRoot, "admin", "collections.site.yml");
  if (!fs.existsSync(seam)) return [];
  const doc = YAML.parse(fs.readFileSync(seam, "utf8"));
  if (!Array.isArray(doc)) return [];
  return doc
    .filter((col) => {
      if (!col || !col.folder || !Array.isArray(col.fields)) return false;
      if (col.fields.some((f) => f && f.$ref === ARCHIVED_PDF_FIELDS_REF)) return true;
      const names = new Set(col.fields.map((f) => f && f.name));
      return ARCHIVED_PDF_FIELD_NAMES.every((n) => names.has(n));
    })
    .map((col) => String(col.name));
}

// ── Home-page layout chain (SOURCE signal) ───────────────────────────────
//
// Several public-page specs load `/` and assert markup the THEME's
// `_layouts/default.html` (skip link, footer follow links) and `main.css`
// (glow animations) put there. That only holds when the home page renders
// THROUGH the theme default. jodidaniel.com's `index.html` uses `layout: home`,
// its OWN `_layouts/home.html`, which is a full HTML document that never
// chains to `default` — so those specs failed there on markup the site never
// asked for (jodidaniel.com#351, cms-platform v0.1.139).
//
// The answer comes from the SITE SOURCE, never from the rendered page lacking
// the markup: a runtime "no skip link, so skip" would hide exactly the
// regression these specs exist to catch on a site that does use the theme.

// Where the theme's layouts live, relative to where the harness runs. The
// local lane checks the platform out at `<site>/.cms-platform/` and then COPIES
// the harness to `<site>/e2e` (e2e-tests.yml "Place harness at site root"), so
// `<harness>/..` is the SITE there, which has no `theme/` (consumers get the
// theme as a gem). Candidates, first existing wins:
//   1. `<harness>/../theme/_layouts` — the harness inside a platform checkout
//      (`.cms-platform/e2e`, the platform's own fixture lanes).
//   2. `<siteRoot>/.cms-platform/theme/_layouts` — the copied-harness layout.
// These are the theme at the HARNESS's platform ref, which the consumer's
// pinned gem matches by the pin-consistency guard; they are not read from the
// installed gem itself.
function themeLayoutsDirCandidates(siteRoot = defaultSiteRoot(), harnessDir = __dirname) {
  return [
    path.resolve(harnessDir, "..", "theme", "_layouts"),
    path.join(siteRoot, ".cms-platform", "theme", "_layouts"),
  ];
}

// The first existing candidate, or null when none exists.
function resolveThemeLayoutsDir(siteRoot = defaultSiteRoot(), harnessDir = __dirname) {
  return themeLayoutsDirCandidates(siteRoot, harnessDir).find((d) => fs.existsSync(d)) || null;
}

// Jekyll front matter: a first line of exactly `---`, closed by the next line
// that is `---` or `...`. Only the block boundaries are found lexically; the
// block itself goes to the real YAML parser. Returns null when the file has no
// front matter (Jekyll then copies a page verbatim and gives a layout none).
function readFrontMatter(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  if (lines[0].trimEnd() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && ["---", "..."].includes(l.trimEnd()));
  if (end === -1) return null;
  const data = YAML.parse(lines.slice(1, end).join("\n"));
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

// `<dir>/<name>.<any ext>` — Jekyll names a layout by its basename, whatever
// the extension. Returns null when there is none.
function findLayoutFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const hit = fs
    .readdirSync(dir)
    .filter((f) => path.parse(f).name === name)
    .sort()[0];
  return hit ? path.join(dir, hit) : null;
}

// Does a `_config.yml` `defaults:` scope path apply to `relPath` (relative to
// the site root)? Mirrors Jekyll: an empty path applies everywhere, otherwise
// the file must be the path or sit under it; `*` globs one path segment.
function scopePathApplies(scopePath, relPath) {
  const scope = String(scopePath == null ? "" : scopePath).replace(/^\/+|\/+$/g, "");
  if (scope === "") return true;
  if (scope.includes("*")) {
    const re = new RegExp(
      "^" +
        scope
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*") +
        "(/|$)",
    );
    return re.test(relPath);
  }
  return relPath === scope || relPath.startsWith(scope + "/");
}

// The `layout` a page at `relPath` gets from `_config.yml` `defaults:` when its
// own front matter has no `layout` key. Jekyll's precedence: a longer scope
// path wins, then a scope that names a type, then the later entry. A home page
// is type `pages`. Returns undefined when no default sets a layout.
function defaultLayoutFor(siteRoot, relPath) {
  const cfg = readYamlIfExists(path.join(siteRoot, "_config.yml"));
  const sets = (cfg && Array.isArray(cfg.defaults) && cfg.defaults) || [];
  let best = null;
  for (const set of sets) {
    if (!set || !set.values || !Object.hasOwn(set.values, "layout")) continue;
    const scope = set.scope || {};
    if (scope.type != null && scope.type !== "pages") continue;
    if (!scopePathApplies(scope.path, relPath)) continue;
    const rank = [String(scope.path == null ? "" : scope.path).length, scope.type != null ? 1 : 0];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] >= best.rank[1])) {
      best = { rank, layout: set.values.layout };
    }
  }
  return best ? best.layout : undefined;
}

// The source file Jekyll writes to `/`. A top-level page declaring
// `permalink: /` (or `/index.html`) wins over `index.*`; otherwise the first of
// index.html, index.md, index.markdown. Pages whose front matter does not
// parse are passed over (Jekyll warns and carries on). Returns null when none.
const HOME_INDEX_FILES = ["index.html", "index.md", "index.markdown"];
function homeSourceFile(siteRoot) {
  const pages = fs
    .readdirSync(siteRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(html|md|markdown)$/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const f of pages) {
    let fm = null;
    try {
      fm = readFrontMatter(path.join(siteRoot, f));
    } catch {
      continue;
    }
    if (fm && ["/", "/index.html"].includes(fm.permalink)) return f;
  }
  return HOME_INDEX_FILES.find((f) => fs.existsSync(path.join(siteRoot, f))) || null;
}

// Does the site's home page (`/`) render through the THEME's `default` layout?
//
//   - the home source is a top-level page with `permalink: /`, else
//     index.(html|md|markdown); none, or one without front matter, ⇒ false
//     (nothing wraps it).
//   - its `layout:` key, else the `_config.yml` `defaults:` layout for it;
//     none, `null` or `none` ⇒ false.
//   - each layout name resolves SITE `_layouts/` first (Jekyll's override
//     order), then the theme's; the chain follows each layout's own `layout:`.
//   - true when the chain reaches `default` NOT overridden by the site: the
//     theme always ships `default`, so that answer needs no theme files. A
//     site that overrides `default.html` itself returns false: the theme's
//     markup is then not guaranteed, and the site's own copy is the site's to
//     test.
//   - a site-owned layout with no parent, a layout found nowhere (Jekyll warns
//     and renders without it) or a cycle ⇒ false.
//
// Theme files are read only to follow a chain through a theme layout OTHER than
// `default` (e.g. `layout: page`). `themeLayoutsDir` defaults to
// resolveThemeLayoutsDir(siteRoot); if that finds nothing at the moment it is
// needed, this THROWS naming the candidates — call it inside a test, never at
// spec-file load, so a broken checkout fails that one test loudly instead of
// emptying the whole suite or skipping silently.
function homeUsesThemeLayout(siteRoot = defaultSiteRoot(), themeLayoutsDir) {
  const home = homeSourceFile(siteRoot);
  if (!home) return false;
  return pageUsesThemeLayout(siteRoot, home, themeLayoutsDir);
}

// The same decision for any page source `relPath` (relative to the site root),
// e.g. `404.html`: false when the file is missing or has no front matter. The
// scaffolder seeds a standalone 404.html that wraps itself in no layout
// (#23), so the theme's header and footer are not the site's promise there.
// Throws exactly like homeUsesThemeLayout: call it inside a test only.
function pageUsesThemeLayout(siteRoot, relPath, themeLayoutsDir) {
  if (!fs.existsSync(path.join(siteRoot, relPath))) return false;
  const fm = readFrontMatter(path.join(siteRoot, relPath));
  if (fm == null) return false;
  let name = Object.hasOwn(fm, "layout") ? fm.layout : defaultLayoutFor(siteRoot, relPath);

  const siteLayoutsDir = path.join(siteRoot, "_layouts");
  const seen = new Set();
  while (name != null && name !== "none" && name !== "") {
    name = String(name);
    if (seen.has(name)) return false;
    seen.add(name);
    const siteFile = findLayoutFile(siteLayoutsDir, name);
    if (!siteFile && name === "default") return true;
    let file = siteFile;
    if (!file) {
      if (themeLayoutsDir === undefined) themeLayoutsDir = resolveThemeLayoutsDir(siteRoot);
      if (!themeLayoutsDir || !fs.existsSync(themeLayoutsDir)) {
        const tried = themeLayoutsDir ? [themeLayoutsDir] : themeLayoutsDirCandidates(siteRoot);
        throw new Error(
          `${relPath}: layout "${name}" is not site-owned and no theme layouts ` +
            `directory was found (tried: ${tried.join(", ")})`,
        );
      }
      file = findLayoutFile(themeLayoutsDir, name);
      if (!file) return false;
    }
    const parent = readFrontMatter(file);
    name = parent && parent.layout;
  }
  return false;
}

// ── RENDERED signals (require a local Jekyll build) ──────────────────────

function renderedAdminConfigPath(siteRoot = defaultSiteRoot()) {
  return path.join(siteRoot, "_site", "admin", "config.yml");
}

// True once the gem's render hook has emitted `_site/admin/config.yml` — i.e.
// the local Jekyll build ran. Specs that read the rendered config should
// already self-skip on `!isBuilt(...)`; these capability predicates likewise
// only make a RENDERED claim when the build is present.
function isBuilt(siteRoot = defaultSiteRoot()) {
  return fs.existsSync(renderedAdminConfigPath(siteRoot));
}

// The collection names Decap will actually show — parsed from the RENDERED
// `_site/admin/config.yml` (the ground truth, AFTER base_collections opt-out
// + collections.site.yml splice). Returns [] when the site isn't built.
function adminCollections(siteRoot = defaultSiteRoot()) {
  const cfg = readYamlIfExists(renderedAdminConfigPath(siteRoot));
  const cols = (cfg && cfg.collections) || [];
  return cols.map((c) => c && c.name).filter(Boolean);
}

// Does the RENDERED admin config expose the named collection? This is the
// precise "an editor can actually edit <name> here" predicate — it reflects
// both the base_collections opt-out AND any site-custom collection. Returns
// false when the site isn't built (no rendered claim to make).
//
// Signature is (siteRoot, name) — siteRoot FIRST (see keepsBaseCollection).
function hasAdminCollection(siteRoot, name) {
  if (name === undefined) {
    name = siteRoot;
    siteRoot = defaultSiteRoot();
  }
  return adminCollections(siteRoot).includes(name);
}

// Built `_site/e2e/<slug>/index.html` present? The on-demand-noindex spec
// reads these; an opted-out consumer (no `e2e` collection, no `_e2e` source)
// renders none. Signature is (siteRoot, slug) — siteRoot FIRST.
function hasRenderedCanary(siteRoot, slug) {
  if (slug === undefined) {
    slug = siteRoot;
    siteRoot = defaultSiteRoot();
  }
  return fs.existsSync(path.join(siteRoot, "_site", "e2e", slug, "index.html"));
}

module.exports = {
  BASE_COLLECTION_NAMES,
  defaultSiteRoot,
  baseCollectionsKeepList,
  keepsBaseCollection,
  isSinglePageConsumer,
  hasSourcePosts,
  hasE2ECanaries,
  ARCHIVED_PDF_FIELDS_REF,
  ARCHIVED_PDF_FIELD_NAMES,
  archivedPdfSourceCollections,
  themeLayoutsDirCandidates,
  resolveThemeLayoutsDir,
  homeUsesThemeLayout,
  pageUsesThemeLayout,
  renderedAdminConfigPath,
  isBuilt,
  adminCollections,
  hasAdminCollection,
  hasRenderedCanary,
};
