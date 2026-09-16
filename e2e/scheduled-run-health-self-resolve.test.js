// @lane: local — pure-fs/pure-Node lint. No browser, no network, no build.
//
// THE INVARIANT THIS LOCKS (#424). scheduled-run-health.yml used to trust
// `inputs.platform_repo` / `inputs.platform_ref` to pick which platform
// commit to sparse-check-out and run. A caller names the platform version
// TWICE — `uses: …@vX.Y.Z` (a Dependabot-movable dependency ref) and
// `with: platform_ref: vX.Y.Z` (an input value Dependabot cannot move) — so a
// half-bumped caller ran the NEW reusable against the OLD
// audit-scheduled-runs.js its stale `platform_ref` sparse-checked out, and an
// argv-scanning `flag()` silently ignored whatever the new workflow asked
// for. The fix resolves the platform repository/commit from the JOB CONTEXT
// instead (see scheduled-run-health.yml's "WHERE THE AUDIT SCRIPT COMES
// FROM" header) and adds a currency lane that reds when the release a caller
// IS pinned to has gone stale. This file locks three things: the reusable's
// static shape (A), that the resolve step's bash actually does the right
// thing when executed for real, on every job-context shape a real runner or
// a stale/malformed caller can produce (B), and the currency script's own
// version math and CLI contract (C).
//
// PLATFORM-INTERNAL, and registered in PLATFORM_META_SPECS: it reads this
// repo's own workflow DEFINITIONS (via workflow-yaml-utils's readWorkflow /
// parseYaml) and requires scripts/check-platform-currency.js directly, none
// of which a consumer ships — a consumer's thin caller has no
// scheduled-run-health.yml of its own and no scripts/ tree at all.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, readWorkflow, allStrings } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOW = "scheduled-run-health.yml";
const SELF_CALLER = "self-scheduled-run-health.yml";
const CHECKER_PATH = path.join(REPO_ROOT, "scripts", "check-platform-currency.js");
const {
  parseVersion,
  compareVersions,
  assessCurrency,
  validateReleases,
  main: currencyMain,
} = require(CHECKER_PATH);

