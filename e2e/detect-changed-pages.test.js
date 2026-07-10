// @lane: local — pure-Node unit tests for the changed-page classifier
const { test, expect } = require("./base");
const { classifyPages, discoverAllPages, mapFileToUrls, runDetect } = require("./detect-changed-pages");

// Pure-function unit tests for the page-change classifier. No browser,
// no git — just verify each rule fires correctly.
//
// These exist specifically to catch the false-negative class of bug
// where the classifier returns "nothing changed" even when something
// did. A previous version of detect-changed-pages.js silently swallowed
// a `git diff` failure and fell through to an empty changeset, which
// made the visual-regression workflow report
// `potentiallyAffected: 0` on every PR regardless of the diff. Fanout
// inputs (layouts/includes/css/_config.yml) are exercised here so a
// future regression that breaks the classifier — or anything that
// silently feeds it an empty list — fails loudly.

const ALL_PAGES = new Set([
  "/",
  "/admin/",
  "/admin/reviews/",
  "/blog/",
  "/blog/hello-world/",
  "/projects/example/",
  "/tags/python/",
]);

test.describe("classifyPages", () => {
  test("empty changeset → everything unchanged", () => {
    const r = classifyPages({ allPages: ALL_PAGES, changedFiles: [] });
    expect(r.changed).toEqual([]);
    expect(r.new).toEqual([]);
    expect(r.unchanged.sort()).toEqual([...ALL_PAGES].sort());
  });

  // ── Fanout inputs: every page must move into `changed`.
  // These are the regression-bait cases — if the classifier ever silently
  // returns "nothing changed" for a layout edit, this fails.
  for (const fanoutFile of [
    "_layouts/post.html",
    "_includes/header.html",
    "_config.yml",
    "assets/css/main.css",
  ]) {
    test(`fanout: ${fanoutFile} → all pages changed`, () => {
      const r = classifyPages({
        allPages: ALL_PAGES,
        changedFiles: [fanoutFile],
      });
      expect(r.changed.sort()).toEqual([...ALL_PAGES].sort());
      expect(r.unchanged).toEqual([]);
      expect(r.new).toEqual([]);
    });
  }

  test("post change → only the matching blog page is in changed", () => {
    const r = classifyPages({
      allPages: ALL_PAGES,
      changedFiles: ["_posts/2026-01-01-hello-world.md"],
    });
    expect(r.changed).toEqual(["/blog/hello-world/"]);
    expect(r.new).toEqual([]);
    expect(r.unchanged).toContain("/");
    expect(r.unchanged).toContain("/admin/");
  });

  test("admin shell change → /admin/ and /admin/reviews/ are in changed", () => {
    const r = classifyPages({
      allPages: ALL_PAGES,
      changedFiles: ["admin/index.html"],
    });
    expect(r.changed.sort()).toEqual(["/admin/", "/admin/reviews/"]);
    expect(r.unchanged).toContain("/");
  });

  test("project change → only the matching project page is in changed", () => {
    const r = classifyPages({
      allPages: ALL_PAGES,
      changedFiles: ["_projects/example.md"],
    });
    expect(r.changed).toEqual(["/projects/example/"]);
  });

  test("unmapped file (e.g. README.md) → nothing changes", () => {
    const r = classifyPages({
      allPages: ALL_PAGES,
      changedFiles: ["README.md"],
    });
    expect(r.changed).toEqual([]);
    expect(r.new).toEqual([]);
  });

  test("new file (not on main) → goes to `new`, not `changed`", () => {
    const r = classifyPages({
      allPages: new Set([...ALL_PAGES, "/blog/brand-new/"]),
      changedFiles: ["_posts/2026-04-29-brand-new.md"],
      // Stub: this file is NOT on main yet.
      fileExistsOnMain: () => false,
    });
    expect(r.new).toEqual(["/blog/brand-new/"]);
    expect(r.changed).toEqual([]);
  });

  test("new admin/ sibling file → /admin/ and /admin/reviews/ are changed, not new", () => {
    // admin/config-test.yml is a brand-new file, but it maps to the
    // always-included admin URLs which already exist on main. The
    // URLs must be classified as `changed`, not `new` — otherwise
    // regression-video.spec.js will draw a placeholder for the
    // production side and the video will misrepresent the admin diff.
    const r = classifyPages({
      allPages: ALL_PAGES,
      changedFiles: ["admin/config-test.yml"],
      fileExistsOnMain: () => false,
    });
    expect(r.changed.sort()).toEqual(["/admin/", "/admin/reviews/"]);
    expect(r.new).toEqual([]);
  });

  // Finding #22 — same shape, narrowed to admin/*.html. A new
  // `admin/index-test.html` mapping to /admin/ must keep /admin/ in
  // `changed`, not flip it to `new`.
  test("new admin/index-test.html → /admin/ stays in changed, not new", () => {
    const r = classifyPages({
      allPages: ALL_PAGES,
      changedFiles: ["admin/index-test.html"],
      fileExistsOnMain: () => false,
    });
    expect(r.changed).toContain("/admin/");
    expect(r.new).not.toContain("/admin/");
    expect(r.new).not.toContain("/admin/reviews/");
  });

  test("fanout + post → fanout wins, every page is in changed", () => {
    const r = classifyPages({
      allPages: ALL_PAGES,
      changedFiles: ["_layouts/default.html", "_posts/2026-01-01-hello-world.md"],
    });
    expect(r.changed.sort()).toEqual([...ALL_PAGES].sort());
    expect(r.unchanged).toEqual([]);
  });
});

