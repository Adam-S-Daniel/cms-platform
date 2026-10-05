// @lane: local — PURE-FS lint of self-fixture-e2e.yml, plus its shell steps run
// offline against real throwaway git repos and synthetic Playwright reports.
// PLATFORM-INTERNAL: reads the platform's own workflow definition.
//
// cms-platform#527: self-fixture-e2e.yml is the one platform lane that runs
// `*.spec.js` in a browser (the `@lane: local` specs on the two admin projects,
// against e2e/fixture-site). Its value rests on a few things that each break
// silently:
//
//   - the GATE: `fixture-e2e` is a REQUIRED context, so it must report on every
//     PR (always(), no wall, no concurrency) and must actually translate the
//     matrix result, or it is a check that can never go red;
//   - the PLACEMENT: the harness must run from INSIDE the fixture with SITE_ROOT
//     on the fixture, or the specs read the platform root as "the site";
//   - the LANE FILTER: `@lane: real` specs must be excluded, because
//     admin-bundle-parity.spec.js fetches production unconditionally;
//   - SALIENCE: a docs-only PR may skip the work, but anything unknown runs it;
//   - NON-VACUITY: the archived-PDF test must have PASSED, so a future skip
//     cannot leave #527's proof green while proving nothing.
//
// The shape checks parse the YAML (workflow-yaml-utils); the behavior checks
// execute the workflow's own `run:` scripts (workflow-step-harness), so they
// test what the steps DO rather than what they look like.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { parseYaml, readWorkflow } = require("./workflow-yaml-utils");
const { runStep } = require("./workflow-step-harness");
const { createSandbox } = require("./git-fixture");
const { filterByLane } = require("./select-specs");

const FILE = "self-fixture-e2e.yml";
const WORK = "fixture-e2e-project";
const GATE = "fixture-e2e";
const HARNESS = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..");

function workflow() {
  return parseYaml(readWorkflow(FILE));
}

function job(id) {
  const j = (workflow().jobs || {})[id];
  expect(j, `${FILE} must keep its \`${id}\` job`).toBeTruthy();
  return j;
}

function step(jobId, name) {
  const s = (job(jobId).steps || []).find((st) => st && st.name === name);
  expect(s, `${FILE} job \`${jobId}\` must keep its step "${name}"`).toBeTruthy();
  return s;
}

function stepWithId(jobId, id) {
  const s = (job(jobId).steps || []).find((st) => st && st.id === id);
  expect(s, `${FILE} job \`${jobId}\` must keep a step with id \`${id}\``).toBeTruthy();
  return s;
}

function required() {
  const m = parseYaml(fs.readFileSync(path.join(REPO_ROOT, "repo-settings.yml"), "utf8"));
  const out = [];
  for (const rule of m.ruleset_library["platform-main"].rules || []) {
    if (rule.type !== "required_status_checks") continue;
    for (const c of rule.parameters.required_status_checks || []) out.push(c.context);
  }
  return out;
}

