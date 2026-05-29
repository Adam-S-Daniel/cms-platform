// @lane: local — pure-fs invariants on the RENDERED _site/admin/config.yml; no browser navigation
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

// Locks in the editor-experience invariants of the Decap CMS configs.
// These properties together close the gaps documented in the content-workflow
// review: drafts go through PRs (not straight to main), the auto-overwritten
// reading_time field doesn't waste editor time, the precedence between
// `published` and `publish_date` is explicit, the real-layout preview URL is
// discoverable from the editor, tags can be created inline, and the media
// path is flat + template-free so an uploaded file's on-disk path is
// byte-identical to the URL written into content (no broken images, no
// literal `{{year}}` in the standalone Media library's Copy Path).

// SITE_ROOT-aware config resolution. The gem's Decap render hook
// (scripts/render-decap-config.rb) emits the LIVE Decap config to
// `<site>/_site/admin/config.yml` during the local-lane build — there is no
// hand-authored source `admin/config.yml` (the platform ships only
// `admin/config.base.yml` templates). So assert the RENDERED config, the
// exact bytes Decap loads at runtime. In a consumer SITE_ROOT points at the
// site; in the platform's own self-CI it falls back to the harness's parent
// (which is the platform/site root — same invariant base.js's REPO_ROOT
// relies on). The config-local.yml / config-test.yml variants are
// platform-only test scaffolding (config-test.yml is never even rendered,
// and config-local.yml only matters to the local-backend decap-server), so
// the cross-config "shared verbatim across all three" parity checks are
// dropped here — only the production-config invariants against the rendered
// config remain.
const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || REPO_ROOT;
const RENDERED_CONFIG = path.join(SITE_ROOT, "_site", "admin", "config.yml");
const CONFIGS = [RENDERED_CONFIG];

// Parse a Decap config file with the real YAML parser, so collections,
// fields, widgets, hints, and any future anchors are read as structure
// rather than scraped line-by-line.
function parseConfig(file) {
  return YAML.parse(fs.readFileSync(file, "utf8")) || {};
}

// A collection object by name (Decap `collections:` is a YAML list).
function findCollection(cfg, name) {
  return ((cfg && cfg.collections) || []).find((c) => c && c.name === name) || null;
}

// A field object by name within a collection (`fields:` is a YAML list).
function findField(collection, fieldName) {
  return ((collection && collection.fields) || []).find((f) => f && f.name === fieldName) || null;
}

