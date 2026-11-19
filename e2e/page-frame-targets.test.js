// Unit tests for e2e/page-frame-targets.js: which pages the page-frame check
// opens (cms-platform#1070). Pure fs, no browser.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { pageFrameTargets, parseChanged } = require("./page-frame-targets");

function site(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-frame-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const post = (fm) => `---\n${fm}\n---\n\nBody.\n`;
const BLOG_SITE = {
  "_config.yml": "title: T\n",
  "index.html": "---\nlayout: default\n---\nHome\n",
  "_posts/2026-01-01-old.md": post("title: Old"),
  "_posts/2026-02-01-new.md": post("title: New\ntags:\n  - A\n  - B"),
  "_posts/2026-03-01-draft.md": post("title: Draft\npublished: false"),
  "_posts/2099-12-31-e2e-prod-mutate-123.md": post("title: Canary"),
  "_posts/2026-01-15-fixture.md": post("title: Fixture\ntest_fixture: true"),
};

test.describe("page-frame targets", () => {
  test("a changed post is opened, and the listings with it", () => {
    const root = site(BLOG_SITE);
    const t = pageFrameTargets({ siteRoot: root, changedFiles: ["_posts/2026-01-01-old.md"] });
    expect(t.listings).toEqual(["/", "/blog/"]);
    expect(t.posts).toEqual([{ path: "/blog/old/", source: "_posts/2026-01-01-old.md" }]);
    expect(t.removedPosts).toBe(0);
  });

  test("a deleted or unpublished post counts as removed, and the newest post stands in", () => {
    const root = site(BLOG_SITE);
    const t = pageFrameTargets({
      siteRoot: root,
      changedFiles: ["_posts/2026-03-01-draft.md", "_posts/2025-05-05-gone.md"],
    });
    expect(t.removedPosts).toBe(2);
    expect(t.posts.map((p) => p.path)).toEqual(["/blog/new/"]);
  });

  test("e2e canaries and test fixtures are never opened or counted", () => {
    const root = site(BLOG_SITE);
    const t = pageFrameTargets({
      siteRoot: root,
      changedFiles: ["_posts/2099-12-31-e2e-prod-mutate-123.md"],
    });
    expect(t.removedPosts).toBe(0);
    const all = pageFrameTargets({ siteRoot: root, all: true });
    expect(all.posts.map((p) => p.path)).toEqual(["/blog/old/", "/blog/new/"]);
  });

  test("a layout-only change still opens one post page", () => {
    const root = site(BLOG_SITE);
    const t = pageFrameTargets({ siteRoot: root, changedFiles: ["_layouts/post.html"] });
    expect(t.posts.map((p) => p.path)).toEqual(["/blog/new/"]);
  });

  test("a single-page site with a site-owned home layout has nothing to open", () => {
    const root = site({
      "_config.yml": "cms:\n  base_collections: []\n",
      "_layouts/home.html": "<html>{{ content }}</html>\n",
      "index.html": "---\nlayout: home\n---\n",
    });
    const t = pageFrameTargets({ siteRoot: root, all: true });
    expect(t).toEqual({ listings: [], posts: [], removedPosts: 0 });
  });

  test("the changed list splits on any whitespace; unset stays unset", () => {
    expect(parseChanged("a.md\nb.md  c.md\n")).toEqual(["a.md", "b.md", "c.md"]);
    expect(parseChanged(undefined)).toBeNull();
  });
});
