const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");

// Locks the e2e required-check stub's `paths:` to e2e-tests.yml's
// `paths-ignore`.
//
// e2e-tests.yml (the heavy Playwright lane) carries a `paths-ignore`, so a
// docs-/infra-/tooling-only PR skips it and the REQUIRED `e2e / e2e` context
// would never report — branch protection then hangs ("Waiting for status to
// be reported"). e2e-stub.yml fires on exactly the complement (its `paths:`
// equals e2e-tests' `paths-ignore`) and emits a synthetic `e2e / e2e` success
// so docs-only PRs stay mergeable. If the two lists drift, a PR can hang
// (matched by neither) or needlessly double-run — so this lint asserts they
// are identical, and that the stub caller is wired to surface `e2e / e2e`.
//
// It reads the canonical examples/site thin callers (the platform templates).
// In a consumed checkout (no examples/) the assertions skip — each site's own
// copy is linted where it lives by this same spec run from the platform
// harness against `<site>/.github/workflows` is out of scope here; the mirror
// invariant is enforced on the template that sites copy.

const WF = path.join(__dirname, "..", "examples", "site", ".github", "workflows");
const E2E = path.join(WF, "e2e-tests.yml");
const STUB = path.join(WF, "e2e-stub.yml");
const HAVE_BOTH = fs.existsSync(E2E) && fs.existsSync(STUB);

function onOf(file) {
  return (parseYaml(fs.readFileSync(file, "utf8")) || {}).on || {};
}

test.describe("e2e required-check stub mirrors e2e-tests paths-ignore", () => {
  test("stub `paths` equals e2e-tests `paths-ignore` (same entries, same order)", () => {
    test.skip(!HAVE_BOTH, "examples/site e2e callers absent (consumed checkout)");
    const ignore = onOf(E2E).pull_request && onOf(E2E).pull_request["paths-ignore"];
    const paths = onOf(STUB).pull_request && onOf(STUB).pull_request.paths;
    expect(Array.isArray(ignore), "e2e-tests.yml must declare on.pull_request.paths-ignore").toBe(
      true,
    );
    expect(Array.isArray(paths), "e2e-stub.yml must declare on.pull_request.paths").toBe(true);
    expect(
      paths.map(String),
      "e2e-stub.yml's paths: must be the byte-for-byte mirror of e2e-tests.yml's " +
        "paths-ignore — otherwise docs-only PRs hang on the required e2e / e2e check, " +
        "or both lanes run. Update them together.",
    ).toEqual(ignore.map(String));
  });

  test("stub caller surfaces the `e2e / e2e` context via the stub reusable", () => {
    test.skip(!HAVE_BOTH, "examples/site e2e callers absent (consumed checkout)");
    const doc = parseYaml(fs.readFileSync(STUB, "utf8")) || {};
    const job = (doc.jobs || {}).e2e;
    expect(
      job,
      "e2e-stub.yml must define a job named `e2e` so the surfaced context is `e2e / e2e`",
    ).toBeTruthy();
    expect(
      String(job.uses || ""),
      "the `e2e` job must call the e2e-required-stub reusable",
    ).toMatch(/e2e-required-stub\.yml@/);
  });
});