test.describe("Decap CMS config invariants", () => {
  test.describe.configure({ mode: "serial" });

  // The rendered config only exists after the local Jekyll build + the gem's
  // Decap render hook run. Skip (rather than ENOENT-fail) when `_site` isn't
  // built — mirrors the sitemap.spec self-skip so the preview/prod lanes
  // (which crawl deployed surfaces and never build `_site`) stay green.
  test.beforeEach(() => {
    test.skip(
      !fs.existsSync(RENDERED_CONFIG),
      `${RENDERED_CONFIG} not built (run the local Jekyll build + render-decap-config.rb) — rendered-config invariants only run in the local lane`,
    );
  });

  for (const configPath of CONFIGS) {
    const label = path.relative(SITE_ROOT, configPath);

    test(`${label}: media_folder/public_folder are flat, template-free, and consistent`, () => {
      // Decap appends ONLY the uploaded file's basename to
      // public_folder; it does not mirror any media_folder
      // subdirectory into the URL it writes into content. So the only
      // configuration where the committed file and its served URL
      // resolve to the same place — on every backend and from the
      // standalone Media library (which has no entry/date context) —
      // is a flat path with public_folder == "/" + media_folder.
      //
      // This replaces the old "media_folder contains {{year}}/{{month}}"
      // assertion. That assertion encoded a string-substitution
      // *assumption* (that the GitHub backend would expand the tokens
      // and that Jekyll would serve the file from a different path than
      // it was written to) that was never true end-to-end: it produced
      // broken images in posts and a literal `{{year}}` "Copy Path" in
      // the Media library. We verify the structural invariant that
      // actually makes uploads resolve, not a templated string.
      const cfg = parseConfig(configPath);
      expect(cfg.media_folder, "media_folder must be set").toBeTruthy();
      expect(cfg.public_folder, "public_folder must be set").toBeTruthy();
      const mediaFolder = String(cfg.media_folder);
      const publicFolder = String(cfg.public_folder);

      // No template tokens anywhere — they cannot be resolved by the
      // standalone Media library and desync the on-disk vs. URL path.
      expect(
        mediaFolder,
        "media_folder must not contain Decap template tokens (e.g. {{year}})",
      ).not.toMatch(/\{\{.*?\}\}/);
      expect(publicFolder, "public_folder must not contain Decap template tokens").not.toMatch(
        /\{\{.*?\}\}/,
      );

      // The exact path is pinned so a future edit can't quietly
      // reintroduce nesting.
      expect(mediaFolder).toBe("assets/images/uploads");

      // public_folder is the URL form of the SAME directory: a single
      // leading slash, then byte-identical to media_folder. This is
      // the property that guarantees `<media_folder>/<file>` on disk
      // is served at `<public_folder>/<file>`.
      expect(publicFolder).toBe(`/${mediaFolder}`);
    });

    test(`${label}: posts collection has no editor-facing reading_time field`, () => {
      const posts = findCollection(parseConfig(configPath), "posts");
      expect(posts, "posts collection must exist").not.toBeNull();
      // reading_time is auto-calculated at build time; surfacing it in the
      // editor is misleading because any value is overwritten on deploy.
      expect(findField(posts, "reading_time")).toBeNull();
    });

    test(`${label}: posts.tags widget allows inline creation`, () => {
      const posts = findCollection(parseConfig(configPath), "posts");
      const tags = findField(posts, "tags");
      expect(tags, "posts.tags field must exist").not.toBeNull();
      // Decap's relation widget only picks from existing entries —
      // inline creation requires the list-of-strings widget. The
      // auto_tag_pages plugin generates archive pages for any string
      // tag, so we don't need a curated `_tags/` entry up front.
      expect(tags.widget).toBe("list");
      expect(tags.widget).not.toBe("relation");
    });

    test(`${label}: posts.published hint clarifies precedence over publish_date`, () => {
      const posts = findCollection(parseConfig(configPath), "posts");
      const published = findField(posts, "published");
      expect(published, "posts.published field must exist").not.toBeNull();
      // Editors must be able to predict which field wins — the hint should
      // call out that `published: true` publishes immediately and that the
      // scheduled date only fires when this toggle is left off.
      expect(String(published.hint || "").toLowerCase()).toMatch(/leave.*off|off.*to schedule/);
    });

    test(`${label}: posts.body hint surfaces the real-layout /preview/ URL`, () => {
      const posts = findCollection(parseConfig(configPath), "posts");
      const body = findField(posts, "body");
      expect(body, "posts.body field must exist").not.toBeNull();
      // The /preview/ route renders draft content using the real Jekyll
      // layouts — strictly better than the in-editor markdown preview, but
      // there's no in-CMS UI for it, so it has to live in the hint text.
      expect(String(body.hint || "")).toContain("/preview/?collection=posts");
    });
  }

  test("rendered admin/config.yml enables the editorial workflow", () => {
    const cfg = parseConfig(RENDERED_CONFIG);
    // Without this, every Save commits straight to main and bypasses the
    // PR-based draft → preview → visual-regression-approval pipeline that
    // the rest of the system (cms-editorial-workflow.yml, the cms/draft
    // and cms/ready labels, /admin/reviews/) is built around.
    expect(cfg.publish_mode).toBe("editorial_workflow");
  });

  // The former "admin/config-test.yml uses test-repo backend" assertion was
  // dropped: config-test.yml is platform-only test scaffolding (the
  // editorial-workflow spec's test-repo entrypoint) — the render hook never
  // emits it into `_site/admin/`, so a consumer has no rendered test config
  // to assert against. The editorial-workflow code path is still exercised
  // by cms-editorial-workflow.spec.js itself in the platform self-CI.

  // ── Editor capability invariants ─────────────────────────────────────
  //
  // These lock in *what an editor can do* per collection — create new
  // entries, delete existing ones, attach images, etc. If a future
  // config edit removes a capability by accident, these tests fail fast.

  for (const configPath of CONFIGS) {
    const label = path.relative(SITE_ROOT, configPath);

    test(`${label}: each content collection allows create + delete`, () => {
      const cfg = parseConfig(configPath);
      // Tags / Posts / Projects / Pages must all be folder collections
      // with create + delete explicitly true so editors get the full
      // CRUD affordances in the Decap UI. Spelling them out keeps the
      // intent visible in the YAML — defaults can shift between major
      // versions.
      for (const name of ["posts", "tags", "projects", "pages"]) {
        const chunk = findCollection(cfg, name);
        expect(chunk, `${name} collection must exist`).not.toBeNull();
        expect(chunk.folder, `${name} must be a folder collection`).toBeTruthy();
        expect(chunk.create, `${name} must set create: true`).toBe(true);
        expect(chunk.delete, `${name} must set delete: true`).toBe(true);
      }
    });

    test(`${label}: posts collection exposes title, date, body, tags, featured_image`, () => {
      const posts = findCollection(parseConfig(configPath), "posts");
      for (const f of ["title", "date", "body", "tags", "featured_image", "published"]) {
        expect(findField(posts, f), `posts.${f} field must exist`).not.toBeNull();
      }
      const featured = findField(posts, "featured_image");
      expect(featured.widget).toBe("image");
    });

    test(`${label}: projects collection exposes a multi-image gallery`, () => {
      const projects = findCollection(parseConfig(configPath), "projects");
      const images = findField(projects, "images");
      expect(images, "projects.images field must exist").not.toBeNull();
      // List widget with a nested image field — the standard Decap
      // recipe for "an ordered, repeatable image gallery" (drag-to-
      // reorder, individual remove). The nested field can be declared
      // singular (`field:`) or as a one-element `fields:` list.
      expect(images.widget).toBe("list");
      const nested = images.field ? [images.field] : images.fields || [];
      expect(
        nested.some((f) => f && f.widget === "image"),
        "projects.images must nest an image field",
      ).toBe(true);
    });

    test(`${label}: tags collection exposes name + description`, () => {
      const tags = findCollection(parseConfig(configPath), "tags");
      expect(findField(tags, "name"), "tags.name must exist").not.toBeNull();
      expect(findField(tags, "description"), "tags.description must exist").not.toBeNull();
    });

    test(`${label}: pages collection exposes title, body, permalink, published`, () => {
      const pages = findCollection(parseConfig(configPath), "pages");
      for (const f of ["title", "body", "permalink", "published"]) {
        expect(findField(pages, f), `pages.${f} must exist`).not.toBeNull();
      }
      // Permalink is now a string (editor-visible) rather than hidden,
      // since editors creating new pages need to set it.
      const permalink = findField(pages, "permalink");
      expect(permalink.widget).toBe("string");
    });

    // ── Audit finding #19: relation-widget creep ─────────────────────
    //
    // The Decap `relation` widget only picks from existing entries —
    // it disables inline creation and would break the auto_tag_pages
    // plugin's "manufacture an archive page for any string tag" loop.
    // We've never had a relation widget in this repo; the invariant
    // makes sure a future contributor doesn't slip one in (the
    // posts.tags-specific check above would only catch the tags
    // field).
    test(`${label}: no widget: relation appears anywhere in the config`, () => {
      const cfg = parseConfig(configPath);
      expect(
        JSON.stringify(cfg),
        "the relation widget is incompatible with the auto_tag_pages plugin (it requires every value to be a curated entry); use list/string instead",
      ).not.toContain('"widget":"relation"');
    });
  }

  // ── Audit finding #7: preview_path / permalink contract ─────────────
  //
  // Decap's "View on Live Site" button substitutes `{{slug}}` into the
  // collection's `preview_path` and opens the result. Jekyll renders
  // each entry at its `permalink:` template (`_config.yml`). When the
  // two diverge, the button 404s — invisible to a routine spec, very
  // visible to an editor mid-publish. This test rebuilds the URL Jekyll
  // would emit from `_config.yml` and asserts it matches preview_path
  // (with `{{slug}}` → a fixture slug).
  //
  // Pages are a special case: pages don't share a global Jekyll
  // permalink template (each entry sets its own front-matter
  // permalink). The contract is that pages.preview_path matches the
  // PER-ENTRY permalink convention enforced by admin/config.yml's
  // `pages.permalink.pattern` default ("/pages/<slug>/").

  function previewPathFor(cfg, collection) {
    const c = findCollection(cfg, collection);
    return c && c.preview_path != null ? String(c.preview_path) : null;
  }

  // The earlier "preview_path round-trips" test that lived here substituted
  // `{{slug}}` → "foo-bar" on Decap's side and `:slug` → "foo-bar" on
  // Jekyll's side and asserted equality. That passed tautologically because
  // it didn't model Decap's TWO-PASS expansion — for posts, the `slug:`
  // template runs first and fills `{{slug}}` in `preview_path` with the
  // FILE slug (`YYYY-MM-DD-foo-bar`), not the field slug. The real contract
  // (and the divergence between Decap and Jekyll for posts) is now modelled
  // properly in `e2e/cms-permalink-contract.spec.js`.

  test("pages.preview_path matches the permalink default editors are nudged toward", () => {
    // Pages don't have a Jekyll-side global permalink template — each
    // page's front matter sets its own. The contract here is that
    // admin/config.yml's `pages.permalink.default` produces a path of
    // the same shape preview_path generates, so an editor who accepts
    // the default doesn't end up with a "View on Live Site" 404.
    const cfg = parseConfig(RENDERED_CONFIG);
    const previewPath = previewPathFor(cfg, "pages");
    expect(previewPath).not.toBeNull();

    const decapPreviewURL = previewPath.replace(/\{\{slug\}\}/g, "foo-bar");
    expect(decapPreviewURL).toBe("/pages/foo-bar/");

    const permalinkField = findField(findCollection(cfg, "pages"), "permalink");
    const permalinkDefault =
      permalinkField && permalinkField.default != null ? String(permalinkField.default) : null;
    expect(
      permalinkDefault,
      "pages.permalink should ship a `default:` so the New Page form pre-fills a sensible value",
    ).not.toBeNull();
    expect(
      decapPreviewURL.startsWith(permalinkDefault),
      `pages preview URL ${decapPreviewURL} must live under the permalink default ${permalinkDefault}`,
    ).toBe(true);
  });
});