// Every scratch dir this file makes, reaped once at the end — this lint runs
// in the REQUIRED node-unit-lints lane, so without teardown it strands one
// mkdtemp dir per test on every machine that runs it, forever.
const SCRATCH_DIRS = [];
test.afterAll(() => {
  for (const dir of SCRATCH_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function workflowDoc(name) {
  return parseYaml(readWorkflow(name));
}

function auditSteps() {
  return (((workflowDoc(WORKFLOW).jobs || {}).audit || {}).steps) || [];
}

// ── A. Reusable shape (parsed YAML) ────────────────────────────────────────
test.describe("#424 scheduled-run-health.yml — reusable shape", () => {
  test("the first step of jobs.audit resolves the platform commit from toJSON(job)", () => {
    const first = auditSteps()[0];
    expect(first && first.id, "the first step of jobs.audit must be id: self").toBe("self");
    const env = (first && first.env) || {};
    expect(
      env.JOB_CONTEXT,
      "the resolve step must read the job context via toJSON(job) — actionlint does not type " +
        "job.workflow_* yet (rhysd/actionlint#647), so a direct ${{ job.workflow_sha }} would " +
        "red the REQUIRED actionlint lane",
    ).toBe("${{ toJSON(job) }}");
  });

  test("the .cms-platform checkout is keyed off the resolve step's own outputs, and sparse-checks-out both scripts", () => {
    const checkoutStep = auditSteps().find((s) => s && s.with && s.with.path === ".cms-platform");
    expect(checkoutStep, "no step checks the platform out to .cms-platform").toBeTruthy();
    expect(
      checkoutStep.with.repository,
      "the checkout must trust the resolve step's output, not inputs.platform_repo",
    ).toBe("${{ steps.self.outputs.repository }}");
    expect(
      checkoutStep.with.ref,
      "the checkout must pin the exact commit sha the job was called at, not inputs.platform_ref",
    ).toBe("${{ steps.self.outputs.sha }}");
    const sparse = String(checkoutStep.with["sparse-checkout"] || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(sparse, "the sparse checkout must include the audit script").toContain(
      "scripts/audit-scheduled-runs.js",
    );
    expect(sparse, "the sparse checkout must include the new currency script").toContain(
      "scripts/check-platform-currency.js",
    );
  });

  test("no step's with: value anywhere in the job selects the checkout via the deprecated inputs", () => {
    const offenders = [];
    for (const step of auditSteps()) {
      const withObj = (step && step.with) || {};
      for (const [key, value] of Object.entries(withObj)) {
        if (/inputs\.platform_(ref|repo)/.test(String(value))) {
          offenders.push(`${step.name || step.id || "(unnamed step)"} with.${key}: ${value}`);
        }
      }
    }
    expect(
      offenders,
      "the deprecated platform_ref/platform_repo inputs must never select the checkout — a " +
        "value that disagrees with the job context may only produce a ::warning::",
    ).toEqual([]);
  });

  test("input declarations: deprecated inputs default empty; the new currency inputs are typed and defaulted", () => {
    const inputs = ((workflowDoc(WORKFLOW).on || {}).workflow_call || {}).inputs || {};
    expect(inputs.platform_ref, "platform_ref must default to empty string, not 'main'").toEqual({
      type: "string",
      default: "",
    });
    expect(inputs.platform_repo, "platform_repo must default to empty string").toEqual({
      type: "string",
      default: "",
    });
    expect(inputs.currency_scan).toEqual({ type: "boolean", default: true });
    expect(inputs.behind_days).toEqual({ type: "string", default: "21" });
  });

  test("the currency step runs AFTER the audit step, is fed steps.self.outputs + inputs.behind_days via env, and gates on CURRENCY_SCAN in shell", () => {
    const steps = auditSteps();
    const auditIdx = steps.findIndex((s) => /audit-scheduled-runs\.js/.test(String(s.run || "")));
    const currencyIdx = steps.findIndex((s) =>
      /check-platform-currency\.js/.test(String(s.run || "")),
    );
    expect(auditIdx, "the audit step must exist").toBeGreaterThanOrEqual(0);
    expect(currencyIdx, "the currency step must exist").toBeGreaterThanOrEqual(0);
    expect(
      currencyIdx,
      "a stale caller must still get its scheduled-run audit — the currency step must come after it",
    ).toBeGreaterThan(auditIdx);

    const currencyStep = steps[currencyIdx];
    const env = currencyStep.env || {};
    expect(env.CURRENCY_REPO, "the caller's repo must come from the job-resolved output").toBe(
      "${{ steps.self.outputs.repository }}",
    );
    expect(env.CURRENCY_REF, "the caller's ref must come from the job-resolved output").toBe(
      "${{ steps.self.outputs.ref }}",
    );
    expect(env.CURRENCY_BEHIND_DAYS).toBe("${{ inputs.behind_days }}");
    expect(env.CURRENCY_SCAN).toBe("${{ inputs.currency_scan }}");

    const run = String(currencyStep.run || "");
    expect(run, "the run block must gate on CURRENCY_SCAN in shell").toMatch(/CURRENCY_SCAN/);
    expect(
      run,
      "caller inputs must reach the run block through env, never interpolated straight into it",
    ).not.toContain("${{");
  });

  test("no ${{ }} expression anywhere in this workflow reads job.workflow_ directly", () => {
    const offenders = allStrings(workflowDoc(WORKFLOW)).filter((s) =>
      /\$\{\{[^}]*\bjob\.workflow_[^}]*\}\}/.test(s),
    );
    expect(
      offenders,
      "job.workflow_* must only be read via toJSON(job) in shell — actionlint does not type " +
        "these properties yet (rhysd/actionlint#647), and a direct reference reds the REQUIRED " +
        "actionlint lane",
    ).toEqual([]);
  });

  test("never the ${{ a && '' || b }} expression shape", () => {
    const offenders = allStrings(workflowDoc(WORKFLOW)).filter((s) =>
      /\$\{\{[^}]*?&&\s*(''|"")\s*\|\|[^}]*?\}\}/.test(s),
    );
    expect(offenders).toEqual([]);
  });
});