test.describe("mapFileToUrls", () => {
  test("post → /blog/<slug>/", () => {
    expect(mapFileToUrls("_posts/2026-01-01-hello.md")).toEqual(["/blog/hello/"]);
  });

  test("project → /projects/<slug>/", () => {
    expect(mapFileToUrls("_projects/foo.md")).toEqual(["/projects/foo/"]);
  });

  test("tag → /tags/<slug>/", () => {
    expect(mapFileToUrls("_tags/python.md")).toEqual(["/tags/python/"]);
  });

  test("admin/ → /admin/ + /admin/reviews/", () => {
    expect(mapFileToUrls("admin/config.yml").sort()).toEqual(["/admin/", "/admin/reviews/"]);
  });

  test("layout/include/css/_config → __ALL__", () => {
    expect(mapFileToUrls("_layouts/post.html")).toEqual(["__ALL__"]);
    expect(mapFileToUrls("_includes/footer.html")).toEqual(["__ALL__"]);
    expect(mapFileToUrls("assets/css/main.css")).toEqual(["__ALL__"]);
    expect(mapFileToUrls("_config.yml")).toEqual(["__ALL__"]);
  });

  test("unrelated file → []", () => {
    expect(mapFileToUrls("README.md")).toEqual([]);
    expect(mapFileToUrls("Gemfile.lock")).toEqual([]);
    expect(mapFileToUrls("package.json")).toEqual([]);
  });
});

test.describe("runDetect (CLI integration)", () => {
  // Finding #2 — a previous version swallowed `git diff` failures and
  // returned an empty changeset. A truncated/shallow clone with no
  // merge base is the exact failure mode that bug masked. runDetect
  // must throw loudly so the workflow fails the run instead of
  // shipping a `potentiallyAffected: 0` lie.
  test("throws when git diff fails (truncated history, no merge base)", () => {
    const fakeGit = (cmd) => {
      // The fetch is best-effort and shouldn't throw — only the diff
      // should. Mirrors the in-CI failure mode exactly.
      if (cmd.startsWith("git fetch")) return "";
      const err = new Error("fatal: no merge base found between origin/main and HEAD");
      throw err;
    };
    expect(() =>
      runDetect({
        runGit: fakeGit,
        runDiscover: () => new Set(["/"]),
        runFileExists: () => true,
      }),
    ).toThrow();
  });
});

test.describe("discoverAllPages (_site scan)", () => {
  // The built _site is the CANONICAL page universe: it must discover pages
  // from SITE-OWNED collections the hardcoded fallback has never heard of.
  // The /tools/ pages on adamdaniel.ai were invisible to the regression
  // gate precisely because the fallback ran in CI (detect used to run
  // before the build) and only knew posts/projects/tags/pages.
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  function makeSite(tree) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "detect-site-"));
    for (const rel of tree) {
      const f = path.join(root, "_site", rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "<html></html>");
    }
    return root;
  }

  test("discovers site-owned collection pages (e.g. /tools/) from the build output", () => {
    const root = makeSite([
      "index.html",
      "blog/index.html",
      "blog/hello/index.html",
      "tools/index.html",
      "tools/claude-memory-map/index.html",
    ]);
    const pages = discoverAllPages(root);
    expect(pages.has("/tools/")).toBe(true);
    expect(pages.has("/tools/claude-memory-map/")).toBe(true);
    expect(pages.has("/blog/hello/")).toBe(true);
    expect(pages.has("/")).toBe(true);
  });

  test("excludes e2e canary fixtures (publish-loop churn must not flake the gate)", () => {
    const root = makeSite(["index.html", "e2e/canary-post/index.html"]);
    const pages = discoverAllPages(root);
    expect(pages.has("/e2e/canary-post/")).toBe(false);
  });

  test("excludes admin/preview output but keeps the always-included admin URLs", () => {
    const root = makeSite(["index.html", "admin/index.html", "preview/index.html"]);
    const pages = discoverAllPages(root);
    expect(pages.has("/admin/")).toBe(true); // via ALWAYS_INCLUDED_ADMIN_PAGES
    expect(pages.has("/admin/reviews/")).toBe(true);
    expect(pages.has("/preview/")).toBe(false);
  });
});
