// @lane: local — pure-fs lint of the cms-editorial-workflow workflow YAML
/*
 * Regression test: cms-editorial-workflow must enable GitHub's
 * native auto-merge (queue-based, respects required checks) — never
 * an unconditional `gh pr merge --merge` / `--squash` that would
 * bypass the required-checks list. (Audit finding #26.)
 */
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, allStrings } = require("./workflow-yaml-utils");

// Every script / expression / github-script body the workflow carries,
// joined. Reading these off the parsed tree (rather than grepping the
// raw file) means YAML comments are already gone and an aliased value
// is still seen. Shell `#` comments inside a run: block are stripped
// separately where they'd otherwise read as live commands.
function scripts(yaml) {
  return allStrings(parseYaml(yaml)).join("\n");
}

function stripShellComments(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

test("no unconditional `gh pr merge --merge|--squash` (without --auto)", () => {
  const code = stripShellComments(scripts(readWorkflow("cms-editorial-workflow.yml")));
  // Each `gh pr merge ...` call ends at the next newline / pipe / &&.
  const re = /gh\s+pr\s+merge\b([^\n;|&]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const flags = m[1];
    if (/--disable-auto/.test(flags)) continue; // disable-auto is fine
    expect(flags, `Found: 'gh pr merge${flags}'`).toMatch(/--auto\b/);
  }
});

test("enablePullRequestAutoMerge GraphQL mutation IS used", () => {
  expect(scripts(readWorkflow("cms-editorial-workflow.yml"))).toMatch(
    /enablePullRequestAutoMerge\b/,
  );
});

test("clean-status fallback lands an already-mergeable PR with a conditional direct squash merge (#80 layer 9 / #85)", () => {
  // When enablePullRequestAutoMerge fails with "Pull request is in clean
  // status" — every required check already passed, so there is nothing to
  // enqueue — the job must land the PR directly (a squash merge, gated on
  // that error string) instead of throwing. Branch protection still enforces
  // the required checks at merge time, so this can only land a green PR.
  const code = scripts(readWorkflow("cms-editorial-workflow.yml"));
  expect(code).toMatch(/clean status/i);
  expect(code).toMatch(/pulls\.merge/);
  expect(code).toMatch(/merge_method:\s*['"]squash['"]/);
});

test("unstable-status fallback polls the PR's own computed mergeable state and lands it with a squash merge (PR #2466 / run 28758624761)", () => {
  // "Pull request is in unstable status" is the SIBLING error to "clean
  // status" above — both stem from the same root cause: a PR whose base
  // isn't `main` (cms/preview-only) has no required-status-check
  // protection rules on that base, so GitHub's auto-merge "wait for
  // checks" has nothing well-defined to arm against and
  // enablePullRequestAutoMerge always errors. Empirical: PR #2466 (base
  // `audit/preview-exercise`, all content checks already green) hit this
  // exact error in run 28758624761. Because this job fires ONLY on the
  // `labeled` event and nothing re-triggers it afterward, the fallback
  // must poll the PR's own computed mergeable state (never the stale
  // webhook payload) and land it with a squash merge once clean.
  const code = scripts(readWorkflow("cms-editorial-workflow.yml"));
  expect(code).toMatch(/unstable status/i);
  expect(code).toMatch(/pulls\.get/);
  expect(code).toMatch(/mergeable_state/);
  expect(code).toMatch(/pulls\.merge/);
  expect(code).toMatch(/merge_method:\s*['"]squash['"]/);
});
