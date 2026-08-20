// @lane: local — pure-fs, CONSUMER-ONLY lint (parses with the `yaml` library,
// never regex) of a live cms-platform consumer's OWN e2e required-check pair:
// `<SITE_ROOT>/.github/workflows/e2e-tests.yml` and `.../e2e-stub.yml`.
//
// WHY THIS EXISTS
// ---------------
// `e2e / e2e` is a REQUIRED status context on a consumer's `main` ruleset (see
// repo-settings.yml, `ruleset_library.consumer-main`). The heavy Playwright
// lane carries a `paths-ignore`, so a docs-/infra-/tooling-only PR skips it —
// and a workflow excluded by `paths:` / `paths-ignore:` emits NO check run at
// all, not a neutral or a skipped one. The stub caller fires on exactly the
// complement (its `paths:` IS the heavy lane's `paths-ignore`) and emits a
// synthetic `e2e / e2e` success, which is the only reason a docs-only PR stays
// mergeable instead of parking forever on "Waiting for status to be reported".
//
// The two lists are therefore a MIRROR, and either direction of drift opens a
// hole: a PR whose files match NEITHER filter gets an `e2e / e2e` check run
// from neither workflow and hangs forever, while a PR matching BOTH needlessly
// double-reports the context. Same argument for `pull_request.types` (#145): a
// retargeted docs-only PR needs the stub to re-fire on the new base exactly
// like the heavy lane does, or the required context is withdrawn and never
// restored.
//
// Two more filters the mirror argument silently assumed but did not check:
//
//   - `pull_request.branches`. Agreeing about paths and types means nothing if
//     the two lanes disagree about which BASE they watch. Move the stub's
//     `branches` off `main` and a docs-only PR targeting `main` matches the
//     heavy lane's `paths-ignore` (no run) AND falls outside the stub's
//     `branches` (no run) — `e2e / e2e` reports from neither and the PR hangs,
//     with `paths` and `types` still perfectly mirrored.
//   - the two must use OPPOSITE filter KEYS. GitHub rejects `paths` and
//     `paths-ignore` on the SAME event, so a stub that gained a `paths-ignore`
//     beside its `paths` would never run at all — and every docs-only PR would
//     hang while the list comparison went on passing, because the list it
//     compares is still present and still correct.
//
// WHAT WAS — AND WAS NOT — COVERED BEFORE THIS FILE
// ------------------------------------------------
// `e2e/required-check-stub-paths.test.js` locks the same mirror on the PLATFORM
// TEMPLATE, the pair under this repo's own examples tree that a site copies
// from, and `test.skip`s the moment those template files are absent — which is
// every consumed checkout. Nothing checked a consumer's OWN copy once it had
// been copied away from the template. Both consumers' pairs happen to match the
// template today, so the gap was LATENT, never live; this spec closes it by
// asserting the mirror where it actually has to hold — in the repo whose branch
// protection is doing the waiting.
//
// CONSUMER ONLY, never platform. This spec reads ONLY
// `<SITE_ROOT>/.github/workflows/` — no platform-source path (not the examples
// template tree, not the repo root used as a content root) appears anywhere in
// this file. It is deliberately NOT registered in PLATFORM_META_SPECS:
// `playwright.config.js` testIgnores every registered name on a CONSUMER lane,
// so registering this one would silently void it on the exact repos it exists
// to protect. That is the cms-platform#244 lesson that shaped its sibling
// `e2e/dependabot-theme-gem-ignored.test.js`, which is unregistered for the
// same reason and whose shape this file follows.
//
// Parsing is the `yaml` library — a real parser, never a regex over workflow
// source — but deliberately NOT via `e2e/workflow-yaml-utils.js`: the meta-spec
// registry's `workflows-def` detector treats a require of that helper as an
// UNCONDITIONAL platform-internal signal, which would force this file into
// PLATFORM_META_SPECS and undo the paragraph above. `e2e/dependabot-config-utils.js`
// reaches for the library directly for exactly this reason.
//
// Skip semantics: `test.skip()` fires ONLY when SITE_ROOT is unset (the
// platform's own self-CI, where the template lint named above is the coverage
// of this invariant). A genuinely SITE_ROOT-having run whose consumer is
// missing either file FAILS — a site that ships the heavy lane without the stub
// (or the reverse) is precisely the hang this lint exists to prevent, not a
// case to wave through as "nothing to guard here".
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const CONSUMER = !!process.env.SITE_ROOT;
const WORKFLOWS_DIR = CONSUMER ? path.join(process.env.SITE_ROOT, ".github", "workflows") : null;
const HEAVY_PATH = CONSUMER ? path.join(WORKFLOWS_DIR, "e2e-tests.yml") : null;
const STUB_PATH = CONSUMER ? path.join(WORKFLOWS_DIR, "e2e-stub.yml") : null;

const SKIP_REASON =
  "SITE_ROOT is unset (platform self-CI) — a consumer's own .github/workflows tree is not " +
  "present here; see e2e/required-check-stub-paths.test.js for the platform-mode coverage of " +
  "this same mirror invariant against the examples template pair.";

