// @lane: local — pure-fs lint of the editorial-label-audit reusable workflow.
//
// REGRESSION GUARD (both consumers, main): the reusable SPARSE-checks-out only
// scripts/audit-editorial-labels.js into .cms-platform/ and never checks out the
// consumer repo, so github.workspace is NOT a git repo. The audit script then
// ran `gh pr list` with no --repo, which falls back to the local git remote →
// `fatal: not a git repository` → `failed to list PRs` → exit 2. The reusable
// MUST pass the repo explicitly so gh queries the caller's repo directly.
const { test, expect } = require("./base");
const { readWorkflow } = require("./workflow-yaml-utils");

test.describe("editorial-label-audit passes the repo to the audit script", () => {
  const raw = readWorkflow("editorial-label-audit.yml");

  test("the audit run step passes --repo ${{ github.repository }}", () => {
    // The script call must include `--repo` wired to github.repository (the
    // caller's repo in a reusable) — not rely on a git checkout that isn't there.
    expect(raw).toMatch(/--repo\s+"?\$\{\{\s*github\.repository\s*\}\}"?/);
  });
});
