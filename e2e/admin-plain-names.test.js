// @lane: local — pure-Node lint: "media" never reads as three different things in the website editor.
/*
 * See "Words we use" in docs/ADMIN-DELIVERY.md and e2e/plain-names-lint.js
 * (the reusable checks, the allowlist and how a site repo runs them).
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const lint = require("./plain-names-lint");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const read = (f) => fs.readFileSync(path.join(ADMIN, f), "utf8");

// Scripts whose strings a site owner reads: the header nav links and the
// script that relabels Decap's own library.
const LABEL_SCRIPTS = ["media-library-labels.js", "media-search-nav-link.js", "reviews-nav-link.js"];

test.describe("plain names for media", () => {
  for (const f of ["config.base.yml", "collections.site.yml.example"]) {
    test(`${f}: no label or hint says "media"`, () => {
      const bad = lint.checkCollectionsYaml(read(f));
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }

  const pages = fs.readdirSync(ADMIN).filter((f) => f.endsWith(".html"));
  test("there are admin pages to scan", () => {
    expect(pages).toContain("media-search.html");
  });
  for (const f of pages) {
    test(`${f}: no visible text says "media"`, async () => {
      const bad = await lint.checkAdminHtml(read(f), f);
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }

  for (const f of LABEL_SCRIPTS) {
    test(`${f}: no injected label says "media"`, () => {
      const bad = lint.checkScriptStrings(read(f), f);
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }

  test("the new-mentions page and nav link use the plain name", async () => {
    expect(read("media-search-nav-link.js")).toContain('"New mentions"');
    expect(await lint.checkAdminHtml(read("media-search.html"))).toEqual([]);
    expect(read("media-search.html")).toContain("<title>New mentions</title>");
  });

  test("the library relabel script sets Images & files", () => {
    expect(read("media-library-labels.js")).toContain('"Images & files"');
  });

  test("the lint itself catches what it should (and allows what it should)", async () => {
    expect(lint.checkCollectionsYaml("collections:\n  - label: Media Items\n    fields:\n      - {label: x, hint: 'Add media'}\n")).toHaveLength(2);
    expect(lint.checkCollectionsYaml("collections:\n  - label: Press and talks\n    hint: Share on social media\n")).toEqual([]);
    expect(await lint.checkAdminHtml('<h1>Media search</h1><a aria-label="Media">x</a><script>var a="Media"</script>')).toHaveLength(2);
    expect(lint.checkScriptStrings('x("Media search"); y("cms-media-search-nav"); z("/admin/media-search.html"); w(`Media`)')).toHaveLength(2);
    expect(lint.checkScriptStrings('a.media = "Images & files"')).toEqual([]);
  });
});
