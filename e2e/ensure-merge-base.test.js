// @lane: local — real git repos in os.tmpdir(), file:// remotes, no network
//
// cms-platform#541 replaced `fetch-depth: 0` in the visual-regression,
// parity-preview and preview-media salience steps with a shallow checkout plus
// e2e/ensure-merge-base.js. A wrong merge base silently changes the diff those
// steps classify, so every scenario here compares the helper's answer with the
// one a FULL clone gives, on real shallow repositories.
const { test, expect } = require("./base");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createSandbox } = require("./git-fixture");
const { ensureMergeBase } = require("./ensure-merge-base");
const { runDetect } = require("./detect-changed-pages");

// The diff every caller classifies, NUL-split.
function changedFiles(sb, dir, base = "main") {
  return sb
    .git(dir, ["diff", "--name-only", "-z", `origin/${base}...HEAD`])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function commitCount(sb, dir) {
  return sb.git(dir, ["rev-list", "--all", "--count"]).trim();
}

function isShallow(sb, dir) {
  return sb.git(dir, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
}

// The helper's git runs with the sandbox's isolated config.
function run(sb, dir, opts = {}) {
  return ensureMergeBase({ base: "main", cwd: dir, git: (args) => sb.git(dir, args), ...opts });
}

test.describe("ensureMergeBase (cms-platform#541)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  // A GitHub-shaped PR: refs/pull/1/merge is a merge of the base tip (P1)
  // and the PR head; after it was computed, main moved on by `moved`
  // commits, including (when moved > 0) a side branch forked BEFORE P1 and
  // merged AFTER it. 150 older commits sit behind it all, so "did not fetch
  // everything" is observable.
  function mergeRefRepo({ moved = 40 } = {}) {
    sb = createSandbox("emb-merge-ref-");
    const src = sb.initRepo("src");
    sb.emptyCommits(src, 150);
    for (let i = 1; i <= 20; i += 1) sb.commit(src, { "f.txt": `c${i}\n` }, `c${i}`);
    sb.git(src, ["checkout", "-q", "-b", "side", "HEAD~5"]);
    sb.commit(src, { "side.txt": "s1\n" }, "side1");
    sb.commit(src, { "side.txt": "s2\n" }, "side2");
    sb.git(src, ["checkout", "-q", "-b", "pr", "main"]);
    sb.commit(src, { "_layouts/café.html": "pr1\n" }, "pr1");
    sb.commit(src, { "_includes/a b.html": "pr2\n", "_posts/2026-01-01-x.md": "p\n" }, "pr2");
    sb.git(src, ["checkout", "-q", "main"]);
    const p1 = sb.rev(src, "main");
    sb.git(src, ["merge", "-q", "--no-ff", "-m", "merge ref", "pr"]);
    const mergeRef = sb.rev(src, "HEAD");
    sb.git(src, ["update-ref", "refs/pull/1/merge", mergeRef]);
    sb.git(src, ["reset", "-q", "--hard", p1]);
    if (moved > 0) {
      for (let i = 1; i <= 10; i += 1) sb.commit(src, { "f.txt": `m${i}\n` }, `m${i}`);
      sb.git(src, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
      for (let i = 11; i < moved; i += 1) sb.commit(src, { "f.txt": `m${i}\n` }, `m${i}`);
    }
    const url = sb.publish(src);
    return { src, url, p1, mergeRef };
  }

  test("merge ref, base moved past the initial depth: P1 found, history stays shallow", () => {
    const { url, p1, mergeRef } = mergeRefRepo();
    const full = sb.fullClone(url);
    // `git clone` takes refs/heads only; fetch the PR merge ref like checkout does.
    sb.git(full, ["fetch", "-q", "--no-tags", "origin", "+refs/pull/1/merge:refs/remotes/pull/1/merge"]);
    sb.git(full, ["checkout", "-q", "--detach", mergeRef]);
    expect(sb.git(full, ["merge-base", "origin/main", "HEAD"]).trim()).toBe(p1);

    const work = sb.shallowCheckout(url, mergeRef, 2);
    const r = run(sb, work, { step: 8 });
    expect(r.mergeBase).toBe(p1);
    expect(changedFiles(sb, work)).toEqual(changedFiles(sb, full));
    expect(changedFiles(sb, work)).toEqual(
      ["_includes/a b.html", "_layouts/café.html", "_posts/2026-01-01-x.md"].sort(),
    );
    // The point of #541: it did not fetch everything.
    expect(isShallow(sb, work)).toBe(true);
    expect(Number(commitCount(sb, work))).toBeLessThan(Number(commitCount(sb, full)));
  });

  test("merge ref, base unchanged: proven after ONE deepen round of the PR side", () => {
    const { url, p1, mergeRef } = mergeRefRepo({ moved: 0 });
    const work = sb.shallowCheckout(url, mergeRef, 2);
    const r = run(sb, work, { step: 8 });
    expect(r.mergeBase).toBe(p1);
    expect(r.rounds).toBe(1);
    expect(isShallow(sb, work)).toBe(true);
    expect(changedFiles(sb, work)).toEqual(
      ["_includes/a b.html", "_layouts/café.html", "_posts/2026-01-01-x.md"].sort(),
    );
  });

  test("merge base far behind a depth-1 PR-head checkout is found (head side deepened)", () => {
    sb = createSandbox("emb-head-");
    const src = sb.initRepo("src");
    for (let i = 1; i <= 10; i += 1) sb.commit(src, { "f.txt": `c${i}\n` }, `c${i}`);
    const fork = sb.rev(src, "main");
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    for (let i = 1; i <= 25; i += 1) sb.commit(src, { [`_data/d${i}.yml`]: `${i}\n` }, `pr${i}`);
    const head = sb.rev(src, "pr");
    sb.git(src, ["checkout", "-q", "main"]);
    for (let i = 11; i <= 15; i += 1) sb.commit(src, { "f.txt": `c${i}\n` }, `c${i}`);
    const url = sb.publish(src);
    const full = sb.fullClone(url);
    sb.git(full, ["checkout", "-q", "--detach", head]);

    const work = sb.shallowCheckout(url, head, 1);
    const r = run(sb, work, { step: 2 });
    expect(r.mergeBase).toBe(fork);
    expect(r.rounds).toBeGreaterThan(0);
    expect(changedFiles(sb, work)).toEqual(changedFiles(sb, full));
    expect(changedFiles(sb, work)).toHaveLength(25);
  });

  test("a shallow-hidden better merge base is found, not the stale ancestor git reports first", () => {
    // Full graph:   R - X - Y - B          (B = HEAD, the PR)
    //                    \   \
    //                     a1  a3 - a2
    //                      \       \
    //                       +------ A      (A = main tip, merges a1 and a2)
    // True merge base of A and B is Y. Fetch A at depth 3 and B at depth 3
    // and the local graph loses Y on A's side (a3 is a boundary), so plain
    // `git merge-base` answers X. Y changed the layout and B changed it
    // BACK: the true diff Y..B contains the layout, the stale X..B does not
    // — a salient PR that the naive answer reads as non-salient.
    sb = createSandbox("emb-hidden-");
    const src = sb.initRepo("src");
    sb.commit(src, { "README.md": "r\n" }, "R");
    const x = sb.commit(src, { "_layouts/default.html": "v1\n" }, "X");
    const y = sb.commit(src, { "_layouts/default.html": "v2\n" }, "Y");
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    const b = sb.commit(src, { "_layouts/default.html": "v1\n", "_posts/2026-01-01-p.md": "p\n" }, "B");
    sb.git(src, ["checkout", "-q", "-b", "a2branch", y]);
    sb.commit(src, { "a3.txt": "a3\n" }, "a3");
    sb.commit(src, { "a2.txt": "a2\n" }, "a2");
    sb.git(src, ["checkout", "-q", "-b", "a1branch", x]);
    sb.commit(src, { "a1.txt": "a1\n" }, "a1");
    sb.git(src, ["merge", "-q", "--no-ff", "-m", "A", "a2branch"]);
    sb.git(src, ["branch", "-q", "-f", "main", "HEAD"]);
    sb.git(src, ["checkout", "-q", "main"]);
    const url = sb.publish(src);

    const work = sb.shallowCheckout(url, b, 3);
    sb.git(work, ["fetch", "-q", "--no-tags", "--depth=3", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    // The trap is real on this git: the local answer is the stale X.
    expect(sb.git(work, ["merge-base", "origin/main", "HEAD"]).trim()).toBe(x);
    expect(changedFiles(sb, work)).toEqual(["_posts/2026-01-01-p.md"]);

    const r = run(sb, work, { step: 3 });
    expect(r.mergeBase).toBe(y);
    expect(changedFiles(sb, work)).toEqual(["_layouts/default.html", "_posts/2026-01-01-p.md"]);
  });

  test("a complete clone is never made shallow", () => {
    const { url, p1, mergeRef } = mergeRefRepo();
    const full = sb.fullClone(url);
    // `git clone` takes refs/heads only; fetch the PR merge ref like checkout does.
    sb.git(full, ["fetch", "-q", "--no-tags", "origin", "+refs/pull/1/merge:refs/remotes/pull/1/merge"]);
    sb.git(full, ["checkout", "-q", "--detach", mergeRef]);
    const before = commitCount(sb, full);
    const r = run(sb, full);
    expect(r).toEqual({ mergeBase: p1, rounds: 0, shallow: false });
    expect(isShallow(sb, full)).toBe(false);
    expect(commitCount(sb, full)).toBe(before);
  });

  test("unrelated histories fail loudly after fetching everything", () => {
    sb = createSandbox("emb-unrelated-");
    const src = sb.initRepo("src");
    for (let i = 1; i <= 6; i += 1) sb.commit(src, { "f.txt": `c${i}\n` }, `c${i}`);
    sb.git(src, ["checkout", "-q", "--orphan", "other"]);
    for (let i = 1; i <= 6; i += 1) sb.commit(src, { "g.txt": `o${i}\n` }, `o${i}`);
    const other = sb.rev(src, "other");
    sb.git(src, ["checkout", "-q", "main"]);
    const url = sb.publish(src);
    const work = sb.shallowCheckout(url, other, 1);
    expect(() => run(sb, work, { step: 1, maxRounds: 2 })).toThrow(/no merge base/);
    expect(isShallow(sb, work)).toBe(false);
  });

  test("rejects a base that is not a valid branch name", () => {
    sb = createSandbox("emb-badref-");
    const src = sb.initRepo("src");
    sb.commit(src, { "f.txt": "1\n" }, "c1");
    expect(() => run(sb, src, { base: "bad..name" })).toThrow(/not a valid branch name/);
    expect(() => run(sb, src, { base: "" })).toThrow(/required/);
  });
});

test.describe("ensureMergeBase fails closed on a shallow remote (cms-platform#541)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  // The proof's last line of defense. When even `--unshallow` leaves a
  // shallow boundary the merge base does not cover, the helper must throw
  // rather than hand back a base it cannot prove. That happens when the
  // REMOTE is itself shallow: T = merge(B, S) with S a side chain, and H a
  // child of B. The merge base is B, but S's parents are hidden at the
  // remote, so nothing fetched can show they do not hide a better one.
  test("a remote that cannot supply the hidden history throws instead of guessing", () => {
    sb = createSandbox("emb-shallow-remote-");
    const src = sb.initRepo("src");
    sb.commit(src, { "f.txt": "r\n" }, "root");
    sb.git(src, ["checkout", "-q", "-b", "side"]);
    sb.commit(src, { "s.txt": "1\n" }, "s1");
    sb.commit(src, { "s.txt": "2\n" }, "s2");
    sb.git(src, ["checkout", "-q", "main"]);
    sb.commit(src, { "f.txt": "b\n" }, "B");
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    const head = sb.commit(src, { "pr.txt": "h\n" }, "H");
    sb.git(src, ["checkout", "-q", "main"]);
    sb.git(src, ["merge", "-q", "--no-ff", "-m", "T", "side"]);

    // The shallow remote: depth 2 from every branch tip.
    const shallowRemote = path.join(sb.root, "shallow-remote");
    sb.git(sb.root, ["clone", "-q", "--no-tags", "--depth=2", "--no-single-branch", sb.publish(src), shallowRemote]);
    sb.git(shallowRemote, ["branch", "pr", "origin/pr"]);

    const work = sb.shallowCheckout(`file://${shallowRemote}`, head, 1);
    expect(() => ensureMergeBase({ base: "main", cwd: work, step: 2, git: (args) => sb.git(work, args) })).toThrow(
      /could not be proven: shallow boundaries remain/,
    );
  });
});

// The workflows run the CLI block, not the function, so the exit status and
// the `--base` plumbing are what a required check actually depends on. These
// spawn `node e2e/ensure-merge-base.js` against local repos (a bare mirror
// served over file:// and a `--depth 1` checkout of it); no network.
test.describe("ensure-merge-base.js CLI (cms-platform#541)", () => {
  const CLI = path.join(__dirname, "ensure-merge-base.js");
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  // main: c0..c3. `release` forks at c1 (r1), and the PR head sits on r1, so
  // its merge base is c1 against main but r1 against release.
  function setup() {
    sb = createSandbox("emb-cli-");
    const src = sb.initRepo("src");
    sb.commit(src, { "f.txt": "0\n" }, "c0");
    const c1 = sb.commit(src, { "f.txt": "1\n" }, "c1");
    sb.commit(src, { "f.txt": "2\n" }, "c2");
    sb.commit(src, { "f.txt": "3\n" }, "c3");
    sb.git(src, ["checkout", "-q", "-b", "release", c1]);
    const r1 = sb.commit(src, { "r.txt": "r\n" }, "r1");
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    const head = sb.commit(src, { "pr.txt": "p\n" }, "p1");
    const work = sb.shallowCheckout(sb.publish(src), head, 1);
    return { c1, r1, work };
  }

  const cli = (cwd, args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: sb.env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  test("success: exit 0 and the proven merge base on stdout", () => {
    const { c1, work } = setup();
    const r = cli(work, ["--base", "main"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${c1}\n`);
  });

  test("the base is the one named by --base, not a default", () => {
    const { r1, c1, work } = setup();
    const r = cli(work, ["--base", "release"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${r1}\n`);
    expect(r1).not.toBe(c1);
  });

  test("--remote names the remote to fetch from", () => {
    const { c1, work } = setup();
    sb.git(work, ["remote", "rename", "origin", "upstream"]);
    expect(cli(work, ["--base", "main"]).status, "origin no longer exists").toBe(1);
    const r = cli(work, ["--base", "main", "--remote", "upstream"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${c1}\n`);
  });

  test("a failing fetch exits 1 with an ::error line and nothing on stdout", () => {
    const { work } = setup();
    const r = cli(work, ["--base", "no-such-branch"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^::error title=ensure-merge-base::/m);
    expect(r.stdout).toBe("");
  });

  test("a missing --base exits 1 with an ::error line", () => {
    const { work } = setup();
    const r = cli(work, []);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^::error title=ensure-merge-base::.*`base`/m);
    expect(r.stdout).toBe("");
  });
});

test.describe("detect-changed-pages on a shallow merge-ref checkout (cms-platform#541)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  test("classifies exactly as on a full clone, without fetching full history", () => {
    sb = createSandbox("emb-detect-");
    const src = sb.initRepo("src");
    sb.emptyCommits(src, 150);
    sb.commit(
      src,
      { "_includes/en-tête.html": "<header></header>\n", "_posts/2026-01-01-old.md": "old\n" },
      "site",
    );
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    sb.commit(src, { "_includes/en-tête.html": "<header>new</header>\n" }, "pr1");
    sb.commit(src, { "_posts/2026-02-01-café.md": "new\n" }, "pr2");
    sb.git(src, ["checkout", "-q", "main"]);
    const p1 = sb.rev(src, "main");
    sb.git(src, ["merge", "-q", "--no-ff", "-m", "merge ref", "pr"]);
    const mergeRef = sb.rev(src, "HEAD");
    sb.git(src, ["update-ref", "refs/pull/1/merge", mergeRef]);
    sb.git(src, ["reset", "-q", "--hard", p1]);
    for (let i = 1; i <= 45; i += 1) sb.commit(src, { "f.txt": `m${i}\n` }, `m${i}`);
    const url = sb.publish(src);

    const pages = () => new Set(["/", "/blog/", "/blog/old/", "/blog/café/"]);
    const full = sb.fullClone(url);
    sb.git(full, ["fetch", "-q", "--no-tags", "origin", "+refs/pull/1/merge:refs/remotes/pull/1/merge"]);
    sb.git(full, ["checkout", "-q", "--detach", mergeRef]);
    const work = sb.shallowCheckout(url, mergeRef, 2);

    const expected = { changed: ["/", "/blog/", "/blog/old/"], new: ["/blog/café/"], unchanged: [] };
    expect(runDetect({ root: full, runDiscover: pages })).toEqual(expected);
    expect(runDetect({ root: work, runDiscover: pages })).toEqual(expected);
    expect(isShallow(sb, work)).toBe(true);
  });
});
