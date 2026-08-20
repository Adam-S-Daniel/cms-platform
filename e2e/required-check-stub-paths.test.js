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
// SCOPE — what this spec does and does NOT cover. It reads the canonical
// examples/site thin callers, i.e. the platform TEMPLATES a site copies from,
// and nothing else; in a consumed checkout there is no examples/ tree, so
// every assertion here skips. A consumer's OWN copies of the pair — once
// copied away from the template and free to drift from it — are covered by the
// CONSUMER-mode sibling e2e/consumer-required-check-mirrors.test.js, which
// reads `<SITE_ROOT>/.github/workflows/` and runs on a real consumer's e2e lane
// (it is deliberately absent from PLATFORM_META_SPECS for exactly that reason).
// Neither spec substitutes for the other: this one is the only coverage of the
// template, that one the only coverage of what a site actually ships. Before
// that sibling existed nothing checked a consumer's copy at all — both
// consumers happened to match the template, so the gap was latent, not live.
//
// Also locks the two callers' `pull_request.types` lists to be identical
// (#145): a docs-only PR that gets RETARGETED onto a new base needs its
// synthetic `e2e / e2e` stub to re-fire too, exactly like the heavy lane — if
// `edited` (or any other type) drifted between the two, a retargeted
// docs-only PR could hang with neither caller reporting the required context.
//
// And the two filters the mirror argument silently assumed but never checked:
//
//   - `pull_request.branches` must match. `paths` and `types` agreeing means
//     nothing if the two lanes disagree about WHICH BASE they watch. Move the
//     stub's `branches` off `main` and a docs-only PR targeting `main` matches
//     the heavy lane's `paths-ignore` (no run) AND falls outside the stub's
//     `branches` (no run) — the required `e2e / e2e` never reports and the PR
//     hangs on "Waiting for status to be reported", with both `paths` and
//     `types` still perfectly mirrored.
//   - the two must use OPPOSITE filter KEYS: the stub declares `paths` and NOT
//     `paths-ignore`, the heavy lane the reverse. GitHub rejects a `paths` and
//     a `paths-ignore` on the SAME event, so a stub that gained a `paths-ignore`
//     alongside its `paths` would never run at all — and every docs-only PR
//     would hang while this lint's list comparison went on passing, because
//     the list it compares is still there and still correct.

const WF = path.join(__dirname, "..", "examples", "site", ".github", "workflows");
const E2E = path.join(WF, "e2e-tests.yml");
const STUB = path.join(WF, "e2e-stub.yml");
const HAVE_BOTH = fs.existsSync(E2E) && fs.existsSync(STUB);

// The trigger mapping of a workflow, ASSERTED to be a real mapping. A bare `on:`
// (no value) parses to null, and a YAML-1.1-schema reader folds the `on` KEY into
// the boolean `true` — probe both, then fail loudly rather than handing back a
// substitute, so a trigger block is never silently read as absent and compared
// `undefined` to `undefined`.
function triggersOf(label, file) {
  const doc = parseYaml(fs.readFileSync(file, "utf8")) || {};
  const on = doc.on != null ? doc.on : doc[true];
  expect(
    on !== null && typeof on === "object" && !Array.isArray(on),
    `${label}: the \`on:\` block must parse as a mapping of trigger names (got ` +
      `${JSON.stringify(on)}). A boolean here means the file was read with a YAML 1.1 schema ` +
      `that folds the \`on\` KEY into \`true\`; a null means \`on:\` was left empty.`,
  ).toBe(true);
  return on;
}

// `on.pull_request` for one of the pair, ASSERTED present. Both callers are
// pull_request-driven by design — the required `e2e / e2e` context only ever
// arises from a PR event — so a missing block is a failure, not an absence to
// route around.
//
// This exists because routing around it was a VACUITY HOLE. The
// "stub declares `paths` only" test below used to read `onOf(STUB).pull_request
// || {}`, so DELETING `on.pull_request` outright from the stub made it pass on an
// empty object: `paths-ignore` was undefined, the assertion wanted undefined, and
// a stub with no PR trigger at all — one that reports the required `e2e / e2e`
// context on exactly zero pull requests — read as compliant. The consumer twin
// e2e/consumer-required-check-mirrors.test.js already routed the same read
// through an asserting helper; this is that shape, adopted here.
function pullRequestOf(label, file) {
  const pr = triggersOf(label, file).pull_request;
  expect(
    pr !== null && typeof pr === "object" && !Array.isArray(pr),
    `${label}: must declare an \`on.pull_request:\` block with the filters that decide whether ` +
      `this lane reports the required \`e2e / e2e\` context. Without one the lane never fires ` +
      `on a PR at all, and every list comparison below would compare two absences and pass.`,
  ).toBe(true);
  return pr;
}

