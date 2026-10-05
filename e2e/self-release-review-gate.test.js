// @lane: local — PURE-FS lint of self-release-review-gate.yml, unit tests of
// scripts/release-review-gate.js, and the workflow's own `run:` step executed
// offline against a stub `gh`. PLATFORM-INTERNAL: reads the platform's own
// workflow definition and scripts.
//
// cms-platform#526, acceptance criterion 3 (owner decision 2026-10-05): a
// release-bearing PR merges only when its body carries
// `Independent review: CLEAN at <sha>` naming its CURRENT head. The REQUIRED
// `release-review-gate` context is the enforcement, so it breaks silently in a
// few ways this file locks:
//
//   - it must report on EVERY PR, including a body edit (`edited`), and never
//     end `cancelled`: no `paths:`, no job `if:`, no concurrency, no wall;
//   - it must read the author-controlled PR fields from the event FILE, never a
//     `${{ github.event.* }}` interpolation into `run:`;
//   - the stamp matcher must accept only the current head, in full, stated in
//     the rendered body (not quoted, fenced, commented or indented as code);
//   - a missing input (an API failure) must fail the gate, not pass it.
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseYaml, readWorkflow, events } = require("./workflow-yaml-utils");
const { runStep, writeStubs } = require("./workflow-step-harness");
const gate = require("../scripts/release-review-gate");

const FILE = "self-release-review-gate.yml";
const JOB = "release-review-gate";
const STEP = "Decide release-bearing and check the review stamp";
const REPO_ROOT = path.resolve(__dirname, "..");

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD = "89abcdef0123456789abcdef0123456789abcdef";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const MB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STAMP = `Independent review: CLEAN at ${HEAD}`;

function workflow() {
  return parseYaml(readWorkflow(FILE));
}

function job() {
  const j = (workflow().jobs || {})[JOB];
  expect(j, `${FILE} must keep its \`${JOB}\` job`).toBeTruthy();
  return j;
}

function gateStep() {
  const s = (job().steps || []).find((st) => st && st.name === STEP);
  expect(s, `${FILE} must keep its step "${STEP}"`).toBeTruthy();
  return s;
}

function platformMainContexts() {
  const m = parseYaml(fs.readFileSync(path.join(REPO_ROOT, "repo-settings.yml"), "utf8"));
  const out = [];
  for (const rule of m.ruleset_library["platform-main"].rules || []) {
    if (rule.type !== "required_status_checks") continue;
    for (const c of rule.parameters.required_status_checks || []) out.push(c.context);
  }
  return out;
}

test.describe("self-release-review-gate.yml: a required check that always reports (#526)", () => {
  test("`release-review-gate` is required by platform-main and the desired-state fixture", () => {
    expect(platformMainContexts()).toContain(JOB);
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "repo-settings", "cms-platform.ruleset-main.json"),
        "utf8",
      ),
    );
    const rule = fixture.rules.find((r) => r.type === "required_status_checks");
    expect(rule.parameters.required_status_checks.map((c) => c.context)).toContain(JOB);
  });

  test("triggers: every PR, including a body edit; no path or branch filter", () => {
    const on = workflow().on;
    expect(events(on)).toEqual(["pull_request"]);
    const pr = on.pull_request;
    expect([...pr.types].sort()).toEqual(["edited", "opened", "reopened", "synchronize"]);
    for (const key of ["paths", "paths-ignore", "branches", "branches-ignore"]) {
      expect(pr, `on.pull_request.${key} would leave some PR without the required context`).not.toHaveProperty(key);
    }
  });

  test("no concurrency, no wall, no if:, no continue-on-error — it can fire twice on one head", () => {
    const wf = workflow();
    const j = job();
    expect(wf.concurrency, "a workflow-level group would cancel a same-head sibling").toBeUndefined();
    expect(j.concurrency, "a job-level group would cancel a same-head sibling").toBeUndefined();
    expect(j["timeout-minutes"], "a wall reports `cancelled` (#289)").toBeUndefined();
    expect(j.if, "a skipped job reports no verdict").toBeUndefined();
    expect(j["continue-on-error"]).toBeUndefined();
    expect(j.name, "the check run must be named by the job id the ruleset requires").toBeUndefined();
  });

  test("least privilege: contents: read, nothing else, no job override", () => {
    expect(workflow().permissions).toEqual({ contents: "read" });
    expect(job().permissions).toBeUndefined();
  });

  test("PR fields come from the event FILE, never a ${{ }} interpolation into run:", () => {
    const steps = job().steps || [];
    const runs = steps.filter((s) => typeof s.run === "string");
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) {
      expect(s.run, `step "${s.name}" interpolates an expression into its script`).not.toContain("${{");
    }
    const run = gateStep().run;
    expect(run).toContain('"$GITHUB_EVENT_PATH"');
    expect(run).toContain('--event "$GITHUB_EVENT_PATH"');
    for (const v of Object.values(gateStep().env || {})) {
      expect(String(v), "no event field may reach the step through env either").not.toMatch(/github\.event/);
    }
  });

  test("the checkout does not persist the token", () => {
    const co = (job().steps || []).find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"));
    expect(co).toBeTruthy();
    expect(co.with["persist-credentials"]).toBe(false);
  });
});

