// @lane: local — pure-fs lint of the loop workflows + the single-page spec source (#1068)
/*
 * The single-page publish loop (#1068) has three halves that must stay in step:
 *
 *   1. cms-publish-loop-host.yml runs cms-publish-loop-single-page.spec.js, the
 *      loop that publishes through a single-page site's own collections.
 *   2. cms-publish-loop-prod.yml, cms-scheduled-publish-loop.yml and
 *      cms-media-roundtrip.yml run `summarize-playwright.js --require-ran`, so on
 *      a site with no posts collection they would fail every day. Each carries an
 *      early "Detect single-page site" step and gates every heavy step on its
 *      output; the JOB itself is never gated, so the required context still
 *      reports success (docs/CI-INVARIANTS.md, "A cancelled required check blocks
 *      the merge").
 *   3. The spec self-skips unless the site is single-page and the host loop opted
 *      in.
 *
 * Workflows are parsed with the `yaml` library and the spec with acorn
 * (./spec-ast.js), never a regex scan of source.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");
const { parse, calleeName, subtreeHasCall, subtreeStrings } = require("./spec-ast");

const GATE = "steps.site_kind.outputs.single_page != 'true'";

// workflow file → its heavy job and the steps that must be gated (by name).
const GATED = {
  "cms-publish-loop-prod.yml": {
    job: "prod-mutate",
    steps: [
      "Install Playwright browser + system deps",
      "Await prod deploy of this merge",
      "Self-heal orphaned canary markers",
      "Run prod mutation playground spec",
      "Upload test results",
      "Post failure summary",
      "Resolve failure summary on success",
    ],
  },
  "cms-scheduled-publish-loop.yml": {
    job: "scheduled-publish-loop",
    steps: [
      "Install Playwright browser + system deps",
      "Run scheduled-publish loop spec",
      "Upload test results",
      "Post failure summary",
      "Resolve failure summary on success",
    ],
  },
  "cms-media-roundtrip.yml": {
    job: "media-roundtrip",
    steps: [
      "Install Playwright browser + system deps",
      "Await prod deploy of this merge",
      "Run media round-trip spec",
      "Upload test results",
      "Post failure summary",
      "Resolve failure summary on success",
    ],
  },
};

function loopJob(wf, name) {
  const doc = parseYaml(readWorkflow(wf));
  const job = doc.jobs[name];
  expect(job, `${wf} must define job ${name}`).toBeTruthy();
  return job;
}

// The `&&`-joined clauses of a step's `if:` (the `${{ }}` wrapper removed).
function clauses(step) {
  const raw = String(step.if == null ? "" : step.if).trim();
  const inner = raw.startsWith("${{") && raw.endsWith("}}") ? raw.slice(3, -2) : raw;
  return inner.split("&&").map((c) => c.trim());
}

test.describe("single-page loop gating (#1068)", () => {
  for (const [wf, { job: jobName, steps }] of Object.entries(GATED)) {
    test.describe(wf, () => {
      test("has a Detect single-page site step that runs the detector against the site", () => {
        const job = loopJob(wf, jobName);
        const detect = job.steps.find((s) => s.name === "Detect single-page site");
        expect(detect, "Detect single-page site step").toBeTruthy();
        expect(detect.id).toBe("site_kind");
        expect(detect["working-directory"]).toBe(".cms-platform/e2e");
        expect(detect.run.trim()).toBe("node single-page-detect.js");
        expect(detect.env.SITE_ROOT).toBe("${{ github.workspace }}");
        expect(String(detect.env.LOOP_NAME || "").length).toBeGreaterThan(0);
        // It is the one step that must always run: no condition of its own.
        expect(detect.if, "the detector must not be gated").toBeUndefined();
      });

      test("the detector runs after the harness install and before any Playwright work", () => {
        const names = loopJob(wf, jobName).steps.map((s) => s.name);
        const at = (n) => names.indexOf(n);
        expect(at("Detect single-page site")).toBeGreaterThan(at("Install harness deps"));
        expect(at("Detect single-page site")).toBeLessThan(
          at("Install Playwright browser + system deps"),
        );
      });

      test("every heavy step is gated on the detector's output", () => {
        const job = loopJob(wf, jobName);
        for (const name of steps) {
          const step = job.steps.find((s) => s.name === name);
          expect(step, `${wf} step "${name}"`).toBeTruthy();
          expect(clauses(step), `${wf} step "${name}" must carry the single-page gate`).toContain(
            GATE,
          );
        }
      });

      test("the job itself is never gated, so its required context still reports success", () => {
        const job = loopJob(wf, jobName);
        expect(String(job.if || "")).not.toContain("site_kind");
        // Nor does any step OUTSIDE the heavy list read the detector (the branch
        // cleanup must keep running on every site).
        for (const step of job.steps) {
          if (steps.includes(step.name)) continue;
          expect(
            String(step.if || ""),
            `${wf} step "${step.name}" must not depend on the detector`,
          ).not.toContain("site_kind");
        }
        const cleanup = job.steps.find((s) => /clean ?up/i.test(s.name || ""));
        expect(cleanup && String(cleanup.if)).toMatch(/always\(\)/);
      });

      test("--require-ran is still on the run step: a real site that runs nothing still fails", () => {
        const job = loopJob(wf, jobName);
        const run = job.steps.find((s) => steps.includes(s.name) && /playwright test/.test(s.run || ""));
        expect(run.run).toContain("summarize-playwright.js --require-ran");
      });
    });
  }

  test("the host loop runs the single-page spec", () => {
    const job = loopJob("cms-publish-loop-host.yml", "host-loop");
    const run = job.steps.find((s) => /playwright test/.test(s.run || ""));
    expect(run.run).toContain("cms-publish-loop-single-page.spec.js");
    expect(run.env.RUN_HOST_REPO_PUBLISH_LOOP).toBe("1");
    expect(run.env.SITE_ROOT).toBe("${{ github.workspace }}");
    // Two legs of up to 80 + 70 minutes (the spec's budgets) plus setup.
    expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(160);
  });

  test("the host loop's branch cleanup covers the single-page spec's media branches", () => {
    const job = loopJob("cms-publish-loop-host.yml", "host-loop");
    const cleanup = job.steps.find((s) => /clean ?up.*ephemeral/i.test(s.name || ""));
    expect(cleanup.run).toContain("'cms/media/0-e2e-publish-loop-'");
  });

  test.describe("cms-publish-loop-single-page.spec.js", () => {
    const SPEC = path.join(__dirname, "cms-publish-loop-single-page.spec.js");
    const ast = parse(fs.readFileSync(SPEC, "utf8"));

    // Every test.skip(...) call in the file: { node, strings, hasCall }.
    function skipCalls() {
      const out = [];
      const walk = require("acorn-walk");
      walk.full(ast, (n) => {
        if (n.type === "CallExpression" && calleeName(n.callee) === "test.skip") out.push(n);
      });
      return out;
    }

    test("self-skips unless the host loop opted in", () => {
      const hit = skipCalls().some((c) =>
        subtreeStrings(c).some((s) => s.includes("RUN_HOST_REPO_PUBLISH_LOOP")),
      );
      expect(hit, "a test.skip on RUN_HOST_REPO_PUBLISH_LOOP").toBe(true);
    });

    test("self-skips unless the site is single-page", () => {
      const hit = skipCalls().some((c) =>
        subtreeHasCall(c, ({ tail }) => tail === "isSinglePageConsumer"),
      );
      expect(hit, "a test.skip keyed on isSinglePageConsumer").toBe(true);
    });

    test("never opens the posts new-entry form (it is a single-page loop)", () => {
      for (const s of subtreeStrings(ast)) {
        expect(s, "no string may route to the posts collection").not.toMatch(
          /collections\/posts\b/,
        );
      }
    });
  });
});
