// @lane: local — pure-fs lint of workflow YAML; no browser, no network
/*
 * Regression guard for #22: the prod-mutating loop reusables leak
 * ephemeral `cms/*` canary branches when a cycle cancels/fails mid-flight
 * (~35 accumulated on adamdaniel). Each loop reusable must run an
 * `if: always()` cleanup step that deletes its own ephemeral canary
 * branch(es) on completion AND on cancel/failure, idempotently and
 * FAIL-OPEN (a cleanup failure must NOT fail the loop). The daily
 * sweep-stale-cms-prs.yml must additionally prune merged/closed
 * cms/(e2e|e2e-fixture)/* and cms/posts/2099-*-e2e-* branches that have no
 * open PR.
 *
 * Parsed with the `yaml` lib (anchors) per AGENTS.md — never regex over
 * raw text for structure.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, jobs } = require("./workflow-yaml-utils");

// workflow → heavy loop job name + the branch glob(s) it must clean up.
// The spec runId is `Date.now()`, so the workflow can't know the exact
// branch — a pattern-delete scoped to the loop's own ephemeral prefix
// with no open PR is the sanctioned approach (#22).
const LOOPS = {
  "cms-publish-loop-prod.yml": {
    job: "prod-mutate",
    patterns: ["cms/posts/2099-12-31-e2e-prod-mutate-"],
  },
  "cms-media-roundtrip.yml": {
    job: "media-roundtrip",
    patterns: ["cms/posts/2099-12-31-e2e-media-roundtrip-"],
  },
  "cms-publish-loop-host.yml": {
    job: "host-loop",
    patterns: ["cms/e2e/canary-", "cms/e2e-fixture/"],
  },
  // #224. Its ephemeral BRANCH prefix is the one the REAL scheduler
  // (publish-scheduled-posts.yml) pushes for genuine editor-scheduled posts,
  // so unlike the two loops above it must NEVER be added to the sweep's
  // TEST_ONLY_PATTERNS — that would let the daily sweep close a real
  // queued-content PR and delete its branch. Its own `if: always()` cleanup
  // (which skips any branch with an open PR) is the whole defence, which is
  // exactly why it needs linting here.
  "cms-scheduled-publish-loop.yml": {
    job: "scheduled-publish-loop",
    patterns: ["cms/posts/scheduled-publish-"],
  },
};
const LOOP_WORKFLOWS = Object.keys(LOOPS);

// A cleanup step's branch prefix can live in the run: script OR in the
// step's env: block (parameterised). Search both.
function stepText(step) {
  const envVals = Object.values((step && step.env) || {}).map(String);
  return [String((step && step.run) || ""), ...envVals].join("\n");
}

// A step is the branch-cleanup step if its name calls it out.
const CLEANUP_NAME_RE = /clean ?up.*(canary|ephemeral).*branch|ephemeral.*branch.*clean/i;

function findCleanupStep(steps) {
  return (steps || []).find((s) => s && typeof s.name === "string" && CLEANUP_NAME_RE.test(s.name));
}

test.describe("loop reusables clean up ephemeral canary branches (#22)", () => {
  test("each loop job has an `if: always()` branch-cleanup step", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      expect(loopJob, `${wf} must define job ${LOOPS[wf].job}`).toBeTruthy();
      const step = findCleanupStep(loopJob.steps);
      expect(
        step,
        `${wf}: ${LOOPS[wf].job} must have a branch-cleanup step (name ~ "Clean up ephemeral canary branch(es)") — #22`,
      ).toBeTruthy();
      // Must run on completion AND cancel/failure: `if: always()` (or an
      // expression that includes always()).
      const ifExpr = String(step.if || "");
      expect(
        ifExpr,
        `${wf}: the branch-cleanup step must be \`if: always()\` so it runs on success, failure AND cancellation (#22)`,
      ).toMatch(/always\(\)/);
    }
  });

  test("the cleanup step is FAIL-OPEN (continue-on-error + guarded deletes)", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      const step = findCleanupStep(loopJob.steps);
      expect(step, `${wf}: cleanup step must exist`).toBeTruthy();
      // continue-on-error so a non-zero exit never reds the loop.
      expect(
        step["continue-on-error"],
        `${wf}: the branch-cleanup step must be continue-on-error (fail-open) — a cleanup failure must NOT fail the loop (#22)`,
      ).toBe(true);
      const run = String(step.run || "");
      expect(run, `${wf}: cleanup step must be a run: script`).toBeTruthy();
      // Idempotent + fail-open at the shell level too: deletes guarded
      // with `|| true` (or `|| echo`) so a missing/already-gone branch is
      // a no-op, never an error.
      expect(
        run,
        `${wf}: each branch delete must be guarded (\`|| true\`/\`|| echo\`) so a missing branch is a no-op (#22)`,
      ).toMatch(/\|\|\s*(true|echo)/);
      // Must NOT `set -e` without a guard that would propagate a delete
      // failure — if it sets -e it must also continue-on-error (asserted
      // above) AND guard the deletes (asserted above). Belt-and-braces:
      // the delete itself must tolerate failure.
      expect(
        run,
        `${wf}: cleanup must delete refs via the git refs API or \`gh\``,
      ).toMatch(/git\/refs\/heads|gh api .*git\/refs|gh api -X DELETE/);
    }
  });

  test("the cleanup deletes ONLY this loop's own ephemeral branch pattern(s)", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      const step = findCleanupStep(loopJob.steps);
      const text = stepText(step);
      for (const pat of LOOPS[wf].patterns) {
        expect(
          text,
          `${wf}: cleanup must scope to its own branch pattern "${pat}" (#22)`,
        ).toContain(pat);
      }
      // Safety: never delete an unrelated cms/ prefix. The host loop owns
      // cms/e2e* + cms/e2e-fixture*; the post loops own cms/posts/2099-*.
      // Assert a _posts_ loop's cleanup does NOT touch cms/e2e* branches.
      if (LOOPS[wf].job !== "host-loop") {
        expect(
          text,
          `${wf}: a _posts_ loop must NOT touch cms/e2e* branches`,
        ).not.toMatch(/cms\/e2e\b/);
      }
    }
  });

  test("the cleanup only deletes branches with NO open PR (scoped + safe)", () => {
    for (const wf of LOOP_WORKFLOWS) {
      const doc = parseYaml(readWorkflow(wf));
      const loopJob = doc.jobs[LOOPS[wf].job];
      const step = findCleanupStep(loopJob.steps);
      const run = String((step && step.run) || "");
      // It must consult open PRs for the branch before deleting (a branch
      // with an in-flight PR could still be a live cycle / a real draft).
      expect(
        run,
        `${wf}: cleanup must check for an open PR on the branch before deleting it (#22)`,
      ).toMatch(/pulls\?|pr list|--state open|state=open/);
    }
  });
});

test.describe("sweep-stale-cms-prs prunes orphaned canary BRANCHES (#22)", () => {
  const SWEEP = "sweep-stale-cms-prs.yml";

  // The orphan-BRANCH prune step is the one that deletes a branch ref via
  // `git/refs/heads/${branch}`. (Distinct from the file sweeps, which DELETE
  // contents paths.) #22 extends it to cover the ephemeral prod-loop post
  // branches the create/media loops force-push.
  function findBranchPruneStep(sweepJob) {
    return (sweepJob.steps || []).find((s) =>
      /git\/refs\/heads\/\$\{?branch/.test(String((s && s.run) || "")),
    );
  }

  test("the sweep deletes orphaned cms/posts/2099-*-e2e-* BRANCHES with no open PR", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    expect(sweepJob, `${SWEEP} must define the sweep job`).toBeTruthy();
    // The existing sweep prunes _posts/ FILES and cms/e2e* / cms/e2e-fixture*
    // BRANCHES, but NOT the ephemeral cms/posts/2099-*-e2e-* BRANCHES the
    // prod-mutate/media loops force-push. #22 needs the BRANCH prune to cover
    // those too — assert the orphan-branch prune step's prefix safelist
    // includes the prod-loop post-branch prefixes.
    const step = findBranchPruneStep(sweepJob);
    expect(
      step,
      `${SWEEP} must have an orphan-branch prune step (deletes git/refs/heads/<branch>)`,
    ).toBeTruthy();
    // Match against FUNCTIONAL lines only — strip full-line and inline `#`
    // comments so an explanatory comment that merely mentions a prefix can't
    // satisfy the assertion while the actual TEST_ONLY_PATTERNS array entry is
    // missing (de-tautologized per the #22 adversarial review).
    const run = String(step.run)
      .split("\n")
      .map((l) => l.replace(/\s#.*$/, ""))
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(
      run,
      `${SWEEP}: the orphan-branch prune must include cms/posts/2099-*-e2e-prod-mutate-* (#22)`,
    ).toMatch(/cms\/posts\/2099-.*e2e-prod-mutate|2099-12-31-e2e-prod-mutate-/);
    expect(
      run,
      `${SWEEP}: the orphan-branch prune must include cms/posts/2099-*-e2e-media-roundtrip-* (#22)`,
    ).toMatch(/cms\/posts\/2099-.*e2e-media-roundtrip|2099-12-31-e2e-media-roundtrip-/);
  });

  test("the cms/(e2e|e2e-fixture)/* orphan-branch prune is present (Tier 3 retained/extended)", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    const runText = (sweepJob.steps || [])
      .map((s) => String((s && s.run) || ""))
      .join("\n");
    expect(runText, `${SWEEP} must still prune cms/e2e/ orphan branches`).toContain("cms/e2e/");
    expect(runText, `${SWEEP} must still prune cms/e2e-fixture/ orphan branches`).toContain(
      "cms/e2e-fixture/",
    );
  });

  test("the orphan-branch prune (incl. prod-loop) is fail-open", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    const step = findBranchPruneStep(sweepJob);
    expect(step, `${SWEEP} must have an orphan-branch prune step`).toBeTruthy();
    expect(
      String(step.run),
      `${SWEEP}: the orphan-branch ref delete must be guarded fail-open (\`|| echo\`/\`|| true\`)`,
    ).toMatch(/\|\|\s*(echo|true)/);
  });

  test("ALL loop workflows + the sweep referenced by the cleanup lints exist", () => {
    // Sanity: the YAML this suite asserts on is real.
    for (const wf of [...LOOP_WORKFLOWS, SWEEP]) {
      expect(() => parseYaml(readWorkflow(wf)), `${wf} must parse`).not.toThrow();
    }
    // jobs() helper sanity — at least the loop job + sweep job resolve.
    for (const wf of LOOP_WORKFLOWS) {
      const names = jobs(readWorkflow(wf)).map((j) => j.name);
      expect(names, `${wf} must contain ${LOOPS[wf].job}`).toContain(LOOPS[wf].job);
    }
  });
});

// ── The ephemeral `_posts/` CONTENT sweep (#224) ──────────────────────────────
// Distinct from the orphan-BRANCH prune above: this is the tier that DELETEs
// orphaned per-run post FILES left on main by a loop that died before its own
// existence-only-delete cleanup. Nothing linted it, and the scheduled-publish
// loop was absent from it for its entire life — an orphan from a 2026-07-31 run
// sat on adamdaniel.ai's `main` for 8 days, publicly reachable at its /blog/
// URL, with nothing in the fleet that would ever collect it.
test.describe("sweep-stale-cms-prs reaps ephemeral `_posts/` orphans (#224)", () => {
  const SWEEP = "sweep-stale-cms-prs.yml";

  // Every loop that creates an EPHEMERAL, uniquely-named per-run `_posts/`
  // entry. Add a row when a new loop does — the sweep must list its prefix or
  // its crashed runs leak forever.
  const EPHEMERAL_POST_PREFIXES = [
    "2099-12-31-e2e-prod-mutate-",
    "2099-12-31-e2e-media-roundtrip-",
    "2099-12-31-e2e-scheduled-publish-",
  ];

  // The content-sweep step is the one that LISTS `_posts` via the contents API.
  function findPostSweepStep(sweepJob) {
    return (sweepJob.steps || []).find((s) => /contents\/_posts/.test(String((s && s.run) || "")));
  }

  // Strip full-line and inline `#` comments so an explanatory comment that
  // merely mentions a prefix can't satisfy the assertion while the actual
  // jq `startswith(...)` filter is missing — same de-tautologization the
  // orphan-branch assertions use. Load-bearing here: the step's own header
  // comment names all three prefixes in prose.
  function functionalRun(step) {
    return String(step.run)
      .split("\n")
      .map((l) => l.replace(/\s#.*$/, ""))
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  }

  test("the content sweep lists EVERY ephemeral per-run post prefix", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    const step = findPostSweepStep(sweepJob);
    expect(step, `${SWEEP} must have a step that lists _posts via the contents API`).toBeTruthy();
    const run = functionalRun(step);
    for (const prefix of EPHEMERAL_POST_PREFIXES) {
      expect(
        run,
        `${SWEEP}: the \`_posts/\` content sweep must select ${prefix}* — a loop whose ` +
          `prefix is missing here leaks an orphan on main forever (#224)`,
      ).toContain(prefix);
    }
  });

  test("the content listings tolerate a consumer with no `_posts/` (or uploads) directory", () => {
    // GitHub's contents API 404s a missing directory, and `gh api` relays the
    // error BODY to stdout — so the fallback MUST sit outside the command
    // substitution (`… ) || files=""`), not inside it (#127/#130). This is also
    // what makes a consumer with no `_posts/` today (jodidaniel.com, a
    // single-page bio) start benefiting automatically the moment it grows one:
    // no per-consumer configuration, the listing simply starts returning paths.
    const doc = parseYaml(readWorkflow(SWEEP));
    const step = findPostSweepStep(doc.jobs.sweep);
    const run = functionalRun(step);
    for (const varName of ["post_files", "upload_files"]) {
      expect(
        run,
        `${SWEEP}: \`${varName}\` must fall back OUTSIDE the command substitution ` +
          `(\`) || ${varName}=""\`) so a missing directory yields empty, not an error body (#130)`,
      ).toMatch(new RegExp(`\\)\\s*\\|\\|\\s*${varName}=""`));
    }
  });
});

// ── Retiring stale scheduled-publish PRs that only flip loop fixtures ────────
//
// adamdaniel.ai's cms-scheduled-publish-loop failed daily from 2026-09-08
// (adamdaniel.ai #3589 / issue #3591): a required check went red on the
// scheduler's `cms/posts/scheduled-publish-<run_id>` PR for an unrelated
// reason, it never merged, and two days later the ephemeral `_posts/` sweep
// above deleted the PR's only fixture file from main — turning it into a
// permanent modify/delete CONFLICTING PR that nothing ever retired. Because
// `cms/posts/scheduled-publish-` is also the REAL scheduler's prefix for
// genuine editor-scheduled posts (see the NOTE on the `_posts/` orphan sweep
// step), it can never join TEST_ONLY_PATTERNS — a new step instead classifies
// by DIFF CONTENT: a PR is retirable only when every changed file matches the
// loop's own per-run fixture shape.
//
// These tests EXECUTE the step's real `run:` script (extracted from the
// parsed workflow, never re-typed) via `bash -c`, with a stub `gh` first on
// PATH — mirrors the ghStubDir technique in scheduled-run-health.test.js
// (around lines 899-935), extended here to also answer `gh pr list` and log
// `gh pr close`. No network, no sleeps: "old" vs "young" is a fixed past ISO
// timestamp vs. now-minus-1-hour computed at test time.
test.describe("sweep-stale-cms-prs retires stale scheduled-publish PRs by diff content", () => {
  const SWEEP = "sweep-stale-cms-prs.yml";
  const RETIRE_STEP_NAME = "Retire stale scheduled-publish PRs that only flip loop fixtures";
  const THRESHOLD_HOURS = 6;
  const OLD_ISO = "2020-01-01T00:00:00Z";
  // 1h old — younger than the 6h threshold.
  const youngIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

  function retireStep() {
    const doc = parseYaml(readWorkflow(SWEEP));
    const sweepJob = doc.jobs.sweep;
    const step = (sweepJob.steps || []).find((s) => s && s.name === RETIRE_STEP_NAME);
    return step;
  }

  // A `gh` stub answering exactly the three calls this step makes:
  // `pr list` (canned PRs, one compact JSON line each — matching gh's real
  // `--jq` output, which is compact-per-result, not pretty-printed jq(1)
  // default), `api .../pulls/<n>/files` (canned filenames, one per line, or a
  // forced non-zero-exit "Not Found" body written to STDOUT — real `gh api`
  // relays an HTTP error body to stdout on failure, which is exactly the
  // #130 trap the step's `|| files=""` guards against), and `pr close`
  // (logged only).
  function ghStubDir({ prs, files }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-retire-stub-"));
    const log = path.join(dir, "calls.jsonl");
    const cfgFile = path.join(dir, "cfg.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ prs, files }));
    const bin = path.join(dir, "gh");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgFile)}, "utf8"));

if (argv[0] === "pr" && argv[1] === "list") {
  for (const pr of cfg.prs) {
    process.stdout.write(JSON.stringify(pr) + "\\n");
  }
  process.exit(0);
}

if (argv[0] === "api") {
  const endpoint = argv[1] || "";
  const m = endpoint.match(/pulls\\/(\\d+)\\/files/);
  if (m) {
    const entry = cfg.files[m[1]];
    if (entry === undefined || entry === null) {
      // Emulates a real 404: gh relays the error body to STDOUT and exits
      // non-zero (#130) — never an empty stdout with a clean exit.
      process.stdout.write(JSON.stringify({ message: "Not Found" }));
      process.exit(1);
    }
    process.stdout.write(entry);
    process.exit(0);
  }
  console.error("gh stub: no api route for " + endpoint);
  process.exit(1);
}

if (argv[0] === "pr" && argv[1] === "close") {
  process.exit(0);
}

console.error("gh stub: no route for " + argv.join(" "));
process.exit(1);
`,
    );
    fs.chmodSync(bin, 0o755);
    return { dir, log };
  }

  function callsOf(log) {
    if (!fs.existsSync(log)) return [];
    return fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  // `gh pr close "$num" --delete-branch --comment "..."` → argv[2] is the
  // PR number being closed.
  function closedPrNumbers(log) {
    return callsOf(log)
      .filter((argv) => argv[0] === "pr" && argv[1] === "close")
      .map((argv) => argv[2]);
  }

  function deletedBranch(log, num) {
    return callsOf(log).some(
      (argv) =>
        argv[0] === "pr" &&
        argv[1] === "close" &&
        argv[2] === num &&
        argv.includes("--delete-branch"),
    );
  }

  function runRetireStep({ dryRun, stubDir }) {
    const step = retireStep();
    expect(step, `${SWEEP} must have a step named "${RETIRE_STEP_NAME}"`).toBeTruthy();
    const script = String((step && step.run) || "");
    expect(script, `${RETIRE_STEP_NAME} must be a run: script`).toBeTruthy();
    const res = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
        GH_TOKEN: "stub-token",
        GH_REPO: "o/r",
        DRY_RUN: dryRun,
        THRESHOLD_HOURS: String(THRESHOLD_HOURS),
      },
    });
    return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
  }

  function pr({ number, headRefName, createdAt, labels = [] }) {
    return { number, headRefName, createdAt, labels: labels.map((name) => ({ name })) };
  }

  const FIXTURE_ONLY = "_posts/2099-12-31-e2e-scheduled-publish-1788859173294.md";
  const REAL_POST = "_posts/2026-10-01-real-post.md";

  test("(a) old PR, fixture-only diff → closed with --delete-branch", () => {
    const num = "101";
    const { dir, log } = ghStubDir({
      prs: [
        pr({
          number: 101,
          headRefName: "cms/posts/scheduled-publish-1788859173294",
          createdAt: OLD_ISO,
        }),
      ],
      files: { [num]: `${FIXTURE_ONLY}\n` },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "false", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([num]);
      expect(deletedBranch(log, num)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(b) old PR, fixture + real post → NOT closed (mixed content)", () => {
    const num = "102";
    const { dir, log } = ghStubDir({
      prs: [
        pr({ number: 102, headRefName: "cms/posts/scheduled-publish-abc", createdAt: OLD_ISO }),
      ],
      files: { [num]: `${FIXTURE_ONLY}\n${REAL_POST}\n` },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "false", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(c) old PR, real post only → NOT closed", () => {
    const num = "103";
    const { dir, log } = ghStubDir({
      prs: [
        pr({ number: 103, headRefName: "cms/posts/scheduled-publish-def", createdAt: OLD_ISO }),
      ],
      files: { [num]: `${REAL_POST}\n` },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "false", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(d) young PR, fixture-only → NOT closed (too new)", () => {
    const num = "104";
    const { dir, log } = ghStubDir({
      prs: [
        pr({
          number: 104,
          headRefName: "cms/posts/scheduled-publish-ghi",
          createdAt: youngIso(),
        }),
      ],
      files: { [num]: `${FIXTURE_ONLY}\n` },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "false", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(e) old fixture-only PR with `keep` label → NOT closed", () => {
    const num = "105";
    const { dir, log } = ghStubDir({
      prs: [
        pr({
          number: 105,
          headRefName: "cms/posts/scheduled-publish-jkl",
          createdAt: OLD_ISO,
          labels: ["keep"],
        }),
      ],
      files: { [num]: `${FIXTURE_ONLY}\n` },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "false", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(f) files fetch fails → NOT closed (fail closed on missing evidence)", () => {
    const num = "106";
    const { dir, log } = ghStubDir({
      prs: [
        pr({ number: 106, headRefName: "cms/posts/scheduled-publish-mno", createdAt: OLD_ISO }),
      ],
      files: { [num]: null },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "false", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(g) DRY_RUN=true with an otherwise-retirable PR → NOT closed", () => {
    const num = "107";
    const { dir, log } = ghStubDir({
      prs: [
        pr({ number: 107, headRefName: "cms/posts/scheduled-publish-pqr", createdAt: OLD_ISO }),
      ],
      files: { [num]: `${FIXTURE_ONLY}\n` },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "true", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(h) headRefName off the prefix (unexpected search result) → NOT closed", () => {
    const num = "108";
    const { dir, log } = ghStubDir({
      prs: [pr({ number: 108, headRefName: "cms/posts/some-other-branch", createdAt: OLD_ISO })],
      files: { [num]: `${FIXTURE_ONLY}\n` },
    });
    try {
      const { code, out } = runRetireStep({ dryRun: "false", stubDir: dir });
      expect(code, out).toBe(0);
      expect(closedPrNumbers(log)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("structural: the step sits after Tier 1 and before the _posts/ content sweep", () => {
    const doc = parseYaml(readWorkflow(SWEEP));
    const steps = doc.jobs.sweep.steps || [];
    const tier1Idx = steps.findIndex((s) => s && s.name === "Sweep stale Decap-managed PRs");
    const retireIdx = steps.findIndex((s) => s && s.name === RETIRE_STEP_NAME);
    // Same "step that lists _posts via the contents API" identification the
    // `_posts/` orphan-sweep describe block above uses (findPostSweepStep) —
    // reimplemented locally rather than imported since that helper is scoped
    // to its own describe block.
    const postSweepIdx = steps.findIndex((s) =>
      /contents\/_posts/.test(String((s && s.run) || "")),
    );
    expect(
      tier1Idx,
      `${SWEEP} must have the "Sweep stale Decap-managed PRs" step`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      retireIdx,
      `${SWEEP} must have the "${RETIRE_STEP_NAME}" step`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      postSweepIdx,
      `${SWEEP} must have a step that lists _posts via the contents API`,
    ).toBeGreaterThanOrEqual(0);
    expect(retireIdx, `${RETIRE_STEP_NAME} must run after Tier 1`).toBeGreaterThan(tier1Idx);
    expect(retireIdx, `${RETIRE_STEP_NAME} must run before the _posts/ content sweep`).toBeLessThan(
      postSweepIdx,
    );
  });

  test("the new step carries no `if:` gate (honours DRY_RUN internally, like Tier 1)", () => {
    const step = retireStep();
    expect(step.if, `${RETIRE_STEP_NAME} must not be step-gated by inputs.dry_run`).toBeFalsy();
  });
});
