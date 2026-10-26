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
const { parse, calleeName, calleeTail, stringValue } = require("./spec-ast");

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

// ── v0.1.139 follow-up: theme home-page specs on a site-owned home layout ──
//
// public-a11y-polish.spec.js and reduced-motion.spec.js load `/` and assert the
// theme default layout's markup. jodidaniel.com's index.html uses its own
// _layouts/home.html, a full document that never chains to `default`, so those
// checks failed there (jodidaniel.com#351). The skip is decided from the site's
// SOURCE by homeUsesThemeLayout; these cases pin each branch of that decision.
test.describe("site-capabilities: homeUsesThemeLayout", () => {
  const THEME = cap.themeLayoutsDirCandidates()[0];

  // Builds a throwaway site root from { "relative/path": "contents" }.
  function siteTree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "home-layout-"));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  }
  const page = (frontMatter) => `---\n${frontMatter}\n---\n<p>body</p>\n`;
  const DOC = "<!DOCTYPE html>\n<html><body>{{ content }}</body></html>\n";

  const cases = [
    // adamdaniel.ai's shape: index.html `layout: default`, a site _layouts/
    // holding only an unrelated layout.
    [
      "theme default (adamdaniel.ai shape)",
      { "index.html": page("layout: default\ntitle: Home"), "_layouts/tool.html": DOC },
      true,
    ],
    // jodidaniel.com's shape: `layout: home`, the site's own full-document home.html.
    [
      "site home.html with no parent (jodidaniel.com shape)",
      { "index.html": page("layout: home"), "_layouts/home.html": DOC },
      false,
    ],
    [
      "site layout chaining to the theme default",
      { "index.html": page("layout: landing"), "_layouts/landing.html": page("layout: default") },
      true,
    ],
    ["theme layout that chains to default", { "index.html": page("layout: page") }, true],
    [
      "site override of default.html",
      { "index.html": page("layout: default"), "_layouts/default.html": DOC },
      false,
    ],
    [
      "site layout chaining to a site-overridden default",
      {
        "index.html": page("layout: landing"),
        "_layouts/landing.html": page("layout: default"),
        "_layouts/default.html": DOC,
      },
      false,
    ],
    [
      "layout cycle",
      {
        "index.html": page("layout: a"),
        "_layouts/a.html": page("layout: b"),
        "_layouts/b.html": page("layout: a"),
      },
      false,
    ],
    ["layout found nowhere", { "index.html": page("layout: missing") }, false],
    ["layout: null", { "index.html": page("layout: null") }, false],
    ["layout: none", { "index.html": page("layout: none") }, false],
    ["no index file", { "about.html": page("layout: default") }, false],
    ["index without front matter (copied verbatim)", { "index.html": DOC }, false],
    ["index.md on the theme default", { "index.md": page("layout: default") }, true],
    [
      "no layout key, _config.yml default for all pages",
      {
        "index.html": page("title: Home"),
        "_config.yml":
          'defaults:\n  - scope: { path: "", type: pages }\n    values: { layout: default }\n',
      },
      true,
    ],
    [
      "no layout key, a more specific default wins",
      {
        "index.html": page("title: Home"),
        "_layouts/home.html": DOC,
        "_config.yml":
          'defaults:\n  - scope: { path: index.html }\n    values: { layout: home }\n  - scope: { path: "", type: pages }\n    values: { layout: default }\n',
      },
      false,
    ],
    [
      "no layout key, a default scoped to another type or dir does not apply",
      {
        "index.html": page("title: Home"),
        "_config.yml":
          'defaults:\n  - scope: { path: "", type: posts }\n    values: { layout: default }\n  - scope: { path: pages }\n    values: { layout: default }\n',
      },
      false,
    ],
    ["no layout key, no defaults", { "index.html": page("title: Home") }, false],
    [
      "explicit layout beats a default",
      {
        "index.html": page("layout: home"),
        "_layouts/home.html": DOC,
        "_config.yml": 'defaults:\n  - scope: { path: "" }\n    values: { layout: default }\n',
      },
      false,
    ],
  ];
  for (const [name, files, expected] of cases) {
    test(`${name} → ${expected}`, () => {
      const dir = siteTree(files);
      try {
        expect(cap.homeUsesThemeLayout(dir, THEME)).toBe(expected);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // The two fixtures cover both answers, so the fixture-e2e public lane runs
  // the theme-markup checks on one and their skips on the other (#702).
  test("the full fixture renders home through the theme default; the single-page one does not", () => {
    expect(cap.homeUsesThemeLayout(FULL, THEME)).toBe(true);
    expect(cap.homeUsesThemeLayout(SINGLEPAGE, THEME)).toBe(false);
  });

  test("pageUsesThemeLayout answers for any page: the scaffolded 404 seed is standalone", () => {
    const site = siteTree({
      "404.html": "---\npermalink: /404.html\ntitle: Page Not Found\n---\n" + DOC,
      "about.html": page("layout: page"),
    });
    try {
      expect(cap.pageUsesThemeLayout(site, "404.html", THEME)).toBe(false);
      expect(cap.pageUsesThemeLayout(site, "about.html", THEME)).toBe(true);
      expect(cap.pageUsesThemeLayout(site, "missing.html", THEME)).toBe(false);
      // The fixture carries the scaffolder's seed; both consumers wrap theirs
      // in `layout: default`, as the single-page fixture does.
      expect(cap.pageUsesThemeLayout(FULL, "404.html", THEME)).toBe(false);
      expect(cap.pageUsesThemeLayout(SINGLEPAGE, "404.html", THEME)).toBe(true);
    } finally {
      fs.rmSync(site, { recursive: true, force: true });
    }
  });

  test("a top-level page with `permalink: /` is the home page, over index.*", () => {
    const viaPermalink = siteTree({
      "index.html": page("layout: default"),
      "home.md": page("layout: home\npermalink: /"),
      "_layouts/home.html": DOC,
    });
    const indexOnly = siteTree({
      "index.html": page("layout: default"),
      "about.md": page("layout: home\npermalink: /about/"),
      "broken.html": "---\nlayout: [unclosed\n---\n",
      "_layouts/home.html": DOC,
    });
    try {
      expect(cap.homeUsesThemeLayout(viaPermalink, THEME)).toBe(false);
      expect(cap.homeUsesThemeLayout(indexOnly, THEME)).toBe(true);
    } finally {
      fs.rmSync(viaPermalink, { recursive: true, force: true });
      fs.rmSync(indexOnly, { recursive: true, force: true });
    }
  });

  // The consumer local lane COPIES the harness to `<site>/e2e`, so
  // `<harness>/../theme` is the site, which has no theme/ (it uses the gem);
  // the platform checkout survives at `<site>/.cms-platform/`.
  test("copied-harness layout: the theme resolves from <site>/.cms-platform", () => {
    const site = siteTree({
      "index.html": page("layout: page"),
      "e2e/playwright.config.js": "",
      ".cms-platform/theme/_layouts/page.html": page("layout: default"),
      ".cms-platform/theme/_layouts/default.html": DOC,
    });
    try {
      const harness = path.join(site, "e2e");
      const dir = cap.resolveThemeLayoutsDir(site, harness);
      expect(dir).toBe(path.join(site, ".cms-platform", "theme", "_layouts"));
      expect(cap.homeUsesThemeLayout(site, dir)).toBe(true);
    } finally {
      fs.rmSync(site, { recursive: true, force: true });
    }
  });

  test("the harness's own platform checkout is preferred when it has a theme", () => {
    expect(cap.resolveThemeLayoutsDir(FULL)).toBe(THEME);
    expect(fs.existsSync(THEME)).toBe(true);
  });

  test("no theme found: `default` still resolves, another theme layout throws", () => {
    const site = siteTree({ "index.html": page("layout: default"), "e2e/x.js": "" });
    const viaPage = siteTree({ "index.html": page("layout: page"), "e2e/x.js": "" });
    try {
      expect(cap.resolveThemeLayoutsDir(site, path.join(site, "e2e"))).toBeNull();
      // The theme always ships `default`; deciding that needs no theme files.
      expect(cap.homeUsesThemeLayout(site, null)).toBe(true);
      expect(() => cap.homeUsesThemeLayout(viaPage, null)).toThrow(
        /layout "page" is not site-owned and no theme layouts directory was found/,
      );
    } finally {
      fs.rmSync(site, { recursive: true, force: true });
      fs.rmSync(viaPage, { recursive: true, force: true });
    }
  });

  // A throw at spec-file load empties the whole consumer suite (Playwright
  // loads zero tests), so the specs must call the predicates inside tests only.
  // AST, not regex: where a call sits is code SHAPE. A spec-local wrapper that
  // calls a predicate (public-a11y-polish's skipUnlessHomeUsesTheme) is a
  // predicate too, transitively (#702), and a describe callback or an IIFE runs
  // at load, so neither counts as deferring the call.
  test("the gated specs call the layout predicates only inside a test, never at load", () => {
    const gated = [];
    for (const spec of fs.readdirSync(HARNESS).filter((f) => f.endsWith(".spec.js")).sort()) {
      const loadTime = layoutPredicateLoadTimeCalls(fs.readFileSync(path.join(HARNESS, spec), "utf8"));
      if (loadTime === null) continue;
      gated.push(spec);
      expect(loadTime, `${spec}: a layout predicate must not run at file load`).toEqual([]);
    }
    for (const spec of [
      "not-found.spec.js",
      "public-a11y-polish.spec.js",
      "reduced-motion.spec.js",
    ]) {
      expect(gated, `${spec} must gate on a layout predicate`).toContain(spec);
    }
  });

  test("the load-time lint catches a direct call, a wrapper call, a describe body and an IIFE", () => {
    const wrapper = `
      const cap = require("./site-capabilities");
      function skipUnless() { test.skip(!cap.homeUsesThemeLayout(), "x"); }
      const viaArrow = () => skipUnless();
    `;
    const red = {
      direct: `const cap = require("./site-capabilities"); const on = cap.homeUsesThemeLayout();`,
      page: `const cap = require("./site-capabilities"); cap.pageUsesThemeLayout(".", "404.html");`,
      "top-level wrapper": `${wrapper} skipUnless();`,
      "two-level wrapper": `${wrapper} viaArrow();`,
      "describe body": `${wrapper} test.describe("d", () => { skipUnless(); });`,
      "describe.serial body": `${wrapper} test.describe.serial("d", function () { viaArrow(); });`,
      iife: `${wrapper} (() => { skipUnless(); })();`,
    };
    for (const [name, src] of Object.entries(red)) {
      expect(layoutPredicateLoadTimeCalls(src), name).not.toEqual([]);
    }
    const green = `${wrapper}
      test.describe("d", () => {
        test.beforeEach(() => skipUnless());
        test("t", async () => { viaArrow(); cap.pageUsesThemeLayout(".", "404.html"); });
      });`;
    expect(layoutPredicateLoadTimeCalls(green)).toEqual([]);
    expect(layoutPredicateLoadTimeCalls(`const x = 1;`)).toBeNull();
  });
});

const LAYOUT_PREDICATES = ["homeUsesThemeLayout", "pageUsesThemeLayout"];

// The calls to a layout predicate (or to a spec-local function that reaches
// one) that run at file load, as `line:col` strings; null when the source
// never calls one.
function layoutPredicateLoadTimeCalls(src) {
  const ast = parse(src);
  const tail = (call) => calleeTail(calleeName(call.callee));
  // Spec-local named functions: `function f() {}` and `const f = () => {}`.
  const fns = new Map();
  walk.full(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id) fns.set(node.id.name, node);
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init &&
      /Function/.test(node.init.type)
    ) {
      fns.set(node.id.name, node.init);
    }
  });
  const names = new Set(LAYOUT_PREDICATES);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, fn] of fns) {
      if (names.has(name)) continue;
      let reaches = false;
      walk.full(fn.body, (n) => {
        if (n.type === "CallExpression" && names.has(tail(n))) reaches = true;
      });
      if (reaches) {
        names.add(name);
        grew = true;
      }
    }
  }
  const calls = [];
  walk.ancestor(ast, {
    CallExpression(node, ancestors) {
      if (names.has(tail(node))) calls.push([...ancestors]);
    },
  });
  if (calls.length === 0) return null;
  const deferred = (ancestors) =>
    ancestors.some((fn, i) => {
      if (!/Function/.test(fn.type)) return false;
      const parent = ancestors[i - 1];
      if (!parent || parent.type !== "CallExpression") return true;
      if (parent.callee === fn) return false; // an IIFE runs where it stands
      return !/(^|\.)describe(\.|$)/.test(calleeName(parent.callee) || ""); // describe bodies run at load
    });
  return calls
    .filter((ancestors) => !deferred(ancestors))
    .map((ancestors) => {
      const { line, column } = ancestors[ancestors.length - 1].loc.start;
      return `${line}:${column}`;
    });
}
