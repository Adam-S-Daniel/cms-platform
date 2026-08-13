// @lane: local — pure-fs, PLATFORM-ONLY lint (parses with the `yaml` library,
// never regex): the scaffold TEMPLATE `examples/site/.github/dependabot.yml`
// carries BOTH platform-bump-owned ignores — the `cms-platform-theme`
// bundler ignore (cms-platform#242) and the github-actions
// `Adam-S-Daniel/cms-platform/*` ignore (cms-platform#244) — AND
// `scaffold/create-site.js` actually copies the file (and its own workflow
// callers) verbatim into a freshly seeded site. See
// e2e/dependabot-config-utils.js for the full WHY of both and the shared
// parse/assert helpers this spec and its consumer-mode sibling
// (e2e/dependabot-theme-gem-ignored.test.js) both use.
//
// Two subtests, mirroring the scaffold-output family
// (scaffold-preview-and-404.test.js / scaffold-seeds-neutral-logo.test.js),
// each now asserting BOTH ignores rather than being split into four:
//   (a) the TEMPLATE itself carries both unscoped ignores, checked against
//       examples/site/.github/workflows — asserted UNCONDITIONALLY (no skip
//       path; the template must always carry them);
//   (b) a fresh `scaffold/create-site.js` run into a throwaway dir seeds a
//       `.github/dependabot.yml` that ALSO carries both, checked against
//       THAT throwaway dir's own seeded `.github/workflows` (the scaffolder
//       re-pins every `uses:@` to `--platform-ref`, so the seeded workflow
//       set is what coverage must be checked against, not the template's).
//       Before this spec, nothing proved the scaffolder's actual OUTPUT
//       carried the fix — only that the source template did;
//       scaffold/create-site.js's copyTree() is a plain directory copy of
//       examples/site/.github, so (b) is a thin but real check that the
//       copy step didn't drop or mangle the file. Extending the existing two
//       subtests (rather than adding two more) keeps the scaffolder — which
//       shells out to `node` and does real fs work — running exactly once.
//
// PLATFORM-ONLY: reads examples/site/.github/dependabot.yml (the template)
// and runs scaffold/create-site.js (the platform generator) — both absent on
// a consumer. Registered in PLATFORM_META_SPECS (playwright.config.js) so a
// CONSUMER=true e2e lane testIgnore's it rather than ENOENT-failing.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");
const {
  parseDependabotConfig,
  assertUnscopedThemeIgnore,
  assertPlatformActionsIgnored,
} = require("./dependabot-config-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");
const TEMPLATE_PATH = path.join(REPO_ROOT, "examples", "site", ".github", "dependabot.yml");
const TEMPLATE_WORKFLOWS_DIR = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");

test.describe(
  "scaffold template + scaffolder output: platform-bump-owned refs are ignored (#242 + #244)",
  () => {
    test(`(a) ${TEMPLATE_PATH} carries both unscoped platform ignores`, () => {
      expect(fs.existsSync(TEMPLATE_PATH), `${TEMPLATE_PATH} must exist`).toBe(true);
      const doc = parseDependabotConfig(TEMPLATE_PATH);
      expect(doc && doc.version, `${TEMPLATE_PATH}: top-level 'version' must be 2`).toBe(2);
      expect(
        Array.isArray(doc.updates) && doc.updates.length > 0,
        `${TEMPLATE_PATH}: top-level 'updates' must be a non-empty array`,
      ).toBe(true);
      assertUnscopedThemeIgnore(TEMPLATE_PATH, doc);
      assertPlatformActionsIgnored(TEMPLATE_PATH, doc, TEMPLATE_WORKFLOWS_DIR);
    });

    test("(b) scaffold/create-site.js seeds a .github/dependabot.yml with both ignores", () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "cms242-scaffold-"));
      try {
        // --platform-ref pins the version so this test never hits the network
        // (mirrors scaffold-preview-and-404.test.js / scaffold-seeds-neutral-logo.test.js).
        execFileSync(
          "node",
          [
            SCAFFOLDER,
            target,
            "--yes",
            "--domain",
            "test.local",
            "--repo",
            "test",
            "--owner",
            "test-owner",
            "--platform-ref",
            "v0.1.52",
          ],
          { stdio: "pipe" },
        );
        const seededPath = path.join(target, ".github", "dependabot.yml");
        const seededWorkflowsDir = path.join(target, ".github", "workflows");
        expect(fs.existsSync(seededPath), `scaffolder must seed ${seededPath}`).toBe(true);
        const doc = parseDependabotConfig(seededPath);
        assertUnscopedThemeIgnore(seededPath, doc);
        assertPlatformActionsIgnored(seededPath, doc, seededWorkflowsDir);
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    });
  },
);
