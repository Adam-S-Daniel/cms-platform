// @lane: local — pure builders for the single-page publish loop (#1068); no browser, no network
const vm = require("node:vm");
const { test, expect } = require("./base");
const { installTestEntryMarkers } = require("./cms-editor-ui");
const { isSelfChurn } = require("./cms-recursion-churn");
const {
  MEDIA_WEIGHT,
  TEST_MEDIA_MARKERS,
  SELF_CHURN_GLOBS,
  DATA_TARGET,
  isPlainAscii,
  slugifyTitle,
  buildSinglePageMedia,
  leakedMarkers,
  missingMediaFields,
  readDataField,
  buildEditedValue,
  sameData,
} = require("./single-page-loop-fixture");

test.describe("single-page publish loop fixture (#1068)", () => {
  test("buildSinglePageMedia is a pure function of runId", () => {
    const a = buildSinglePageMedia({ runId: 1790000000001 });
    expect(a).toEqual(buildSinglePageMedia({ runId: 1790000000001 }));
    expect(a.title).toBe("E2E publish loop 1790000000001");
    expect(a.slug).toBe("e2e-publish-loop-1790000000001");
    expect(a.fileSlug).toBe(`${MEDIA_WEIGHT}-e2e-publish-loop-1790000000001`);
    expect(a.filePath).toBe("_media/99-e2e-publish-loop-1790000000001.md");
    expect(a.branch).toBe("cms/media/99-e2e-publish-loop-1790000000001");
    expect(a.publicPath).toBe("/media/99-e2e-publish-loop-1790000000001/");
    expect(a.entryPath).toBe("/collections/media/entries/99-e2e-publish-loop-1790000000001");
    expect(buildSinglePageMedia({ runId: 2 }).filePath).not.toBe(a.filePath);
    expect(() => buildSinglePageMedia({})).toThrow(/runId/);
  });

  test("the media fields satisfy what jodidaniel.com's verifier accepts (issues 338 and 339)", () => {
    const m = buildSinglePageMedia({ runId: 1790000000001 });
    for (const text of [m.title, m.fields.source, m.fields.date_display, m.fields.category]) {
      expect(isPlainAscii(text), `"${text}" must be plain ASCII (no em dash)`).toBe(true);
    }
    // A real, non-blank date in the field's own "Month YYYY" shape.
    expect(m.fields.date_display).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    expect(m.fields.article_url).toMatch(/^https:\/\/example\.com\//);
    expect(Number.isInteger(m.fields.weight)).toBe(true);
  });

  test("isPlainAscii rejects an em dash, a curly quote and non-strings", () => {
    expect(isPlainAscii("plain title 1")).toBe(true);
    expect(isPlainAscii("a — b")).toBe(false);
    expect(isPlainAscii("it’s")).toBe(false);
    expect(isPlainAscii(7)).toBe(false);
  });

  test("slugifyTitle lowercases and dashes", () => {
    expect(slugifyTitle("E2E publish loop 12")).toBe("e2e-publish-loop-12");
    expect(slugifyTitle("  A -- B  ")).toBe("a-b");
  });

  test("the media file path is covered by the host loop's self-churn set", () => {
    const m = buildSinglePageMedia({ runId: 1790000000001 });
    expect(isSelfChurn("host", m.filePath)).toBe(true);
    for (const glob of SELF_CHURN_GLOBS) {
      expect(isSelfChurn("host", glob.split("*").join("1790000000001"))).toBe(true);
    }
    // A real media item is NOT swallowed by the gate.
    expect(isSelfChurn("host", "_media/1-fda-amicus.md")).toBe(false);
  });

  test("leakedMarkers finds the item's own copy in a gated page and nothing else", () => {
    const m = buildSinglePageMedia({ runId: 5 });
    expect(leakedMarkers("<h1>Coming soon</h1>", m)).toEqual([]);
    expect(leakedMarkers(`<h1>${m.title}</h1>`, m)).toEqual([m.title]);
    expect(leakedMarkers(`<a href="${m.fields.article_url}">x</a>`, m)).toEqual([
      m.fields.article_url,
    ]);
  });

  test("missingMediaFields reports what Decap did not commit", () => {
    const m = buildSinglePageMedia({ runId: 5 });
    const good =
      "---\n" +
      `category: "${m.fields.category}"\n` +
      `title: "${m.title}"\n` +
      `source: "${m.fields.source}"\n` +
      `date_display: "${m.fields.date_display}"\n` +
      `article_url: "${m.fields.article_url}"\n` +
      `weight: ${m.fields.weight}\n` +
      "test_fixture: true\n" +
      "---\n";
    expect(missingMediaFields(good, m)).toEqual([]);
    expect(missingMediaFields(good.replace("test_fixture: true\n", ""), m)).toEqual([
      "test_fixture",
    ]);
    expect(missingMediaFields(good.replace(/date_display: .*\n/, 'date_display: ""\n'), m)).toEqual([
      "date_display",
    ]);
    expect(missingMediaFields("no front matter", m).length).toBeGreaterThan(5);
    expect(missingMediaFields("---\n: : :\n---\n", m).length).toBeGreaterThan(5);
  });

  test("buildEditedValue appends a run marker, stays ASCII and differs from the original", () => {
    const v = buildEditedValue({ original: "Connect", runId: 17 });
    expect(v).toBe("Connect e2e 17");
    expect(v).not.toBe("Connect");
    expect(isPlainAscii(v)).toBe(true);
    expect(() => buildEditedValue({ original: "", runId: 1 })).toThrow(/original/);
    expect(() => buildEditedValue({ original: "x" })).toThrow(/runId/);
  });

  test("readDataField and sameData compare parsed data, not bytes", () => {
    const flow = 'heading: "Connect"\nlinks:\n  - { label: "A", url: "https://example.com/a" }\n';
    const block = "heading: Connect\nlinks:\n  - label: A\n    url: https://example.com/a\n";
    expect(readDataField(flow, DATA_TARGET.field)).toBe("Connect");
    expect(readDataField("- a\n- b\n", "heading")).toBeUndefined();
    expect(readDataField(": : :", "heading")).toBeUndefined();
    expect(sameData(flow, block)).toBe(true);
    expect(sameData(flow, block.replace("Connect", "Connect e2e 1"))).toBe(false);
    expect(sameData(flow, ": : :")).toBe(false);
  });

  test("the data target names a seam entry that has no comments to lose", () => {
    expect(DATA_TARGET).toMatchObject({
      collection: "site_contact",
      entry: "contact",
      filePath: "_data/contact.yml",
      field: "heading",
    });
  });

  test("the preSave listener stamps test_fixture on exactly this run's media entry", () => {
    class FakeMap {
      constructor(obj) {
        this.obj = { ...obj };
      }
      get(key) {
        return this.obj[key];
      }
      set(key, value) {
        return new FakeMap({ ...this.obj, [key]: value });
      }
    }
    const registered = [];
    const window = { CMS: { registerEventListener: (l) => registered.push(l) } };
    const m = buildSinglePageMedia({ runId: 9 });
    const arg = { collection: "media", title: m.title, markers: { ...TEST_MEDIA_MARKERS } };
    expect(vm.runInNewContext(`(${installTestEntryMarkers.toString()})(arg)`, { window, arg })).toBe(
      true,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("preSave");
    const entry = (collection, title) => ({
      get: (k) => (k === "collection" ? collection : new FakeMap({ title })),
    });
    const stamped = registered[0].handler({ entry: entry("media", m.title) });
    expect(stamped.get("test_fixture")).toBe(true);
    // Another entry, another collection, or no entry: "no change".
    expect(registered[0].handler({ entry: entry("media", "Some real item") })).toBeUndefined();
    expect(registered[0].handler({ entry: entry("expertise", m.title) })).toBeUndefined();
    expect(registered[0].handler({})).toBeUndefined();
  });

  test("the installer fails loudly when Decap's CMS API is not loaded", () => {
    const arg = { collection: "media", title: "t", markers: {} };
    expect(() =>
      vm.runInNewContext(`(${installTestEntryMarkers.toString()})(arg)`, { window: {}, arg }),
    ).toThrow(/registerEventListener is unavailable/);
  });
});
