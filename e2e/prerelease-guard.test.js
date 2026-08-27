// @lane: local — pure-Node: spawns the guard CLI and reads YAML off disk.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");

// The prerelease MERGE guard (scripts/assert-release-pin.js +
// .github/workflows/platform-prerelease-guard.yml + its examples/site caller +
// the repo-settings.yml required-context entry).
//
// release.yml can cut `vX.Y.Z-rc.N` as a GitHub prerelease so a platform fix is
// validated on ONE consumer PR before it reaches production. That pin belongs on
// a stacked branch; it must never ride into the consumer's default branch, which
// is what deploy-production builds from.
//
// Three separate things have to hold, and two of them are invisible at runtime —
// they fail as "this PR hangs forever" or "this PR merged an RC", neither of
// which looks like a broken lint. Hence the locks below.

const REPO = path.join(__dirname, "..");
const SCRIPT = path.join(REPO, "scripts", "assert-release-pin.js");
const CALLER = path.join(
  REPO,
  "examples",
  "site",
  ".github",
  "workflows",
  "platform-prerelease-guard.yml",
);
const REUSABLE = path.join(REPO, ".github", "workflows", "platform-prerelease-guard.yml");
const SETTINGS = path.join(REPO, "repo-settings.yml");

// In a CONSUMED checkout there is no examples/ tree and no repo-settings.yml, so
// the template-shape assertions have nothing to read. Skip rather than fail —
// same convention as required-check-stub-paths.test.js.
const HAVE_TEMPLATES = fs.existsSync(CALLER) && fs.existsSync(REUSABLE) && fs.existsSync(SETTINGS);

function withLock(body, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prerelease-guard-"));
  try {
    if (body !== null) fs.writeFileSync(path.join(dir, "platform.lock"), body);
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runGuard(dir) {
  return spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });
}

test.describe("assert-release-pin.js — refuses a prerelease platform pin", () => {
  test("a release pin passes", () => {
    withLock("platform_ref: v0.1.88\n", (dir) => {
      const r = runGuard(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/OK — platform_ref 'v0\.1\.88' is not a prerelease/);
    });
  });

  test("a prerelease pin fails, and the message names the ref", () => {
    withLock("platform_ref: v0.1.89-rc.1\n", (dir) => {
      const r = runGuard(dir);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/FAIL/);
      expect(r.stdout).toContain("v0.1.89-rc.1");
    });
  });

  test("every prerelease shape fails, not just -rc.N", () => {
    for (const ref of ["v0.1.89-rc1", "v0.1.89-beta.2", "v0.2.0-alpha", "v1.0.0-0"]) {
      withLock(`platform_ref: ${ref}\n`, (dir) => {
        expect(runGuard(dir).status, `${ref} should be refused`).toBe(1);
      });
    }
  });

  test("a release pin is not mistaken for a prerelease by a hyphen elsewhere", () => {
    // The pattern is anchored at both ends; a quoted ref with trailing content
    // is not a version at all and must not be silently treated as one.
    withLock('platform_ref: "v0.1.88"\n', (dir) => {
      expect(runGuard(dir).status).toBe(0);
    });
  });

  // Exit 2 is "could not run", and the workflow step fails on it exactly as it
  // fails on 1. A guard that cannot read its input must never look like a pass —
  // this is the class of bug that let cms-platform#244's lookup swallow real
  // failures behind a green exit 0.
  test("a guard that cannot evaluate its input exits 2, never 0", () => {
    withLock(null, (dir) => {
      expect(runGuard(dir).status, "missing platform.lock").toBe(2);
    });
    withLock("platform_repo: Adam-S-Daniel/cms-platform\n", (dir) => {
      expect(runGuard(dir).status, "no platform_ref key").toBe(2);
    });
    withLock(":::not yaml:::\n  - [\n", (dir) => {
      expect(runGuard(dir).status, "unparseable YAML").toBe(2);
    });
    withLock("", (dir) => {
      expect(runGuard(dir).status, "empty platform.lock").toBe(2);
    });
  });
});

