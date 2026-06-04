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
  renderedAdminConfigPath,
  isBuilt,
  adminCollections,
  hasAdminCollection,
  hasRenderedCanary,
};
