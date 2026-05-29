// @lane: local — cross-checks the RENDERED _site/admin Decap config + Jekyll permalink output via local fs
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

// E2 — Permalink contract cross-check.
//
// Decap CMS's "View on Live Site" toolbar substitutes `{{slug}}` into the
// collection's `preview_path` and opens the result. Jekyll renders each entry
// at its `permalink:` template (`_config.yml`).
//
// The subtle thing: for collections that ship a `slug:` template (Posts use
// `"{{year}}-{{month}}-{{day}}-{{slug}}"` so Jekyll's `_posts/` folder
// receives the date-prefixed filename it requires), Decap runs a TWO-PASS
// expansion. First the `slug:` template fills in `{{slug}}` from the entry's
// fields → produces the file slug, e.g. `2026-01-15-foo`. Then `preview_path`
// fills in its own `{{slug}}` from THAT result, NOT from the field slug. So
// `preview_path: "/blog/{{slug}}/"` becomes `/blog/2026-01-15-foo/` — but
// Jekyll's `permalink: /blog/:slug/` strips the date prefix and renders at
// `/blog/foo/`. The toolbar 404s.
//
// The earlier round-trip block at e2e/cms-config.spec.js:280-304 substituted
// the same fixture string into BOTH templates and asserted equality, which
// passed tautologically. This spec models the actual two-pass expansion
// Decap performs and asserts the contract that EITHER:
//
//   (a) the templates round-trip — Decap's preview URL equals Jekyll's URL
//       for the same field slug;
//   (b) an authoritative JS override exists at admin/native-preview-href.js
//       AND is loaded by all three index files (admin/index.html,
//       admin/index-local.html, admin/index-test.html). When the JS runs in
//       the browser, it rewrites the toolbar anchor's href via a
//       MutationObserver, so the static template divergence is fixed at
//       runtime.
//
// In current state: posts diverge AND override script exists → posts pass via
// the override fallback. Tags / projects / pages / e2e templates round-trip
// → pass directly.
//
// Pure-Node spec — no browser, no servers, just file I/O and YAML parse.

// SITE_ROOT-aware resolution. The Decap config + admin shell are RENDERED
// into `<site>/_site/admin/` by the gem's render hook during the local-lane
// build (the source `admin/config.yml` doesn't exist — only the
// `config.base.yml` template — and the index*.html / native-preview-href.js
// shells are likewise build-emitted into `_site/admin/`). So cross-check the
// rendered admin tree, the exact bytes the browser loads. `_config.yml` is
// the consuming site's own and stays at the site root.
const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || REPO_ROOT;
const SITE_ADMIN = path.join(SITE_ROOT, "_site", "admin");
const ADMIN_CONFIG = path.join(SITE_ADMIN, "config.yml");
const JEKYLL_CONFIG = path.join(SITE_ROOT, "_config.yml");
const NATIVE_PREVIEW_OVERRIDE = path.join(SITE_ADMIN, "native-preview-href.js");
// The rendered admin ships index.html + index-local.html (the render hook
// emits config-local.yml too). index-test.html is platform-only test
// scaffolding that the deploy/build drops, so it may be absent in a
// consumer; overrideScriptIsLoaded() below tolerates a missing shell by
// only requiring the override be referenced from the shells that DO exist.
const INDEX_FILES = [
  path.join(SITE_ADMIN, "index.html"),
  path.join(SITE_ADMIN, "index-local.html"),
  path.join(SITE_ADMIN, "index-test.html"),
];

// Synthetic entry — kept simple so the substitution math is obvious. The
// date must have two-digit month/day so the date_format pads correctly.
const SYNTHETIC = { slug: "foo", date: "2026-01-15" };

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

// Find a collection by name in the parsed admin/config.yml. Decap
// collections are a YAML list of objects — return the object, or null
// when absent.
function findCollection(adminCfg, name) {
  const cols = (adminCfg && adminCfg.collections) || [];
  return cols.find((c) => c && c.name === name) || null;
}

// Read a single key (e.g. `slug` / `preview_path`) off a collection
// object, as a string, or null when absent.
function readKey(collection, key) {
  const v = collection && collection[key];
  return v == null ? null : String(v);
}

// The per-collection permalink template from the parsed _config.yml.
// Top-level posts render at the document-root `permalink:`; other
// collection-typed entries live under `collections.<name>.permalink`.
function jekyllPermalinkFor(jekyllCfg, collection) {
  const v =
    collection === "posts"
      ? jekyllCfg && jekyllCfg.permalink
      : jekyllCfg &&
        jekyllCfg.collections &&
        jekyllCfg.collections[collection] &&
        jekyllCfg.collections[collection].permalink;
  return v == null ? null : String(v);
}

// Substitute `{{year}}`, `{{month}}`, `{{day}}`, `{{slug}}` from the synthetic
// entry. Mirrors what Decap does when expanding the `slug:` template. The
// values are zero-padded to match Decap's `date_format: YYYY-MM-DD`.
function expandSlugTemplate(template, entry) {
  const [year, month, day] = entry.date.split("-");
  return template
    .replace(/\{\{year\}\}/g, year)
    .replace(/\{\{month\}\}/g, month)
    .replace(/\{\{day\}\}/g, day)
    .replace(/\{\{slug\}\}/g, entry.slug);
}

// Substitute `{{slug}}` in a preview_path with the value Decap actually
// passes — the FILE SLUG produced by `expandSlugTemplate` above. The `{{slug}}`
// in `preview_path` is NOT the field slug.
function expandPreviewPath(previewPath, fileSlug) {
  return previewPath.replace(/\{\{slug\}\}/g, fileSlug);
}

