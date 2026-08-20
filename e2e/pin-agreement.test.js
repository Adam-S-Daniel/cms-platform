// @lane: local — pure-fs/pure-Node lint. No browser, no network, no build.
//
// THE INVARIANT (#283): a workflow that names a version TWICE must name the
// SAME version both times.
//
// A caller of a cms-platform reusable carries the platform version as a
// dependency ref (`uses: …@vX.Y.Z`) AND as an input value
// (`with: platform_ref: vX.Y.Z`). Dependabot's `github-actions` ecosystem moves
// the first and structurally cannot move the second. The skew that leaves is
// worse than a crash: the NEW reusable runs against the OLD script its stale
// `platform_ref` sparse-checks out, an argv-scanning `flag()` ignores flags it
// does not know, and the job reports GREEN having done none of the work the new
// workflow asked for. Seven fleet repos sat a release behind on exactly that
// pair while one of them accumulated fourteen unreported failing
// default-branch push runs.
//
// WHAT THIS FILE COVERS, AND WHY IT IS SPLIT THE WAY IT IS
//   - the pure checker (`scripts/check-pin-agreement.js`) against SYNTHETIC
//     workflows, including the exact #283 shape and the alias/merge-key shapes
//     a regex is blind to. This is the part that proves the lint DISCRIMINATES:
//     a check nothing can make fail is not a check.
//   - the REAL trees this repo owns — the `examples/site` thin-caller templates
//     (where every one of these pairs actually lives) and this repo's own
//     workflows — so a template bumped by halves reds here.
//   - the delivery: the `pin-agreement.yml` reusable's shape, because the whole
//     point of #283 is reaching repos with no harness, and the reusable is the
//     only thing that reaches them.
//
// PLATFORM-INTERNAL, and registered in PLATFORM_META_SPECS: it reads the
// platform `scripts/` tree, this repo's own workflow definitions and the
// `examples/site` templates, none of which a consumer ships. That is the
// OPPOSITE call to its sibling `e2e/consumer-automerge-nudge-contexts.test.js`,
// and deliberately so — this lint's subject is the platform's own tree, so
// being testIgnored on a consumer lane costs it nothing.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml, listWorkflows, readWorkflow } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const CHECKER = path.join(REPO_ROOT, "scripts", "check-pin-agreement.js");
const TEMPLATE_DIR = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const REUSABLE = "pin-agreement.yml";

const { pinPairs, scanPinAgreement, usesRef, main } = require(CHECKER);

