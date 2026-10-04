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
//     base bound from the step's `env:` and failing closed — after the
//     platform checkout that provides it and before the diff.
// detect-changed-pages.js (the `generate` job) calls the helper itself.
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

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
          const w = words(l);
          const i = w.indexOf("git");
          const sub = i >= 0 ? w.slice(i + 1).find((x) => !x.startsWith("-")) : undefined;
          expect(sub === "fetch", `${s.name}: \`${l.trim()}\` — fetch through ensure-merge-base.js`).toBe(
            false,
          );
        }
      }
    });

    if (diffStep) {
      test("runs ensure-merge-base.js after the platform checkout and before the diff, failing closed", () => {
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

        // Fail closed: the helper is the whole command (bash -e fails the
        // step), or its failure exits non-zero explicitly.
        const run = String(step.run).trim();
        const whole = !run.includes("\n");
        const explicit = /\|\|\s*exit\s+1\b/.test(line) || /^\s*if\s+!\s/.test(line);
        expect(whole || explicit, `\`${line.trim()}\` must fail the step on error`).toBe(true);
      });
    }
  });
}
