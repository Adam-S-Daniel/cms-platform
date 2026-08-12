/*
 * Shared parse + assertion helpers for `.github/dependabot.yml`'s bundler-
 * ecosystem `cms-platform-theme` ignore (cms-platform#242).
 *
 * WHY the ignore has to exist: `platform-bump.yml` is the SOLE owner of the
 * gem's version — it moves the Gemfile `tag:`, the Gemfile.lock git
 * `revision:`, platform.lock's `platform_ref`, and every reusable
 * `uses:@<tag>` pin as ONE atomic PR, which is exactly what lets
 * `check-platform-pin-consistency.js --require-canonical` pass on that PR
 * alone. Dependabot's `bundler` ecosystem can only see (and move) the
 * Gemfile/Gemfile.lock half of that set — a Dependabot-authored bump is
 * either redundant (platform-bump already got there) or skews the tree and
 * reddens platform-pin-consistency. Realized: adamdaniel.ai#3076 rebased a
 * stale Dependabot PR forward without re-resolving its target and proposed a
 * DOWNGRADE, v0.1.80 -> v0.1.75.
 *
 * Two callers share this module so the assertions (and their failure
 * messages) can't drift between them:
 *   - e2e/dependabot-theme-gem-ignored.test.js — CONSUMER mode only, reads
 *     `<SITE_ROOT>/.github/dependabot.yml`.
 *   - e2e/scaffold-seeds-dependabot-ignore.test.js — PLATFORM mode, reads the
 *     `examples/site/.github/dependabot.yml` template AND a freshly
 *     scaffolded site's copy of it.
 *
 * Parses with the `yaml` library — never regex — per the repo-wide
 * AST/real-parser rule (see AGENTS.md).
 */
const fs = require("node:fs");
const { expect } = require("@playwright/test");
const YAML = require("yaml");

// Read + parse a dependabot.yml. Throws on a missing file or invalid YAML —
// callers decide what "must exist" / "must parse" means for their own skip
// semantics before calling this.
function parseDependabotConfig(filePath) {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

// Every `updates` entry whose `package-ecosystem` is `bundler`.
function bundlerEntries(doc) {
  const updates = Array.isArray(doc && doc.updates) ? doc.updates : [];
  return updates.filter((u) => u && u["package-ecosystem"] === "bundler");
}

// The `cms-platform-theme` entry inside a bundler update's `ignore` array, or
// undefined. YAML parsing already normalises quoted/unquoted scalar values to
// the same JS string, so no separate quoted-vs-unquoted handling is needed.
function themeIgnoreEntry(bundlerUpdate) {
  const ignore = Array.isArray(bundlerUpdate && bundlerUpdate.ignore) ? bundlerUpdate.ignore : [];
  return ignore.find((entry) => entry && entry["dependency-name"] === "cms-platform-theme");
}

// Full assertion set for a parsed dependabot.yml doc: exactly one bundler
// entry, that entry ignores cms-platform-theme, and the ignore is UNSCOPED
// (no `update-types`, no `versions` — either key would narrow the ignore to
// specific update classes / version ranges and let a plain version bump
// through, which is the exact PR class this guard exists to block). `label`
// is the file path under test; every failure message names it so a red run
// always says which file to fix.
function assertUnscopedThemeIgnore(label, doc) {
  const updates = bundlerEntries(doc);
  expect(
    updates.length,
    `${label}: expected exactly one 'updates' entry with 'package-ecosystem: bundler', ` +
      `found ${updates.length}.`,
  ).toBe(1);

  const [bundlerUpdate] = updates;
  const themeIgnore = themeIgnoreEntry(bundlerUpdate);
  expect(
    themeIgnore,
    `${label}: the bundler entry's 'ignore' array must contain an entry with ` +
      `'dependency-name: cms-platform-theme'. Add:\n` +
      `    ignore:\n      - dependency-name: "cms-platform-theme"\n` +
      `platform-bump.yml owns this gem's version — see cms-platform#242.`,
  ).toBeTruthy();

  expect(
    themeIgnore["update-types"],
    `${label}: the cms-platform-theme ignore must NOT carry an 'update-types' key. An ` +
      `update-types-scoped ignore (e.g. only 'version-update:semver-major') would NOT stop ` +
      `a plain minor/patch version bump — the exact PR class this guard exists to block ` +
      `(adamdaniel.ai#3076 proposed a downgrade via one such bump). Remove 'update-types' ` +
      `so the ignore applies to every version update.`,
  ).toBeUndefined();

  expect(
    themeIgnore["versions"],
    `${label}: the cms-platform-theme ignore must NOT carry a 'versions' key. A ` +
      `versions-scoped ignore only blocks specific version ranges, letting an in-range ` +
      `Dependabot bump through and skew the tree again — remove 'versions' so the ignore ` +
      `blocks the dependency outright (cms-platform#242).`,
  ).toBeUndefined();
}

module.exports = {
  parseDependabotConfig,
  bundlerEntries,
  themeIgnoreEntry,
  assertUnscopedThemeIgnore,
};
