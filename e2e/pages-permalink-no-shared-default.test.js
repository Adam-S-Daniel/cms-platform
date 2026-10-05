// @lane: local — pure-fs YAML parse of the three admin config sources; no browser, no network
// Regression lock for #639: the Pages collection's `permalink` field used to
// default to the bare "/pages/", so every new page written with defaults landed
// on the same URL and the second one silently collided with the first. Decap
// cannot derive a value from the title in a field default, so the contract is:
// no shared default, and a pattern that rejects the bare "/pages/".
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ADMIN_DIR = path.resolve(__dirname, "../theme/admin");
const SOURCES = ["config.base.yml", "config-local.base.yml", "config-test.yml"];

function pagesPermalink(file) {
  const doc = YAML.parse(fs.readFileSync(path.join(ADMIN_DIR, file), "utf8"));
  const pages = doc.collections.find((c) => c.name === "pages");
  expect(pages, `${file} has a pages collection`).toBeTruthy();
  const field = pages.fields.find((f) => f.name === "permalink");
  expect(field, `${file} pages has a permalink field`).toBeTruthy();
  return field;
}

for (const file of SOURCES) {
  test(`${file}: pages.permalink has no shared default and rejects bare /pages/`, () => {
    const field = pagesPermalink(file);
    expect(field.required).toBe(true);
    expect(field.default, "a shared default collides every new page (#639)").toBeUndefined();
    const re = new RegExp(field.pattern[0]);
    for (const bad of ["/pages/", "/", "//", "/pages", "about/", ""]) {
      expect(re.test(bad), `rejects ${JSON.stringify(bad)}`).toBe(false);
    }
    for (const good of ["/pages/about/", "/about/", "/pages/a/b/"]) {
      expect(re.test(good), `accepts ${JSON.stringify(good)}`).toBe(true);
    }
  });
}
