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

  test("the audit run step passes --repo from an env var set to github.repository", () => {
    // The script call must include `--repo` wired to github.repository (the
    // caller's repo in a reusable) — not rely on a git checkout that isn't there.
    // The value reaches the script through env:, never pasted into run: (#981).
    expect(raw).toMatch(/REPO:\s*\$\{\{\s*github\.repository\s*\}\}/);
    expect(raw).toMatch(/--repo\s+"\$REPO"/);
  });

  test("caller-controlled inputs reach the script through env:, not the run: text (#981)", () => {
    expect(raw).toMatch(/BRANCH_PREFIX:\s*\$\{\{\s*inputs\.branch_prefix\s*\}\}/);
    expect(raw).toMatch(/LABEL_PREFIX:\s*\$\{\{\s*inputs\.label_prefix\s*\}\}/);
    expect(raw).toMatch(/--branch-prefix\s+"\$BRANCH_PREFIX"/);
    expect(raw).toMatch(/--label-prefix\s+"\$LABEL_PREFIX"/);
    expect(raw).not.toMatch(/--(?:branch|label)-prefix\s+"?\$\{\{/);
  });

  test("self-heal wiring: fix input (default true) → --fix flag + pull-requests: write", () => {
    // The audit SELF-HEALS by default: an unlabelled editorial PR gets its
    // decap-cms/<status> label applied by the audit itself instead of only
    // failing loud for days (the "adding labels…" dialog stayed up on prod
    // while the daily red run went unnoticed — PR #2387, 2026-07). All three
    // pieces must stay wired together: the input, the flag pass-through, and
    // the write permission the label POST needs.
    expect(raw).toMatch(/fix:\s*\{\s*type:\s*boolean,\s*default:\s*true\s*\}/);
    expect(raw).toMatch(/\$\{\{\s*inputs\.fix\s*&&\s*'--fix'\s*\|\|\s*''\s*\}\}/);
    expect(raw).toMatch(/pull-requests:\s*write/);
  });
});
