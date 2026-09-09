// @lane: local — pure-fs lint over platform-prerelease-guard.yml and
// platform-pin-consistency.yml, asserting each workflow's `yaml`-parser
// install stays scoped to the PLATFORM checkout (`.cms-platform/`) and never
// reads the consumer root's `package.json`.
/*
 * Regression test for the 2026-09-08 incident.
 *
 * Both reusables used to install `yaml` with a plain
 * `npm install --no-save --no-package-lock yaml@2.9.0`, run from the
 * CONSUMER repo root (no `--prefix`). npm resolves the ENTIRE dependency
 * tree of whatever `package.json` sits at its prefix, so an install at the
 * consumer root doesn't just fetch `yaml` — it re-resolves every
 * devDependency the consumer happens to declare, and `--no-package-lock`
 * forces that resolution straight from the registry, bypassing the
 * lockfile that pins those devDependencies to versions already known to
 * work. That silently couples a platform-pin guard's exit code to packages
 * it has nothing to do with.
 *
 * It stopped being theoretical on 2026-09-08: decap-cms-lib-util@3.8.1 was
 * published with unresolved pnpm `catalog:` specifiers in its manifest.
 * npm exited `EUNSUPPORTEDPROTOCOL` trying to resolve them, and because
 * both `platform-prerelease-guard.yml` and `platform-pin-consistency.yml`
 * installed `yaml` at the consumer root, that one broken upstream publish
 * turned BOTH — both REQUIRED status checks — red on every adamdaniel.ai
 * PR, blocking every editorial publish until the install moved.
 *
 * The fix is `npm install --prefix .cms-platform ...`. `.cms-platform/` is
 * the sparse platform checkout these workflows already create to fetch the
 * guard scripts, and it carries no `package.json` of its own, so npm
 * resolves `yaml` and nothing else. Both scripts' `loadYaml()` already
 * probe `path.resolve(__dirname, "..", "node_modules")` — i.e.
 * `.cms-platform/node_modules` from `.cms-platform/scripts/` — so no
 * script logic needed to change, only where the install lands.
 *
 * This lint parses the workflow YAML with the real parser — never a regex
 * or line scan over the file (AGENTS.md) — via workflow-yaml-utils'
 * `runScripts()`, which returns every `run:` block off the parsed tree.
 * Matching a flag (`--prefix`, `yaml@<version>`) WITHIN one already-
 * extracted run-block string with a regex is fine: that is lexical content
 * of a string this repo's own parser handed us, not a structural read of
 * the file.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, runScripts } = require("./workflow-yaml-utils");

const WORKFLOWS = ["platform-prerelease-guard.yml", "platform-pin-consistency.yml"];

// e2e/package.json's own `yaml` devDependency is the single source of truth
// for the pinned version — read it rather than hardcoding "2.9.0" a second
// time, so the workflows' pin and the harness's pin cannot silently diverge.
const PINNED_YAML_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
).devDependencies.yaml;

// Every `run:` block that installs `yaml` via npm. Structural down to the
// `run:` block (runScripts() walks the parsed document), then a lexical
// regex over each extracted script string to recognise the
// `npm install ... yaml@...` shape within it.
function yamlInstallScripts(workflowText) {
  return runScripts(workflowText).filter(
    ({ script }) => /npm\s+install\b/.test(script) && /\byaml@/.test(script),
  );
}

for (const workflow of WORKFLOWS) {
  test.describe(`${workflow}: yaml install stays scoped to .cms-platform`, () => {
    test("exactly one run: block installs yaml via npm", () => {
      const matches = yamlInstallScripts(readWorkflow(workflow));
      expect(
        matches.length,
        `expected exactly one npm install of yaml in ${workflow}, found ` +
          `${matches.length}: ${JSON.stringify(matches.map((m) => m.script))}. A second ` +
          "install site means this guard must be re-examined rather than silently " +
          "half-covered.",
      ).toBe(1);
    });

    test("that install carries --prefix .cms-platform", () => {
      const matches = yamlInstallScripts(readWorkflow(workflow));
      for (const { script } of matches) {
        expect(script).toMatch(/--prefix\s+\.cms-platform\b/);
      }
    });

    test("no yaml install lands in the consumer root (missing --prefix)", () => {
      const matches = yamlInstallScripts(readWorkflow(workflow));
      const unscoped = matches.filter(({ script }) => !/--prefix\b/.test(script));
      expect(
        unscoped.map((m) => m.script),
        "an npm install of yaml with no --prefix resolves against whatever " +
          "package.json sits at the consumer root, re-coupling this guard to every " +
          "devDependency the consumer declares — the 2026-09-08 incident.",
      ).toEqual([]);
    });

    test("the pinned yaml version matches e2e/package.json's yaml devDependency", () => {
      const matches = yamlInstallScripts(readWorkflow(workflow));
      for (const { script } of matches) {
        const m = script.match(/\byaml@(\S+)/);
        expect(m, `no yaml@<version> found in: ${script}`).toBeTruthy();
        expect(m[1]).toBe(PINNED_YAML_VERSION);
      }
    });
  });
}
