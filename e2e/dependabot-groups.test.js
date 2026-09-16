// @lane: local — pure-fs, PLATFORM lint (parses with the `yaml` library,
// never a regex over source) on THIS repo's OWN `.github/dependabot.yml`.
//
// THE FAILURE MODE BEING GUARDED IS SILENCE
// ------------------------------------------
// Dependabot ignores a `groups.<name>` key it does not recognise — the
// config still parses, still reviews clean, and the group simply never
// forms. `applies_to` (underscore) instead of `applies-to` (hyphen) is the
// obvious typo, but any misspelled key in this position has the same shape:
// nothing goes red, nothing warns, and the npm `/e2e` entry's security
// group silently stops grouping. That reopens the #118-122 batch-strand
// risk this platform already got burned by once (see AGENTS.md,
// "Dependabot batch-strand re-arm sweep") — with no signal anywhere that it
// happened.
//
// THE ALLOWED KEY SET — verified 2026-08-31 against GitHub's Dependabot
// options reference. A `groups.<name>` definition allows EXACTLY these six
// keys; `applies-to` allows EXACTLY these two values.
const ALLOWED_GROUP_KEYS = [
  "applies-to",
  "dependency-type",
  "exclude-patterns",
  "group-by",
  "patterns",
  "update-types",
];
const ALLOWED_APPLIES_TO_VALUES = ["version-updates", "security-updates"];

// PLATFORM-ONLY: reads THIS repo's own `.github/dependabot.yml` by literal
// path — a consumer's dependabot.yml is a different file with different
// (and legitimately different) groups. Registered in PLATFORM_META_SPECS
// (playwright.config.js) so a CONSUMER=true e2e lane testIgnore's it rather
// than asserting against a config this spec was never meant to check.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const YAML = require("yaml");

const REPO_ROOT = path.resolve(__dirname, "..");
const TARGET_PATH = path.join(REPO_ROOT, ".github", "dependabot.yml");

function parseTarget() {
  return YAML.parse(fs.readFileSync(TARGET_PATH, "utf8"));
}

// Every `groups.<name>` definition across every `updates[]` entry, flattened
// with enough context (ecosystem + directory + group name) for a useful
// failure message. [] when no entry declares a `groups` map at all.
function eachGroup(doc) {
  const updates = Array.isArray(doc && doc.updates) ? doc.updates : [];
  const out = [];
  for (const entry of updates) {
    const groups =
      entry && typeof entry.groups === "object" && entry.groups !== null ? entry.groups : null;
    if (!groups) continue;
    for (const [groupName, group] of Object.entries(groups)) {
      out.push({
        ecosystem: entry["package-ecosystem"],
        directory: entry.directory,
        groupName,
        group: group && typeof group === "object" ? group : {},
      });
    }
  }
  return out;
}

test.describe("dependabot.yml groups: every key is one Dependabot actually honours", () => {
  test("every group key is one Dependabot RECOGNISES — an unknown key is silently ignored", () => {
    const doc = parseTarget();
    const groups = eachGroup(doc);

    // Non-vacuity: refuse to pass a check that never looked at anything. A
    // walk over "every group" passes trivially the day there are none — this
    // repo has been burned by that exact shape before (see the non-vacuity
    // guard in dependabot-config-utils.js's assertPlatformActionsIgnored),
    // so guard it explicitly here too rather than trusting the loop below.
    expect(
      groups.length > 0,
      `${TARGET_PATH}: found no 'groups' entries anywhere under 'updates[]' — this check refuses ` +
        `to pass without having examined at least one group. Either the npm /e2e entry's ` +
        `'groups:' block was removed (see the third test in this file), or this file's ` +
        `eachGroup() walk is broken.`,
    ).toBe(true);

    for (const { ecosystem, directory, groupName, group } of groups) {
      for (const key of Object.keys(group)) {
        expect(
          ALLOWED_GROUP_KEYS.includes(key),
          `${TARGET_PATH}: group '${groupName}' under package-ecosystem '${ecosystem}' directory ` +
            `'${directory}' declares key '${key}', which Dependabot does not recognise as a ` +
            `groups option. Dependabot SILENTLY IGNORES an unrecognised group key — the config ` +
            `still parses, still reviews clean, and the group simply never forms. Recognised ` +
            `keys are: ${ALLOWED_GROUP_KEYS.join(", ")}.`,
        ).toBe(true);
      }
    }
  });

  test("applies-to carries a value Dependabot recognises", () => {
    const doc = parseTarget();
    const groups = eachGroup(doc).filter(({ group }) =>
      Object.prototype.hasOwnProperty.call(group, "applies-to"),
    );

    for (const { ecosystem, directory, groupName, group } of groups) {
      expect(
        ALLOWED_APPLIES_TO_VALUES.includes(group["applies-to"]),
        `${TARGET_PATH}: group '${groupName}' under package-ecosystem '${ecosystem}' directory ` +
          `'${directory}' sets 'applies-to: ${group["applies-to"]}', which Dependabot does not ` +
          `recognise. An unrecognised applies-to value is likewise silently ignored rather than ` +
          `rejected — the group parses and reviews clean but never actually narrows to the ` +
          `intended update class. Recognised values are: ${ALLOWED_APPLIES_TO_VALUES.join(", ")}.`,
      ).toBe(true);
    }
  });

  test("the npm /e2e entry groups SECURITY updates (#118-122 batch-strand)", () => {
    const doc = parseTarget();
    const updates = Array.isArray(doc && doc.updates) ? doc.updates : [];
    const entry = updates.find(
      (u) => u && u["package-ecosystem"] === "npm" && u.directory === "/e2e",
    );

    expect(
      entry,
      `${TARGET_PATH}: expected an 'updates[]' entry with 'package-ecosystem: npm' and ` +
        `'directory: "/e2e"' — none found.`,
    ).toBeTruthy();

    const groups =
      entry && typeof entry.groups === "object" && entry.groups !== null ? entry.groups : {};
    const hasSecurityGroup = Object.values(groups).some(
      (g) => g && g["applies-to"] === "security-updates",
    );

    expect(
      hasSecurityGroup,
      `${TARGET_PATH}: the npm '/e2e' entry must declare at least one 'groups' entry with ` +
        `'applies-to: security-updates'. WHY THIS MATTERS: a batch of Dependabot PRs opened ` +
        `together strands indefinitely — GitHub auto-disables auto-merge the moment the FIRST ` +
        `PR in the batch merges, and every later merge in the batch also leaves the rest ` +
        `genuinely behind main; dependabot-rearm-sweep.yml re-arms auto-merge but cannot ` +
        `un-strand a PR whose base has already moved (see AGENTS.md, "Dependabot batch-strand ` +
        `re-arm sweep", cms-platform#118-122). Grouping security updates into one PR collapses ` +
        `the whole batch, so there is nothing left to strand. Removing this group fails ` +
        `SILENTLY: Dependabot just reverts to opening one PR per advisory, the config still ` +
        `parses and reviews clean, and no check goes red.`,
    ).toBe(true);
  });

  // Deliberately NOT asserted: the exact `patterns` value, or that
  // `@playwright/test` sits in `exclude-patterns`. Both are policy
  // judgments, not correctness properties — they're explained at length in
  // the comment above the `groups:` block in .github/dependabot.yml, and
  // grouping github-actions too, or reconsidering the Playwright exclusion,
  // are legitimate future tuning decisions. Pinning either here would turn
  // a policy call into a fight with CI. This suite only guards that (a)
  // every group key Dependabot is ever handed is one it actually honours,
  // and (b) the npm /e2e entry has SOME group covering security updates —
  // never which packages that group names.
});
