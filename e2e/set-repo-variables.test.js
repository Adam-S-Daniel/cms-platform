// @lane: local — pure-fs/exec lint of scripts/set-repo-variables.sh derivations
// + the scaffolder wiring; no network, no gh (every assertion runs --dry-run or
// fails before any gh call). Platform-internal (reads scripts/ + scaffold/ +
// infrastructure/), so it's registered in playwright.config.js PLATFORM_META_SPECS
// and testIgnore'd on consumer lanes.
//
// Why this exists: the five repo VARIABLES the reusable workflows read via
// `vars.*` (CMS_APEX, CMS_PROD_URL, PREVIEW_BUCKET, AWS_REGION, and the optional
// PROD_PLAYGROUND_MODE) used to be set by hand per consumer. set-repo-variables.sh
// centralizes that in the platform and DERIVES every value from the single
// source of truth (infrastructure/site-params.env → APEX_DOMAIN), so a value is
// never typed twice and a consumer can't drift (e.g. PREVIEW_BUCKET that doesn't
// match the apex). These lints lock:
//   (a) the script exists, is executable, and carries a bash shebang;
//   (b) run --dry-run against the shipped site-params.example.env, it derives
//       exactly the expected values from APEX_DOMAIN and makes no gh call;
//   (c) overrides (GITHUB_ORG, RESOURCE_PREFIX) + opt-in PROD_PLAYGROUND_MODE work;
//   (d) it refuses to run without APEX_DOMAIN (no silent half-config);
//   (e) the scaffolder's nextSteps points operators at the script.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "set-repo-variables.sh");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");
const EXAMPLE_ENV = path.join(REPO_ROOT, "infrastructure", "site-params.example.env");

// Run the script via `bash` (so the test doesn't depend on the executable bit)
// with a CLEAN environment — only PATH is carried through, so the only inputs
// are the flags + whatever --env-file sources. Returns { code, out }.
function run(args, env) {
  try {
    const out = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...(env || {}) },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

test.describe("scripts/set-repo-variables.sh", () => {
  test("(a) exists, is executable, bash shebang", () => {
    expect(fs.existsSync(SCRIPT), `missing ${SCRIPT}`).toBe(true);
    const st = fs.statSync(SCRIPT);
    expect(Boolean(st.mode & 0o111), "script must be executable").toBe(true);
    expect(fs.readFileSync(SCRIPT, "utf8").startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  test("(b) derives all four base vars from the shipped example env (dry-run, no gh)", () => {
    const { code, out } = run(["--env-file", EXAMPLE_ENV, "--dry-run"]);
    expect(code, `dry-run should exit 0\n${out}`).toBe(0);
    // example env: APEX_DOMAIN=example.com, GITHUB_REPO=example.com, GITHUB_ORG
    // commented → default Adam-S-Daniel.
    expect(out).toMatch(/target Adam-S-Daniel\/example\.com\s+\(dry-run\)/);
    expect(out).toMatch(/^\s*CMS_APEX=example\.com$/m);
    expect(out).toMatch(/^\s*CMS_PROD_URL=https:\/\/example\.com$/m);
    expect(out).toMatch(/^\s*PREVIEW_BUCKET=example-com-previews$/m);
    expect(out).toMatch(/^\s*AWS_REGION=us-east-1$/m);
    // opt-in only — example env doesn't set it, so it must not appear.
    expect(out).not.toMatch(/PROD_PLAYGROUND_MODE/);
    expect(out).toMatch(/done \(4 variables\)/);
  });

  test("(c) honors GITHUB_ORG/RESOURCE_PREFIX overrides + opt-in PROD_PLAYGROUND_MODE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setvars-"));
    const envFile = path.join(dir, "site-params.env");
    fs.writeFileSync(
      envFile,
      [
        'export GITHUB_REPO="jodidaniel.com"',
        'export GITHUB_ORG="jodidaniel"',
        'export APEX_DOMAIN="jodidaniel.com"',
        'export PROD_PLAYGROUND_MODE="true"',
        "",
      ].join("\n"),
    );
    try {
      const { code, out } = run(["--env-file", envFile, "--dry-run"]);
      expect(code, out).toBe(0);
      expect(out).toMatch(/target jodidaniel\/jodidaniel\.com\s+\(dry-run\)/);
      expect(out).toMatch(/^\s*CMS_APEX=jodidaniel\.com$/m);
      expect(out).toMatch(/^\s*CMS_PROD_URL=https:\/\/jodidaniel\.com$/m);
      expect(out).toMatch(/^\s*PREVIEW_BUCKET=jodidaniel-com-previews$/m);
      expect(out).toMatch(/^\s*PROD_PLAYGROUND_MODE=true$/m);
      expect(out).toMatch(/done \(5 variables\)/);
      // --repo overrides the derived OWNER/REPO.
      const ovr = run(["--env-file", envFile, "--repo", "acme/site", "--dry-run"]);
      expect(ovr.out).toMatch(/target acme\/site\s+\(dry-run\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(d) refuses to run without APEX_DOMAIN (no half-config)", () => {
    // No --env-file and a clean env → APEX_DOMAIN unset → must fail before gh.
    const { code, out } = run(["--dry-run"]);
    expect(code, "must exit non-zero when APEX_DOMAIN is missing").not.toBe(0);
    expect(out).toMatch(/APEX_DOMAIN is required/);
  });

  test("(e) scaffolder nextSteps points operators at set-repo-variables.sh", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "setvars-scaffold-"));
    try {
      const out = execFileSync(
        "node",
        [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner"],
        { encoding: "utf8" },
      );
      expect(out, "nextSteps must reference scripts/set-repo-variables.sh").toMatch(
        /set-repo-variables\.sh/,
      );
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
