// @lane: local — pure-fs unit test for e2e/site-capabilities.js, the shared
// base_collections-aware capability helper. Runs against BOTH fixture shapes:
// the full fixture-site (all generic collections + _e2e canaries) and the
// opted-out fixture-site-singlepage (cms.base_collections: [] + one custom
// folder collection, NO _posts/_e2e).
//
// These two fixtures are the platform's own proof that the capability
// predicates discriminate a full consumer from a single-page consumer — and,
// downstream, that the generic-content specs guarded on those predicates SKIP
// on the opted-out shape while RUNNING on the full shape (see
// e2e/base-collections-skip-meta.test.js).
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const cap = require("./site-capabilities");

const HARNESS = __dirname;
const FULL = path.join(HARNESS, "fixture-site");
const SINGLEPAGE = path.join(HARNESS, "fixture-site-singlepage");

// The capability predicates that read the RENDERED admin config need a built
// `_site/admin/config.yml`. The meta-test builds both fixtures; when run in
// isolation without that build, skip the admin-config-dependent assertions
// rather than ENOENT-fail (mirrors the existing rendered-config self-skips).
const FULL_BUILT = fs.existsSync(path.join(FULL, "_site", "admin", "config.yml"));
const SINGLEPAGE_BUILT = fs.existsSync(path.join(SINGLEPAGE, "_site", "admin", "config.yml"));

test.describe("site-capabilities: base_collections keep-list semantics", () => {
  test("full fixture keeps all base collections (cms.base_collections unset)", () => {
    // Unset keep-list ⇒ null ⇒ every base collection kept (back-compat default).
    expect(cap.baseCollectionsKeepList(FULL)).toBeNull();
    for (const name of ["posts", "tags", "projects", "pages", "e2e"]) {
      expect(cap.keepsBaseCollection(FULL, name), `full keeps ${name}`).toBe(true);
    }
    expect(cap.isSinglePageConsumer(FULL)).toBe(false);
  });

  test("opted-out fixture keeps NO base collections (cms.base_collections: [])", () => {
    expect(cap.baseCollectionsKeepList(SINGLEPAGE)).toEqual([]);
    for (const name of ["posts", "tags", "projects", "pages", "e2e"]) {
      expect(cap.keepsBaseCollection(SINGLEPAGE, name), `singlepage drops ${name}`).toBe(false);
    }
    expect(cap.isSinglePageConsumer(SINGLEPAGE)).toBe(true);
  });
});

test.describe("site-capabilities: admin collection presence (rendered config)", () => {
  test("full fixture's rendered admin config exposes the generic collections", () => {
    test.skip(!FULL_BUILT, `${FULL}/_site/admin/config.yml not built — run the meta-test build`);
    const names = cap.adminCollections(FULL);
    for (const name of ["posts", "tags", "projects", "pages", "e2e"]) {
      expect(names, `full admin config lists ${name}`).toContain(name);
      expect(cap.hasAdminCollection(FULL, name)).toBe(true);
    }
  });

  test("opted-out fixture's rendered admin config drops the generic collections", () => {
    test.skip(
      !SINGLEPAGE_BUILT,
      `${SINGLEPAGE}/_site/admin/config.yml not built — run the meta-test build`,
    );
    const names = cap.adminCollections(SINGLEPAGE);
    for (const name of ["posts", "tags", "projects", "pages", "e2e"]) {
      expect(cap.hasAdminCollection(SINGLEPAGE, name), `singlepage drops ${name}`).toBe(false);
    }
    // …but the site's OWN custom collection survives the opt-out.
    expect(names, "singlepage keeps its custom 'notes' collection").toContain("notes");
    expect(cap.hasAdminCollection(SINGLEPAGE, "notes")).toBe(true);
  });
});

test.describe("site-capabilities: E2E canary presence", () => {
  test("full fixture has _e2e canaries", () => {
    expect(cap.hasE2ECanaries(FULL)).toBe(true);
  });

  test("opted-out fixture has NO _e2e canaries", () => {
    expect(cap.hasE2ECanaries(SINGLEPAGE)).toBe(false);
  });

  test("rendered canary pages: full has them, singlepage does not", () => {
    test.skip(
      !FULL_BUILT || !SINGLEPAGE_BUILT,
      "both fixtures must be built for the rendered-canary check",
    );
    expect(cap.hasRenderedCanary(FULL, "canary-post")).toBe(true);
    expect(cap.hasRenderedCanary(SINGLEPAGE, "canary-post")).toBe(false);
  });
});

test.describe("site-capabilities: posts/source content", () => {
  test("full fixture has _posts; opted-out fixture does not", () => {
    expect(cap.hasSourcePosts(FULL)).toBe(true);
    expect(cap.hasSourcePosts(SINGLEPAGE)).toBe(false);
  });
});
