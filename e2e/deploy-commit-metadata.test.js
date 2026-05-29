// @lane: local — pure-fs lint of deploy workflow YAML; no browser, no network
/*
 * Regression test: the `commit.json` step in deploy-{preview,production}
 * must read the timestamp from `git log` against HEAD (or a derived
 * refstring), not from `${{ github.sha }}`.
 *
 * On `pull_request` events, `github.sha` is a synthetic merge commit
 * created by GitHub — it isn't fetched into shallow clones, so
 * `git log -1 --format=%cI ${{ github.sha }}` fails with `bad object`.
 * (Audit chat-finding #7.)
 */
const { test, expect } = require("./base");
const { readWorkflow, runScripts } = require("./workflow-yaml-utils");

// Every `run:` script that writes the deployed-build pill's commit.json
// — pulled from the parsed workflow, so it sees the script GitHub
// actually runs regardless of YAML shape.
function commitJsonScripts(yaml) {
  return runScripts(yaml)
    .map((r) => r.script)
    .filter((s) => s.includes("commit.json"));
}

// Drop shell comment lines so a `# … github.sha …` explainer inside the
// script never counts as an offender.
function stripComments(script) {
  return script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

for (const wf of ["deploy-preview.yml", "deploy-production.yml"]) {
  const steps = commitJsonScripts(readWorkflow(wf));

  test(`${wf} writes commit.json`, () => {
    expect(
      steps.length,
      `Expected a commit.json step in ${wf} — the deployed-build pill ` +
        `in admin/index.html depends on it.`,
    ).toBeGreaterThan(0);
  });

  steps.forEach((step, i) => {
    test(`${wf} commit.json step #${i + 1} uses HEAD, not github.sha`, () => {
      const code = stripComments(step);
      expect(code).toMatch(/git log\b/);
      const offenders = code
        .split("\n")
        .filter((l) => /git log\b/.test(l) && /\$\{\{\s*github\.sha\s*\}\}/.test(l));
      expect(
        offenders,
        `git log in ${wf} must use HEAD or github.event.pull_request.head.sha, ` +
          `not \${{ github.sha }} (synthetic merge commit, not in shallow ` +
          `clones).`,
      ).toEqual([]);
    });
  });
}
