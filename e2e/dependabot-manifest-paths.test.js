// @lane: local — behavioural test of the Dependabot manifest-path allowlist
// against throwaway git repos. No network.
//
// PLATFORM-INTERNAL: runs scripts/check-dependabot-manifest-paths.sh, which a
// consumer does not have. Registered in playwright.config.js
// PLATFORM_META_SPECS.
//
// Locks the allowlist's verdict per changed path, including the pip
// requirements files added for jodidaniel.com#430 and the neighbors that must
// stay refused (pyproject.toml, build scripts, stray .txt files).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { test, expect } = require("./base");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "check-dependabot-manifest-paths.sh");

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// Commit a base file on main, then commit `files` on a branch; return the
// script's exit status for main...HEAD.
function runAllowlist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dependabot-paths-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(dir, "base.md"), "base\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "bump");
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "changed\n");
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "bump");
    return spawnSync("bash", [SCRIPT, "main", "HEAD"], { cwd: dir, encoding: "utf8" }).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ACCEPTED = [
  "scripts/requirements-fonts.txt",
  "requirements.txt",
  "Gemfile.lock",
  "e2e/package-lock.json",
  ".github/workflows/ci.yml",
];
const REJECTED = [
  "scripts/build.py",
  "pyproject.toml",
  "requirements.txt.bak",
  "docs/notes.txt",
  "scripts/requirements-hooks/run.txt",
];

for (const f of ACCEPTED) {
  test(`allowlist accepts ${f}`, () => {
    expect(runAllowlist([f])).toBe(0);
  });
}

for (const f of REJECTED) {
  test(`allowlist rejects ${f}`, () => {
    expect(runAllowlist([f])).toBe(1);
  });
}

test("allowlist rejects a diff mixing an accepted and a refused path", () => {
  expect(runAllowlist(["requirements.txt", "scripts/build.py"])).toBe(1);
});