test.describe("self-fixture-e2e.yml: the required gate (#527)", () => {
  test("`fixture-e2e` is required by platform-main; the matrix legs are not", () => {
    const ctx = required();
    expect(ctx).toContain(GATE);
    expect(ctx.filter((c) => c.startsWith(WORK))).toEqual([]);
  });

  test("the gate always reports: needs the work, always(), no wall, no concurrency", () => {
    const wf = workflow();
    expect(wf.concurrency, "no workflow-level concurrency on a required context").toBeUndefined();
    const gate = job(GATE);
    expect(String(gate.needs)).toBe(WORK);
    expect(String(gate.if).replace(/\s+/g, "")).toBe("${{always()}}");
    expect("timeout-minutes" in gate, "a gate killed at a wall reports `cancelled` (#289)").toBe(false);
    expect("concurrency" in gate).toBe(false);
    expect("continue-on-error" in gate).toBe(false);
    expect(gate.name, "the context is the bare job id").toBeUndefined();
  });

  test("the gate translates the matrix result: red unless `success`", () => {
    const gateStep = job(GATE).steps[0];
    expect(String(gateStep.env.PROJECTS_RESULT)).toContain(`needs.${WORK}.result`);
    const sb = createSandbox("fixture-e2e-gate-");
    try {
      for (const [result, status] of [
        ["success", 0],
        ["failure", 1],
        ["cancelled", 1],
        ["skipped", 1],
        ["", 1],
      ]) {
        const r = runStep(gateStep, {
          cwd: sb.root,
          scratch: path.join(sb.root, `gate-${result || "empty"}`),
          env: sb.env,
          stepEnv: { PROJECTS_RESULT: result },
        });
        expect(r.status, `PROJECTS_RESULT=${JSON.stringify(result)}`).toBe(status);
      }
    } finally {
      sb.cleanup();
    }
  });

  test("triggers match self-ci.yml: every PR to main, push to main, no path filter", () => {
    const on = workflow().on;
    expect(on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened"] });
    expect(on.push).toEqual({ branches: ["main"] });
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect(workflow().permissions).toEqual({ contents: "read" });
  });
});

test.describe("self-fixture-e2e.yml: the work job (#527)", () => {
  test("runs exactly the two admin projects, one engine each, with a wall", () => {
    const w = job(WORK);
    expect(w.strategy.matrix.project).toEqual(["chromium-desktop-3k", "webkit-iphone16"]);
    expect(w.strategy["fail-fast"]).toBe(false);
    expect(w["timeout-minutes"]).toBeGreaterThan(0);
    expect(w.env.PW_PROJECT).toBe("${{ matrix.project }}");
    expect(w.env.TARGET).toBe("local");
  });

  test("every step after salience is gated on it, so a skip still reports success", () => {
    const steps = job(WORK).steps;
    const at = steps.findIndex((s) => s.id === "salient");
    expect(at, "the salience step must exist and run before the work").toBeGreaterThan(0);
    for (const s of steps.slice(at + 1)) {
      expect(String(s.if), `step "${s.name}" must be gated on the salience output`).toContain(
        "steps.salient.outputs.salient == 'true'",
      );
    }
  });

  test("the harness is placed INSIDE the fixture and SITE_ROOT points at the fixture", () => {
    const place = step(WORK, "Place the harness inside the fixture");
    expect(place.run).toMatch(/rsync\b[^\n]*\\\n\s*e2e\/ e2e\/fixture-site\/e2e\//);
    for (const ex of ["fixture-site", "fixture-site-singlepage", "node_modules"]) {
      expect(place.run).toContain(`--exclude ${ex}`);
    }
    const run = step(WORK, "Run the local-lane specs against the fixture");
    expect(run["working-directory"]).toBe("e2e/fixture-site/e2e");
    expect(run.env.SITE_ROOT).toBe("${{ github.workspace }}/e2e/fixture-site");
    expect(stepWithId(WORK, "select")["working-directory"]).toBe("e2e/fixture-site/e2e");
    const ruby = step(WORK, "Setup Ruby + Bundler");
    expect(ruby.with["working-directory"]).toBe("e2e/fixture-site");
    expect(ruby.with["bundler-cache"]).toBe(true);
  });

  test("the fixture's Gemfile.lock is committed, not ignored (frozen install)", () => {
    const lock = path.join(HARNESS, "fixture-site", "Gemfile.lock");
    expect(fs.existsSync(lock), "e2e/fixture-site/Gemfile.lock must be tracked").toBe(true);
    const src = fs.readFileSync(lock, "utf8");
    expect(src).toContain("PATH\n  remote: ../../theme\n");
    for (const ignore of [path.join(REPO_ROOT, ".gitignore"), path.join(HARNESS, "fixture-site", ".gitignore")]) {
      const lines = fs.readFileSync(ignore, "utf8").split("\n").map((l) => l.trim());
      expect(lines.filter((l) => /(^|\/)Gemfile\.lock$/.test(l)), ignore).toEqual([]);
    }
  });
});

test.describe("self-fixture-e2e.yml: the lane filter excludes `@lane: real` (#527)", () => {
  test("the select step picks every local spec and no real one", () => {
    const sb = createSandbox("fixture-e2e-select-");
    try {
      const r = runStep(stepWithId(WORK, "select"), {
        cwd: HARNESS,
        scratch: path.join(sb.root, "select"),
        env: { ...process.env, PW_PROJECT: "chromium-desktop-3k" },
      });
      expect(r.status, r.stderr).toBe(0);
      const out = Object.fromEntries(
        r.output.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      const picked = out.specs.split(" ").filter(Boolean).sort();
      const all = fs.readdirSync(HARNESS).filter((f) => f.endsWith(".spec.js"));
      const real = filterByLane(all, "real", { repoRoot: HARNESS });
      expect(real.length, "the real-lane set this filter must exclude").toBeGreaterThan(0);
      expect(real).toContain("admin-bundle-parity.spec.js");
      expect(picked).toEqual(filterByLane(all, "local", { repoRoot: HARNESS }).sort());
      expect(picked).toContain("cms-editorial-workflow.spec.js");
      for (const s of real) expect(picked, `${s} is @lane: real`).not.toContain(s);
      expect(Number(out.count)).toBe(picked.length);
      expect(out.workers, "ci-matrix.js --workers (a count or a percentage)").toMatch(/^\d+%?$/);
    } finally {
      sb.cleanup();
    }
  });
});

test.describe("self-fixture-e2e.yml: salience is a fail-safe deny-list (#527)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  function salient(eventName, payload, repo) {
    const scratch = path.join(sb.root, `run-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(scratch, { recursive: true });
    const eventPath = path.join(scratch, "event.json");
    fs.writeFileSync(eventPath, JSON.stringify(payload));
    const r = runStep(stepWithId(WORK, "salient"), {
      cwd: repo,
      scratch,
      env: { ...sb.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath },
    });
    expect(r.status, r.stderr).toBe(0);
    const m = /^salient=(true|false)$/m.exec(r.output);
    expect(m, `step output: ${r.output}`).toBeTruthy();
    return m[1] === "true";
  }

  const CASES = [
    { files: { "docs/CONTRIBUTING.md": "x\n" }, salient: false },
    { files: { "README.md": "x\n", "theme/README.md": "x\n" }, salient: false },
    { files: { "infrastructure/rum/template.yaml": "x\n", LICENSE: "x\n" }, salient: false },
    { files: { "oauth-proxy/lambda.py": "x\n", "scripts/cross_post/cross_post.py": "x\n" }, salient: false },
    { files: { "docs/x.md": "x\n", "theme/_layouts/post.html": "x\n" }, salient: true },
    { files: { "e2e/fixture-site/_posts/2026-01-01-new.md": "x\n" }, salient: true },
    { files: { "e2e/cms-editorial-workflow.spec.js": "x\n" }, salient: true },
    { files: { ".github/workflows/self-fixture-e2e.yml": "x\n" }, salient: true },
    { files: { "theme/admin/café.js": "x\n" }, salient: true },
  ];

  for (const { files, salient: want } of CASES) {
    test(`PR touching ${Object.keys(files).join(" + ")} -> salient=${want}`, () => {
      sb = createSandbox("fixture-e2e-salient-");
      const repo = sb.initRepo("site");
      const base = sb.commit(repo, { "seed.txt": "base\n" }, "base");
      const head = sb.commit(repo, files, "change");
      const payload = { pull_request: { base: { sha: base }, head: { sha: head } } };
      expect(salient("pull_request", payload, repo)).toBe(want);
    });
  }

  test("a moved salient file counts at its SOURCE path too (--no-renames)", () => {
    sb = createSandbox("fixture-e2e-salient-");
    const repo = sb.initRepo("site");
    const body = "a layout body long enough for rename detection to pair it\n".repeat(20);
    const base = sb.commit(repo, { "theme/_layouts/post.html": body }, "base");
    const head = sb.commit(repo, { "theme/_layouts/post.html": null, "docs/post.md": body }, "move");
    const payload = { pull_request: { base: { sha: base }, head: { sha: head } } };
    expect(salient("pull_request", payload, repo)).toBe(true);
  });

  test("a push to main always runs, and an uncomputable diff runs (fail-safe)", () => {
    sb = createSandbox("fixture-e2e-salient-");
    const repo = sb.initRepo("site");
    sb.commit(repo, { "docs/a.md": "x\n" }, "only docs");
    expect(salient("push", { ref: "refs/heads/main" }, repo)).toBe(true);
    const missing = { pull_request: { base: { sha: "0".repeat(40) }, head: { sha: "1".repeat(40) } } };
    expect(salient("pull_request", missing, repo)).toBe(true);
    expect(salient("pull_request", {}, repo)).toBe(true);
  });
});

test.describe("self-fixture-e2e.yml: the archived-PDF test must have PASSED (#527)", () => {
  const TITLE = "opted-in archived PDF fields render host-specific copy and stay private by default";
  const SPEC = "cms-editorial-workflow.spec.js";

  function report(tests) {
    return {
      suites: [
        {
          title: SPEC,
          file: SPEC,
          specs: [],
          suites: [
            {
              title: "editorial workflow",
              file: SPEC,
              specs: [{ title: TITLE, file: SPEC, tests }],
            },
          ],
        },
      ],
    };
  }

  function assertStep(json) {
    const s = step(WORK, "Assert the archived-PDF test passed");
    expect(s.env.REQUIRED_SPEC_FILE).toBe(SPEC);
    expect(s.env.REQUIRED_TEST_TITLE).toBe(TITLE);
    const sb = createSandbox("fixture-e2e-assert-");
    try {
      const file = path.join(sb.root, "results.json");
      if (json !== undefined) fs.writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json));
      return runStep(s, {
        cwd: sb.root,
        scratch: path.join(sb.root, "assert"),
        env: { ...sb.env, PW_PROJECT: "webkit-iphone16" },
        stepEnv: {
          PLAYWRIGHT_JSON_OUTPUT_FILE: file,
          REQUIRED_SPEC_FILE: SPEC,
          REQUIRED_TEST_TITLE: TITLE,
        },
      });
    } finally {
      sb.cleanup();
    }
  }

  const passed = { projectName: "webkit-iphone16", status: "expected", results: [{ status: "passed" }] };

  test("the test's title still exists in the spec it names", () => {
    expect(fs.readFileSync(path.join(HARNESS, SPEC), "utf8")).toContain(JSON.stringify(TITLE));
  });

  test("passes when the test passed on this project (also after a retry)", () => {
    expect(assertStep(report([passed])).status).toBe(0);
    const flaky = { ...passed, status: "flaky", results: [{ status: "failed" }, { status: "passed" }] };
    expect(assertStep(report([flaky])).status).toBe(0);
  });

  test("fails on a skip, a failure, another project only, or no report", () => {
    const skipped = { ...passed, status: "skipped", results: [{ status: "skipped" }] };
    expect(assertStep(report([skipped])).status).toBe(1);
    const failed = { ...passed, status: "unexpected", results: [{ status: "failed" }] };
    expect(assertStep(report([failed])).status).toBe(1);
    expect(assertStep(report([{ ...passed, projectName: "chromium-desktop-3k" }])).status).toBe(1);
    expect(assertStep(report([])).status).toBe(1);
    expect(assertStep({ suites: [] }).status).toBe(1);
    expect(assertStep("{not json").status).toBe(1);
    expect(assertStep(undefined).status).toBe(1);
  });
});
