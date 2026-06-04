/*
 * REGISTRY — the single source of truth for the base_collections skip-guards on
 * the CONSUMER-RUNNING @admin-write / @admin-read / @admin-screenshots specs that
 * drive `/admin/index-local.html` (issue #33, CONCERN A).
 *
 * WHY (the gap PR #34's first pass missed)
 * ----------------------------------------
 * A single-page consumer that opts out of the platform's base collections via
 * `cms.base_collections: []` (v0.1.7; e.g. jodidaniel.com) renders its LOCAL-dev
 * Decap config (`_site/admin/config-local.yml`) with the posts/tags/projects/
 * pages collection blocks STRIPPED — the gem's `decap_config_hook.rb` applies the
 * keep-list deletion to BOTH config.yml AND config-local.yml (and config-local
 * has no `__SITE_COLLECTIONS__` marker, so the site's OWN custom collections
 * aren't spliced back into local-dev either — see AGENTS.md "config-local
 * single-page limitation"). So a consumer's LOCAL admin shows NO collections.
 *
 * The first #33 pass guarded the read-only / config / served-content specs but
 * NOT the ~dozen @admin-write/@admin-read/@admin-screenshots specs that navigate
 * `/admin/index-local.html#/collections/{posts,projects,pages,tags}/...` or wait
 * for the posts/tags/projects/pages SIDEBAR LINK. On a `base_collections: []`
 * consumer every one of those would time out (the link / route never appears) —
 * permanently RED. This registry guards each PRECISELY.
 *
 * KEY SIGNAL CHOICE — build-INDEPENDENT SOURCE signal
 * ---------------------------------------------------
 * These specs drive `index-local.html` → `config-local.yml`. We key the skip on
 * `site-capabilities.keepsBaseCollection(siteRoot, name)`, which reads the
 * consumer's `_config.yml` `cms.base_collections` keep-list — a pure SOURCE read
 * that needs NO Jekyll build. So the guard resolves correctly even in a lane
 * where `_site/` isn't built (and matches the gem's deletion: a name absent from
 * the keep-list is the name the hook strips from config-local).
 *
 * PRECISION — each spec is guarded on EXACTLY the collection(s) it exercises:
 *   - mode "all": skip unless ALL listed collections are kept. Used by specs that
 *     hard-assert the whole base sidebar (posts AND tags AND projects AND pages).
 *     A consumer that keeps posts but drops pages must still skip — the spec would
 *     fail on the missing pages link otherwise.
 *   - mode "any" (a single-element list is the common case): skip unless the one
 *     collection the spec drives is kept.
 *
 * HOW A NEW GENERIC-COLLECTION SPEC MUST REGISTER (drift lock)
 * -----------------------------------------------------------
 * Any NEW consumer-running spec that drives `/admin/index-local.html` and
 * navigates `#/collections/<base>` or waits for a base-collection sidebar link
 * MUST add an entry here AND apply the matching inline guard (see
 * applyGuard / guardReason below). `base-collections-guard-registry.test.js`
 * (a pure-fs lint in self-CI's node-unit-lints lane) goes RED if:
 *   (a) a registered spec loses its inline guard, or
 *   (b) a NEW index-local generic-collection spec appears that's neither
 *       registered here nor in the lint's explicit NON_GUARDED allowlist.
 * So the guard set can't silently drift.
 */
const cap = require("./site-capabilities");

