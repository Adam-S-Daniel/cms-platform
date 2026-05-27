const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");

// Locks in the "content-only PRs do not trigger visual regression"
// invariant of .github/workflows/visual-regression.yml.
//
// The CMS's editorial workflow opens a PR for every Save. Those PRs
// touch only the CMS-managed content paths (the collections defined in
// admin/config.yml: _posts, _tags, _projects, pages, _e2e) plus media
// uploads (assets/images/uploads/). Running visual regression on
// content-only PRs is pure noise — pixel diffs are the *intent* of the
// edit, not a regression to flag. The workflow should fire only when
// the diff can introduce *unintentional* visual drift (templates,
// layouts, styling, the admin shell, pipeline tooling).
//
// If a future change re-adds any of the CMS-content paths to the
// workflow's `paths:` list, this test fails and the PR has to either
// (a) explicitly remove the path again or (b) document why the
// invariant changed by editing this test.
//
// PLATFORM PORT NOTE: visual-regression.yml became a `workflow_call`
// reusable, so the `on.pull_request` trigger + its content-skip `paths:`
// list now live on the THIN CALLER a site copies in
// (examples/site/.github/workflows/visual-regression.yml). The reusable
// has no `paths:` of its own; this lint reads the canonical caller, which
// is the file that actually carries the trigger.

const WORKFLOW = path.join(
  __dirname,
  "..",
  "examples",
  "site",
  ".github",
  "workflows",
  "visual-regression.yml",
);

// CMS-managed content paths. These MUST NOT appear in the workflow's
// `paths:` list. Mirror admin/config.yml's collection folders.
const FORBIDDEN_PATHS = [
  "_posts/**",
  "_tags/**",
  "_projects/**",
  "pages/**",
  "_e2e/**",
  "assets/images/uploads/**",
  "assets/**", // bare wildcard — would re-introduce uploads/**
];

// Templates / styling / tooling paths. At least these MUST be present
// so the workflow still fires on the changes it's supposed to catch.
// (If the workflow is deleted entirely, this also fails — which is the
// right answer: "removed without replacement" should not pass silently.)
const REQUIRED_PATHS = [
  "_layouts/**",
  "_includes/**",
  "admin/**",
  "_config.yml",
  ".github/workflows/visual-regression.yml",
];

function readPathsList() {
  // The workflow's `on.pull_request.paths` list, straight off the parsed
  // tree — the parser handles quoting, inline comments, and any anchors.
  const on = parseYaml(fs.readFileSync(WORKFLOW, "utf8")).on;
  const paths = on && on.pull_request && on.pull_request.paths;
  if (!Array.isArray(paths)) {
    throw new Error("could not locate the `on.pull_request.paths` list in visual-regression.yml");
  }
  return paths.map(String);
}

test.describe("visual-regression workflow: content-only PRs are skipped", () => {
  test("no CMS-managed content path appears in the trigger list", () => {
    const paths = readPathsList();
    for (const forbidden of FORBIDDEN_PATHS) {
      expect(
        paths,
        `forbidden path "${forbidden}" is present in visual-regression.yml's paths: list — content-only PRs would re-trigger the regression video`,
      ).not.toContain(forbidden);
    }
  });

  test("template/styling paths are still in the trigger list", () => {
    const paths = readPathsList();
    for (const required of REQUIRED_PATHS) {
      expect(
        paths,
        `required path "${required}" is missing from visual-regression.yml's paths: list — the workflow would no longer fire on template/styling changes`,
      ).toContain(required);
    }
  });

  test("CMS collection folders match the forbidden list", () => {
    // Sanity check: if a new collection is added to admin/config.yml,
    // its folder should also be added to FORBIDDEN_PATHS above.
    const cfg = YAML.parse(
      fs.readFileSync(path.join(__dirname, "..", "admin", "config.yml"), "utf8"),
    );
    const folders = ((cfg && cfg.collections) || [])
      .map((c) => c && c.folder)
      .filter(Boolean)
      .map(String);
    expect(folders.length, "admin/config.yml has at least one collection folder").toBeGreaterThan(
      0,
    );
    for (const folder of folders) {
      const expected = `${folder}/**`;
      expect(
        FORBIDDEN_PATHS,
        `admin/config.yml has a collection at "${folder}" but FORBIDDEN_PATHS does not include "${expected}" — update this test alongside the workflow filter`,
      ).toContain(expected);
    }
  });
});