// Run `main()` with stdout/stderr captured, so the CLI contract (exit code AND
// what it printed) is asserted rather than assumed. Restores in a `finally`, so
// a failing expectation never leaks a patched stream into another test.
function runCli(args) {
  const chunks = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const capture = (s) => {
    chunks.push(String(s));
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    return { code: main(args), output: chunks.join("") };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

function tmpWorkflows(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-agreement-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  }
  return dir;
}

const AGREEING = `
name: Caller
on: { push: { branches: [main] } }
jobs:
  audit:
    uses: example-owner/example-platform/.github/workflows/audit.yml@v0.1.87
    with:
      platform_ref: v0.1.87
`;

// The #283 shape, byte-for-byte in structure: Dependabot moved the dependency
// ref and could not move the input value.
const HALF_BUMPED = `
name: Caller
on: { push: { branches: [main] } }
jobs:
  audit:
    uses: example-owner/example-platform/.github/workflows/audit.yml@v0.1.87
    with:
      platform_ref: v0.1.85
`;

test.describe("#283 pin agreement — the pure checker", () => {
  test("agreeing refs produce no finding, and the pair IS counted", () => {
    const doc = parseYaml(AGREEING);
    expect(
      pinPairs(doc).map((p) => `${p.path}:${p.usesRef}/${p.platformRef}`),
      "the walker must find the one job that carries both refs — a check that examines nothing " +
        "looks exactly like a check that found nothing wrong",
    ).toEqual(["jobs.audit:v0.1.87/v0.1.87"]);
    expect(scanPinAgreement(doc, "caller.yml")).toEqual([]);
  });

  test("THE REGRESSION: a half-bumped caller (uses@v0.1.87, platform_ref v0.1.85) is a finding", () => {
    const findings = scanPinAgreement(parseYaml(HALF_BUMPED), "caller.yml");
    expect(
      findings.map((f) => `${f.file} :: ${f.path}: ${f.usesRef} != ${f.platformRef}`),
      "this is the exact skew #283 measured across seven fleet repos: the NEW reusable running " +
        "against the OLD sparse-checked-out script, reporting green having detected nothing",
    ).toEqual(["caller.yml :: jobs.audit: v0.1.87 != v0.1.85"]);
  });

  // The reason this PARSES instead of scanning lines. GitHub enabled YAML
  // anchors in workflows on 2025-09-18, so either half of the pair can be an
  // ALIAS whose value is written somewhere else in the file entirely — and a
  // regex over the source sees two tokens that are not versions at all.
  test("an ALIASED ref is compared by VALUE (a line scan reads this file as clean)", () => {
    const aliasedAgreeing = `
name: Caller
x-pins:
  platform: &platform_pin v0.1.87
on: { push: { branches: [main] } }
jobs:
  audit:
    uses: example-owner/example-platform/.github/workflows/audit.yml@v0.1.87
    with:
      platform_ref: *platform_pin
`;
    const aliasedSkewed = aliasedAgreeing.replace("&platform_pin v0.1.87", "&platform_pin v0.1.85");
    expect(
      scanPinAgreement(parseYaml(aliasedAgreeing), "caller.yml"),
      "an alias resolving to the same ref is agreement, not a finding",
    ).toEqual([]);
    expect(
      scanPinAgreement(parseYaml(aliasedSkewed), "caller.yml").map((f) => f.platformRef),
      "an alias resolving to a DIFFERENT ref is the same defect wearing a disguise — and the " +
        "disguise is exactly what a regex or a line scan cannot see through",
    ).toEqual(["v0.1.85"]);
  });

  // `merge: true` at the parse seam. Without it `<<` survives as a LITERAL own
  // key, so a job assembled from a merge key looks to every structural check
  // like a job with no `uses:` and no `with:` — a blind spot underneath the
  // whole check, not a missed edge case.
  test("a job assembled through a MERGE KEY is still examined", () => {
    const merged = `
name: Caller
x-defaults: &defaults
  uses: example-owner/example-platform/.github/workflows/audit.yml@v0.1.87
on: { push: { branches: [main] } }
jobs:
  audit:
    <<: *defaults
    with:
      platform_ref: v0.1.85
`;
    expect(
      scanPinAgreement(parseYaml(merged), "caller.yml").map((f) => f.usesRef),
      "a merge-key job must not be invisible to the walk",
    ).toEqual(["v0.1.87"]);
  });

  test("a STEP-level pair is walked too, and located by key path", () => {
    const stepLevel = `
name: Caller
on: { push: { branches: [main] } }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: example-owner/example-platform/.github/actions/thing@v0.1.87
        with:
          platform_ref: v0.1.85
`;
    expect(
      scanPinAgreement(parseYaml(stepLevel), "caller.yml").map((f) => f.path),
      "the finding must name the exact mapping to edit",
    ).toEqual(["jobs.build.steps[1]"]);
  });

  test("shapes with nothing to compare are not findings", () => {
    // A `uses:` with no `platform_ref` is the SAFE shape — one reference, no
    // skew possible — and must never be reported; a local or container `uses:`
    // has no ref at all.
    const noPair = `
name: Caller
on: { push: { branches: [main] } }
jobs:
  a:
    uses: example-owner/example-platform/.github/workflows/audit.yml@v0.1.87
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/local
        with:
          platform_ref: v0.1.85
      - uses: docker://alpine:3.20
        with:
          platform_ref: v0.1.85
`;
    const doc = parseYaml(noPair);
    expect(pinPairs(doc), "none of these three mappings carries two comparable refs").toEqual([]);
    expect(scanPinAgreement(doc, "caller.yml")).toEqual([]);
    expect(usesRef("./.github/actions/local"), "a local path has no ref").toBeNull();
    expect(usesRef("docker://alpine:3.20"), "a container tag is not a ref").toBeNull();
    expect(usesRef("owner/repo/.github/workflows/x.yml@v1.2.3")).toBe("v1.2.3");
  });
});

test.describe("#283 pin agreement — the CLI contract", () => {
  test("exit 0 on an agreeing directory, exit 1 on a skewed one", () => {
    const ok = runCli([tmpWorkflows({ "caller.yml": AGREEING })]);
    expect(ok.code, "an agreeing scan exits 0").toBe(0);
    expect(ok.output, "success must state how many pairs it actually compared").toContain(
      "1 ref pair(s) agree",
    );

    const bad = runCli([tmpWorkflows({ "caller.yml": HALF_BUMPED })]);
    expect(bad.code, "a skewed scan exits 1 — LOUD is the whole point of #283").toBe(1);
    expect(bad.output).toContain("uses@v0.1.87 != platform_ref v0.1.85");
  });

  // Three-valued on purpose: a caller has to tell "ran, found skew" apart from
  // "could not run". Folding the second into 0 is the silent-green failure this
  // whole issue is about; folding it into 1 would cry wolf.
  test("exit 2 — never 0 — when the scan could not run", () => {
    expect(
      runCli([tmpWorkflows({})]).code,
      "an EMPTY directory must not report success: a check that silently examines nothing is " +
        "indistinguishable from one that found nothing wrong, and this lint is adopted by repos " +
        "where nobody is watching the output closely",
    ).toBe(2);
    expect(
      runCli([path.join(os.tmpdir(), "pin-agreement-does-not-exist-a9f3")]).code,
      "a missing target is a could-not-run, not a pass",
    ).toBe(2);
    const malformed = runCli([tmpWorkflows({ "caller.yml": "jobs:\n  a:\n   - [unclosed\n" })]);
    expect(malformed.code, "an unparseable workflow is a could-not-run, not a pass").toBe(2);
  });
});

test.describe("#283 pin agreement — the real trees this repo owns", () => {
  test("every examples/site thin-caller template agrees with itself", () => {
    const res = runCli([TEMPLATE_DIR]);
    expect(
      res.code,
      `the thin-caller templates a site copies from must never ship a half-bumped pair — a new ` +
        `site would be born skewed. Output:\n${res.output}`,
    ).toBe(0);
    // Fail-on-zero, derived from what the scan actually compared rather than
    // from a literal: these templates are where essentially every pair in the
    // fleet comes from, so a run that found none of them means the scan missed
    // the tree, not that the tree is clean.
    const pairs = Number((res.output.match(/OK — (\d+) ref pair/) || [])[1]);
    expect(
      pairs,
      "the template scan must have compared a non-zero number of ref pairs",
    ).toBeGreaterThan(0);
  });

  test("this repo's own workflows agree with themselves", () => {
    const res = runCli([path.join(REPO_ROOT, ".github", "workflows")]);
    expect(res.code, `platform workflows must agree. Output:\n${res.output}`).toBe(0);
  });
});

test.describe("#283 pin agreement — the reusable that delivers it to repos with no harness", () => {
  const doc = () => parseYaml(readWorkflow(REUSABLE));

  test("the reusable exists and is workflow_call-only", () => {
    expect(
      listWorkflows().map((f) => path.basename(f)),
      "the delivery mechanism must exist — the repos #283 is about have no e2e harness to run " +
        "the checker any other way",
    ).toContain(REUSABLE);
    expect(
      Object.keys(doc().on || {}),
      "a reusable, so an adopting repo owns its own triggers and run-name",
    ).toEqual(["workflow_call"]);
  });

  test("it fetches the checker from the platform and runs it against the CALLER's tree", () => {
    const steps = ((doc().jobs || {})["pin-agreement"] || {}).steps || [];
    const fetch = steps.find(
      (s) => s.with && String(s.with["sparse-checkout"] || "").includes("check-pin-agreement.js"),
    );
    expect(
      fetch,
      "the reusable must sparse-check-out the checker from the platform at `platform_ref` — that " +
        "is what lets a repo with no Node project and no lockfile run it",
    ).toBeTruthy();
    expect(
      fetch.with.path,
      "into the same dot-dir every other platform-fetching reusable uses",
    ).toBe(".cms-platform");

    // The caller's own checkout is the one that names NO `repository:` —
    // identified by that, not by "has no `with:` block at all", so adding an
    // unrelated input (a `fetch-depth`, say) does not turn this lint red for a
    // change that leaves the invariant intact.
    const plainCheckout = steps.find(
      (s) =>
        /^actions\/checkout@/.test(String(s.uses || "")) &&
        !(s.with && s.with.repository !== undefined),
    );
    expect(
      plainCheckout,
      "the CALLER's own tree must be checked out too — it is the tree under test, and it is the " +
        "reason a stale platform_ref cannot hide a half-bump: the workflows being read are " +
        "always current even when the script is not",
    ).toBeTruthy();

    const run = steps.map((s) => String(s.run || "")).join("\n");
    expect(run, "and the checker must actually be invoked").toContain(
      "check-pin-agreement.js",
    );
  });

  test("the YAML parser is installed at an EXACT pinned version", () => {
    const run = (((doc().jobs || {})["pin-agreement"] || {}).steps || [])
      .map((s) => String(s.run || ""))
      .join("\n");
    const pin = (run.match(/yaml@(\S+)/) || [])[1];
    expect(
      pin,
      "the check parses (anchors have been legal in workflows since 2025-09-18), so the parser " +
        "is not optional and must be installed by the reusable — an adopting fleet repo has no " +
        "node_modules of its own",
    ).toBeTruthy();
    expect(
      pin,
      "pinned EXACT, no caret: an unpinned install can drift onto a release that has had no " +
        "cooling-off at all",
    ).toMatch(/^\d+\.\d+\.\d+$/);
    // Same version this repo already vets, so the 7-day cooling-off is
    // inherited rather than restarted — and the two cannot silently diverge.
    const harnessPin = JSON.parse(
      fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
    ).devDependencies.yaml;
    expect(
      pin,
      "the reusable's parser pin must equal the harness's, so one vetted version covers both",
    ).toBe(harnessPin);
  });

  test("caller inputs reach the run block through env, never interpolated into it", () => {
    const steps = ((doc().jobs || {})["pin-agreement"] || {}).steps || [];
    for (const step of steps) {
      expect(
        String(step.run || ""),
        "an interpolated `${{ inputs.* }}` is echoed to the log as a rendered command and is " +
          "re-parsed by the shell — read it from env instead",
      ).not.toContain("${{");
    }
  });
});