// The `on:` value of a parsed workflow, asserted to be a real mapping. A bare
// `on:` (no value) parses to null, and a YAML-1.1-schema parser would hand back
// the BOOLEAN `true` for the key — either way the trigger block is unreadable
// and every downstream assertion would compare `undefined` to `undefined` and
// pass vacuously. Fail loudly instead.
function triggersOf(label, doc) {
  const on = doc && doc.on;
  expect(
    on !== null && typeof on === "object" && !Array.isArray(on),
    `${label}: the \`on:\` block must parse as a mapping of trigger names (got ` +
      `${JSON.stringify(on)}). A boolean here means the file was read with a YAML 1.1 schema ` +
      `that folds the \`on\` KEY into \`true\`; a null means \`on:\` was left empty.`,
  ).toBe(true);
  return on;
}

// `on.pull_request` for one of the pair, asserted present. Both callers are
// pull_request-driven by design — the required `e2e / e2e` context only ever
// arises from a PR event — so a missing block is a failure, not an absence to
// route around.
function pullRequestOf(label, doc) {
  const pr = triggersOf(label, doc).pull_request;
  expect(
    pr !== null && typeof pr === "object" && !Array.isArray(pr),
    `${label}: must declare an \`on.pull_request:\` block with the filters that decide whether ` +
      `this lane reports the required \`e2e / e2e\` context.`,
  ).toBe(true);
  return pr;
}

// Read + parse BOTH callers, returning them alongside the count of files
// actually parsed. The existence check is an assertion rather than a skip (see
// the header), and the read itself sits OUTSIDE any try/catch: an ENOENT or a
// permissions failure must surface as the error it is, never be mistaken for a
// malformed-input case this lint decided to tolerate.
function parsePair() {
  const files = [
    { label: "e2e-tests.yml", file: HEAVY_PATH },
    { label: "e2e-stub.yml", file: STUB_PATH },
  ];
  const parsed = {};
  for (const { label, file } of files) {
    expect(
      fs.existsSync(file),
      `${file} does not exist. A consumer that carries one half of the e2e required-check pair ` +
        `without the other cannot satisfy the required \`e2e / e2e\` context on every PR shape: ` +
        `whichever lane is missing, the PRs it was meant to cover hang on "Waiting for status to ` +
        `be reported". Ship both callers, or neither plus a ruleset that does not require the ` +
        `context.`,
    ).toBe(true);
    parsed[label] = YAML.parse(fs.readFileSync(file, "utf8"));
  }
  return { parsed, count: files.length };
}