test.describe("findStamps / checkStamp: the stamp grammar", () => {
  test("the current head, in full, passes", () => {
    expect(gate.checkStamp(`Summary\n\n${STAMP}\n`, HEAD).ok).toBe(true);
  });

  test("hex case and surrounding whitespace do not matter; CRLF bodies parse", () => {
    const body = `Summary\r\n  Independent review: CLEAN at ${HEAD.toUpperCase()}  \r\nmore`;
    expect(gate.checkStamp(body, HEAD).ok).toBe(true);
  });

  test("a stale head fails and is named as stale", () => {
    const v = gate.checkStamp(`Independent review: CLEAN at ${OLD}`, HEAD);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(`${OLD} (line 1, a stale head)`);
  });

  test("a missing, empty or null body fails", () => {
    for (const body of [null, undefined, "", "LGTM, ship it"]) {
      const v = gate.checkStamp(body, HEAD);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain(`Independent review: CLEAN at ${HEAD}`);
    }
  });

  test("a 7+ character prefix of the head is NOT accepted", () => {
    for (const n of [7, 12, 39]) {
      const v = gate.checkStamp(`Independent review: CLEAN at ${HEAD.slice(0, n)}`, HEAD);
      expect(v.ok, `a ${n}-character prefix`).toBe(false);
      expect(v.reason).toContain("not a full 40-character SHA");
    }
  });

  test("only CLEAN, exactly spelled, on a line of its own counts", () => {
    for (const line of [
      `Independent review: DIRTY at ${HEAD}`,
      `independent review: clean at ${HEAD}`,
      `Independent review: CLEAN at ${HEAD}, with nits`,
      `Not yet. Independent review: CLEAN at ${HEAD}`,
      `**Independent review: CLEAN at ${HEAD}**`,
      `Independent review: CLEAN at ${HEAD}0`,
    ]) {
      expect(gate.checkStamp(line, HEAD).ok, line).toBe(false);
    }
  });

  test("a stamp in a fenced code block, quote, HTML comment or indented code does not count", () => {
    const bodies = [
      "```\n" + STAMP + "\n```",
      "~~~text\n" + STAMP + "\n~~~",
      "````\n```\n" + STAMP + "\n```\n````",
      "> " + STAMP,
      ">" + STAMP,
      "<!-- " + STAMP + " -->",
      "<!--\n" + STAMP + "\n-->",
      "    " + STAMP,
      "\t" + STAMP,
    ];
    for (const body of bodies) {
      expect(gate.findStamps(body), JSON.stringify(body)).toEqual([]);
      expect(gate.checkStamp(body, HEAD).ok).toBe(false);
    }
  });

  test("a stamp AFTER a closed fence or comment counts again", () => {
    expect(gate.checkStamp("```\nx\n```\n" + STAMP, HEAD).ok).toBe(true);
    expect(gate.checkStamp("<!--\nx\n-->\n" + STAMP, HEAD).ok).toBe(true);
    expect(gate.checkStamp("<!-- x -->\n" + STAMP, HEAD).ok).toBe(true);
  });

  test("an unclosed fence swallows the rest of the body", () => {
    expect(gate.checkStamp("```\n" + STAMP, HEAD).ok).toBe(false);
  });

  test("an old stamp beside the current one passes; the current head decides", () => {
    const body = `Independent review: CLEAN at ${OLD}\n\n${STAMP}`;
    expect(gate.findStamps(body)).toEqual([
      { sha: OLD, line: 1 },
      { sha: HEAD, line: 3 },
    ]);
    expect(gate.checkStamp(body, HEAD).ok).toBe(true);
  });

  test("a malformed head never matches", () => {
    expect(gate.checkStamp(STAMP, "").ok).toBe(false);
    expect(gate.checkStamp(`Independent review: CLEAN at ${HEAD.slice(0, 7)}`, HEAD.slice(0, 7)).ok).toBe(false);
  });
});

