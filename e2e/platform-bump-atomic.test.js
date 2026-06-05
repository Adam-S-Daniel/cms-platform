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
