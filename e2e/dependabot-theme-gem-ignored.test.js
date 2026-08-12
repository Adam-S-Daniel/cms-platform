// @lane: local — pure-fs, CONSUMER-ONLY lint (parses with the `yaml` library,
// never regex) of a live cms-platform consumer's `.github/dependabot.yml`: the
// bundler ecosystem MUST carry an unscoped ignore for the `cms-platform-theme`
// gem (cms-platform#242). See e2e/dependabot-config-utils.js for the full WHY
// and the shared parse/assert helpers this spec and its platform-mode sibling
// (e2e/scaffold-seeds-dependabot-ignore.test.js) both use.
//
// CONSUMER ONLY, never platform. This spec reads ONLY
// `<SITE_ROOT>/.github/dependabot.yml` — no platform-source path (not
// `examples/site`, not the repo root used as a content root) appears
// anywhere in this file. When SITE_ROOT is unset (the platform's own
// self-CI) the whole describe block is skipped, deliberately: the
// platform's OWN `.github/dependabot.yml` carries NO `bundler` ecosystem at
// all — it ships a bare `theme/*.gemspec` with no Gemfile.lock to pin (see
// the comment in that file) — so falling back to the repo root here would
// assert against a file that was never meant to carry this fix and fail for
// the wrong reason. The platform TEMPLATE (examples/site/.github/
// dependabot.yml) and the scaffolder's seeded output are covered separately,
// and unconditionally, by e2e/scaffold-seeds-dependabot-ignore.test.js —
// which IS registered in PLATFORM_META_SPECS. This file is deliberately NOT
// registered there: it is meaningful (and safe to run) on a real consumer
// e2e lane, which is the whole point of it existing.
//
// Consumer skip: `test.skip()` fires when SITE_ROOT is unset (platform mode,
// per above) OR when a genuinely SITE_ROOT-having run's target file doesn't
// exist at all (a site with no `.github/dependabot.yml` has nothing to guard
// here). Every other run asserts unconditionally.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseDependabotConfig, assertUnscopedThemeIgnore } = require("./dependabot-config-utils");

const CONSUMER = !!process.env.SITE_ROOT;
const TARGET_PATH = CONSUMER ? path.join(process.env.SITE_ROOT, ".github", "dependabot.yml") : null;

const SKIP = !CONSUMER || !fs.existsSync(TARGET_PATH);
const SKIP_REASON = !CONSUMER
  ? "SITE_ROOT is unset (platform self-CI) — the platform's own dependabot.yml carries no " +
    "bundler ecosystem by design; see e2e/scaffold-seeds-dependabot-ignore.test.js for the " +
    "platform-mode coverage of this invariant."
  : `${TARGET_PATH} does not exist — this consumer carries no .github/dependabot.yml, so ` +
    `there is nothing to guard here.`;

test.describe("consumer dependabot.yml: cms-platform-theme gem is ignored under bundler (#242)", () => {
  test("exists, parses as YAML, and its bundler entry unscopes-ignores cms-platform-theme", () => {
    test.skip(SKIP, SKIP_REASON);

    const label = TARGET_PATH;
    let doc;
    let parseError = null;
    try {
      doc = parseDependabotConfig(label);
    } catch (err) {
      parseError = err;
    }
    expect(
      parseError,
      `${label} must parse as valid YAML` + (parseError ? ` (got: ${parseError.message})` : ""),
    ).toBeNull();

    expect(doc && doc.version, `${label}: top-level 'version' must be 2`).toBe(2);
    expect(
      Array.isArray(doc.updates) && doc.updates.length > 0,
      `${label}: top-level 'updates' must be a non-empty array`,
    ).toBe(true);

    assertUnscopedThemeIgnore(label, doc);
  });
});
