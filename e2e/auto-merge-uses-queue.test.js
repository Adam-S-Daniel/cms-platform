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
