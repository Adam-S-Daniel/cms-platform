/*
 * Shared parse + assertion helpers for `.github/dependabot.yml`'s two
 * cms-platform ignores: the bundler-ecosystem `cms-platform-theme` gem
 * (cms-platform#242) and the github-actions-ecosystem
 * `Adam-S-Daniel/cms-platform/*` reusable-workflow pins (cms-platform#244).
 *
 * WHY the bundler ignore has to exist: `platform-bump.yml` is the SOLE owner of
 * the gem's version — it moves the Gemfile `tag:`, the Gemfile.lock git
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
 * WHY the github-actions ignore has to exist, and why it's a bigger surface:
 * that ecosystem treats each WORKFLOW FILE's `uses:` as its own independent
 * dependency, so Dependabot can only move them ONE PR AT A TIME — every such
 * PR necessarily leaves the other ~34 cms-platform references behind, which
 * is exactly the skew pin-consistency exists to fail. Not theoretical:
 * jodidaniel.com#8-#22 produced FIFTEEN bump PRs from a single release (two
 * self-closed as redundant), and adamdaniel.ai#1895-#1898 produced four more
 * with different from-versions per file in the same batch. The matcher
 * GitHub actually applies to an `ignore:` `dependency-name` —
 * `Dependabot::Config::UpdateConfig.wildcard_match?` (in
 * common/lib/dependabot/config/update_config.rb) — treats `*` as `.*`, which
 * crosses `/`; that's why one `Adam-S-Daniel/cms-platform/*` pattern covers every
 * `.../.github/workflows/<name>.yml` (and future `.../.github/actions/<name>`)
 * dependency name. `wildcardMatches()` below re-implements that matcher
 * exactly, because the wildcard semantics are the one piece of this fix that
 * can't be proven empirically inside CI — nothing here talks to Dependabot.
 *
 * Four callers share this module so the assertions (and their failure
 * messages) can't drift between them:
 *   - e2e/dependabot-theme-gem-ignored.test.js — CONSUMER mode only, reads
 *     `<SITE_ROOT>/.github/dependabot.yml`; covers both #242 and #244.
 *   - e2e/scaffold-seeds-dependabot-ignore.test.js — PLATFORM mode, reads the
 *     `examples/site/.github/dependabot.yml` template AND a freshly
 *     scaffolded site's copy of it; covers both #242 and #244.
 *
 * Parses with the `yaml` library — never regex — per the repo-wide
 * AST/real-parser rule (see AGENTS.md).
 */
const fs = require("node:fs");
const path = require("node:path");
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

// ── github-actions ecosystem (#244) ─────────────────────────────────────

const DEFAULT_PLATFORM_REPO = "Adam-S-Daniel/cms-platform";

// A faithful JS port of dependabot-core's
// `Dependabot::Config::UpdateConfig.wildcard_match?` (in
// common/lib/dependabot/config/update_config.rb) — the matcher GitHub
// actually applies to an `ignore:` `dependency-name`.
// Ruby source: lowercase the pattern, split on `*`, Regexp.quote each
// literal segment, join the pieces with `.*`, anchor `^...$`, and test
// against the lowercased candidate. `*` becomes `.*`, and `.` matches `/`
// by default in both Ruby and JS regex, so a single wildcard segment DOES
// cross path separators — that's why `Adam-S-Daniel/cms-platform/*` covers
// `Adam-S-Daniel/cms-platform/.github/workflows/e2e-tests.yml`. This is the
// one piece of the #244 fix that cannot be proven empirically inside CI (no
// call here actually talks to Dependabot), so the lint has to encode the
// semantics directly instead.
function escapeRegExpLiteral(segment) {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardMatches(pattern, candidate) {
  if (typeof pattern !== "string" || typeof candidate !== "string") return false;
  const segments = pattern.toLowerCase().split("*").map(escapeRegExpLiteral);
  const re = new RegExp(`^${segments.join(".*")}$`);
  return re.test(candidate.toLowerCase());
}

// Recursively walk a parsed workflow document and collect every `uses:`
// STRING value found anywhere (job-level `uses:` on a reusable-workflow
// call, and step-level `uses:` on an action step) — never regex the source,
// per the repo-wide AST/real-parser rule.
function collectUsesFromNode(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectUsesFromNode(item, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string") {
        out.push(value);
      } else {
        collectUsesFromNode(value, out);
      }
    }
  }
}

