// @lane: local — pure-fs unit test for the admin link crawler's collection
// list. The crawler walks each base collection's sidebar link, so it must walk
// only the ones the consumer keeps via `cms.base_collections`; a dropped one has
// no sidebar link and the wait for it times out (adamdaniel.ai#4104, which
// dropped `projects`).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const cap = require("./site-capabilities");

const FULL = path.join(__dirname, "fixture-site");

function siteWithKeepList(keep) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-crawler-"));
  fs.writeFileSync(
    path.join(dir, "_config.yml"),
    `cms:\n  base_collections: [${keep.join(", ")}]\n`,
  );
  return dir;
}

test.describe("cms-link-crawler collections honor cms.base_collections", () => {
  test("an unset keep-list crawls every base collection with a sidebar link", () => {
    expect(cap.linkCrawlerCollections(FULL)).toEqual([
      "posts",
      "tags",
      "projects",
      "pages",
    ]);
  });

  test("a dropped collection is not crawled", () => {
    const dir = siteWithKeepList(["posts", "tags", "pages", "e2e"]);
    expect(cap.linkCrawlerCollections(dir)).toEqual(["posts", "tags", "pages"]);
  });

  test("the spec takes its list from the helper, not a literal", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "cms-link-crawler.spec.js"),
      "utf8",
    );
    expect(src).toMatch(
      /const COLLECTIONS = cap\.linkCrawlerCollections\(SITE_ROOT\);/,
    );
  });
});
