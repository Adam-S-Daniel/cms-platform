// @lane: local — pure-fs lint of the platform-bump reusable workflow.
//
// Locks the two halves of issue #13 so the automated down-sync can't regress
// to a state that either (a) can't push or (b) produces a PR that fails the
// single-version pin-consistency guard (#29):
//
//   1. PUSH AUTH — the bump rewrites `.github/workflows/*` (the `uses:@` pins +
//      `platform_ref:` inputs), so the push needs `workflows` permission. The
//      default Actions GITHUB_TOKEN's App lacks it, so the checkout MUST use the
//      caller's PAT (`secrets.gh_token`) as the persisted push credential.
//      Without it: "refusing to allow a GitHub App to ... update workflow ...
//      without 'workflows' permission" → the whole bump fails.
//   2. ATOMIC BUMP — the bump must move EVERY pinned reference in one PR, not
//      just `platform_ref:`: the `uses:@<tag>` pins, the `cms-platform-theme`
//      Gemfile `tag:`, and `Gemfile.lock` (`tag:` + git `revision:`). A
//      `platform_ref:`-only PR fails pin-consistency until Dependabot's piecemeal
//      PRs land. So the run script must resolve the release COMMIT sha and
//      rewrite the Gemfile / Gemfile.lock revision too.
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const wf = parseYaml(readWorkflow("platform-bump.yml"));
const steps = wf.jobs.bump.steps;
const checkout = steps.find((s) => typeof s.uses === "string" && /actions\/checkout/.test(s.uses));
const runStep = steps.find((s) => typeof s.run === "string" && /gh\s+release\s+view/.test(s.run));

test.describe("platform-bump reusable — pushable + atomic (#13)", () => {
  test("checks out with the caller's PAT so the workflow-file push is authorised", () => {
    expect(checkout, "an actions/checkout step must exist").toBeTruthy();
    expect(checkout.with, "checkout must pass a token").toBeTruthy();
    expect(
      String(checkout.with.token),
      "checkout MUST use secrets.gh_token (the CMS_PLATFORM_PAT with Workflows:write) " +
        "as the push credential — the default GITHUB_TOKEN can't push .github/workflows/* changes",
    ).toMatch(/secrets\.gh_token/);
  });

  test("the bump step exists and resolves the latest release", () => {
    expect(runStep, "the bump run-step must exist").toBeTruthy();
    expect(runStep.run).toMatch(/gh\s+release\s+view/);
  });

  test("it bumps EVERY reference atomically (not just platform_ref)", () => {
    const run = runStep.run;
    // Resolves the release tag -> commit sha (deref annotated) for the revision.
    expect(run, "must resolve the release tag's commit sha").toMatch(/git\/refs\/tags/);
    expect(run, "must dereference annotated tags").toMatch(/object\.type/);
    // Reads the OLD revision and rewrites it -> the new one.
    expect(run, "must read + rewrite the Gemfile.lock git revision").toMatch(/revision:/);
    expect(run, "must operate on Gemfile.lock").toMatch(/Gemfile\.lock/);
    // Touches the .github/workflows tree (the uses:@ / platform_ref: pins).
    expect(run, "must rewrite the .github/workflows pins").toMatch(/\.github\/workflows/);
    // Moves the version string AND the commit sha.
    expect(run, "must substitute the new version string").toMatch(/LATEST/);
    expect(run, "must substitute the new commit sha").toMatch(/NEW_SHA/);
  });

  test("opens the bump PR", () => {
    expect(runStep.run).toMatch(/gh pr create/);
  });
});

test.describe("platform-bump reusable — seeds newly-dictated workflow callers", () => {
  test("fetches the platform-dictated set from examples/site AT THE NEW ref", () => {
    expect(runStep.run).toMatch(/examples\/site\/\.github\/workflows/);
    expect(runStep.run).toMatch(/ref=\$LATEST/);
  });

  test("only seeds a caller that's wholly MISSING — never touches one that already exists", () => {
    expect(runStep.run, "must skip seeding when the destination file already exists").toMatch(
      /\[ -f "\$dest" \] && continue/,
    );
  });

  test("stamps the seeded file's platform-ref pin to $LATEST (not the example's own, possibly stale, pin)", () => {
    expect(runStep.run).toMatch(/ENV\{LATEST\}/);
  });

  test("logs which workflows were seeded", () => {
    expect(runStep.run).toMatch(/seeded.*newly platform-dictated workflow/i);
  });

  test("detects an add-only diff (untracked seeded file), not just a modified-file diff", () => {
    expect(runStep.run, "git diff --quiet alone misses brand-new untracked files").toMatch(
      /git status --porcelain/,
    );
  });
});

test.describe("platform-bump reusable — closes superseded platform/bump-* PRs", () => {
  // Each bump PR is an ATOMIC absolute rewrite (see #13 above), so it fully
  // supersedes whatever an older `platform/bump-*` PR proposed. Without a
  // closure step these pile up every time a release is cut before a
  // consumer merges the previous bump PR (observed live: a consumer accrued
  // 4 open bump PRs at once). These lints lock the closure step in place
  // and its fail-open shape — this is cosmetic cleanup, never worth failing
  // the bump over.
  test("closes other open PRs, scoped to the platform/bump- prefix", () => {
    const run = runStep.run;
    expect(run, "must list open PRs to find other bump PRs").toMatch(/gh pr list --state open/);
    expect(run, "must filter the enumeration to the platform/bump- prefix").toMatch(
      /startswith\(\\"platform\/bump-\\"\)/,
    );
    expect(run, "must close the matched PRs").toMatch(/gh pr close/);
  });

  test("excludes the current $BRANCH from the closure candidates", () => {
    expect(runStep.run, "must select .headRefName != the current bump's own $BRANCH").toMatch(
      /select\(\.headRefName\s*!=\s*\\"\$\{BRANCH\}\\"\)/,
    );
  });

  test("the closure step is fail-open under set -euo pipefail", () => {
    const run = runStep.run;
    expect(run, "the run block must be strict (set -euo pipefail)").toMatch(
      /set -euo pipefail/,
    );
    // Under `set -euo pipefail` a bare `gh pr close` would fail the whole
    // job on the first stale PR it can't close. It must be guarded inline —
    // `|| echo "::warning::..."` — exactly like the `gh pr merge --auto`
    // line it follows, never a bare unguarded call.
    expect(run, "gh pr close must degrade to a warning, not fail the job").toMatch(
      /gh pr close[\s\S]{0,300}\|\|\s*echo "::warning::/,
    );
    // The enumeration itself (gh pr list piped through mapfile) must also
    // be guarded — a transient `gh pr list` failure must not abort the bump.
    expect(run, "the gh pr list enumeration must also be fail-open").toMatch(
      /2>\/dev\/null \|\| true/,
    );
  });
});