// ── B. The resolve step's bash, executed for real ──────────────────────────
function hasJq() {
  try {
    execFileSync("jq", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}
const JQ_AVAILABLE = hasJq();

function resolveStepScript() {
  const step = auditSteps().find((s) => s && s.id === "self");
  if (!step || typeof step.run !== "string") {
    throw new Error("could not locate the id: self step's run: block in scheduled-run-health.yml");
  }
  return step.run;
}

// Runs the resolve step's REAL bash (extracted from the parsed workflow, not
// re-typed here) against a synthetic JOB_CONTEXT. GITHUB_OUTPUT is a real
// temp file so the step's `>>"$GITHUB_OUTPUT"` writes land somewhere this
// test can read back, exactly like a real runner provides one per step.
function runResolveStep({ jobContext, platformRef = "", platformRepo = "" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-run-health-self-resolve-"));
  SCRATCH_DIRS.push(dir);
  const outputFile = path.join(dir, "github-output");
  fs.writeFileSync(outputFile, "");
  const result = spawnSync("bash", ["-e", "-c", resolveStepScript()], {
    env: {
      PATH: process.env.PATH,
      JOB_CONTEXT: jobContext,
      INPUT_PLATFORM_REF: platformRef,
      INPUT_PLATFORM_REPO: platformRepo,
      GITHUB_OUTPUT: outputFile,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: fs.readFileSync(outputFile, "utf8"),
  };
}

const PLATFORM_REPO_SLUG = "Adam-S-Daniel/cms-platform";
const SHA = "a1b2c3d4".repeat(5); // 40 hex chars

function jobContextFor({ repo = PLATFORM_REPO_SLUG, sha = SHA, wref }) {
  return JSON.stringify({ workflow_repository: repo, workflow_sha: sha, workflow_ref: wref });
}

test.describe("#424 scheduled-run-health.yml — the resolve step's bash, executed", () => {
  test("jq is on PATH — required to run this file's coverage of the resolve step for real", () => {
    expect(
      JQ_AVAILABLE,
      "jq is required by this test file; GitHub-hosted ubuntu runners ship it. Install it " +
        "locally (apt/brew install jq) rather than this coverage silently not running.",
    ).toBe(true);
  });

  test("tag call: resolves repository/sha/ref, no warning", () => {
    const jobContext = jobContextFor({
      wref: `${PLATFORM_REPO_SLUG}/.github/workflows/${WORKFLOW}@refs/tags/v0.1.108`,
    });
    const res = runResolveStep({ jobContext });
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    expect(res.output).toContain(`repository=${PLATFORM_REPO_SLUG}`);
    expect(res.output).toContain(`sha=${SHA}`);
    expect(res.output).toContain("ref=v0.1.108");
    expect(res.stdout).not.toContain("::warning::");
  });

  test("branch call: ref resolves to the bare branch name", () => {
    const jobContext = jobContextFor({
      wref: `${PLATFORM_REPO_SLUG}/.github/workflows/${WORKFLOW}@refs/heads/main`,
    });
    const res = runResolveStep({ jobContext });
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    expect(res.output).toContain("ref=main");
  });

  test("sha call: ref resolves to the bare sha itself", () => {
    const jobContext = jobContextFor({
      wref: `${PLATFORM_REPO_SLUG}/.github/workflows/${WORKFLOW}@${SHA}`,
    });
    const res = runResolveStep({ jobContext });
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBe(0);
    expect(res.output).toContain(`ref=${SHA}`);
  });

  test("platform_ref agreeing with the resolved ref warns never; disagreeing warns and does NOT change sha", () => {
    const jobContext = jobContextFor({
      wref: `${PLATFORM_REPO_SLUG}/.github/workflows/${WORKFLOW}@refs/tags/v0.1.108`,
    });

    const agree = runResolveStep({ jobContext, platformRef: "v0.1.108" });
    expect(agree.status).toBe(0);
    expect(agree.stdout).not.toContain("::warning::");

    const disagree = runResolveStep({ jobContext, platformRef: "v0.1.87" });
    expect(disagree.status, "a disagreeing platform_ref is a warning, not a failure").toBe(0);
    expect(disagree.stdout).toContain("::warning::");
    expect(disagree.stdout).toContain("v0.1.87");
    expect(disagree.stdout).toContain("v0.1.108");
    expect(
      disagree.output,
      "sha must stay the job-context sha regardless of platform_ref — proves the input does not " +
        "select the tree",
    ).toContain(`sha=${SHA}`);
  });

  test("platform_repo agreeing warns never; disagreeing warns", () => {
    const jobContext = jobContextFor({
      wref: `${PLATFORM_REPO_SLUG}/.github/workflows/${WORKFLOW}@refs/tags/v0.1.108`,
    });

    const agree = runResolveStep({ jobContext, platformRepo: PLATFORM_REPO_SLUG });
    expect(agree.status).toBe(0);
    expect(agree.stdout).not.toContain("::warning::");

    const disagree = runResolveStep({ jobContext, platformRepo: "someone/fork" });
    expect(disagree.status).toBe(0);
    expect(disagree.stdout).toContain("::warning::");
    expect(disagree.stdout).toContain("someone/fork");
  });

  test("old-runner shape (no workflow_* keys at all): non-zero exit, ::error::, empty GITHUB_OUTPUT", () => {
    const res = runResolveStep({ jobContext: JSON.stringify({ status: "success" }) });
    expect(res.status, "must not exit 0 when the job context carries nothing usable").not.toBe(0);
    expect(res.stdout + res.stderr).toContain("::error::");
    expect(res.output, "GITHUB_OUTPUT must stay untouched on any failure path").toBe("");
  });

  test("malformed job-context values each fail loud, and never write GITHUB_OUTPUT", () => {
    const cases = {
      "sha too short": jobContextFor({ sha: "abc123", wref: `${PLATFORM_REPO_SLUG}/x.yml@refs/tags/v0.1.108` }),
      "repository containing a space": jobContextFor({
        repo: "Adam S-Daniel/cms-platform",
        wref: `Adam S-Daniel/cms-platform/x.yml@refs/tags/v0.1.108`,
      }),
      "workflow_ref with no @": jobContextFor({ wref: "no-at-sign-here" }),
    };
    for (const [label, jobContext] of Object.entries(cases)) {
      const res = runResolveStep({ jobContext });
      expect(res.status, `${label}: must exit non-zero`).not.toBe(0);
      expect(res.stdout + res.stderr, `${label}: must annotate ::error::`).toContain("::error::");
      expect(res.output, `${label}: GITHUB_OUTPUT must stay empty`).toBe("");
    }
  });
});

// ── C. scripts/check-platform-currency.js ───────────────────────────────────
const NOW_ISO = "2026-09-15T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 86400000;

function daysAgoIso(days) {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

function release({ tag, publishedAt, draft = false, prerelease = false }) {
  return { tag_name: tag, published_at: publishedAt, draft, prerelease };
}

// Captures out/err through injected writers — never monkeypatches
// process.stdout/stderr — so a failing expectation can never leak a patched
// stream into a later test.
function runCurrency(argv, deps = {}) {
  const chunks = [];
  const code = currencyMain(argv, {
    now: NOW_MS,
    out: (s) => chunks.push(s),
    err: (s) => chunks.push(s),
    ...deps,
  });
  return { code, output: chunks.join("") };
}

test.describe("#424 check-platform-currency.js — version parse/compare", () => {
  test("parseVersion accepts vX.Y.Z and vX.Y.Z-prerelease, rejects non-release shapes", () => {
    const plain = parseVersion("v0.1.93");
    expect(plain && plain.major).toBe(0);
    expect(plain && plain.minor).toBe(1);
    expect(plain && plain.patch).toBe(93);
    expect(plain && plain.prerelease).toEqual([]);

    const rc = parseVersion("v0.1.92-rc.2");
    expect(rc && rc.prerelease).toEqual(["rc", "2"]);

    expect(parseVersion("main"), "a branch name is not a release tag").toBeNull();
    expect(parseVersion(SHA), "a bare sha is not a release tag").toBeNull();
    expect(parseVersion("refs/pull/1/merge"), "a pull-ref is not a release tag").toBeNull();
  });

  test("compareVersions: a prerelease sorts below its release, and patch compares numerically not lexically", () => {
    const rc2 = parseVersion("v0.1.92-rc.2");
    const rel92 = parseVersion("v0.1.92");
    const rel93 = parseVersion("v0.1.93");
    const v9 = parseVersion("v0.1.9");
    const v10 = parseVersion("v0.1.10");
    expect(compareVersions(rc2, rel92), "v0.1.92-rc.2 < v0.1.92").toBeLessThan(0);
    expect(compareVersions(rel92, rel93), "v0.1.92 < v0.1.93").toBeLessThan(0);
    expect(
      compareVersions(v9, v10),
      "v0.1.9 < v0.1.10 numerically — a string compare would put '10' before '9'",
    ).toBeLessThan(0);
  });
});

test.describe("#424 check-platform-currency.js — CLI contract", () => {
  const BASE_ARGS = ["--platform-repo", PLATFORM_REPO_SLUG, "--ref", "v0.1.92", "--behind-days", "21"];

  test("current: the pin IS the latest release → exit 0", () => {
    const res = runCurrency(
      ["--platform-repo", PLATFORM_REPO_SLUG, "--ref", "v0.1.93", "--behind-days", "21"],
      { fetchReleases: () => [release({ tag: "v0.1.93", publishedAt: daysAgoIso(30) })] },
    );
    expect(res.code, res.output).toBe(0);
  });

  test("within window: first newer release is 5 days old (window 21) → exit 0", () => {
    const releases = [
      release({ tag: "v0.1.92", publishedAt: daysAgoIso(40) }),
      release({ tag: "v0.1.93", publishedAt: daysAgoIso(5) }),
    ];
    const res = runCurrency(BASE_ARGS, { fetchReleases: () => releases });
    expect(res.code, res.output).toBe(0);
  });

  test("behind: first newer release is 22 days old (window 21) → exit 1, names the pin, first-newer, and latest", () => {
    const releases = [
      release({ tag: "v0.1.92", publishedAt: daysAgoIso(60) }),
      release({ tag: "v0.1.93", publishedAt: daysAgoIso(22) }),
      release({ tag: "v0.1.94", publishedAt: daysAgoIso(10) }),
    ];
    const res = runCurrency(BASE_ARGS, { fetchReleases: () => releases });
    expect(res.code, res.output).toBe(1);
    expect(res.output).toContain("v0.1.92"); // the pin
    expect(res.output).toContain("v0.1.93"); // the first release that superseded it
    expect(res.output).toContain("v0.1.94"); // the latest
  });

  test("boundary: exactly 21 days old with a 21-day window is NOT behind → exit 0", () => {
    const releases = [
      release({ tag: "v0.1.92", publishedAt: daysAgoIso(60) }),
      release({ tag: "v0.1.93", publishedAt: daysAgoIso(21) }),
    ];
    const res = runCurrency(BASE_ARGS, { fetchReleases: () => releases });
    expect(res.code, res.output).toBe(0);
  });

  test("firstNewer is the LOWEST newer version even when the API lists releases newest-first", () => {
    const releases = [
      release({ tag: "v0.1.95", publishedAt: daysAgoIso(1) }),
      release({ tag: "v0.1.94", publishedAt: daysAgoIso(22) }),
      release({ tag: "v0.1.93", publishedAt: daysAgoIso(30) }), // lowest newer, oldest — must drive the verdict
    ];
    const res = runCurrency(BASE_ARGS, { fetchReleases: () => releases });
    expect(res.code, res.output).toBe(1);
    expect(
      res.output,
      "the BEHIND verdict must be driven by v0.1.93 (30 days old), not v0.1.95 (listed first, only 1 day old)",
    ).toContain("v0.1.93");
  });

  test("drafts and prereleases are ignored — a newer draft/prerelease alone keeps current", () => {
    const releases = [
      release({ tag: "v0.1.93", publishedAt: daysAgoIso(90), draft: true }),
      release({ tag: "v0.1.94", publishedAt: daysAgoIso(90), prerelease: true }),
      release({ tag: "v0.1.95-rc.1", publishedAt: daysAgoIso(90) }),
    ];
    const res = runCurrency(BASE_ARGS, { fetchReleases: () => releases });
    expect(res.code, res.output).toBe(0);
  });

  test("non-release refs (branch, sha, pull ref) skip the check without ever fetching releases", () => {
    for (const ref of ["main", SHA, "refs/pull/1/merge"]) {
      const res = runCurrency(["--platform-repo", PLATFORM_REPO_SLUG, "--ref", ref], {
        fetchReleases: () => {
          throw new Error("fetchReleases must not be called for a non-release ref");
        },
      });
      expect(res.code, `${ref}: ${res.output}`).toBe(0);
      expect(res.output).toMatch(/not a vX\.Y\.Z release tag/);
    }
  });

  test("zero valid releases → exit 2", () => {
    const res = runCurrency(BASE_ARGS, { fetchReleases: () => [{ nonsense: true }, { tag_name: 42 }] });
    expect(res.code, res.output).toBe(2);
  });

  test("--behind-days abc → exit 2", () => {
    const res = runCurrency(
      ["--platform-repo", PLATFORM_REPO_SLUG, "--ref", "v0.1.92", "--behind-days", "abc"],
      { fetchReleases: () => [] },
    );
    expect(res.code, res.output).toBe(2);
  });

  test("missing --platform-repo → exit 2", () => {
    const res = runCurrency(["--ref", "v0.1.92"], {});
    expect(res.code, res.output).toBe(2);
  });

  test("an injected fetchReleases that throws → exit 2, and the output never leaks the thrown message", () => {
    const SECRET = "SENSITIVE-API-PAYLOAD-4f9c1a";
    const res = runCurrency(["--platform-repo", PLATFORM_REPO_SLUG, "--ref", "v0.1.92"], {
      fetchReleases: () => {
        throw new Error(SECRET);
      },
    });
    expect(res.code, res.output).toBe(2);
    expect(
      res.output,
      "an arbitrary thrown error's message must never reach the report — it can quote a raw API " +
        "response body",
    ).not.toContain(SECRET);
  });

  test("GITHUB_ACTIONS=true adds the ::error title=cms-platform caller behind:: annotation; absent otherwise", () => {
    const releases = [release({ tag: "v0.1.93", publishedAt: daysAgoIso(22) })];

    const withCI = runCurrency(BASE_ARGS, {
      fetchReleases: () => releases,
      env: { GITHUB_ACTIONS: "true" },
    });
    expect(withCI.code).toBe(1);
    expect(withCI.output).toContain("::error title=cms-platform caller behind::");

    const withoutCI = runCurrency(BASE_ARGS, { fetchReleases: () => releases, env: {} });
    expect(withoutCI.code).toBe(1);
    expect(withoutCI.output).not.toContain("::error");
  });

  test("--releases-file round-trips a JSON file of releases without ever calling fetchReleases", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-platform-currency-"));
    SCRATCH_DIRS.push(dir);
    const file = path.join(dir, "releases.json");
    fs.writeFileSync(
      file,
      JSON.stringify([release({ tag: "v0.1.93", publishedAt: daysAgoIso(5) })]),
    );
    const res = runCurrency(
      ["--platform-repo", PLATFORM_REPO_SLUG, "--ref", "v0.1.93", "--releases-file", file],
      {
        fetchReleases: () => {
          throw new Error("fetchReleases must not be called when --releases-file is given");
        },
      },
    );
    expect(res.code, res.output).toBe(0);
  });
});

test.describe("#424 check-platform-currency.js — pure helper unit coverage", () => {
  test("validateReleases drops structurally malformed entries and keeps well-formed ones", () => {
    const raw = [
      release({ tag: "v0.1.93", publishedAt: daysAgoIso(5) }),
      { tag_name: "v0.1.94" }, // no published_at / draft / prerelease
      { tag_name: 42, published_at: daysAgoIso(1), draft: false, prerelease: false },
      null,
      "not an object",
    ];
    const valid = validateReleases(raw);
    expect(valid.length).toBe(1);
    expect(valid[0].tag_name).toBe("v0.1.93");
  });

  test("assessCurrency returns not-a-release-tag for a non-release ref without needing releases", () => {
    const result = assessCurrency({ ref: "main", releases: [], behindDays: 21, nowMs: NOW_MS });
    expect(result.status).toBe("not-a-release-tag");
    expect(result.pinned).toBeNull();
  });
});

// ── D. The self-caller still passes no platform_ref ────────────────────────
test.describe("#424 self-scheduled-run-health.yml — no platform_ref reintroduced", () => {
  test("the self-caller's with: block never sets platform_ref", () => {
    const selfDoc = workflowDoc(SELF_CALLER);
    const job = ((selfDoc.jobs || {}).audit) || {};
    expect(
      job.with && Object.prototype.hasOwnProperty.call(job.with, "platform_ref"),
      "self-scheduled-run-health.yml must not reintroduce platform_ref — its call at './' " +
        "already resolves to 'main' via the job context",
    ).toBeFalsy();
  });
});
