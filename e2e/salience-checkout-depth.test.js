// @lane: local — parses the platform's own workflow YAML; no network
//
// cms-platform#541: the salience jobs used to check out FULL history
// (`fetch-depth: 0`, 14-20 s each on adamdaniel.ai) to diff
// `origin/<base>...HEAD`. They now check out the PR merge commit and its two
// parents (`fetch-depth: 2`) and run e2e/ensure-merge-base.js, which deepens
// only until the merge base is proven (its behavior is locked by
// e2e/ensure-merge-base.test.js on real shallow repos). This lint locks the
// wiring: every job below
//   - checks the SITE out at depth 2 (never 0),
//   - fetches nothing itself (`git fetch` belongs to the helper, whose
//     fetches are the ones the proof covers),
//   - and, where the job diffs in a run step, runs the helper — with the
//     base bound from the step's `env:` — after the platform checkout that
//     provides it and before the diff.
// Failing CLOSED is a behavior, not a shape: the last describe EXECUTES every
// step that calls the helper with a `node` that fails, and requires the step
// to exit non-zero without writing an output that reads as "nothing salient".
// detect-changed-pages.js (the `generate` job) calls the helper itself.
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");
const { findRunSteps, writeStubs, runStep } = require("./workflow-step-harness");

const JOBS = [
  { workflow: "visual-regression.yml", job: "detect", diffStep: "salience" },
  { workflow: "visual-regression.yml", job: "generate", diffStep: null },
  { workflow: "parity-preview.yml", job: "parity-probe", diffStep: "select" },
  { workflow: "preview-media.yml", job: "media-probe", diffStep: "salient" },
];

const isCheckout = (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@");
const isSiteCheckout = (s) => isCheckout(s) && !(s.with && s.with.repository);
const isPlatformCheckout = (s) => isCheckout(s) && s.with && s.with.path === ".cms-platform";
// Shell words of one run script, backslash continuations joined.
const lines = (s) =>
  String(s.run || "")
    .replace(/\\\n/g, " ")
    .split("\n");
const words = (line) => line.split(/[\s$()|;]+/).filter(Boolean);
// git's global options that take a SEPARATE argument; `--opt=value` spellings
// and the boolean flags (`-p`, `--no-pager`, ...) need no skipping.
const GIT_OPTIONS_WITH_ARG = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
  "--attr-source",
]);
// The git subcommands one line runs: for each `git` word, the first word
// after git's global options. `git -c k=v fetch` is a fetch, not a `k=v`.
function gitSubcommands(lineWords) {
  const subs = [];
  lineWords.forEach((word, i) => {
    if (word !== "git") return;
    let j = i + 1;
    while (j < lineWords.length && lineWords[j].startsWith("-")) {
      j += GIT_OPTIONS_WITH_ARG.has(lineWords[j]) ? 2 : 1;
    }
    if (j < lineWords.length) subs.push(lineWords[j]);
  });
  return subs;
}
const helperLine = (s) => lines(s).find((l) => words(l).some((w) => w.endsWith("e2e/ensure-merge-base.js")));

for (const { workflow, job, diffStep } of JOBS) {
  test.describe(`${workflow} › ${job}`, () => {
    const steps = () => {
      const wf = parseYaml(readWorkflow(workflow));
      const j = wf.jobs && wf.jobs[job];
      expect(j, `${workflow} has a \`${job}\` job`).toBeTruthy();
      return j.steps || [];
    };

    test("checks the site out at fetch-depth 2, never full history", () => {
      const site = steps().filter(isSiteCheckout);
      expect(site, "exactly one site checkout").toHaveLength(1);
      expect(site[0].with && Number(site[0].with["fetch-depth"])).toBe(2);
      for (const s of steps().filter(isCheckout)) {
        expect(Number((s.with || {})["fetch-depth"] ?? 1), `${s.name}: fetch-depth`).not.toBe(0);
      }
    });

    test("no run step fetches history itself", () => {
      for (const s of steps()) {
        for (const l of lines(s)) {
          expect(
            gitSubcommands(words(l)),
            `${s.name}: \`${l.trim()}\` — fetch through ensure-merge-base.js`,
          ).not.toContain("fetch");
        }
      }
    });

    if (diffStep) {
      test("runs ensure-merge-base.js after the platform checkout and before the diff", () => {
        const all = steps();
        const platform = all.findIndex(isPlatformCheckout);
        const helper = all.findIndex((s) => helperLine(s));
        const diff = all.findIndex((s) => s.id === diffStep);
        expect(platform, "platform checkout into .cms-platform").toBeGreaterThan(-1);
        expect(helper, "a step runs e2e/ensure-merge-base.js").toBeGreaterThan(platform);
        expect(diff, `step id \`${diffStep}\``).toBeGreaterThanOrEqual(helper);

        const step = all[helper];
        const line = helperLine(step);
        const w = line.trim().split(/\s+/);
        const base = /^"\$([A-Z_]+)";?$/.exec(w[w.indexOf("--base") + 1] || "");
        expect(base, `--base takes a quoted env var in \`${line.trim()}\``).toBeTruthy();
        expect(Object.keys(step.env || {}), "the base is bound in the step's env:").toContain(base[1]);
      });
    }
  });
}

