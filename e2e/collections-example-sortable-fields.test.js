// @lane: local — pure-fs lint on theme/admin/collections.site.yml.example's
// weight-ordered-collection sortable_fields pairing (cms-platform#329.3).
//
// The bug: reordering a folder collection via a manual "weight"/"Order"
// field works on the public site, but the admin entry LIST never visibly
// reflects it — the owner has no way to verify the reorder took effect —
// because Decap's "Sort by" dropdown only offers a field as a sort key
// when that field is listed in the collection's `sortable_fields`. The
// cheap fix (named directly in the issue) is `sortable_fields: [weight]`
// in the seam; this lint locks the platform's example seam (and, by the
// scaffolder's own verbatim copy of it — see scaffold/create-site.js —
// what a NEW site is handed) so that pairing is present by default rather
// than something every site has to independently rediscover.
//
// A real YAML parser, not a regex or line scan (per AGENTS.md): an aliased
// or merge-keyed sortable_fields list would be invisible to a line scan,
// and this file is spliced as a raw sequence fragment at build time, so
// it must also stay genuinely parseable on its own.

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const EXAMPLE_PATH = path.join(__dirname, "..", "theme", "admin", "collections.site.yml.example");

function parseCollections() {
  const src = fs.readFileSync(EXAMPLE_PATH, "utf8");
  const doc = YAML.parseDocument(src);
  expect(doc.errors, "collections.site.yml.example must be valid YAML").toEqual([]);
  const collections = doc.toJSON();
  expect(
    Array.isArray(collections),
    "the example seam is a top-level sequence of collection items, spliced " +
      "into the platform's base collections list at build time",
  ).toBe(true);
  return collections;
}

test.describe("collections.site.yml.example — weight-ordered sortable_fields (#329.3)", () => {
  test("every collection with a manual-order `weight` field also lists it in sortable_fields", () => {
    const collections = parseCollections();
    for (const col of collections) {
      const fieldNames = (col.fields || []).map((f) => f && f.name).filter(Boolean);
      if (!fieldNames.includes("weight")) continue;
      expect(
        Array.isArray(col.sortable_fields) && col.sortable_fields.includes("weight"),
        `collection "${col.name}" has a manual-order "weight" field but does not list ` +
          `"weight" in sortable_fields — the admin's "Sort by" dropdown would offer no Order ` +
          `option, and the entry list would never visibly reflect a reorder (cms-platform#329.3)`,
      ).toBe(true);
    }
  });

  test("the example models at least one weight-ordered collection (so new sites inherit the pairing)", () => {
    const collections = parseCollections();
    const withWeight = collections.filter((col) =>
      (col.fields || []).some((f) => f && f.name === "weight"),
    );
    expect(
      withWeight.length,
      "the example seam must demonstrate the sortable_fields pairing on a real " +
        "weight-ordered collection — scaffold/create-site.js copies this file byte-for-byte " +
        "into every new site, so this is how a site inherits the fix by default",
    ).toBeGreaterThan(0);
  });

  test("the weight field itself is a number widget", () => {
    const collections = parseCollections();
    for (const col of collections) {
      const weightField = (col.fields || []).find((f) => f && f.name === "weight");
      if (!weightField) continue;
      expect(weightField.widget, `collection "${col.name}"'s weight field must be numeric`).toBe(
        "number",
      );
    }
  });
});
