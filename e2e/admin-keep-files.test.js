// @lane: local — pure-fs invariant: the gem-shipped admin assets must survive
// Jekyll's `cleanup` phase, and be copied ATOMICALLY, so the e2e admin
// link-crawler (and any reader) never HEADs/GETs a deleted or truncated
// _site/admin asset during an in-test `jekyll build` (#1815 admin-crawler flake).
//
// Root cause it locks: _site/admin/* land via the post_write render hook, NOT
// Jekyll generation — so without `keep_files: [admin]`, Jekyll's cleanup deletes
// them at the start of every build (incl. the rebuilds @admin-write specs run
// against the live _site), and the crawler 404s in the delete→recopy window.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadYaml() {
  // Reuse the harness yaml dep (e2e/node_modules) the same way other lints do.
  // eslint-disable-next-line global-require
  return require("yaml");
}

test.describe("gem admin assets survive cleanup + copy atomically (#1815 admin-crawler flake)", () => {
  test("fixture-site _config.yml keeps `admin` in keep_files", () => {
    const cfg = loadYaml().parse(
      fs.readFileSync(path.join(REPO_ROOT, "e2e", "fixture-site", "_config.yml"), "utf8"),
    );
    expect(
      Array.isArray(cfg.keep_files) && cfg.keep_files.includes("admin"),
      "e2e/fixture-site/_config.yml must set keep_files: [admin] so Jekyll's cleanup never deletes the gem-copied _site/admin assets mid-build (#1815 admin-crawler flake)",
    ).toBe(true);
  });

  test("the scaffolder emits keep_files: [admin] for new sites", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "scaffold", "create-site.js"), "utf8");
    // The generated _config.yml (configYml template literal) must include the
    // keep_files block so every new consumer is born race-free.
    expect(
      /keep_files:\s*\n\s*-\s*admin/.test(src),
      "scaffold/create-site.js configYml() must emit `keep_files:\\n  - admin`",
    ).toBe(true);
  });

  for (const rel of [
    "theme/lib/cms-platform-theme/decap_config_hook.rb",
    "scripts/render-decap-config.rb",
  ]) {
    test(`${rel} copies gem admin assets ATOMICALLY (temp + rename), not a bare truncating cp`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      // The depth-1 gem-asset loop must NOT write the destination directly with
      // FileUtils.cp (truncate-then-write = a partial-read window); it must copy
      // to a temp then File.rename (atomic).
      expect(
        /File\.rename\(tmp,/.test(src),
        `${rel}: gem-asset copy must use a temp + File.rename (atomic), not a bare FileUtils.cp into the served path (#1815 admin-crawler flake)`,
      ).toBe(true);
      // Guard against a bare cp straight into the admin out dir reappearing.
      expect(
        /FileUtils\.cp\(f, File\.join\((?:out|admin_out), bn\)\)/.test(src),
        `${rel}: a bare FileUtils.cp(f, File.join(<out>, bn)) reappeared — use the atomic temp+rename form`,
      ).toBe(false);
    });
  }
});
