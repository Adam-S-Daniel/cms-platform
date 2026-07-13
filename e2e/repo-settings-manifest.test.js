// @lane: local — pure-fs lint of the repo-settings.yml manifest; no browser, no network.
// Platform-internal (reads the root manifest + scripts/audit-repo-settings.js
// + the release.yml workflow DEFINITION) — registered in playwright.config.js
// PLATFORM_META_SPECS and testIgnore'd on consumer lanes.
/*
 * Manifest lint for repo settings as code (#109). repo-settings.yml is the
 * single source of truth for the GitHub repo settings + rulesets of the
 * platform repo and both consumers; a human applies it with
 * `node scripts/audit-repo-settings.js --fix --yes`. This lint locks the
 * shapes the mechanism depends on BEFORE anything reaches the live API:
 *   - every value leaf carries a `# why:` comment — the captured rationale
 *     IS the point of #109 (the v0.1.40 delete_branch_on_merge flip had no
 *     record anywhere);
 *   - every settings key is in the script's MANAGED_REPO_KEYS (the SSOT of
 *     what --fix may PATCH — a typo'd key must fail here, not silently
 *     no-op in a PATCH);
 *   - ruleset bodies stay PUT-payload-shaped (known rule types, non-empty
 *     required-check contexts, complete bypass_actors entries);
 *   - the release.yml fan-out consumers are a subset of the managed repos
 *     (a NEW consumer wired into the release fan-out without settings
 *     governance is the pre-#109 gap all over again).
 *
 * Comment reading uses the yaml lib's parseDocument (comment-preserving);
 * the `why:` check on the extracted comment TEXT is a lexical concern —
 * the permitted regex class per AGENTS.md's AST rule.
 */
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "repo-settings.yml");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "audit-repo-settings.js");

const CANONICAL_REPOS = [
  "Adam-S-Daniel/cms-platform",
  "Adam-S-Daniel/adamdaniel.ai",
  "jodidaniel/jodidaniel.com",
];