test.describe("consumer e2e required-check pair: the stub mirrors the heavy lane's filters", () => {
  // Fail-on-zero. A lint that silently examines nothing looks exactly like a
  // lint that found nothing wrong — the class of miss that shipped when
  // `listWorkflows`, which yields ABSOLUTE paths, was fed to `readWorkflow`,
  // which takes BASENAMES, and the loop body never ran. Belt and braces: the
  // function names above are written without a trailing `(` on purpose, so the
  // meta-spec registry's `workflows-def` detector cannot key off them even if
  // its comment-stripping pass ever changes.
  test("both of this consumer's e2e callers were read and parsed", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { parsed, count } = parsePair();
    expect(count, "this lint must examine a non-zero number of workflow files").toBeGreaterThan(0);
    expect(count, "both halves of the e2e required-check pair must be parsed").toBe(2);
    expect(
      Object.keys(parsed).sort(),
      "the parsed pair must be exactly the heavy lane and its stub",
    ).toEqual(["e2e-stub.yml", "e2e-tests.yml"]);
  });

  test("stub `paths` equals e2e-tests `paths-ignore` (same entries, same order)", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { parsed } = parsePair();
    const ignore = pullRequestOf("e2e-tests.yml", parsed["e2e-tests.yml"])["paths-ignore"];
    const paths = pullRequestOf("e2e-stub.yml", parsed["e2e-stub.yml"]).paths;
    expect(
      Array.isArray(ignore),
      "e2e-tests.yml must declare on.pull_request.paths-ignore — it is the list the stub mirrors",
    ).toBe(true);
    expect(
      Array.isArray(paths),
      "e2e-stub.yml must declare on.pull_request.paths — it is the complement that keeps the " +
        "required e2e / e2e context reporting on the PRs the heavy lane skips",
    ).toBe(true);
    expect(
      paths.map(String),
      "e2e-stub.yml's `paths:` must be the byte-for-byte mirror of e2e-tests.yml's " +
        "`paths-ignore:`. A workflow excluded by a path filter emits NO check run at all, so a " +
        "PR that matches NEITHER list gets `e2e / e2e` from neither lane and hangs forever on " +
        `"Waiting for status to be reported"; a PR matching BOTH runs the heavy lane and the ` +
        "stub for the same context. Update the two lists together.",
    ).toEqual(ignore.map(String));
  });

  // #145 — a retargeted docs-only PR needs the stub to re-fire on the new base.
  test("stub `pull_request.types` equals e2e-tests `pull_request.types` (same set)", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { parsed } = parsePair();
    const heavyTypes = pullRequestOf("e2e-tests.yml", parsed["e2e-tests.yml"]).types;
    const stubTypes = pullRequestOf("e2e-stub.yml", parsed["e2e-stub.yml"]).types;
    expect(Array.isArray(heavyTypes), "e2e-tests.yml must declare on.pull_request.types").toBe(
      true,
    );
    expect(Array.isArray(stubTypes), "e2e-stub.yml must declare on.pull_request.types").toBe(true);
    // SET, not sequence — the test's name says "same set" and the assertion now
    // agrees with it. GitHub does not care in what order `types:` are listed, so
    // a reordering must not red this lint; sorting BOTH sides leaves a missing
    // or duplicated entry failing exactly as before.
    expect(
      [...stubTypes.map(String)].sort(),
      "e2e-stub.yml's `pull_request.types` must mirror e2e-tests.yml's. The two lanes split the " +
        "PR population by path, so an event type only one of them listens to leaves the PRs on " +
        "the other side with no `e2e / e2e` check run for that event — the required context " +
        `stalls at "Waiting for status to be reported" until a new head sha arrives. Update the ` +
        "two lists together.",
    ).toEqual([...heavyTypes.map(String)].sort());
  });

  // A mirrored `paths` list means nothing if the pair watches different bases.
  test("stub `pull_request.branches` equals e2e-tests `pull_request.branches` (same set)", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { parsed } = parsePair();
    const heavyBranches = pullRequestOf("e2e-tests.yml", parsed["e2e-tests.yml"]).branches;
    const stubBranches = pullRequestOf("e2e-stub.yml", parsed["e2e-stub.yml"]).branches;
    expect(
      Array.isArray(heavyBranches),
      "e2e-tests.yml must declare on.pull_request.branches — the base filter the stub mirrors",
    ).toBe(true);
    expect(
      Array.isArray(stubBranches),
      "e2e-stub.yml must declare on.pull_request.branches — without it the pair's split of the " +
        "PR population is by path only on one side and by path AND base on the other",
    ).toBe(true);
    expect(
      [...stubBranches.map(String)].sort(),
      "e2e-stub.yml's `pull_request.branches` must mirror e2e-tests.yml's. The pair divides the " +
        "PR population by PATH; divide it by BASE as well and a docs-only PR onto a base only " +
        "the heavy lane watches matches that lane's `paths-ignore` (no run) and falls outside " +
        "the stub's `branches` (no run), so the required `e2e / e2e` arrives from neither and " +
        `the PR hangs on "Waiting for status to be reported" — with the paths and types ` +
        "mirrors above still passing. Update the two lists together.",
    ).toEqual([...heavyBranches.map(String)].sort());
  });

  // GitHub rejects `paths` and `paths-ignore` on one event — a stub carrying
  // both never runs, and every list comparison above stays green regardless.
  test("stub declares `paths` only; e2e-tests `paths-ignore` only", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { parsed } = parsePair();
    const heavyPr = pullRequestOf("e2e-tests.yml", parsed["e2e-tests.yml"]);
    const stubPr = pullRequestOf("e2e-stub.yml", parsed["e2e-stub.yml"]);
    expect(
      stubPr["paths-ignore"],
      "e2e-stub.yml must NOT declare `paths-ignore` alongside its `paths`. GitHub rejects both " +
        "filters on one event, so the stub would never run and EVERY docs-only PR would hang " +
        "on the required `e2e / e2e` — while the paths mirror above kept passing, because the " +
        "list it compares is still present and still correct.",
    ).toBeUndefined();
    expect(
      heavyPr.paths,
      "e2e-tests.yml must NOT declare `paths` alongside its `paths-ignore` — the same " +
        "rejection, and a silent heavy lane takes the required `e2e / e2e` down on every code " +
        "PR.",
    ).toBeUndefined();
  });

  test("the stub caller surfaces `e2e / e2e` via an `e2e` job calling the stub reusable", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { parsed } = parsePair();
    const doc = parsed["e2e-stub.yml"];
    const job = (doc && doc.jobs) || {};
    expect(
      job.e2e,
      "e2e-stub.yml must define a job named exactly `e2e`. Branch protection keys on the CONTEXT " +
        "name, and a caller's context is `<workflow file's job id> / <called job id>` — rename " +
        "the job and the stub reports some other context while the required `e2e / e2e` never " +
        `arrives, hanging every docs-only PR on "Waiting for status to be reported".`,
    ).toBeTruthy();
    expect(
      String(job.e2e.uses || ""),
      "the stub's `e2e` job must call the platform's e2e-required-stub reusable — that is " +
        "what emits the synthetic success; a job pointed anywhere else reports a context that " +
        "means something different, or nothing at all.",
    ).toMatch(/e2e-required-stub\.yml@/);
  });
});
