// @lane: local — pure-fs lint: every `sortable_fields` the platform ships passes Decap's config schema (#650)
//
// The bug this locks: PR #707 first wrote
//   sortable_fields: { fields: [date, title], default: { field: date, direction: Descending } }
// into all three admin configs. Decap 3.15.1's config schema declares
// `sortable_fields` as an ARRAY, so the admin threw
// `'collections[0].sortable_fields' must be array` on load and never rendered
// its login button: every admin spec in fixture-e2e timed out. The unit test
// of that PR pinned the invalid object, and nothing else read the key, so only
// the browser lane could notice.
//
// SCHEMA SOURCE. Copied from the pinned bundle itself
// (https://unpkg.com/decap-cms@3.15.1/dist/decap-cms.js, the config schema's
// `sortable_fields:{type:"array",items:{oneOf:[{type:"string"},{type:"object",
// properties:{field:{type:"string"},label:{type:"string"},default_sort:
// {oneOf:[{type:"boolean"},{type:"string",enum:["asc","desc"]}]}},
// required:["field"],additionalProperties:!1}]}}`) plus its validator's rule
// "only one default_sort", not recalled from memory. The first test fails when
// an admin shell pins another Decap version, so a bump re-reads the schema
// before it can go green.
//
// YAML is parsed with `yaml`, never matched by regex (AGENTS.md).

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SCHEMA_VERIFIED_AGAINST = "3.15.1";

// Returns the list of schema violations for one collection's `sortable_fields`
// value (an empty list means Decap accepts it).
function sortableFieldsProblems(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`must be array, got ${typeof value}`];
  const problems = [];
  let defaults = 0;
  value.forEach((item, i) => {
    if (typeof item === "string") return;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`[${i}] must be a string or an object`);
      return;
    }
    if (typeof item.field !== "string") problems.push(`[${i}].field must be a string`);
    if (item.label !== undefined && typeof item.label !== "string") {
      problems.push(`[${i}].label must be a string`);
    }
    if (item.default_sort !== undefined) {
      defaults += 1;
      const d = item.default_sort;
      if (typeof d !== "boolean" && d !== "asc" && d !== "desc") {
        problems.push(`[${i}].default_sort must be a boolean, "asc" or "desc"`);
      }
    }
    for (const key of Object.keys(item)) {
      if (!["field", "label", "default_sort"].includes(key)) {
        problems.push(`[${i}] has unknown property "${key}"`);
      }
    }
  });
  if (defaults > 1) problems.push("only one default_sort is allowed");
  return problems;
}

function collectionsOf(doc) {
  if (Array.isArray(doc)) return doc;
  return (doc && doc.collections) || [];
}

const SOURCES = [
  "config.base.yml",
  "config-local.base.yml",
  "config-test.yml",
  "collections.site.yml.example",
].map((f) => path.join(ADMIN, f));

test.describe("sortable_fields matches Decap's config schema (#650)", () => {
  test("every admin shell loads the Decap version this schema was read from", () => {
    const shells = fs.readdirSync(ADMIN).filter((f) => /^index.*\.html$/.test(f));
    expect(shells.length).toBeGreaterThan(0);
    for (const f of shells) {
      const html = fs.readFileSync(path.join(ADMIN, f), "utf8");
      const versions = [...html.matchAll(/decap-cms@(\d[\w.]*)\/dist\/decap-cms\.js/g)].map(
        (m) => m[1],
      );
      for (const v of versions) {
        expect(v, `${f} pins Decap ${v}: re-read the sortable_fields schema first`).toBe(
          SCHEMA_VERIFIED_AGAINST,
        );
      }
    }
  });

  for (const file of SOURCES) {
    test(`${path.basename(file)}: every collection's sortable_fields is valid`, () => {
      const doc = YAML.parse(fs.readFileSync(file, "utf8"));
      const collections = collectionsOf(doc);
      expect(collections.length).toBeGreaterThan(0);
      for (const col of collections) {
        expect(sortableFieldsProblems(col.sortable_fields), `collection "${col.name}"`).toEqual([]);
      }
    });
  }

  test("the validator rejects the object form PR #707 first shipped, and other bad shapes", () => {
    const objectForm = {
      fields: ["date", "title"],
      default: { field: "date", direction: "Descending" },
    };
    expect(sortableFieldsProblems(objectForm)).toEqual(["must be array, got object"]);
    expect(sortableFieldsProblems([{ field: "date", default_sort: "Descending" }])).toHaveLength(1);
    expect(sortableFieldsProblems([{ default_sort: "desc" }])).toHaveLength(1);
    expect(
      sortableFieldsProblems([
        { field: "date", default_sort: "desc" },
        { field: "title", default_sort: "asc" },
      ]),
    ).toEqual(["only one default_sort is allowed"]);
    expect(sortableFieldsProblems([{ field: "date", direction: "desc" }])).toHaveLength(1);
  });

  test("the validator accepts the forms Decap documents", () => {
    expect(sortableFieldsProblems(undefined)).toEqual([]);
    expect(sortableFieldsProblems([])).toEqual([]);
    expect(sortableFieldsProblems(["title"])).toEqual([]);
    expect(
      sortableFieldsProblems([{ field: "date", label: "Date", default_sort: "desc" }, "title"]),
    ).toEqual([]);
    expect(sortableFieldsProblems([{ field: "date", default_sort: true }])).toEqual([]);
  });
});
