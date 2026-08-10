// @lane: local — pure-fs/exec lint of scripts/set-repo-variables.sh derivations
// + the scaffolder wiring; no network, no gh (every assertion runs --dry-run or
// fails before any gh call). Platform-internal (reads scripts/ + scaffold/ +
// infrastructure/), so it's registered in playwright.config.js PLATFORM_META_SPECS
// and testIgnore'd on consumer lanes.
//
// Why this exists: the repo VARIABLES the reusable workflows read via `vars.*`
// (CMS_APEX, CMS_PROD_URL, PREVIEW_BUCKET, AWS_REGION, plus the two optional
// non-derived passthroughs PROD_PLAYGROUND_MODE and CMS_AUTOMATION_APP_ID) used
// to be set by hand per consumer. set-repo-variables.sh
// centralizes that in the platform and DERIVES every value from the single
// source of truth (infrastructure/site-params.env → APEX_DOMAIN), so a value is
// never typed twice and a consumer can't drift (e.g. PREVIEW_BUCKET that doesn't
// match the apex). These lints lock:
//   (a) the script exists, is executable, and carries a bash shebang;
//   (b) run --dry-run against the shipped site-params.example.env, it derives
//       exactly the expected values from APEX_DOMAIN and makes no gh call;
//   (c) overrides (GITHUB_ORG, RESOURCE_PREFIX) + opt-in PROD_PLAYGROUND_MODE work;
//   (d) it refuses to run without APEX_DOMAIN (no silent half-config);
//   (e) the scaffolder's nextSteps points operators at the script;
//   (f) CMS_AUTOMATION_APP_ID is an opt-in passthrough in BOTH directions — the
//       script pushes it only when set, AND the shipped example env documents the
//       key so an operator can discover it (a passthrough the setter honours but
//       site-params.example.env never mentions is unreachable in practice).
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
    // opt-in only — the example env leaves both COMMENTED, so neither may appear.
    expect(out).not.toMatch(/PROD_PLAYGROUND_MODE/);
    expect(out).not.toMatch(/CMS_AUTOMATION_APP_ID/);
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

  test("(f) CMS_AUTOMATION_APP_ID is an opt-in passthrough, and the example env documents it", () => {
    // Direction 1 — the SCRIPT honours it. Mirrors PROD_PLAYGROUND_MODE exactly:
    // pushed only when the env explicitly sets it, absent otherwise. It is
    // NON-DERIVED (a GitHub App ID, not something APEX_DOMAIN can produce), and
    // its companion CMS_AUTOMATION_APP_PRIVATE_KEY is a SECRET, so the setter
    // must never claim to handle the key half.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setvars-app-"));
    const base = [
      'export GITHUB_REPO="example.com"',
      'export APEX_DOMAIN="example.com"',
    ];
    try {
      const withApp = path.join(dir, "with-app.env");
      fs.writeFileSync(withApp, [...base, 'export CMS_AUTOMATION_APP_ID="123456"', ""].join("\n"));
      const on = run(["--env-file", withApp, "--dry-run"]);
      expect(on.code, on.out).toBe(0);
      expect(on.out).toMatch(/^\s*CMS_AUTOMATION_APP_ID=123456$/m);
      expect(on.out).toMatch(/done \(5 variables\)/);

      const withoutApp = path.join(dir, "without-app.env");
      fs.writeFileSync(withoutApp, [...base, ""].join("\n"));
      const off = run(["--env-file", withoutApp, "--dry-run"]);
      expect(off.code, off.out).toBe(0);
      expect(off.out).not.toMatch(/CMS_AUTOMATION_APP_ID/);
      expect(off.out).toMatch(/done \(4 variables\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // Direction 2 — the shipped EXAMPLE ENV names it (commented, like the other
    // optional knobs), so the passthrough is discoverable rather than a hidden
    // env var only this script knows about.
    const example = fs.readFileSync(EXAMPLE_ENV, "utf8");
    expect(example, "site-params.example.env must document CMS_AUTOMATION_APP_ID").toMatch(
      /CMS_AUTOMATION_APP_ID/,
    );
    expect(
      /#\s*export CMS_AUTOMATION_APP_ID=/.test(example),
      "the example key must stay COMMENTED — it is opt-in, and an uncommented one would push a bogus App ID",
    ).toBe(true);
  });

  test("(e) scaffolder nextSteps points operators at set-repo-variables.sh", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "setvars-scaffold-"));
    try {
      // --platform-ref pins the version so this test never hits the network.
      const out = execFileSync(
        "node",
        [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner", "--platform-ref", "v0.1.52"],
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