test.describe("prerelease guard — the wiring that makes it BLOCK a merge", () => {
  test.skip(!HAVE_TEMPLATES, "platform-only: no examples/ tree in a consumed checkout");

  function triggersOf(file) {
    const doc = parseYaml(fs.readFileSync(file, "utf8")) || {};
    // A bare `on:` parses to null, and a YAML-1.1 reader folds the `on` KEY into
    // boolean true — probe both rather than compare undefined to undefined.
    const on = doc.on != null ? doc.on : doc[true];
    expect(on !== null && typeof on === "object" && !Array.isArray(on), `${file}: bad on:`).toBe(
      true,
    );
    return on;
  }

  // THE load-bearing one. A required context whose workflow is skipped emits no
  // check run, and branch protection then hangs forever on "Waiting for status
  // to be reported" — the trap platform-pin-consistency.yml's caller documents.
  //
  // And the usual remedy is unavailable here: a mirroring stub (e2e-stub.yml)
  // emits a SYNTHETIC success, so a content-only PR on a branch already pinned
  // to an RC would collect that pass and stay mergeable. The pin does not have
  // to change in the PR for the pin to be wrong. So this caller may never carry
  // a path filter at all.
  test("the caller carries NO paths / paths-ignore filter", () => {
    const pr = triggersOf(CALLER).pull_request || {};
    expect(
      pr.paths === undefined && pr["paths-ignore"] === undefined,
      "platform-prerelease-guard.yml must run on EVERY pull_request into the default branch. " +
        "A path filter would skip it, the required context would never report, and every " +
        "filtered PR would hang. A mirroring stub cannot fix it here either — a synthetic " +
        "pass would let a content-only PR merge while still pinned to a prerelease.",
    ).toBe(true);
  });

  test("the caller watches the default branch, and omits the `edited` type", () => {
    const pr = triggersOf(CALLER).pull_request || {};
    expect(pr.branches).toEqual(["main"]);
    expect(pr.types || []).not.toContain("edited");
  });

  // The required context string is `<caller job id> / <reusable job id>`.
  // Renaming either job silently orphans the ruleset entry: nothing publishes
  // the context the ruleset waits for, so every consumer PR hangs.
  test("the job ids compose exactly the context repo-settings.yml requires", () => {
    const callerJobs = Object.keys(parseYaml(fs.readFileSync(CALLER, "utf8")).jobs || {});
    const reusableJobs = Object.keys(parseYaml(fs.readFileSync(REUSABLE, "utf8")).jobs || {});
    expect(callerJobs).toHaveLength(1);
    expect(reusableJobs).toHaveLength(1);
    const context = `${callerJobs[0]} / ${reusableJobs[0]}`;

    const settings = parseYaml(fs.readFileSync(SETTINGS, "utf8"));
    const consumerMain = (settings.ruleset_library || {})["consumer-main"];
    expect(
      consumerMain,
      "repo-settings.yml's ruleset_library must declare `consumer-main`",
    ).toBeTruthy();
    const required = (consumerMain.rules || [])
      .filter((r) => r && r.type === "required_status_checks")
      .flatMap((r) => (r.parameters || {}).required_status_checks || [])
      .map((c) => c.context);

    expect(
      required,
      `the guard publishes "${context}"; repo-settings.yml's consumer-main required set must ` +
        `contain exactly that string or the ruleset waits on a context nothing reports`,
    ).toContain(context);
  });

  // The required set only bites on repos that BIND `consumer-main` to their
  // default branch. If a consumer were switched to another ruleset, the context
  // above would go on being published and go on not blocking anything.
  test("every consumer binds consumer-main to its default branch", () => {
    const settings = parseYaml(fs.readFileSync(SETTINGS, "utf8"));
    const consumers = Object.entries(settings.repos || {}).filter(
      ([, cfg]) => ((cfg || {}).rulesets || {}).main === "consumer-main",
    );
    expect(
      consumers.length,
      "no repo binds consumer-main to main — the required prerelease context would block nobody",
    ).toBeGreaterThan(0);
  });

  test("the caller pins the reusable it declares as required", () => {
    const job = Object.values(parseYaml(fs.readFileSync(CALLER, "utf8")).jobs || {})[0];
    expect(job.uses).toMatch(
      /^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/platform-prerelease-guard\.yml@/,
    );
  });
});