test.describe("classify: what is release-bearing", () => {
  const same = [
    { file: "plugin.json", base: "0.1.133", head: "0.1.133" },
    { file: ".claude-plugin/plugin.json", base: "0.1.133", head: "0.1.133" },
  ];

  test("no version change on a feature branch is not release-bearing", () => {
    expect(gate.classify({ headRef: "fix/thing", versions: same })).toEqual({
      releaseBearing: false,
      reasons: [],
    });
  });

  test("a release/* head branch is release-bearing even before the bump", () => {
    expect(gate.classify({ headRef: "release/v0.1.134", versions: same }).releaseBearing).toBe(true);
    expect(gate.classify({ headRef: "fix/release/x", versions: same }).releaseBearing).toBe(false);
  });

  test("either manifest's version change is release-bearing", () => {
    for (const i of [0, 1]) {
      const versions = same.map((v, k) => (k === i ? { ...v, head: "0.1.134" } : v));
      const c = gate.classify({ headRef: "fix/thing", versions });
      expect(c.releaseBearing).toBe(true);
      expect(c.reasons).toEqual([`${versions[i].file} version 0.1.133 -> 0.1.134`]);
    }
  });
});

// The workflow's own step, run under bash with a stub `gh` (no network): the
// stub answers the compare call with STUB_MB and each contents call with a
// manifest whose version depends on the ref asked for.
test.describe("the gate step, executed offline", () => {
  const GH_STUB = [
    'case "$*" in',
    '  *compare/*) if [ -n "$STUB_MB" ]; then echo "$STUB_MB"; else echo \'{"message":"Bad credentials"}\'; exit 1; fi ;;',
    '  *contents/*"ref=$STUB_MB"*) printf \'{"name":"cms-platform","version":"%s"}\\n\' "$STUB_BASE_VERSION" ;;',
    '  *contents/*) printf \'{"name":"cms-platform","version":"%s"}\\n\' "$STUB_HEAD_VERSION" ;;',
    "  *) exit 64 ;;",
    "esac",
  ].join("\n");

  function run({ body, headRef = "fix/thing", headSha = HEAD, mb = MB, baseVersion = "0.1.133", headVersion = "0.1.133" }) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "release-review-gate-"));
    try {
      const stubs = writeStubs(path.join(scratch, "bin"), { gh: GH_STUB });
      const eventPath = path.join(scratch, "event.json");
      fs.writeFileSync(
        eventPath,
        JSON.stringify({
          action: "edited",
          pull_request: { number: 1, body, head: { sha: headSha, ref: headRef }, base: { sha: BASE, ref: "main" } },
        }),
      );
      return runStep(gateStep(), {
        cwd: REPO_ROOT,
        scratch: path.join(scratch, "run"),
        env: {
          PATH: `${stubs}:${process.env.PATH}`,
          HOME: scratch,
          GITHUB_EVENT_PATH: eventPath,
          STUB_MB: mb,
          STUB_BASE_VERSION: baseVersion,
          STUB_HEAD_VERSION: headVersion,
        },
        stepEnv: { GH_TOKEN: "stub-token", REPO: "example/repo" },
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  test("a PR that is not release-bearing passes without a stamp", () => {
    const r = run({ body: "no stamp here" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("not release-bearing");
  });

  test("a version bump with no stamp fails, and the log never echoes the body", () => {
    const r = run({ body: "PRIVATE-BODY-MARKER no stamp", headVersion: "0.1.134" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::release-review-gate: no \"Independent review: CLEAN at <sha>\"");
    expect(r.stdout + r.stderr).not.toContain("PRIVATE-BODY-MARKER");
  });

  test("a version bump stamped at the current head passes", () => {
    const r = run({ body: `Release\n\n${STAMP}`, headVersion: "0.1.134" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Independent review: CLEAN at ${HEAD} found`);
  });

  test("a release/* branch stamped at an older head fails", () => {
    const r = run({ body: `Independent review: CLEAN at ${OLD}`, headRef: "release/v0.1.134" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("a stale head");
  });

  test("an API failure fails the gate, without printing the response body", () => {
    const r = run({ body: STAMP, mb: "" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::could not resolve the merge base");
    expect(r.stdout + r.stderr).not.toContain("Bad credentials");
  });

  test("an event without a 40-character head SHA fails", () => {
    const r = run({ body: STAMP, headSha: "abc" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("no 40-character head/base SHA");
  });
});