// Every `uses:` string in every `*.yml`/`*.yaml` file directly under
// `workflowsDir`. [] when the directory doesn't exist — a missing
// `.github/workflows` is a legitimate (if unusual) state for a caller to
// probe, not a parse error.
function collectUsesRefs(workflowsDir) {
  if (!fs.existsSync(workflowsDir)) return [];
  const out = [];
  const files = fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
  for (const file of files) {
    const doc = YAML.parse(fs.readFileSync(path.join(workflowsDir, file), "utf8"));
    collectUsesFromNode(doc, out);
  }
  return out;
}

// The Dependabot github-actions dependency NAME for a `uses:` value:
// everything before the `@`, trimmed. Local actions (`./...`) and
// `docker://...` references aren't github-actions-ecosystem dependencies at
// all (Dependabot doesn't version-track them the same way), so both return
// null rather than a bogus name.
function usesDependencyName(uses) {
  if (typeof uses !== "string") return null;
  const trimmed = uses.trim();
  if (trimmed.startsWith("./") || trimmed.startsWith("docker://")) return null;
  const at = trimmed.indexOf("@");
  return (at === -1 ? trimmed : trimmed.slice(0, at)).trim();
}

// The de-duplicated, sorted set of dependency names under `workflowsDir`
// that belong to `platformRepo` itself or one of its `/...` sub-paths
// (composite actions, reusable workflows) — compared case-insensitively,
// matching wildcard_match?'s own case-folding.
function platformActionNames(workflowsDir, platformRepo = DEFAULT_PLATFORM_REPO) {
  const repoLower = platformRepo.toLowerCase();
  const names = collectUsesRefs(workflowsDir)
    .map(usesDependencyName)
    .filter(Boolean)
    .filter((name) => {
      const nameLower = name.toLowerCase();
      return nameLower === repoLower || nameLower.startsWith(`${repoLower}/`);
    });
  return Array.from(new Set(names)).sort();
}

// Every `updates` entry whose `package-ecosystem` is `github-actions`.
function actionsEntries(doc) {
  const updates = Array.isArray(doc && doc.updates) ? doc.updates : [];
  return updates.filter((u) => u && u["package-ecosystem"] === "github-actions");
}

// Representative third-party action names none of the platform ignore
// entries may accidentally cover. Catches a lazy `dependency-name: "*"`,
// which would silently disable the WHOLE ecosystem and break this file's
// own promise (stated in the comment above the ignore) that a genuine
// third-party action is still picked up the moment one is added.
const THIRD_PARTY_PROBE_ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "ruby/setup-ruby",
  "aws-actions/configure-aws-credentials",
];