test.describe("e2e required-check stub mirrors e2e-tests paths-ignore", () => {
  test("stub `paths` equals e2e-tests `paths-ignore` (same entries, same order)", () => {
    test.skip(!HAVE_BOTH, "examples/site e2e callers absent (consumed checkout)");
    const ignore = pullRequestOf("e2e-tests.yml", E2E)["paths-ignore"];
    const paths = pullRequestOf("e2e-stub.yml", STUB).paths;
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

  // #145 — retargeted docs-only PRs need the stub to re-fire too.
  test("stub `pull_request.types` equals e2e-tests `pull_request.types` (same set)", () => {
    test.skip(!HAVE_BOTH, "examples/site e2e callers absent (consumed checkout)");
    const e2eTypes = pullRequestOf("e2e-tests.yml", E2E).types;
    const stubTypes = pullRequestOf("e2e-stub.yml", STUB).types;
    expect(Array.isArray(e2eTypes), "e2e-tests.yml must declare on.pull_request.types").toBe(true);
    expect(Array.isArray(stubTypes), "e2e-stub.yml must declare on.pull_request.types").toBe(true);
    // SET, not sequence — the test's name says "same set" and the assertion now
    // agrees with it. GitHub does not care what order `types:` are listed in, so
    // a reordering must not red this lint; sorting BOTH sides keeps a duplicate
    // or a missing entry failing exactly as before.
    expect(
      [...stubTypes.map(String)].sort(),
      "e2e-stub.yml's pull_request.types must mirror e2e-tests.yml's — otherwise a " +
        "retargeted docs-only PR's synthetic e2e / e2e stub won't re-fire on the new " +
        "base (or the heavy lane fires an event the stub doesn't, double-reporting). " +
        "Update them together.",
    ).toEqual([...e2eTypes.map(String)].sort());
  });

  // A mirrored `paths` list means nothing if the two lanes watch different bases.
  test("stub `pull_request.branches` equals e2e-tests `pull_request.branches` (same set)", () => {
    test.skip(!HAVE_BOTH, "examples/site e2e callers absent (consumed checkout)");
    const e2eBranches = pullRequestOf("e2e-tests.yml", E2E).branches;
    const stubBranches = pullRequestOf("e2e-stub.yml", STUB).branches;
    expect(Array.isArray(e2eBranches), "e2e-tests.yml must declare on.pull_request.branches").toBe(
      true,
    );
    expect(Array.isArray(stubBranches), "e2e-stub.yml must declare on.pull_request.branches").toBe(
      true,
    );
    expect(
      [...stubBranches.map(String)].sort(),
      "e2e-stub.yml's pull_request.branches must mirror e2e-tests.yml's. The pair splits the " +
        "PR population by PATH; if they also split it by BASE, a docs-only PR onto a base only " +
        "the heavy lane watches matches that lane's paths-ignore (no run) and falls outside the " +
        "stub's branches (no run), so the required e2e / e2e reports from neither and the PR " +
        `hangs on "Waiting for status to be reported". Update them together.`,
    ).toEqual([...e2eBranches.map(String)].sort());
  });

  // GitHub rejects `paths` and `paths-ignore` on one event — a stub carrying
  // both would never run, and the list comparison above would not notice.
  test("stub declares `paths` only; e2e-tests `paths-ignore` only", () => {
    test.skip(!HAVE_BOTH, "examples/site e2e callers absent (consumed checkout)");
    const heavyPr = pullRequestOf("e2e-tests.yml", E2E);
    const stubPr = pullRequestOf("e2e-stub.yml", STUB);
    expect(
      stubPr["paths-ignore"],
      "e2e-stub.yml must NOT declare `paths-ignore` alongside its `paths`: GitHub rejects both " +
        "filters on the same event, so the stub would never run and EVERY docs-only PR would " +
        "hang on the required e2e / e2e — while the paths mirror above kept passing, because " +
        "the list it compares is still present and still correct.",
    ).toBeUndefined();
    expect(
      heavyPr.paths,
      "e2e-tests.yml must NOT declare `paths` alongside its `paths-ignore` — the same " +
        "rejection, and a silent heavy lane takes the required e2e / e2e down on every code PR.",
    ).toBeUndefined();
  });
});
