// Fetch just enough history for `git diff <remote>/<base>...HEAD` to be
// exact, and PROVE it is enough, instead of checking out full history
// (`fetch-depth: 0`, 14-20 s per job on adamdaniel.ai — cms-platform#541).
//
// What the callers need. Every caller diffs `origin/<base>...HEAD`, i.e. from
// the merge base of the base tip and HEAD to HEAD. On a `pull_request` run
// HEAD is GitHub's merge commit (refs/pull/N/merge, parents: base tip, PR
// head), so the merge base is normally HEAD^1 and only a handful of commits
// are needed. "Normally" is not good enough: a shallow repository can report
// a common ancestor that is NOT the real merge base, because a better one
// sits behind a shallow boundary. The diff from that wrong base can omit a
// file the PR changed (e.g. one the PR reverted to an older version), which
// would let a salient PR read as non-salient.
//
// The proof. Let M be the merge base git computes locally. If no shallow
// boundary commit is reachable from the base tip or HEAD except M itself or
// ancestors of M, then every ancestor of either tip that is not an ancestor
// of M is present with all its parents, so the local graph contains every
// candidate the full graph does, and M is the true merge base. Until that
// holds, the side(s) with an unproven boundary are deepened, doubling each
// round; after `maxRounds` the remaining history is fetched outright
// (`--unshallow`), where the check is trivially true. So the answer is either
// proven exact or the step fails — it is never a silent guess.
//
// A non-shallow repository (a local clone, or a checkout with full history)
// is never converted to a shallow one: it gets a plain fetch of the base.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function defaultGit(cwd) {
  return (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
}

function ensureMergeBase({
  base,
  head = "HEAD",
  remote = "origin",
  cwd = process.cwd(),
  step = 32,
  maxRounds = 6,
  git = defaultGit(cwd),
  log = () => {},
} = {}) {
  if (!base) throw new Error("ensureMergeBase: `base` (the base branch name) is required");
  // A branch name reaches git only as one argv element inside a refspec, so
  // it cannot inject anything; this rejects names git itself would refuse.
  try {
    git(["check-ref-format", `refs/heads/${base}`]);
  } catch {
    throw new Error(`ensureMergeBase: ${JSON.stringify(base)} is not a valid branch name`);
  }
  const tipRef = `refs/remotes/${remote}/${base}`;
  const refspec = `+refs/heads/${base}:${tipRef}`;
  const headSha = git(["rev-parse", "--verify", `${head}^{commit}`]).trim();

  const isShallow = () => git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const tryMergeBase = () => {
    try {
      return git(["merge-base", tipRef, headSha]).trim() || null;
    } catch {
      return null;
    }
  };
  const shallowCommits = () => {
    const file = path.resolve(cwd, git(["rev-parse", "--git-path", "shallow"]).trim());
    if (!fs.existsSync(file)) return new Set();
    return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean));
  };
  // Shallow boundaries reachable from `from` that are neither `mb` nor its
  // ancestors — the commits whose hidden parents could hide a better base.
  const unproven = (mb, from) => {
    const shallow = shallowCommits();
    if (shallow.size === 0) return [];
    const reachable = git(["rev-list", ...from, "--not", mb]).split("\n").filter(Boolean);
    return reachable.filter((c) => shallow.has(c));
  };

  if (!isShallow()) {
    git(["fetch", "--no-tags", remote, refspec]);
    const mb = tryMergeBase();
    if (!mb) throw new Error(`no merge base between ${remote}/${base} and ${headSha}`);
    log(`merge base ${mb} (complete history)`);
    return { mergeBase: mb, rounds: 0, shallow: false };
  }

  git(["fetch", "--no-tags", `--depth=${step}`, remote, refspec]);
  let deepen = step;
  for (let round = 0; ; round += 1) {
    const mb = tryMergeBase();
    let deepenBase = true;
    let deepenHead = true;
    if (mb) {
      const tipSide = unproven(mb, [tipRef]);
      const headSide = unproven(mb, [headSha]);
      if (tipSide.length === 0 && headSide.length === 0) {
        log(`merge base ${mb} proven after ${round} deepen round(s)`);
        return { mergeBase: mb, rounds: round, shallow: isShallow() };
      }
      deepenBase = tipSide.length > 0;
      deepenHead = headSide.length > 0;
    }
    if (!isShallow() || round >= maxRounds) break;
    log(`round ${round + 1}: deepening ${deepenBase ? "base " : ""}${deepenHead ? "head " : ""}by ${deepen}`);
    // One want per fetch: deepening is relative to the boundaries reachable
    // from the wants, and git upload-pack was measured deepening only one
    // side when both were requested together.
    if (deepenBase) git(["fetch", "--no-tags", `--deepen=${deepen}`, remote, refspec]);
    if (deepenHead) git(["fetch", "--no-tags", `--deepen=${deepen}`, remote, headSha]);
    deepen *= 2;
  }

  if (isShallow()) {
    log("bounded deepening did not prove the merge base; fetching the remaining history");
    git(["fetch", "--no-tags", "--unshallow", remote, refspec]);
    if (isShallow()) git(["fetch", "--no-tags", "--unshallow", remote, headSha]);
  }
  const mb = tryMergeBase();
  if (!mb) throw new Error(`no merge base between ${remote}/${base} and ${headSha}`);
  const left = unproven(mb, [tipRef, headSha]);
  if (left.length > 0) {
    throw new Error(`merge base ${mb} could not be proven: shallow boundaries remain at ${left.join(", ")}`);
  }
  log(`merge base ${mb} (history fetched to completion)`);
  return { mergeBase: mb, rounds: maxRounds, shallow: isShallow() };
}

module.exports = { ensureMergeBase };

// CLI, for the workflows:
//   node .cms-platform/e2e/ensure-merge-base.js --base "$BASE"
// Run from the site checkout. Exits non-zero (failing the step closed) when
// the merge base cannot be established.
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const r = ensureMergeBase({
      base: opt("--base"),
      remote: opt("--remote") || "origin",
      log: (m) => process.stderr.write(`[ensure-merge-base] ${m}\n`),
    });
    process.stdout.write(`${r.mergeBase}\n`);
  } catch (e) {
    process.stderr.write(`::error title=ensure-merge-base::${e.message}\n`);
    process.exit(1);
  }
}