// The registry. Keyed by spec basename. Each entry:
//   collections : the base-collection name(s) the spec drives / asserts.
//   mode        : "all"  → skip unless EVERY listed collection is kept.
//                 "any"  → skip unless the (single) listed collection is kept.
//   reason      : the human-readable skip message (always ends "(#33)").
//
// All values are derived from a re-audit of every consumer-running spec
// (target:local, NOT in playwright.config.js PLATFORM_META_SPECS) that drives
// admin/index-local.html (config-local.yml → honours base_collections).
const ADMIN_WRITE_GUARDS = {
  // ── posts-only specs ─────────────────────────────────────────────────────
  "cms-featured-image-lifecycle.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — no Posts editor to drive the featured-image lifecycle (#33)',
  },
  "cms-html-embed.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — no Posts editor to drive the HTML-embed round-trip (#33)',
  },
  "cms-image-upload.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — no Posts editor to drive the image-upload round-trip (#33)',
  },
  "cms-inline-image.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — no Posts editor to drive the inline-image round-trip (#33)',
  },
  "cms-link-crawler.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — the crawler waits for the Posts sidebar link that never renders (#33)',
  },
  "cms-publish-flow.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — no Posts editor to drive the create→build→browse publish loop (#33)',
  },
  "cms-posts-list-runtime.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — the posts-list dashboard waits for the Posts sidebar link that never renders (#33)',
  },
  "manual-walkthrough-content-guide.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — the content-guide walkthrough drives the Posts editor (#33)',
  },
  "manual-walkthrough-first-post.spec.js": {
    collections: ["posts"],
    mode: "any",
    reason:
      'consumer opts out of the "posts" collection via cms.base_collections — the first-post walkthrough drives the Posts editor (#33)',
  },

  // ── pages-only ───────────────────────────────────────────────────────────
  "cms-page-crud.spec.js": {
    collections: ["pages"],
    mode: "any",
    reason:
      'consumer opts out of the "pages" collection via cms.base_collections — no Pages editor to round-trip page CRUD (#33)',
  },

  // ── projects-only ────────────────────────────────────────────────────────
  "cms-project-crud.spec.js": {
    collections: ["projects"],
    mode: "any",
    reason:
      'consumer opts out of the "projects" collection via cms.base_collections — no Projects editor to round-trip project CRUD (#33)',
  },
  "cms-project-gallery.spec.js": {
    collections: ["projects"],
    mode: "any",
    reason:
      'consumer opts out of the "projects" collection via cms.base_collections — no Projects editor to drive the gallery widget (#33)',
  },

  // ── full-sidebar specs (skip unless ALL base collections kept) ───────────
  "cms-smoke.spec.js": {
    collections: ["posts", "tags", "projects", "pages"],
    mode: "all",
    reason:
      "consumer opts out of the base collections via cms.base_collections — the smoke test hard-asserts the Posts/Tags/Projects/Pages sidebar links (#33)",
  },
  "manual-walkthrough-contributor.spec.js": {
    collections: ["posts", "tags", "projects", "pages"],
    mode: "all",
    reason:
      "consumer opts out of the base collections via cms.base_collections — the contributor walkthrough asserts the full Posts/Tags/Projects/Pages sidebar (#33)",
  },
};

// Decide whether `siteRoot` should SKIP the registered spec. Uses the
// build-INDEPENDENT keep-list source signal. mode "all" ⇒ skip when ANY listed
// collection is dropped; mode "any" ⇒ skip when the (single) collection is
// dropped. An unknown spec name is a programmer error — throw loudly.
function shouldSkip(siteRoot, specBasename) {
  const entry = ADMIN_WRITE_GUARDS[specBasename];
  if (!entry) {
    throw new Error(
      `base-collections-guards: no registry entry for "${specBasename}" — add one (and the inline guard) or it can't be guarded.`,
    );
  }
  const kept = entry.collections.map((name) => cap.keepsBaseCollection(siteRoot, name));
  if (entry.mode === "all") {
    // skip unless every listed collection is kept
    return kept.some((k) => !k);
  }
  // mode "any" — skip unless the single collection is kept
  return kept.some((k) => !k);
}

// The skip message for a registered spec.
function guardReason(specBasename) {
  const entry = ADMIN_WRITE_GUARDS[specBasename];
  if (!entry) {
    throw new Error(`base-collections-guards: no registry entry for "${specBasename}".`);
  }
  return entry.reason;
}

// Convenience for the specs: returns [skipBool, reason] for `test.skip(...)`.
// Call sites pass the SITE_ROOT they already resolve + their own basename, so
// the guard reads identically in every spec and the lint can match it.
function guard(siteRoot, specBasename) {
  return [shouldSkip(siteRoot, specBasename), guardReason(specBasename)];
}

module.exports = {
  ADMIN_WRITE_GUARDS,
  GUARDED_SPEC_NAMES: Object.keys(ADMIN_WRITE_GUARDS),
  shouldSkip,
  guardReason,
  guard,
};