// Full assertion set for a parsed dependabot.yml doc's github-actions
// ecosystem, mirroring `assertUnscopedThemeIgnore`'s structure and
// failure-message quality: every message names `label` and, where an add
// is needed, says exactly what to add. `workflowsDir` is the
// `.github/workflows` directory belonging to the SAME repo as `doc` (a
// consumer's own tree in CONSUMER mode, or the platform template /
// scaffolder output in PLATFORM mode) — coverage is only meaningful when
// checked against that repo's own `uses:` refs.
function assertPlatformActionsIgnored(label, doc, workflowsDir) {
  const updates = actionsEntries(doc);
  expect(
    updates.length,
    `${label}: expected exactly one 'updates' entry with 'package-ecosystem: github-actions', ` +
      `found ${updates.length}.`,
  ).toBe(1);

  const [actionsUpdate] = updates;
  const ignoreEntries = Array.isArray(actionsUpdate.ignore) ? actionsUpdate.ignore : [];

  // Non-vacuity: refuse to pass a check that never looked at anything. This
  // repo has been burned by that failure mode twice — v0.1.77's pin-
  // consistency checker silently dropped from 96 checks to 61 and still
  // printed "consistent", and a `runScripts(wf).join()` bug once let both
  // shell assertions pass against the 15-character string "[object Object]".
  const platformNames = platformActionNames(workflowsDir);
  expect(
    platformNames.length > 0,
    `${label}: platformActionNames() found NO ${DEFAULT_PLATFORM_REPO} 'uses:' reference under ` +
      `${workflowsDir} — either that workflows directory is wrong, or this repo's workflow set ` +
      `no longer pins any cms-platform action at all, and this check refuses to pass without ` +
      `having looked at anything (cms-platform#244).`,
  ).toBe(true);

  // Coverage: every platform dependency name must be matched by at least
  // one ignore entry, using the SAME wildcard_match? semantics Dependabot
  // itself applies.
  const uncovered = platformNames.filter(
    (name) =>
      !ignoreEntries.some((entry) => wildcardMatches(entry && entry["dependency-name"], name)),
  );
  const shownUncovered = uncovered.slice(0, 5);
  const uncoveredTail =
    uncovered.length > shownUncovered.length
      ? ` …and ${uncovered.length - shownUncovered.length} more`
      : "";
  expect(
    uncovered.length,
    `${label}: the github-actions entry's 'ignore' array does not cover ${uncovered.length} ` +
      `cms-platform dependency name(s): ${shownUncovered.join(", ")}${uncoveredTail}. Add:\n` +
      `    ignore:\n      - dependency-name: "${DEFAULT_PLATFORM_REPO}/*"\n` +
      `platform-bump.yml owns every cms-platform reference atomically — see cms-platform#244.`,
  ).toBe(0);

  // Unscoped: any ignore entry that covers at least one platform name must
  // carry neither `update-types` nor `versions` — same reasoning as the
  // bundler half above. A scoped ignore would let a plain version bump
  // through, which is the exact PR class this guard blocks
  // (jodidaniel.com#8-#22, adamdaniel.ai#1895-#1898).
  const coveringEntries = ignoreEntries.filter((entry) =>
    platformNames.some((name) => wildcardMatches(entry && entry["dependency-name"], name)),
  );
  for (const entry of coveringEntries) {
    expect(
      entry["update-types"],
      `${label}: the ignore entry 'dependency-name: ${entry["dependency-name"]}' must NOT carry ` +
        `an 'update-types' key. An update-types-scoped ignore would NOT stop a plain minor/patch ` +
        `version bump — the exact PR class this guard exists to block (jodidaniel.com#8-#22, ` +
        `adamdaniel.ai#1895-#1898). Remove 'update-types' so the ignore applies to every version ` +
        `update.`,
    ).toBeUndefined();

    expect(
      entry["versions"],
      `${label}: the ignore entry 'dependency-name: ${entry["dependency-name"]}' must NOT carry ` +
        `a 'versions' key. A versions-scoped ignore only blocks specific ranges, letting an ` +
        `in-range Dependabot bump through and skew the tree again — remove 'versions' so the ` +
        `ignore blocks the dependency outright (cms-platform#244).`,
    ).toBeUndefined();
  }

  // Not over-broad: no ignore entry covering a platform name may ALSO match
  // a genuine third-party action — that would mean the pattern is wider
  // than `Adam-S-Daniel/cms-platform/*` (a bare `*`, most likely), which
  // silently disables the whole ecosystem instead of narrowly targeting
  // cms-platform.
  for (const thirdParty of THIRD_PARTY_PROBE_ACTIONS) {
    const overBroad = coveringEntries.find((entry) =>
      wildcardMatches(entry && entry["dependency-name"], thirdParty),
    );
    const overBroadName = overBroad && overBroad["dependency-name"];
    expect(
      overBroad,
      `${label}: the ignore entry 'dependency-name: ${overBroadName}' also matches the ` +
        `third-party action '${thirdParty}' — it must be scoped to '${DEFAULT_PLATFORM_REPO}/*', ` +
        `never a bare '*', which would silently disable the WHOLE ecosystem and break this ` +
        `file's own promise that a genuine third-party action is picked up the moment one is ` +
        `added.`,
    ).toBeUndefined();
  }
}

module.exports = {
  parseDependabotConfig,
  bundlerEntries,
  themeIgnoreEntry,
  assertUnscopedThemeIgnore,
  wildcardMatches,
  collectUsesRefs,
  usesDependencyName,
  platformActionNames,
  assertPlatformActionsIgnored,
};
