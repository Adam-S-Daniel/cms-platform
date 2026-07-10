const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const { isSalient } = require("./visual-regression-salient");

// Locks the "content-only PRs do not trigger the visual-regression build /
// review" invariant.
//
// The CMS's editorial workflow opens a PR for every Save. Those PRs touch
// only CMS-managed content paths (the collections in admin/config.base.yml:
// _posts, _tags, _projects, pages, _e2e) plus media uploads
// (assets/images/uploads/). Running visual regression on content-only PRs is
// pure noise — pixel diffs are the *intent* of the edit, not a regression.
// The pipeline must fire only when the diff can introduce *unintentional*
// visual drift (templates, layouts, styling, the admin shell, pipeline
// tooling).
//
// HISTORY: this invariant used to live as the caller's
// `on.pull_request.paths` filter. It moved into
// e2e/visual-regression-salient.js so the workflow can ALWAYS trigger and the
// required `approve-regression` check always reports a status (a
// path-filtered workflow that never fires would deadlock a required check).
// The reusable's `detect` job pipes the PR's changed files through that
// module. If a future change makes a CMS-content path salient (or drops a
// template path), a test here fails and the change must either revert it or
// document why the invariant moved (by editing this file).

// A representative changed file under each CMS-managed content folder.
const CONTENT_FILES = [
  "_posts/2026-01-01-x.md",
  "_tags/x.md",
  "_projects/x.md",
  "pages/x.md",
  "_e2e/x.md",
  "assets/images/uploads/x.png",
];

// Representative template / styling / admin / tooling files that MUST stay
// salient so the pipeline still fires on the drift it's meant to catch.
const SALIENT_FILES = [
  "_layouts/post.html",
  "_includes/head.html",
  "admin/config.base.yml",
  "_config.yml",
  "assets/css/main.css",
  ".github/workflows/visual-regression.yml",
];

test.describe("visual-regression: content-only PRs are non-salient", () => {
  test("each CMS content folder is non-salient on its own", () => {
    for (const f of CONTENT_FILES) {
      expect(
        isSalient([f]),
        `"${f}" must be NON-salient — content pixel diffs are intentional, not a regression`,
      ).toBe(false);
    }
  });

  test("a content-only diff (all content files together) is non-salient", () => {
    expect(isSalient(CONTENT_FILES)).toBe(false);
  });

  test("template / styling / admin / tooling files are salient", () => {
    for (const f of SALIENT_FILES) {
      expect(
        isSalient([f]),
        `"${f}" must be salient — it can shift rendered output and must trigger the regression build`,
      ).toBe(true);
    }
  });

  test("a mixed diff (content + one template) is salient", () => {
    expect(isSalient([...CONTENT_FILES, "_layouts/post.html"])).toBe(true);
  });

  test("synced tool vendor bumps are non-salient (auto-pass by design)", () => {
    // A tool-sync PR (see the site AGENTS.md "Vendored-tool sync") touches
    // exactly the vendored asset + its provenance record. Its delta is the
    // INTENT of the change, already reviewed in the tool's source repo —
    // the site-side gate must not re-review it. The provenance path is a
    // carve-out from the broad `_data/` salience rule.
    expect(isSalient(["assets/tools/claude-memory-map/index.html"])).toBe(false);
    expect(isSalient(["_data/tool_sources/claude-memory-map.yml"])).toBe(false);
    expect(
      isSalient([
        "assets/tools/claude-memory-map/index.html",
        "_data/tool_sources/claude-memory-map.yml",
      ]),
    ).toBe(false);
  });

  test("the auto-pass is for UPDATES only — a new tool's collection entry is salient", () => {
    // A brand-new tool must add `_tools/<slug>.md`; a sync update never
    // touches it. Keeping that path salient is what stops a new tool from
    // riding the sync carve-out into production with zero regression review
    // (the run's _site scan + prod-404 detection then flag the new page for
    // the manual gate).
    expect(isSalient(["_tools/my-new-tool.md"])).toBe(true);
    expect(
      isSalient([
        "_tools/my-new-tool.md",
        "assets/tools/my-new-tool/index.html",
        "_data/tool_sources/my-new-tool.yml",
      ]),
    ).toBe(true);
  });

  test("the tool_sources carve-out does not swallow the rest of _data/", () => {
    expect(isSalient(["_data/navigation.yml"])).toBe(true);
  });

  test("a mixed diff (tool bump + one template) is still salient", () => {
    expect(
      isSalient(["assets/tools/claude-memory-map/index.html", "_layouts/post.html"]),
    ).toBe(true);
  });

  test("every CMS collection folder in admin/config.base.yml is non-salient", () => {
    // Sanity check: a newly-added collection's folder must NOT be salient,
    // or content edits to it would wrongly trigger regression review.
    const cfg = YAML.parse(
      fs.readFileSync(path.join(__dirname, "..", "theme", "admin", "config.base.yml"), "utf8"),
    );
    const folders = ((cfg && cfg.collections) || [])
      .map((c) => c && c.folder)
      .filter(Boolean)
      .map(String);
    expect(
      folders.length,
      "admin/config.base.yml has at least one collection folder",
    ).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(
        isSalient([`${folder}/entry.md`]),
        `admin/config.base.yml has a collection at "${folder}" but visual-regression-salient.js ` +
          `treats it as salient — content edits there would wrongly trigger regression review`,
      ).toBe(false);
    }
  });

  test("the reusable detect job wires in the salience module", () => {
    // Guard against the workflow regressing to a path-filtered trigger or
    // dropping the salience helper — either would break "always report".
    const wf = fs.readFileSync(
      path.join(__dirname, "..", ".github", "workflows", "visual-regression.yml"),
      "utf8",
    );
    expect(
      wf,
      "visual-regression.yml's detect job must invoke e2e/visual-regression-salient.js",
    ).toMatch(/visual-regression-salient\.js/);
  });
});
