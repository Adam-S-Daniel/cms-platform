// @lane: local — pure-Node unit tests for scripts/check-platform-pin-consistency.js (#29)
/*
 * scripts/check-platform-pin-consistency.js is the platform-owned anti-skew
 * guard (issue #29). A consuming repo references the platform version in many
 * places — every reusable-workflow `uses: …/.github/workflows/<n>.yml@<ref>`,
 * every SHA-pinned composite `uses: …/.github/actions/<n>@<sha>  # vX.Y.Z`
 * comment, the `Gemfile` gem `tag:`, the `Gemfile.lock` git-source `tag:`, and
 * `platform.lock`'s `platform_ref` — and Dependabot/platform-bump land bumps
 * piecemeal, so a consumer drifts (observed live: adamdaniel.ai pinned @v0.1.0
 * loop/deploy callers, gem @v0.1.5, others @v0.1.3/@v0.1.6 at once). This guard
 * derives the CANONICAL version from platform.lock `platform_ref` and fails
 * (exit non-zero) with a per-file diff if any reference disagrees.
 *
 * These tests drive the CLI against synthetic CONSUMER fixtures in a temp dir
 * (so they're hermetic + need no browser/build — they run in the self-CI
 * node-unit-lints lane). They point the checker at fixtures via --root, and at
 * a fixture owner/repo via --owner/--repo so the checker stays site-agnostic.
 *
 * RED-FIRST: written before the script exists; the consistent-fixture case
 * fails (script absent) until the GREEN implementation lands.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const SCRIPT = path.resolve(__dirname, "../scripts/check-platform-pin-consistency.js");
const OWNER = "Acme-Org";
const REPO = "cms-platform";
const SLUG = `${OWNER}/${REPO}`;

// A 40-hex placeholder SHA for composite-action pins (the checker gates on the
// trailing version COMMENT, not on resolving the SHA).
const SHA = "0123456789abcdef0123456789abcdef01234567";

// The preview-media probe sentinel (#84) — checkMediaProbeSentinel() now
// asserts every consumer carries this, so every fixture below that expects
// exit 0 must include it (a missing sentinel is its own dedicated test group
// further down).
const SENTINEL_REL = "assets/images/uploads/e2e-preview-media-probe.png";
// Seed the CANONICAL bytes straight from e2e/fixtures/tiny-pixel.png rather than
// a re-embedded base64 copy: this makes every "exits 0 when byte-identical" case
// a proof that the SCRIPT's embedded PROBE_MEDIA_PNG_BASE64/PROBE_MEDIA_SHA1 still
// accept the canonical PNG — so a future sentinel-byte update that changes the
// fixture but misses the script constant turns these exit-0 cases RED, instead of
// only surfacing on a consumer's next platform_ref bump (#84). The script keeps
// its constant embedded (sparse-checkout), but this self-test always runs in the
// full platform tree, so it can read the fixture directly.
const CANONICAL_SENTINEL_PNG = path.join(__dirname, "fixtures", "tiny-pixel.png");
function writeSentinel(root) {
  write(root, SENTINEL_REL, fs.readFileSync(CANONICAL_SENTINEL_PNG));
}

function run(root) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--root", root, "--owner", OWNER, "--repo", REPO],
    { encoding: "utf8" },
  );
}

// Write a file, creating parent dirs.
function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function mkConsumer() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cms29-pin-"));
}

function platformLock(ref) {
  return [
    "# cms-platform lock",
    `platform_repo: ${SLUG}`,
    `platform_ref: ${ref}`,
    "",
  ].join("\n");
}

// A reusable-workflow caller pinned to `ref`.
function reusableCaller(name, ref) {
  return [
    `name: ${name}`,
    "on: { pull_request: {} }",
    "jobs:",
    "  call:",
    `    uses: ${SLUG}/.github/workflows/${name}.yml@${ref}`,
    `    with: { platform_ref: ${ref} }`,
    "",
  ].join("\n");
}

// A workflow that pins a SHA composite action with a trailing `# vX.Y.Z` comment.
function compositeCaller(name, commentVersion) {
  return [
    `name: ${name}`,
    "on: { pull_request: {} }",
    "jobs:",
    "  job:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${SLUG}/.github/actions/post-failure-comment@${SHA}  # ${commentVersion} (2026-05-29)`,
    "",
  ].join("\n");
}

function gemfile(tag) {
  return [
    'source "https://rubygems.org"',
    "group :jekyll_plugins do",
    `  gem "cms-platform-theme", git: "https://github.com/${SLUG}", glob: "theme/*.gemspec", tag: "${tag}"`,
    "end",
    "",
  ].join("\n");
}

function gemfileLock(tag) {
  return [
    "GIT",
    `  remote: https://github.com/${SLUG}`,
    "  revision: a442f54daa3a2896051dca02371364dc1e71a2b7",
    `  tag: ${tag}`,
    "  glob: theme/*.gemspec",
    "  specs:",
    "    cms-platform-theme (0.1.4)",
    "",
    "PLATFORMS",
    "  ruby",
    "",
  ].join("\n");
}

test.describe("check-platform-pin-consistency.js — CONSISTENT fixture (#29)", () => {
  test("exits 0 with an OK summary when every reference == platform_ref", () => {
    const root = mkConsumer();
    const V = "v0.1.7";
    write(root, "platform.lock", platformLock(V));
    write(root, ".github/workflows/deploy.yml", reusableCaller("deploy", V));
    write(root, ".github/workflows/e2e-tests.yml", reusableCaller("e2e-tests", V));
    write(root, ".github/workflows/code-quality.yml", compositeCaller("code-quality", V));
    write(root, "Gemfile", gemfile(V));
    write(root, "Gemfile.lock", gemfileLock(V));
    writeSentinel(root);

    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(new RegExp(`\\b${V.replace(/\./g, "\\.")}\\b`));
    // Concise OK summary, not a violation dump.
    expect(out).toMatch(/consistent|all agree|OK/i);
  });

  test("tolerates a consumer with no Gemfile (gem-less consumer) — still 0", () => {
    const root = mkConsumer();
    const V = "v0.1.7";
    write(root, "platform.lock", platformLock(V));
    write(root, ".github/workflows/deploy.yml", reusableCaller("deploy", V));
    writeSentinel(root);
    // No Gemfile / Gemfile.lock at all.
    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
  });

  test("ignores non-cms-platform `uses:` refs (e.g. actions/checkout@v4)", () => {
    const root = mkConsumer();
    const V = "v0.1.7";
    write(root, "platform.lock", platformLock(V));
    writeSentinel(root);
    write(
      root,
      ".github/workflows/x.yml",
      [
        "name: x",
        "on: { pull_request: {} }",
        "jobs:",
        "  j:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v9.9.9  # some other repo",
        `      - uses: ${SLUG}/.github/actions/post-failure-comment@${SHA}  # ${V} (2026-05-29)`,
        "",
      ].join("\n"),
    );
    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
  });
});

test.describe("check-platform-pin-consistency.js — SKEWED fixture (#29)", () => {
  test("exits non-zero AND names each offending file + found/expected value", () => {
    const root = mkConsumer();
    const CANON = "v0.1.7";
    write(root, "platform.lock", platformLock(CANON));
    // (a) a reusable caller pinned to an OLDER ref
    write(root, ".github/workflows/deploy.yml", reusableCaller("deploy", "v0.1.0"));
    // a second reusable caller that DOES agree (must not be reported)
    write(root, ".github/workflows/e2e-tests.yml", reusableCaller("e2e-tests", CANON));
    // (b) a composite action whose # comment is MISMATCHED
    write(root, ".github/workflows/code-quality.yml", compositeCaller("code-quality", "v0.1.3"));
    // (c) the gem @newer than platform_ref
    write(root, "Gemfile", gemfile("v0.1.8"));
    write(root, "Gemfile.lock", gemfileLock("v0.1.8"));

    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;

    // Canonical version is reported as the expectation.
    expect(out).toMatch(/v0\.1\.7/);

    // Each offending FILE is named.
    expect(out).toMatch(/\.github\/workflows\/deploy\.yml/);
    expect(out).toMatch(/\.github\/workflows\/code-quality\.yml/);
    expect(out).toMatch(/Gemfile\.lock/);
    expect(out).toMatch(/Gemfile(?!\.lock)/); // the bare Gemfile too

    // Each offending VALUE is named.
    expect(out).toMatch(/v0\.1\.0/); // the skewed reusable ref
    expect(out).toMatch(/v0\.1\.3/); // the skewed composite comment
    expect(out).toMatch(/v0\.1\.8/); // the skewed gem tag

    // The CONSISTENT caller is NOT reported as a violation.
    expect(out).not.toMatch(/e2e-tests\.yml/);
  });

  test("fails clearly when platform.lock is missing", () => {
    const root = mkConsumer();
    write(root, ".github/workflows/deploy.yml", reusableCaller("deploy", "v0.1.0"));
    const res = run(root);
    expect(res.status).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/platform\.lock/);
  });

  test("fails clearly when platform.lock has no platform_ref", () => {
    const root = mkConsumer();
    write(root, "platform.lock", `platform_repo: ${SLUG}\n`);
    const res = run(root);
    expect(res.status).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/platform_ref/);
  });
});

// ── The `platform_ref` INPUT (#220). The reusable's platform checkout does
// `ref: ${{ inputs.platform_ref }}`, so THIS value — not the `uses:@` pin —
// decides which platform tree the job actually runs. It's canonical by
// definition, NOT a site-specific `with:` value, which is why the
// workflow-CONTENT parity check (it masks `with:` VALUES) can't see it. Live:
// jodidaniel.com's cms-scheduled-publish-loop shipped `uses:@v0.1.72` with
// `platform_ref: v0.1.59` for 14 releases — the checkout predated the v0.1.70
// install-playwright-browsers composite, so the step failed "Can't find
// 'action.yml'" while every other pin check reported consistent.
test.describe("check-platform-pin-consistency.js — stale platform_ref INPUT (#220)", () => {
  // A caller whose `uses:@` pin and `platform_ref` input can disagree.
  function splitCaller(name, usesRef, platformRefValue) {
    return [
      `name: ${name}`,
      "on: { workflow_dispatch: {} }",
      "jobs:",
      "  call:",
      `    uses: ${SLUG}/.github/workflows/${name}.yml@${usesRef}`,
      "    with:",
      "      # Pin to the SAME ref as the `uses:` pin above so the harness matches.",
      `      platform_ref: ${platformRefValue}`,
      "",
    ].join("\n");
  }

  test("FAILS when uses:@ is current but the platform_ref input is stale", () => {
    const root = mkConsumer();
    const CANON = "v0.1.73";
    write(root, "platform.lock", platformLock(CANON));
    writeSentinel(root);
    write(
      root,
      ".github/workflows/cms-scheduled-publish-loop.yml",
      splitCaller("cms-scheduled-publish-loop", CANON, "v0.1.59"),
    );

    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/cms-scheduled-publish-loop\.yml/);
    expect(out).toMatch(/platform_ref/);
    expect(out).toMatch(/v0\.1\.59/); // the stale INPUT value is named
    expect(out).toMatch(/v0\.1\.73/); // …against the canonical expectation
  });

  test("exits 0 when the platform_ref input agrees with platform.lock", () => {
    const root = mkConsumer();
    const CANON = "v0.1.73";
    write(root, "platform.lock", platformLock(CANON));
    writeSentinel(root);
    write(
      root,
      ".github/workflows/cms-scheduled-publish-loop.yml",
      splitCaller("cms-scheduled-publish-loop", CANON, CANON),
    );
    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
  });

  test("ignores a `${{ … }}` expression value (a forwarded parameter, not a pin)", () => {
    const root = mkConsumer();
    const CANON = "v0.1.73";
    write(root, "platform.lock", platformLock(CANON));
    writeSentinel(root);
    write(
      root,
      ".github/workflows/forwarder.yml",
      splitCaller("forwarder", CANON, "${{ inputs.platform_ref }}"),
    );
    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
  });

  test("ignores an input DECLARATION (`platform_ref: { type: string, default: main }`)", () => {
    const root = mkConsumer();
    const CANON = "v0.1.73";
    write(root, "platform.lock", platformLock(CANON));
    writeSentinel(root);
    // The shape every platform reusable uses to DECLARE the input — a map value,
    // not a pin. `default: main` must not be read as a stale version.
    write(
      root,
      ".github/workflows/declares-it.yml",
      [
        "name: declares-it",
        "on:",
        "  workflow_call:",
        "    inputs:",
        "      platform_ref: { type: string, default: main }",
        "jobs:",
        "  j:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "",
      ].join("\n"),
    );
    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
  });
});

// ── Preview-media probe sentinel (#84): a consumer must carry
// assets/images/uploads/e2e-preview-media-probe.png byte-identical to the
// canonical 1x1 PNG (git-blob sha1 62a5f8f47fec02344e5bf9061888262f677cf5d6).
// preview-media.yml's salient-change gate fetches this exact path on the
// deployed preview (e2e/preview-media-resolves.spec.js PROBE_PATH); a
// missing/wrong sentinel must fail HERE at PR time, not intermittently on a
// later media-salient change.
test.describe("check-platform-pin-consistency.js — preview-media sentinel (#84)", () => {
  function baseConsumer() {
    const root = mkConsumer();
    write(root, "platform.lock", platformLock("v0.1.7"));
    return root;
  }

  test("FAILS with MISSING when the sentinel is absent", () => {
    const root = baseConsumer(); // no sentinel written
    const res = run(root);
    expect(res.status).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/preview-media sentinel: MISSING/);
    expect(out).toMatch(/assets\/images\/uploads\/e2e-preview-media-probe\.png/);
  });

  test("FAILS with WRONG-BYTES when the sentinel doesn't match the canonical bytes", () => {
    const root = baseConsumer();
    write(root, SENTINEL_REL, "not the right bytes");
    const res = run(root);
    expect(res.status).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/preview-media sentinel: WRONG-BYTES/);
  });

  test("exits 0 when the sentinel is byte-identical to the canonical PNG", () => {
    const root = baseConsumer();
    writeSentinel(root);
    const res = run(root);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
  });
});

// ── Workflow-set parity: consumer's .github/workflows SET must EQUAL the
// platform's canonical examples/site set (the platform-dictated set) at the
// pinned ref — no MISSING, no EXTRA. The canonical set is supplied via
// --canonical-workflows (the reusable points it at the .cms-platform checkout).
test.describe("check-platform-pin-consistency.js — workflow-set parity", () => {
  const V = "v0.1.20";

  // A temp "canonical" dir holding the platform-dictated basenames. Content is
  // the SAME reusableCaller shape the consumer uses, so the companion
  // CONTENT-parity check (call-interface) is satisfied for shared files and
  // these SET-parity assertions stay isolated to the set comparison.
  function mkCanonical(names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-canon-"));
    for (const n of names) {
      fs.writeFileSync(path.join(dir, n), reusableCaller(n.replace(/\.ya?ml$/, ""), V));
    }
    return dir;
  }
  // A version-consistent consumer carrying exactly `names` workflow callers.
  function consumerWith(names) {
    const root = mkConsumer();
    write(root, "platform.lock", platformLock(V));
    for (const n of names) write(root, `.github/workflows/${n}`, reusableCaller(n.replace(/\.ya?ml$/, ""), V));
    writeSentinel(root);
    return root;
  }
  function runWithCanonical(root, canonicalDir) {
    return spawnSync(
      process.execPath,
      [SCRIPT, "--root", root, "--owner", OWNER, "--repo", REPO, "--canonical-workflows", canonicalDir],
      { encoding: "utf8" },
    );
  }

  test("exits 0 when the consumer set EQUALS the canonical set", () => {
    const names = ["deploy-production.yml", "e2e-tests.yml", "secrets-scan.yml"];
    const res = runWithCanonical(consumerWith(names), mkCanonical(names));
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/workflow-set/);
    expect(res.status).toBe(0);
  });

  test("FAILS with MISSING when a platform-dictated workflow is absent", () => {
    const root = consumerWith(["deploy-production.yml", "e2e-tests.yml"]);
    const canon = mkCanonical(["deploy-production.yml", "e2e-tests.yml", "regression-review-reaper.yml"]);
    const res = runWithCanonical(root, canon);
    expect(res.status).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/workflow-set: MISSING/);
    expect(out).toMatch(/regression-review-reaper\.yml/);
  });

  test("FAILS with EXTRA when the consumer carries a non-dictated workflow", () => {
    const root = consumerWith(["deploy-production.yml", "e2e-tests.yml", "regenerate-manual.yml"]);
    const canon = mkCanonical(["deploy-production.yml", "e2e-tests.yml"]);
    const res = runWithCanonical(root, canon);
    expect(res.status).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/workflow-set: EXTRA/);
    expect(out).toMatch(/regenerate-manual\.yml/);
  });

  test("skips parity (still exits 0) when no canonical set is available", () => {
    const res = run(consumerWith(["deploy-production.yml"])); // no --canonical-workflows, no .cms-platform
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/workflow-set parity skipped/);
  });
});

// ── Workflow-CONTENT (call-interface) parity: a consumer's thin caller must
// match the canonical template's uses target + with KEYS + secrets map +
// permissions — modulo version refs, site-specific with VALUES, and site-tuned
// on: triggers. Catches the sweep `startup_failure` class (dropped required
// secret) WITHOUT false-positiving on legit site differences.
test.describe("check-platform-pin-consistency.js — workflow-content (call-interface) parity", () => {
  const V = "v0.1.24";
  // A sweep-style caller. `secrets` / `withKeys` / `apex` / `cron` / `paths`
  // are configurable so a test can drift exactly one facet.
  function sweepCaller({
    ref = V,
    secrets = true,
    withKeys = ["dry_run", "threshold_hours"],
    apex = "example.com",
    cron = "0 4 * * *",
    paths = ["admin/**"],
  } = {}) {
    const lines = [
      "name: Sweep",
      "on:",
      "  schedule:",
      `    - cron: '${cron}'`,
      "  push:",
      "    paths:",
      ...paths.map((p) => `      - ${p}`),
      "permissions:",
      "  contents: write",
      "  pull-requests: write",
      "jobs:",
      "  sweep:",
      `    uses: ${SLUG}/.github/workflows/sweep-stale-cms-prs.yml@${ref}`,
    ];
    if (secrets) {
      lines.push("    secrets:", "      CMS_E2E_PAT: ${{ secrets.CMS_E2E_PAT }}");
    }
    lines.push("    with:");
    if (withKeys.includes("dry_run")) lines.push("      dry_run: false");
    if (withKeys.includes("threshold_hours")) lines.push("      threshold_hours: 6");
    if (withKeys.includes("apex")) lines.push(`      apex: ${apex}`);
    lines.push(`      platform_ref: ${ref}`);
    return lines.join("\n") + "\n";
  }
  function mkCanonicalDir(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-canon-"));
    fs.writeFileSync(path.join(dir, "sweep-stale-cms-prs.yml"), content);
    return dir;
  }
  function consumer(callerContent) {
    const root = mkConsumer();
    write(root, "platform.lock", platformLock(V));
    write(root, ".github/workflows/sweep-stale-cms-prs.yml", callerContent);
    writeSentinel(root);
    return root;
  }
  function runC(root, canonicalDir) {
    return spawnSync(
      process.execPath,
      [SCRIPT, "--root", root, "--owner", OWNER, "--repo", REPO, "--canonical-workflows", canonicalDir],
      { encoding: "utf8" },
    );
  }

  test("exits 0 when the call interface matches (despite site-tuned on: + with VALUES)", () => {
    const canon = mkCanonicalDir(sweepCaller({ apex: "example.com", cron: "0 4 * * *", paths: ["admin/**"] }));
    // Same uses/with-keys/secrets, but a DIFFERENT schedule, push paths, and apex value.
    const root = consumer(sweepCaller({ apex: "jodidaniel.com", cron: "0 7 * * *", paths: ["_layouts/**"] }));
    const res = runC(root, canon);
    expect(`${res.stdout}${res.stderr}`).not.toMatch(/workflow-content/);
    expect(res.status).toBe(0);
  });

  test("FAILS when the caller drops the required secrets: map (the sweep startup_failure)", () => {
    const canon = mkCanonicalDir(sweepCaller({ secrets: true }));
    const root = consumer(sweepCaller({ secrets: false }));
    const res = runC(root, canon);
    expect(res.status).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/workflow-content: DRIFT/);
    expect(out).toMatch(/sweep-stale-cms-prs\.yml/);
    expect(out).toMatch(/secrets: map/);
  });

  test("FAILS when a required with: key is missing", () => {
    const canon = mkCanonicalDir(sweepCaller({ withKeys: ["dry_run", "threshold_hours"] }));
    const root = consumer(sweepCaller({ withKeys: ["dry_run"] })); // dropped threshold_hours
    const res = runC(root, canon);
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/with: keys/);
  });
});

// ── The guard must not SILENTLY DEGRADE. Run without a resolvable canonical set
// the checker drops from 96 checks to 61 — losing exactly the workflow-SET and
// workflow-CONTENT parity checks that police a consumer's `secrets:` map — and it
// used to still print "Pins are consistent." A report that cannot distinguish
// "verified" from "did not look" is the same defect class fixed in the re-arm
// sweep's 0/0/0 summary, the scheduled-run health audit, and
// `audit-repo-settings.js`'s unqualified OK line (whose
// `unverifiableKeys`/`repoOkLine`/`cleanScanSummary` vocabulary `okSummary`
// mirrors). Locked in BOTH directions, because the quiet half is the one a
// refactor regresses: with parity VERIFIED the wording must stay byte-identical.
test.describe("check-platform-pin-consistency.js — degraded-scan wording + --require-canonical", () => {
  const { okSummary } = require("../scripts/check-platform-pin-consistency.js");
  const V = "v0.1.76";

  // A canonical dir + a consumer carrying EXACTLY that set, with identical call
  // interfaces, so both parity checks RUN and PASS (the verified branch).
  function mkCanonical(names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-degrade-canon-"));
    for (const n of names) {
      fs.writeFileSync(path.join(dir, n), reusableCaller(n.replace(/\.ya?ml$/, ""), V));
    }
    return dir;
  }
  function mkConsistentConsumer(names) {
    const root = mkConsumer();
    write(root, "platform.lock", platformLock(V));
    for (const n of names) {
      write(root, `.github/workflows/${n}`, reusableCaller(n.replace(/\.ya?ml$/, ""), V));
    }
    writeSentinel(root);
    return root;
  }
  function runWith(root, extraArgs) {
    return spawnSync(
      process.execPath,
      [SCRIPT, "--root", root, "--owner", OWNER, "--repo", REPO, ...extraArgs],
      { encoding: "utf8" },
    );
  }
  const NAMES = ["deploy-production.yml", "e2e-tests.yml"];
  // `--root <tmpdir>` makes the reported root deterministic (`rel(ROOT)` is "" →
  // "."), so the summary line can be compared verbatim.
  function summaryLine(out) {
    const line = out.split("\n").find((l) => l.startsWith("platform-pin-consistency: OK —"));
    expect(line, `no OK summary in:\n${out}`).toBeTruthy();
    return line;
  }

  test("canonical PRESENT → summary is BYTE-IDENTICAL to today's wording", () => {
    // (a) the pure helper's verified wording, asserted on the literal — this is
    // what stops a later refactor quietly rephrasing the clean-scan sentence.
    expect(
      okSummary({
        checked: 96,
        root: ".",
        platformRef: V,
        lockRel: "platform.lock",
        parityVerified: true,
      }),
    ).toBe(
      "platform-pin-consistency: OK — all 96 platform-consistency check(s) in . " +
        `pass for platform_ref ${V} (canonical, from platform.lock). Pins are consistent.`,
    );

    // (b) the CLI emits exactly what the helper produces for its own check count.
    const root = mkConsistentConsumer(NAMES);
    const res = runWith(root, ["--canonical-workflows", mkCanonical(NAMES)]);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    const line = summaryLine(res.stdout);
    const checked = Number(line.match(/all (\d+) platform-consistency/)[1]);
    expect(line).toBe(
      okSummary({
        checked,
        root: ".",
        platformRef: V,
        lockRel: "platform.lock",
        parityVerified: true,
      }),
    );
    expect(line).toContain("Pins are consistent.");
    expect(res.stdout).not.toMatch(/workflow-set parity skipped/);
  });

  test("canonical MISSING → summary is QUALIFIED, never claims consistency, exit still 0", () => {
    const root = mkConsistentConsumer(NAMES); // no --canonical-workflows, no .cms-platform
    const res = runWith(root, []);
    // Exit code UNCHANGED so no existing caller breaks — only the wording moves.
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    const line = summaryLine(res.stdout);
    expect(line).not.toContain("Pins are consistent");
    expect(line).toMatch(/NOT VERIFIED/);
    expect(line).toMatch(/[Ww]orkflow-SET and workflow-CONTENT parity/);
    // It must name what to pass to actually verify them.
    expect(line).toMatch(/--canonical-workflows/);
    expect(line).toMatch(/--require-canonical/);
    // …and the pure helper agrees with the CLI on the degraded branch too.
    const checked = Number(line.match(/all (\d+) platform-consistency/)[1]);
    expect(line).toBe(
      okSummary({
        checked,
        root: ".",
        platformRef: V,
        lockRel: "platform.lock",
        parityVerified: false,
      }),
    );
  });

  test("canonical MISSING + --require-canonical → exit NON-ZERO, naming the flag + reason", () => {
    const root = mkConsistentConsumer(NAMES);
    const res = runWith(root, ["--require-canonical"]);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).not.toBe(0);
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/::error/); // annotation, emitted regardless of CI
    expect(out).toMatch(/--require-canonical/); // the flag that made it fatal
    expect(out).toMatch(/NOT VERIFIED/); // the reason
    expect(out).toMatch(/--canonical-workflows/); // how to fix it
    // A hard failure must never also print the OK line.
    expect(out).not.toContain("Pins are consistent");
  });

  test("--require-canonical is SATISFIED (exit 0) once the canonical set resolves", () => {
    const root = mkConsistentConsumer(NAMES);
    const res = runWith(root, ["--require-canonical", "--canonical-workflows", mkCanonical(NAMES)]);
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    expect(summaryLine(res.stdout)).toContain("Pins are consistent.");
  });
});

// ── The reusable ALWAYS checks examples/site out into `.cms-platform/`, so a
// parity SKIP there can only mean that checkout broke — it must therefore demand
// --require-canonical rather than accept the 61-check degraded scan. Parsed with
// the real YAML parser (workflow-yaml-utils), never a regex over the file.
test.describe("platform-pin-consistency.yml reusable — demands --require-canonical", () => {
  const { readWorkflow, parseYaml, jobs, runScripts, allStrings } = require("./workflow-yaml-utils");
  const WF = "platform-pin-consistency.yml";

  test("the checker invocation passes --require-canonical", () => {
    const text = readWorkflow(WF);
    const invocations = runScripts(text)
      .map((b) => b.script)
      .filter((s) => s.includes("check-platform-pin-consistency.js"));
    expect(invocations.length, "no checker invocation found in the reusable").toBe(1);
    expect(invocations[0]).toMatch(/--require-canonical\b/);
  });

  test("it still checks the canonical workflow SET out (what the flag demands)", () => {
    const text = readWorkflow(WF);
    const doc = parseYaml(text);
    expect(Object.keys(jobs(text)).length).toBeGreaterThan(0);
    const strings = allStrings(doc);
    expect(
      strings.some((s) => s.includes("examples/site/.github/workflows")),
      "the reusable must sparse-checkout examples/site/.github/workflows, or " +
        "--require-canonical would fail every run",
    ).toBe(true);
  });
});

// ── scripts/verify-consumer-pins.sh — ONE command whose EXIT CODE is the
// definition of done for a consumer pin bump. It exists because the v0.1.76 bump
// was delegated with the gate named in the spec and neither subagent ran it (one
// left 58 stale refs and described the work as near-done). Driven end-to-end here
// HERMETICALLY: a synthetic platform dir (real checker + an authored canonical
// set + a symlink to the harness's own `yaml`) and a synthetic consumer.
test.describe("scripts/verify-consumer-pins.sh — the consumer-bump gate", () => {
  const VERIFIER = path.resolve(__dirname, "../scripts/verify-consumer-pins.sh");
  const V = "v0.1.76";
  const NAMES = ["deploy-production.yml", "e2e-tests.yml"];

  test("exists, is executable, and is `bash -n` clean", () => {
    expect(fs.existsSync(VERIFIER)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect((fs.statSync(VERIFIER).mode & 0o111) !== 0, "must be executable").toBe(true);
    const res = spawnSync("bash", ["-n", VERIFIER], { encoding: "utf8" });
    expect(res.status, `bash -n:\n${res.stderr}`).toBe(0);
  });

  test("structure: strict mode, demands --require-canonical, never swallows a check", () => {
    const src = fs.readFileSync(VERIFIER, "utf8");
    expect(src).toMatch(/^set -euo pipefail$/m);
    expect(src).toMatch(/--require-canonical/);
    expect(src).toMatch(/--canonical-workflows/);
    // A check that cannot fail is the bug this script exists to prevent, so it
    // must never `|| true` / `|| :` its way past one.
    expect(src).not.toMatch(/\|\|\s*true\b/);
    expect(src).not.toMatch(/\|\|\s*:\s*$/m);
    // A missing node / yaml lib is a hard FAIL, never a skip.
    expect(src).toMatch(/must not be skipped/);
  });

  // A synthetic platform tree: the REAL checker + an authored canonical set +
  // the harness's own `yaml` (symlinked, so this stays hermetic and offline).
  function mkPlatform(names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-verify-plat-"));
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, "scripts", path.basename(SCRIPT)));
    const canon = path.join(dir, "examples", "site", ".github", "workflows");
    fs.mkdirSync(canon, { recursive: true });
    for (const n of names) {
      fs.writeFileSync(path.join(canon, n), reusableCaller(n.replace(/\.ya?ml$/, ""), V));
    }
    fs.mkdirSync(path.join(dir, "e2e", "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.resolve(__dirname, "node_modules", "yaml"),
      path.join(dir, "e2e", "node_modules", "yaml"),
      "dir",
    );
    return dir;
  }
  function mkVerifiableConsumer(refByName) {
    const root = mkConsumer();
    write(root, "platform.lock", platformLock(V));
    for (const [n, ref] of Object.entries(refByName)) {
      write(root, `.github/workflows/${n}`, reusableCaller(n.replace(/\.ya?ml$/, ""), ref));
    }
    writeSentinel(root);
    return root;
  }
  function runVerifier(root, platformDir) {
    return spawnSync("bash", [VERIFIER, "--platform-dir", platformDir], {
      cwd: root,
      encoding: "utf8",
    });
  }
  const consistent = () => Object.fromEntries(NAMES.map((n) => [n, V]));

  test("PASSES on a consistent consumer (exit 0, PASS verdict)", () => {
    const res = runVerifier(mkVerifiableConsumer(consistent()), mkPlatform(NAMES));
    const out = `${res.stdout}${res.stderr}`;
    expect(res.status, out).toBe(0);
    expect(out).toMatch(/verify-consumer-pins: PASS/);
    expect(out).toMatch(/--require-canonical/); // parity really was verified
  });

  test("FAILS red on a consumer carrying ONE stale pin, naming that file", () => {
    const refs = consistent();
    refs["e2e-tests.yml"] = "v0.1.75"; // the exact shape of the v0.1.76 incident
    const res = runVerifier(mkVerifiableConsumer(refs), mkPlatform(NAMES));
    const out = `${res.stdout}${res.stderr}`;
    expect(res.status, out).not.toBe(0);
    expect(out).toMatch(/e2e-tests\.yml/); // the offending FILE is named
    expect(out).toMatch(/v0\.1\.75/); // …and the stale value
    expect(out).toMatch(/verify-consumer-pins: FAIL \(\d+ problem\(s\)\)/);
    expect(out).not.toMatch(/verify-consumer-pins: PASS/);
  });

  test("does NOT trip on an unrelated version string (third-party pin / prose)", () => {
    // The benign 35-vs-34 class: a `# v6.0.2` third-party pin comment and a prose
    // "since v0.1.4" header line must not read as a stale platform ref.
    const root = mkVerifiableConsumer(consistent());
    write(
      root,
      ".github/workflows/noise.yml",
      [
        "# This caller has shipped since v0.1.4 (prose, not a pin).",
        "name: noise",
        "on: { pull_request: {} }",
        "jobs:",
        "  j:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567  # v6.0.2 (2026-01-09)",
        "",
      ].join("\n"),
    );
    // `noise.yml` is not platform-dictated, so workflow-SET parity flags it —
    // scope this assertion to the STALE-REF check, which must stay silent.
    const res = runVerifier(root, mkPlatform(NAMES));
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toMatch(/ok: no stale platform ref/);
    expect(out).not.toMatch(/v6\.0\.2 \(expected/);
    expect(out).not.toMatch(/v0\.1\.4 \(expected/);
  });

  test("FAILS when a workflow does not parse as YAML", () => {
    const root = mkVerifiableConsumer(consistent());
    write(root, ".github/workflows/broken.yml", "name: broken\non: { pull_request: {} }\njobs:\n  - [oops\n");
    const res = runVerifier(root, mkPlatform(NAMES));
    const out = `${res.stdout}${res.stderr}`;
    expect(res.status, out).not.toBe(0);
    expect(out).toMatch(/broken\.yml/);
    expect(out).toMatch(/does not parse/);
  });
});