// Substitute `:slug` in a Jekyll permalink with the FIELD slug (Jekyll's
// `:slug` strips the `_posts/` date prefix automatically).
function expandJekyllPermalink(permalink, fieldSlug) {
  return permalink.replace(/:slug/g, fieldSlug);
}

function overrideScriptIsLoaded() {
  // The override file must exist on disk AND be referenced from every
  // rendered index shell that's PRESENT. The "all three shells" requirement
  // is relaxed for consumer mode: the render hook emits index.html +
  // index-local.html but index-test.html is platform-only test scaffolding
  // that the build can drop, so a missing shell is tolerated — we require
  // the override be referenced from at least one present shell and from
  // every shell that does exist. (In the platform self-CI all three are
  // rendered, so this is identical to the old behaviour there.)
  if (!fs.existsSync(NATIVE_PREVIEW_OVERRIDE)) return false;
  const NEEDLE = /<script\s[^>]*src=["']native-preview-href\.js["']/;
  const present = INDEX_FILES.filter((file) => fs.existsSync(file));
  if (present.length === 0) return false;
  return present.every((file) => NEEDLE.test(readText(file)));
}

// Collections we model. Each entry says which Jekyll permalink to look up
// (`null` = pages, which are governed per-entry by their own front-matter
// `permalink:` rather than a Jekyll-level template).
const COLLECTIONS = [
  { name: "posts", jekyllKey: "posts" },
  { name: "tags", jekyllKey: "tags" },
  { name: "projects", jekyllKey: "projects" },
  { name: "pages", jekyllKey: null },
  { name: "e2e", jekyllKey: "e2e" },
];

test.describe("CMS permalink contract — Decap two-pass vs Jekyll", () => {
  // The rendered admin config only exists after the local Jekyll build +
  // render hook run; skip (rather than ENOENT-fail) when `_site` isn't built
  // — mirrors the sitemap.spec self-skip for the preview/prod lanes.
  test.beforeEach(() => {
    test.skip(
      !fs.existsSync(ADMIN_CONFIG),
      `${ADMIN_CONFIG} not built (run the local Jekyll build + render-decap-config.rb) — rendered-config permalink contract only runs in the local lane`,
    );
  });

  for (const { name, jekyllKey } of COLLECTIONS) {
    test(`${name} — Decap preview URL matches Jekyll URL (or override is loaded)`, () => {
      const adminCfg = YAML.parse(readText(ADMIN_CONFIG));
      const jekyllCfg = YAML.parse(readText(JEKYLL_CONFIG));
      const coll = findCollection(adminCfg, name);
      expect(coll, `admin/config.yml must define collection "${name}"`).not.toBeNull();

      const slugTemplate = readKey(coll, "slug") || "{{slug}}";
      const previewPath = readKey(coll, "preview_path");

      // Tags collection ships without a preview_path — there's no "View
      // Live" button to break, so the contract has nothing to assert. The
      // tag archive page itself is generated separately by the
      // auto_tag_pages plugin from string tags on posts.
      if (previewPath == null) {
        expect(
          name,
          `Only the tags collection is allowed to ship without a preview_path. ` +
            `If "${name}" should surface a "View Live" button, add preview_path.`,
        ).toBe("tags");
        return;
      }

      // Pages have a `preview_path` (for the toolbar) but no Jekyll-level
      // permalink template — each page sets its own front-matter
      // `permalink:`. So the toolbar's `/pages/{{slug}}/` substitution is
      // just a hint; the actual rendered URL is whatever the editor typed.
      // We still want to lock that the override's runtime computation
      // (which reads the permalink field directly) is what governs the
      // toolbar — the override fallback is the relevant safety net here
      // too. Skip the static URL comparison; assert the override is
      // present.
      if (name === "pages") {
        expect(
          overrideScriptIsLoaded(),
          `pages.preview_path uses {{slug}} but pages permalinks are per-entry. ` +
            `The runtime override at admin/native-preview-href.js must be loaded ` +
            `from all three index files so the toolbar reflects the entry's actual ` +
            `permalink field.`,
        ).toBe(true);
        return;
      }

      const permalink = jekyllPermalinkFor(jekyllCfg, jekyllKey);
      expect(
        permalink,
        `_config.yml must define a permalink for collection "${jekyllKey}"`,
      ).not.toBeNull();

      // Two-pass Decap expansion: first `slug:` produces the file slug, then
      // `preview_path`'s `{{slug}}` is replaced by THAT file slug.
      const fileSlug = expandSlugTemplate(slugTemplate, SYNTHETIC);
      const decapURL = expandPreviewPath(previewPath, fileSlug);
      // Jekyll's `:slug` is the field slug — the `_posts/` date prefix is
      // stripped automatically.
      const jekyllURL = expandJekyllPermalink(permalink, SYNTHETIC.slug);

      const roundTrips = decapURL === jekyllURL;
      const overrideLoaded = overrideScriptIsLoaded();

      // Assertion: pass if EITHER the templates round-trip OR the override
      // script is wired up. The fail message names the divergence and
      // points at the override path so the next contributor knows where to
      // look.
      expect(
        roundTrips || overrideLoaded,
        `Permalink contract broken for "${name}":\n` +
          `  slug template:  ${slugTemplate}\n` +
          `  preview_path:   ${previewPath}\n` +
          `  permalink:      ${permalink}\n` +
          `  Decap URL:      ${decapURL}\n` +
          `  Jekyll URL:     ${jekyllURL}\n` +
          `Either fix the templates so they round-trip, or load the JS override at\n` +
          `  admin/native-preview-href.js\n` +
          `from all three of admin/index.html, admin/index-local.html, admin/index-test.html.`,
      ).toBe(true);
    });
  }
});