// Fail closed, proven by running the step. A step that swallows the helper's
// failure (`|| true`, a deleted `exit 1`) goes on to write `salient=false` /
// `count=0`, which a required check reads as "nothing salient changed" and
// passes without running: fail-open.
test.describe("every step that runs ensure-merge-base.js fails closed (behavioral)", () => {
  const steps = findRunSteps((run) => run.includes("e2e/ensure-merge-base.js"));
  const ids = steps.map((s) => `${s.workflow} › ${s.job} › ${s.step.name}`);

  test("the three known call sites are found", () => {
    for (const w of [
      "visual-regression.yml › detect",
      "parity-preview.yml › parity-probe",
      "preview-media.yml › media-probe",
    ]) {
      expect(
        ids.some((id) => id.startsWith(w)),
        `a step in ${w}`,
      ).toBe(true);
    }
  });

  let scratch;
  test.beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "emb-step-"));
  });
  test.afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  // `node` is a stub that logs its arguments and exits with `nodeStatus` for
  // the helper only (any other node call, such as the selector that follows
  // it, succeeds, so a swallowed helper failure cannot be masked by a later
  // failure); `git` and `tee` are harmless (a git that succeeds and prints
  // nothing, a tee that only copies stdin to stdout).
  function execute({ step }, nodeStatus) {
    const bin = writeStubs(path.join(scratch, "bin"), {
      node: `echo "$@" >> "$STUB_LOG"\ncase "$*" in *e2e/ensure-merge-base.js*) exit ${nodeStatus} ;; esac\nexit 0`,
      git: "exit 0",
      tee: "cat",
    });
    const work = path.join(scratch, "work");
    fs.mkdirSync(work, { recursive: true });
    const log = path.join(scratch, "node.log");
    const stepEnv = Object.fromEntries(Object.keys(step.env || {}).map((k) => [k, "main"]));
    const r = runStep(step, {
      cwd: work,
      scratch: path.join(scratch, "run"),
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch, STUB_LOG: log },
      stepEnv,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { ...r, calls };
  }

  for (const found of steps) {
    const label = `${found.workflow} › ${found.job} › ${found.step.name}`;

    test(`${label}: a failing helper fails the step and writes no output`, () => {
      expect(found.step["continue-on-error"], "continue-on-error would swallow the failure").toBeFalsy();
      const r = execute(found, 1);
      expect(r.calls[0], "the helper is the first thing the step runs").toMatch(
        /e2e\/ensure-merge-base\.js --base main$/,
      );
      expect(r.status, `exit status; stderr: ${r.stderr}`).not.toBe(0);
      expect(r.output, "no output a later gate could read as `nothing salient`").toBe("");
    });

    test(`${label}: a succeeding helper lets the step through (the harness is not vacuous)`, () => {
      const r = execute(found, 0);
      expect(r.calls[0]).toMatch(/e2e\/ensure-merge-base\.js --base main$/);
      expect(r.status, `exit status; stderr: ${r.stderr}`).toBe(0);
    });
  }
});

// The lint above is only as good as its reading of `git ... fetch`; pin it on
// the spellings that hid a fetch behind global options.
test.describe("gitSubcommands (the no-direct-fetch lint's reader)", () => {
  const sub = (cmd) => gitSubcommands(words(cmd));
  for (const [cmd, expected] of [
    ["git fetch origin main", ["fetch"]],
    ["git -c k=v fetch origin main", ["fetch"]],
    ["git -c core.quotepath=off -c a=b fetch", ["fetch"]],
    ["git -C /tmp/work fetch", ["fetch"]],
    ["git --git-dir=.git --work-tree=. fetch", ["fetch"]],
    ["git --git-dir .git --no-pager fetch", ["fetch"]],
    ["echo x | git -c k=v fetch", ["fetch"]],
    ["git -c k=v diff --name-only", ["diff"]],
    ["git config --global --add safe.directory x", ["config"]],
    ["echo fetch", []],
  ]) {
    test(`${cmd} -> ${JSON.stringify(expected)}`, () => {
      expect(sub(cmd)).toEqual(expected);
    });
  }
});
