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
const os = require("node:os");
const walk = require("acorn-walk");
const cap = require("./site-capabilities");
const { parse, calleeName, stringValue } = require("./spec-ast");

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

// ── #527: the platform coverage fixture must exercise the shared PDF fields ──
//
// The archived-PDF browser test in cms-editorial-workflow.spec.js used to call
// test.skip whenever the rendered config had no opted-in collection — and the
// platform fixture had none, so every run skipped it silently. The full fixture
// now opts `articles` in through its own seam; these lints keep it that way and
// keep the spec from sliding back to a silent skip.
test.describe("site-capabilities: archived_pdf_fields opt-in (#527)", () => {
  function seamSite(seam) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-seam-"));
    fs.mkdirSync(path.join(dir, "admin"));
    if (seam != null) fs.writeFileSync(path.join(dir, "admin", "collections.site.yml"), seam);
    return dir;
  }

  test("full fixture opts a folder collection into the shared PDF fields", () => {
    expect(
      cap.archivedPdfSourceCollections(FULL),
      "e2e/fixture-site/admin/collections.site.yml must opt a folder collection into " +
        `${cap.ARCHIVED_PDF_FIELDS_REF} — without it the archived-PDF browser test has ` +
        "nothing to drive on the platform fixture (#527)",
    ).toEqual(["articles"]);
  });

  test("opted-out fixture stays a NON-PDF consumer (its notes collection has no PDF fields)", () => {
    expect(cap.archivedPdfSourceCollections(SINGLEPAGE)).toEqual([]);
  });

  test("the predicate reads a $ref opt-in, an inline opt-in, and nothing else", () => {
    const ref = seamSite(
      [
        "  - name: articles",
        "    folder: _articles",
        "    fields:",
        "      - { name: title, widget: string }",
        `      - $ref: "${cap.ARCHIVED_PDF_FIELDS_REF}"`,
        "",
      ].join("\n"),
    );
    const inline = seamSite(
      [
        "  - name: media",
        "    folder: _media",
        "    fields:",
        ...cap.ARCHIVED_PDF_FIELD_NAMES.map((n) => `      - { name: ${n}, widget: string }`),
        "",
      ].join("\n"),
    );
    const partial = seamSite(
      [
        "  - name: notes",
        "    folder: _notes",
        "    fields:",
        "      - { name: pdf_public, widget: boolean }",
        "",
      ].join("\n"),
    );
    const fileCollection = seamSite(
      [
        "  - name: settings",
        "    files:",
        "      - { name: s, file: _data/s.yml, fields: [] }",
        "    fields:",
        `      - $ref: "${cap.ARCHIVED_PDF_FIELDS_REF}"`,
        "",
      ].join("\n"),
    );
    const none = seamSite(null);
    try {
      expect(cap.archivedPdfSourceCollections(ref)).toEqual(["articles"]);
      expect(cap.archivedPdfSourceCollections(inline)).toEqual(["media"]);
      expect(cap.archivedPdfSourceCollections(partial)).toEqual([]);
      expect(cap.archivedPdfSourceCollections(fileCollection)).toEqual([]);
      expect(cap.archivedPdfSourceCollections(none)).toEqual([]);
    } finally {
      for (const d of [ref, inline, partial, fileCollection, none]) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  });

  // AST, not regex: which calls sit inside which `if` is code SHAPE.
  test("the archived-PDF browser test skips only after asserting the site declared no opt-in", () => {
    const src = fs.readFileSync(path.join(HARNESS, "cms-editorial-workflow.spec.js"), "utf8");
    let callback = null;
    walk.full(parse(src), (node) => {
      if (node.type !== "CallExpression" || calleeName(node.callee) !== "test") return;
      const title = stringValue(node.arguments[0]) || "";
      if (title.startsWith("opted-in archived PDF fields")) callback = node.arguments.at(-1);
    });
    expect(callback, "cms-editorial-workflow.spec.js lost its archived-PDF test").not.toBeNull();

    const skips = [];
    walk.ancestor(callback, {
      CallExpression(node, ancestors) {
        if (calleeName(node.callee) === "test.skip") skips.push({ node, ancestors: [...ancestors] });
      },
    });
    expect(skips.length, "the archived-PDF test must keep its non-PDF-consumer skip").toBeGreaterThan(0);
    for (const { node, ancestors } of skips) {
      const where = `test.skip at line ${node.loc.start.line}`;
      const guard = [...ancestors].reverse().find((a) => a.type === "IfStatement");
      expect(guard, `${where} must sit inside the absence branch, not run unconditionally`).toBeTruthy();
      const before = [];
      walk.full(guard.consequent, (n) => {
        if (n.type === "CallExpression" && n.start < node.start) before.push(calleeName(n.callee));
      });
      expect(
        before.some((name) => name && name.endsWith("archivedPdfSourceCollections")),
        `${where} must be preceded by cap.archivedPdfSourceCollections(SITE_ROOT) — a site that ` +
          "declares the shared PDF fields must FAIL when the render drops them, not skip (#527)",
      ).toBe(true);
      expect(before, `${where} must be preceded by an expect() on the declared opt-ins`).toContain(
        "expect",
      );
    }
  });
});
