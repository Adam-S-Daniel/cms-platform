// @lane: local — runs the reusable secrets-scan.yml "Scan for secrets" step
// against a throwaway git repo with a stub gitleaks; no browser, no network.
//
// #1022: a STACKED pull request (base = another PR's branch) is later
// retargeted onto the default branch, which fires only `edited`, an event the
// scan does not run on. The `scan / scan` reported while the base was the
// parent branch is the one that gates the merge, so it must cover the parent
// branch's commits too, not just `base.sha..head`.
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseYaml, readWorkflow } = require("./workflow-yaml-utils");

function scanStepScript() {
  const doc = parseYaml(readWorkflow("secrets-scan.yml"));
  const step = doc.jobs.scan.steps.find((s) => s.name === "Scan for secrets");
  expect(step, "secrets-scan.yml has a `Scan for secrets` step").toBeTruthy();
  return step.run;
}

function git(cwd, ...args) {
  // Ignore the developer's global git config (hooksPath, signing, …).
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd, file) {
  fs.writeFileSync(path.join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

// main: m1 ── parent: p1 ── child: c1. The remote-tracking ref for main is
// what actions/checkout with fetch-depth: 0 leaves behind.
function stackedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-range-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "commit.gpgsign", "false");
  const m1 = commit(dir, "m1");
  git(dir, "update-ref", "refs/remotes/origin/main", m1);
  const p1 = commit(dir, "p1");
  const c1 = commit(dir, "c1");
  const bin = path.join(dir, ".stub-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gitleaks"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
    mode: 0o755,
  });
  return { dir, bin, m1, p1, c1 };
}

function runScan(repo, env) {
  const r = spawnSync("bash", ["-c", scanStepScript()], {
    cwd: repo.dir,
    encoding: "utf8",
    env: { PATH: `${repo.bin}:${process.env.PATH}`, HOME: repo.dir, ...env },
  });
  fs.rmSync(repo.dir, { recursive: true, force: true });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

test.describe("secrets-scan.yml PR scan range (#1022)", () => {
  test("a stacked PR scans from where it left the default branch", () => {
    const repo = stackedRepo();
    const out = runScan(repo, {
      EVENT_NAME: "pull_request",
      BASE_SHA: repo.p1,
      BASE_REF: "parent",
      DEFAULT_BRANCH: "main",
      HEAD_SHA: repo.c1,
    });
    expect(out).toContain(`--log-opts=${repo.m1}..${repo.c1}`);
  });

  test("a PR into the default branch keeps scanning base..head", () => {
    const repo = stackedRepo();
    const out = runScan(repo, {
      EVENT_NAME: "pull_request",
      BASE_SHA: repo.p1,
      BASE_REF: "main",
      DEFAULT_BRANCH: "main",
      HEAD_SHA: repo.c1,
    });
    expect(out).toContain(`--log-opts=${repo.p1}..${repo.c1}`);
  });

  test("a stacked PR with no default-branch ref falls back to a full scan", () => {
    const repo = stackedRepo();
    git(repo.dir, "update-ref", "-d", "refs/remotes/origin/main");
    const out = runScan(repo, {
      EVENT_NAME: "pull_request",
      BASE_SHA: repo.p1,
      BASE_REF: "parent",
      DEFAULT_BRANCH: "main",
      HEAD_SHA: repo.c1,
    });
    expect(out).toContain("Scanning full history");
    expect(out).not.toContain("--log-opts");
  });
});
