// Throwaway local git repositories for tests that must exercise REAL git
// behavior (path quoting, shallow history, merge bases) rather than a stub.
//
// Deterministic and offline: every repo lives under os.tmpdir(), remotes are
// `file://` URLs, the user's and system git config are ignored, and commit
// dates come from a counter instead of the wall clock.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createSandbox(prefix = "git-fixture-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  let tick = 0;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };

  // Run git in `cwd`; returns raw stdout (untrimmed — `-z` output matters).
  function git(cwd, args, opts = {}) {
    tick += 1;
    const date = `${1700000000 + tick} +0000`;
    return execFileSync("git", args, {
      cwd,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
  }

  function rev(cwd, ref) {
    return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  }

  // An empty non-bare repo whose first branch is `main`.
  function initRepo(name) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    return dir;
  }

  // Write (string) or delete (null) each path, then commit everything.
  function commit(dir, files, message) {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      if (content === null) {
        fs.rmSync(full, { force: true });
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
    return rev(dir, "HEAD");
  }

  // `n` empty commits: cheap history depth behind a scenario.
  function emptyCommits(dir, n, label = "old") {
    for (let i = 1; i <= n; i += 1) git(dir, ["commit", "-q", "--allow-empty", "-m", `${label}${i}`]);
    return rev(dir, "HEAD");
  }

  // A bare mirror of `srcDir` (every ref, including refs/pull/*), served to
  // clones over file:// so shallow fetches behave as they do from a server.
  function publish(srcDir, name = "origin.git") {
    const dir = path.join(root, name);
    git(root, ["clone", "-q", "--mirror", srcDir, dir]);
    return `file://${dir}`;
  }

  // What actions/checkout does for `fetch-depth: N`: an empty repo, a
  // depth-limited fetch of one commit, and a detached checkout of it.
  function shallowCheckout(url, sha, depth, name = "work") {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, ["init", "-q"]);
    git(dir, ["remote", "add", "origin", url]);
    git(dir, ["fetch", "-q", "--no-tags", `--depth=${depth}`, "origin", `+${sha}:refs/remotes/checkout/head`]);
    git(dir, ["checkout", "-q", "--detach", sha]);
    return dir;
  }

  function fullClone(url, name = "full") {
    const dir = path.join(root, name);
    git(root, ["clone", "-q", "--no-tags", url, dir]);
    return dir;
  }

  function cleanup() {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { root, env, git, rev, initRepo, commit, emptyCommits, publish, shallowCheckout, fullClone, cleanup };
}

module.exports = { createSandbox };