function loadScript() {
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

function parseManifestDoc() {
  return YAML.parseDocument(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

// All comment text attached to a pair (before/inline, key/value side). A
// comment line preceding a block map's FIRST item attaches to the MAP node's
// commentBefore (yaml lib behaviour), so the parent map + index are needed
// to credit it to that first pair.
function pairCommentText(pair, parentMap, index) {
  return [
    index === 0 && parentMap && parentMap.commentBefore,
    pair.key && pair.key.commentBefore,
    pair.key && pair.key.comment,
    pair.value && pair.value.commentBefore,
    pair.value && pair.value.comment,
  ]
    .filter(Boolean)
    .join("\n");
}

function mapPairs(node) {
  return node && node.items ? node.items : [];
}

test.describe("repo-settings.yml — manifest shape (#109)", () => {
  const doc = parseManifestDoc();
  const data = doc.toJS();

  test("parses cleanly (no YAML errors / duplicate keys) at version 1", () => {
    expect(doc.errors, `YAML errors: ${doc.errors.map((e) => e.message).join("; ")}`).toEqual([]);
    expect(data.version, "repo-settings.yml must declare version: 1").toBe(1);
  });

  test("loads through the script's validating loader", () => {
    // loadManifest() hard-fails on non-MANAGED keys / dangling library refs —
    // the same validation --fix relies on before PATCHing anything.
    const { loadManifest } = loadScript();
    expect(() => loadManifest(MANIFEST_PATH)).not.toThrow();
  });

  test("repos: exactly the three canonical full names", () => {
    expect(Object.keys(data.repos).sort()).toEqual([...CANONICAL_REPOS].sort());
  });

  test("every settings key is a MANAGED_REPO_KEY (the --fix PATCH SSOT)", () => {
    const { MANAGED_REPO_KEYS } = loadScript();
    for (const key of Object.keys(data.settings_defaults || {})) {
      expect(
        MANAGED_REPO_KEYS,
        `settings_defaults.${key} is not in MANAGED_REPO_KEYS (scripts/audit-repo-settings.js)`,
      ).toContain(key);
    }
    for (const [repo, entry] of Object.entries(data.repos)) {
      for (const key of Object.keys((entry && entry.settings) || {})) {
        expect(
          MANAGED_REPO_KEYS,
          `repos.${repo}.settings.${key} is not in MANAGED_REPO_KEYS`,
        ).toContain(key);
      }
    }
  });

  test("every actions_permissions key is a MANAGED_ACTIONS_PERMISSION_KEY (the --fix PUT SSOT)", () => {
    const { MANAGED_ACTIONS_PERMISSION_KEYS } = loadScript();
    for (const key of Object.keys(data.actions_permissions_defaults || {})) {
      expect(
        MANAGED_ACTIONS_PERMISSION_KEYS,
        `actions_permissions_defaults.${key} is not in MANAGED_ACTIONS_PERMISSION_KEYS (scripts/audit-repo-settings.js)`,
      ).toContain(key);
    }
    for (const [repo, entry] of Object.entries(data.repos)) {
      for (const key of Object.keys((entry && entry.actions_permissions) || {})) {
        expect(
          MANAGED_ACTIONS_PERMISSION_KEYS,
          `repos.${repo}.actions_permissions.${key} is not in MANAGED_ACTIONS_PERMISSION_KEYS`,
        ).toContain(key);
      }
    }
  });

  test("actions_permissions: SHA pinning required + the SHORT fork-approval form on all three", () => {
    // Locks the desired baseline (#109 Actions-permissions extension): the two
    // leaves the audit enforces, and specifically the SHORT
    // `all_external_contributors` value the live API returns for "all outside
    // collaborators" — NOT the long require_approval_for_all_outside_
    // collaborators form (the value the task explicitly flagged as wrong).
    const { effectiveActionsPermissions, loadManifest } = loadScript();
    const manifest = loadManifest(MANIFEST_PATH);
    for (const repo of CANONICAL_REPOS) {
      const ap = effectiveActionsPermissions(manifest, repo);
      expect(ap.sha_pinning_required, `${repo} must require workflow SHA pinning`).toBe(true);
      expect(
        ap.approval_policy,
        `${repo} fork-PR approval must be the short all_external_contributors form`,
      ).toBe("all_external_contributors");
      expect(ap.approval_policy).not.toBe("require_approval_for_all_outside_collaborators");
    }
  });

  test("every actions_permissions leaf carries a `# why:` comment", () => {
    const defaults = doc.get("actions_permissions_defaults", true);
    expect(mapPairs(defaults).length).toBeGreaterThan(0);
    mapPairs(defaults).forEach((pair, i) => {
      expect(
        pairCommentText(pair, defaults, i),
        `actions_permissions_defaults.${pair.key} has no \`# why:\` comment`,
      ).toMatch(/why:/);
    });
    const repos = doc.get("repos", true);
    for (const repoPair of mapPairs(repos)) {
      const ap = repoPair.value && repoPair.value.get && repoPair.value.get("actions_permissions", true);
      mapPairs(ap).forEach((pair, i) => {
        expect(
          pairCommentText(pair, ap, i),
          `repos.${repoPair.key}.actions_permissions.${pair.key} has no \`# why:\` comment`,
        ).toMatch(/why:/);
      });
    }
  });

  test("every settings leaf carries a `# why:` comment (the captured rationale)", () => {
    const defaults = doc.get("settings_defaults", true);
    mapPairs(defaults).forEach((pair, i) => {
      expect(
        pairCommentText(pair, defaults, i),
        `settings_defaults.${pair.key} has no \`# why:\` comment — the historical ` +
          `rationale living NEXT TO the value is the whole point of #109`,
      ).toMatch(/why:/);
    });
    const repos = doc.get("repos", true);
    for (const repoPair of mapPairs(repos)) {
      const settings = repoPair.value && repoPair.value.get && repoPair.value.get("settings", true);
      mapPairs(settings).forEach((pair, i) => {
        expect(
          pairCommentText(pair, settings, i),
          `repos.${repoPair.key}.settings.${pair.key} has no \`# why:\` comment`,
        ).toMatch(/why:/);
      });
    }
  });

  test("every ruleset_library entry carries a `# why:` comment", () => {
    const lib = doc.get("ruleset_library", true);
    expect(mapPairs(lib).length).toBeGreaterThan(0);
    mapPairs(lib).forEach((pair, i) => {
      expect(
        pairCommentText(pair, lib, i),
        `ruleset_library.${pair.key} has no \`# why:\` comment`,
      ).toMatch(/why:/);
    });
  });

  test("every ruleset_library entry is referenced by at least one repo", () => {
    const referenced = new Set();
    for (const entry of Object.values(data.repos)) {
      for (const libName of Object.values((entry && entry.rulesets) || {})) referenced.add(libName);
    }
    for (const name of Object.keys(data.ruleset_library || {})) {
      expect(
        referenced.has(name),
        `ruleset_library.${name} is referenced by no repo — dead manifest weight ` +
          `(delete it or wire it under a repo's rulesets:)`,
      ).toBe(true);
    }
  });

  test("every repo resolves delete_branch_on_merge and declares a `main` ruleset", () => {
    const { effectiveSettings, loadManifest } = loadScript();
    const manifest = loadManifest(MANIFEST_PATH);
    for (const repo of Object.keys(data.repos)) {
      expect(
        typeof effectiveSettings(manifest, repo).delete_branch_on_merge,
        `${repo} does not resolve a boolean delete_branch_on_merge — the #109 motivating flag`,
      ).toBe("boolean");
      expect(
        Object.keys(data.repos[repo].rulesets || {}),
        `${repo} declares no \`main\` ruleset — main must never be unprotected`,
      ).toContain("main");
    }
  });

  test("ruleset bodies stay PUT-payload-shaped (rule types / contexts / bypass actors)", () => {
    const { KNOWN_RULE_TYPES } = loadScript();
    for (const [name, body] of Object.entries(data.ruleset_library || {})) {
      for (const rule of body.rules || []) {
        expect(
          KNOWN_RULE_TYPES,
          `ruleset_library.${name}: unknown rule type "${rule.type}" — a typo here ` +
            `would only surface as a live PUT 422`,
        ).toContain(rule.type);
        for (const check of (rule.parameters && rule.parameters.required_status_checks) || []) {
          expect(
            typeof check.context === "string" && check.context.length > 0,
            `ruleset_library.${name}: required_status_checks entry with an empty context`,
          ).toBe(true);
        }
      }
      for (const actor of body.bypass_actors || []) {
        for (const key of ["actor_id", "actor_type", "bypass_mode"]) {
          expect(
            actor[key] !== undefined && actor[key] !== null,
            `ruleset_library.${name}: bypass_actors entry missing ${key} — an ` +
              `incomplete actor makes the PUT 422 or (worse) silently broadens the bypass`,
          ).toBe(true);
        }
      }
    }
  });

  test("cross-lock: every release.yml fan-out consumer is a managed repo", () => {
    // release.yml dispatches platform-bump to its hardcoded consumer list; a
    // consumer wired into the release fan-out but absent here would get
    // platform code with UNGOVERNED settings — the pre-#109 gap.
    const wf = parseYaml(readWorkflow("release.yml"));
    const runs = [];
    for (const job of Object.values(wf.jobs || {})) {
      for (const step of job.steps || []) if (typeof step.run === "string") runs.push(step.run);
    }
    const fanout = [];
    for (const run of runs) {
      // Lexical extraction of the `dispatch "<owner>/<repo>"` call sites from
      // the (already YAML-parsed) shell text — leaf-token regex, permitted.
      for (const m of run.matchAll(/dispatch\s+"([^"]+\/[^"]+)"/g)) fanout.push(m[1]);
    }
    expect(fanout.length, "release.yml fan-out dispatch list not found").toBeGreaterThan(0);
    for (const repo of fanout) {
      expect(
        Object.keys(data.repos),
        `release.yml fans out to ${repo}, which repo-settings.yml does not manage — ` +
          `add it under repos: (usually main: consumer-main + cms-feature-branches)`,
      ).toContain(repo);
    }
  });
});
