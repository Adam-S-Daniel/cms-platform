// @lane: local — pure-fs lint of the scheduled-run-health reusable + pure-Node
// unit tests for scripts/audit-scheduled-runs.js helpers. No browser, no network.
// Platform-internal (reads ../scripts + the platform workflow DEFINITIONS +
// examples/site templates) — registered in playwright.config.js
// PLATFORM_META_SPECS and testIgnore'd on consumer lanes.
/*
 * REGRESSION GUARD for the scheduled-run alerting layer (2026-07 audit):
 * scheduled workflows fail SILENTLY (adamdaniel's editorial-label-audit red
 * 24/30 days unnoticed; jodidaniel's sweep-stale-cms-prs 30/30 for a month).
 * The scheduled-run-health reusable scans the caller's last-48h schedule-event
 * runs and files/updates ONE tracking issue. These lints lock the shapes that
 * made previous scheduled workflows silently break:
 *   - the reusable must pass --repo ${{ github.repository }} (sparse checkout
 *     leaves no git repo — the editorial-label-audit v0.1.16 trap);
 *   - callers must declare the dispatch dry_run input as `type: string` +
 *     fromJSON-coerce it (typed booleans startup-fail the workflow_call
 *     handoff — the exact failure class this audit exists to catch);
 *   - callers must grant actions: read + issues: write (reusable permissions
 *     are capped by the caller's grant).
 * Plus unit tests of the audit script's pure helpers (conclusion filtering,
 * run-id dedupe, issue-body construction), exported via the require.main
 * guard so importing never runs the CLI.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, events } = require("./workflow-yaml-utils");

const SCRIPT_PATH = path.resolve(__dirname, "../scripts/audit-scheduled-runs.js");
const EXAMPLE_CALLER = path.resolve(
  __dirname,
  "../examples/site/.github/workflows/scheduled-run-health.yml",
);

function loadScript() {
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

function run(overrides = {}) {
  return {
    id: 1,
    name: "Some workflow",
    path: ".github/workflows/some.yml",
    event: "schedule",
    conclusion: "failure",
    html_url: "https://github.com/o/r/actions/runs/1",
    run_started_at: "2026-07-05T09:00:00Z",
    created_at: "2026-07-05T09:00:00Z",
    ...overrides,
  };
}

// A job of a run, shaped like the API's /jobs entries. Defaults are a NORMAL
// job (a real runner picked it up) so each test overrides only what it means.
function job(overrides = {}) {
  return {
    name: "some / some",
    status: "completed",
    conclusion: "success",
    runner_id: 1000003871,
    runner_name: "GitHub Actions 1000003871",
    steps: [{ number: 1 }],
    ...overrides,
  };
}

test.describe("scheduled-run-health.yml (reusable) — workflow shape", () => {
  const raw = readWorkflow("scheduled-run-health.yml");
  const doc = parseYaml(raw);

  test("is workflow_call-only with the (reusable) name suffix", () => {
    expect(events(doc.on)).toEqual(["workflow_call"]);
    expect(doc.name).toMatch(/\(reusable\)$/);
  });

  // Every assertion below reads the PARSED step (its `env` map and its `run`
  // body), not the raw file text. The previous versions text-matched the exact
  // interpolation, which is how the push_scan bug shipped WITH coverage: the
  // spec asserted the literal characters `inputs.push_scan && '' || '--no-push-scan'`
  // were present, and they were — while meaning the opposite of what was
  // intended. A spelling check is not a behaviour check.
  const auditStep = doc.jobs.audit.steps.find((s) => /audit-scheduled-runs\.js/.test(s.run || ""));

  test("the audit step passes the caller's repo, via env not inline", () => {
    // The reusable SPARSE-checks-out only the audit script — github.workspace
    // is not a git repo, so gh cannot infer the repo from a local remote.
    expect(auditStep, "no step invokes audit-scheduled-runs.js").toBeTruthy();
    expect(auditStep.env.AUDIT_REPO).toMatch(/\$\{\{\s*github\.repository\s*\}\}/);
    expect(auditStep.run).toMatch(/--repo\s+"\$AUDIT_REPO"/);
  });

  test("declares actions: read + issues: write (list runs / file the alert)", () => {
    expect(doc.permissions).toMatchObject({ actions: "read", issues: "write" });
  });

  test("dry_run input (boolean, default false) adds --dry-run only when true", () => {
    const inputs = doc.on.workflow_call.inputs;
    expect(inputs.dry_run).toMatchObject({ type: "boolean", default: false });
    expect(auditStep.env.AUDIT_DRY_RUN).toMatch(/\$\{\{\s*inputs\.dry_run\s*\}\}/);
    // OPT-IN: the flag is added when the env value IS "true".
    expect(auditStep.run).toMatch(/if\s+\[\[\s+"\$AUDIT_DRY_RUN"\s+==\s+"true"\s+\]\];\s*then\s+args\+=\(--dry-run\)/);
  });

  test("push_scan (boolean, default TRUE) adds --no-push-scan only when NOT true (#279)", () => {
    // Default true is deliberate — see the reusable's header: an opt-in-off
    // flag would leave exactly the repos that need this uncovered.
    const inputs = doc.on.workflow_call.inputs;
    expect(inputs.push_scan).toMatchObject({ type: "boolean", default: true });
    expect(auditStep.env.AUDIT_PUSH_SCAN).toMatch(/\$\{\{\s*inputs\.push_scan\s*\}\}/);
    // OPT-OUT, and the polarity is the whole point: `!=` not `==`. Measured on
    // run 32280743541, the previous inline form emitted --no-push-scan
    // unconditionally, so a dispatch with push_scan=true silently skipped the
    // push scan and still reported "0 failing push run(s)" from a static default.
    expect(auditStep.run).toMatch(/if\s+\[\[\s+"\$AUDIT_PUSH_SCAN"\s+!=\s+"true"\s+\]\];\s*then\s+args\+=\(--no-push-scan\)/);
    // And it must never be emitted unconditionally again.
    expect(auditStep.run).not.toMatch(/^\s*args\+=\(--no-push-scan\)\s*$/m);
  });

  test("window_hours and issue_label pass through to the script", () => {
    const inputs = doc.on.workflow_call.inputs;
    // Strings, so thin callers can wire dispatch inputs straight through.
    expect(inputs.window_hours).toMatchObject({ type: "string", default: "48" });
    expect(inputs.issue_label).toMatchObject({ type: "string", default: "ci" });
    expect(auditStep.env.AUDIT_WINDOW_HOURS).toMatch(/\$\{\{\s*inputs\.window_hours\s*\}\}/);
    expect(auditStep.env.AUDIT_LABEL).toMatch(/\$\{\{\s*inputs\.issue_label\s*\}\}/);
    expect(auditStep.run).toMatch(/--window-hours\s+"\$AUDIT_WINDOW_HOURS"/);
    expect(auditStep.run).toMatch(/--label\s+"\$AUDIT_LABEL"/);
  });
});

// Both thin callers (the platform self-caller + the examples/site template a
// consumer seeds) must carry the same non-negotiable caller-side shapes.
const CALLERS = [
  { label: "self-scheduled-run-health.yml (platform self-caller)", text: () => readWorkflow("self-scheduled-run-health.yml") },
  { label: "examples/site scheduled-run-health.yml (consumer template)", text: () => fs.readFileSync(EXAMPLE_CALLER, "utf8") },
];

for (const { label, text } of CALLERS) {
  test.describe(`${label} — caller shape`, () => {
    test("schedules daily and allows manual dispatch", () => {
      const doc = parseYaml(text());
      const evs = events(doc.on);
      expect(evs).toContain("schedule");
      expect(evs).toContain("workflow_dispatch");
      const crons = doc.on.schedule.map((s) => s.cron);
      expect(crons.length).toBeGreaterThan(0);
      // Daily cadence: the 48h scan window assumes ~daily runs; a weekly cron
      // would open a blind gap even with the overlap.
      expect(crons[0]).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    });

    test("dispatch dry_run is type: string and fromJSON-coerced (startup-failure trap)", () => {
      // workflow_dispatch hands typed booleans to a reusable's `with:` as
      // strings; the reusable's boolean input then rejects them and the run
      // STARTUP-FAILS — invisibly, which is precisely the failure class this
      // audit exists to surface. Never regress the caller to type: boolean.
      const doc = parseYaml(text());
      const input = doc.on.workflow_dispatch.inputs.dry_run;
      expect(input.type).toBe("string");
      expect(input.default).toBe("false");
      expect(text()).toMatch(
        /dry_run:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*fromJSON\(inputs\.dry_run\)\s*\|\|\s*false\s*\}\}/,
      );
    });

    test("grants the reusable's needed permissions (caller caps the token)", () => {
      const doc = parseYaml(text());
      expect(doc.permissions).toMatchObject({ actions: "read", issues: "write" });
    });

    test("calls the scheduled-run-health reusable", () => {
      const doc = parseYaml(text());
      const uses = doc.jobs.audit.uses;
      expect(uses).toMatch(/\.github\/workflows\/scheduled-run-health\.yml/);
    });
  });
}

test.describe("audit-scheduled-runs.js — pure helpers", () => {
  test("importing never runs the CLI (require.main guard)", () => {
    // Would throw/exit if the CLI ran (no gh auth in the lint lane).
    expect(() => loadScript()).not.toThrow();
  });

  test("sinceIso subtracts the window in hours (second precision, Z)", () => {
    const { sinceIso } = loadScript();
    const now = Date.parse("2026-07-06T10:00:00.000Z");
    expect(sinceIso(now, 48)).toBe("2026-07-04T10:00:00Z");
    expect(sinceIso(now, 0)).toBe("2026-07-06T10:00:00Z");
  });

  test("filterAlertRuns keeps only completed schedule-event failure classes", () => {
    const { filterAlertRuns, BAD_CONCLUSIONS } = loadScript();
    expect(BAD_CONCLUSIONS).toEqual(["failure", "startup_failure", "timed_out"]);
    const runs = [
      run({ id: 1, conclusion: "failure" }),
      run({ id: 2, conclusion: "startup_failure" }),
      run({ id: 3, conclusion: "timed_out" }),
      run({ id: 4, conclusion: "success" }),
      // Cancelled is by-design (loop concurrency supersession) — not a health signal.
      run({ id: 5, conclusion: "cancelled" }),
      // Still running: no conclusion yet.
      run({ id: 6, conclusion: null }),
      // Not a scheduled run — a dispatch failure has an actor watching it.
      run({ id: 7, event: "workflow_dispatch", conclusion: "failure" }),
    ];
    expect(filterAlertRuns(runs).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  test("filterAlertRuns applies the since cutoff client-side (defense in depth)", () => {
    const { filterAlertRuns } = loadScript();
    const runs = [
      run({ id: 1, run_started_at: "2026-07-05T09:00:00Z" }),
      run({ id: 2, run_started_at: "2026-07-01T09:00:00Z" }),
    ];
    expect(filterAlertRuns(runs, "2026-07-04T10:00:00Z").map((r) => r.id)).toEqual([1]);
  });

  test("isAlertRun / filterAlertRuns generalize to event=push via default params (#279)", () => {
    // Every existing call site (above) omits `event` and must keep seeing
    // ONLY schedule runs — the default param is what makes that byte-
    // identical. The push lane (default-branch push failures are exactly as
    // silent as scheduled ones) is the first caller to pass "push" explicitly.
    const { isAlertRun, filterAlertRuns } = loadScript();
    const scheduled = run({ id: 1, event: "schedule", conclusion: "failure" });
    const pushed = run({ id: 2, event: "push", conclusion: "failure" });
    expect(isAlertRun(scheduled)).toBe(true);
    expect(isAlertRun(pushed)).toBe(false);
    expect(isAlertRun(pushed, "push")).toBe(true);
    expect(isAlertRun(scheduled, "push")).toBe(false);

    const runs = [scheduled, pushed];
    expect(filterAlertRuns(runs).map((r) => r.id)).toEqual([1]);
    expect(filterAlertRuns(runs, undefined, "push").map((r) => r.id)).toEqual([2]);
  });

  test("runsForEventEndpoint: the schedule shape is byte-identical to the pre-#279 endpoint", () => {
    const { runsForEventEndpoint } = loadScript();
    expect(runsForEventEndpoint("o/r", "schedule", "2026-07-04T10:00:00Z", 1)).toBe(
      `repos/o/r/actions/runs?event=schedule&created=${encodeURIComponent(
        ">=2026-07-04T10:00:00Z",
      )}&per_page=100&page=1`,
    );
  });

  test("runsForEventEndpoint: the push lane scopes to event=push + branch=<default_branch> (#279)", () => {
    // Mirrors runJobsEndpoint's pagination-shape test below — the push
    // listing shape stays unit-assertable without shelling out to gh.
    const { runsForEventEndpoint } = loadScript();
    expect(
      runsForEventEndpoint("o/r", "push", "2026-07-04T10:00:00Z", 2, "&branch=main"),
    ).toBe(
      `repos/o/r/actions/runs?event=push&created=${encodeURIComponent(
        ">=2026-07-04T10:00:00Z",
      )}&branch=main&per_page=100&page=2`,
    );
  });

  test("groupByWorkflow groups by workflow FILE basename (never run.name), newest run first", () => {
    // run.name is the run's DISPLAY TITLE — for this repo family the evaluated
    // dynamic `run-name:` (e.g. "scheduled — 0 12 * * *"), which never says
    // WHICH workflow failed. The workflow file basename is the stable identity.
    const { groupByWorkflow, workflowKey } = loadScript();
    const grouped = groupByWorkflow([
      run({ id: 1, name: "scheduled — 0 12 * * *", path: ".github/workflows/a.yml", run_started_at: "2026-07-05T01:00:00Z" }),
      run({ id: 2, name: "scheduled — 0 13 * * *", path: ".github/workflows/b.yml", run_started_at: "2026-07-05T03:00:00Z" }),
      run({ id: 3, name: "manual — @someone", path: ".github/workflows/a.yml", run_started_at: "2026-07-05T02:00:00Z" }),
    ]);
    expect([...grouped.keys()]).toEqual(["b.yml", "a.yml"]); // most recent breakage first
    expect(grouped.get("a.yml").map((r) => r.id)).toEqual([3, 1]);
    // Fallback when the API omits path entirely.
    expect(workflowKey({ name: "X" })).toBe("X");
    expect(workflowKey({})).toBe("(unknown workflow)");
  });

  test("run-id dedupe roundtrip: every reported run id is recoverable, even past the visible cap", () => {
    const { buildIssueBody, buildComment, extractReportedRunIds, MAX_LINKS_PER_WORKFLOW } =
      loadScript();
    // More failures than the visible per-workflow link cap: the hidden
    // run-ids block must still record ALL of them, or tomorrow's audit
    // re-reports the capped-away runs forever.
    const many = Array.from({ length: MAX_LINKS_PER_WORKFLOW + 3 }, (_, i) =>
      run({ id: 100 + i, html_url: `https://github.com/o/r/actions/runs/${100 + i}` }),
    );
    const body = buildIssueBody({
      repo: "o/r",
      windowHours: 48,
      runs: many,
      nowIso: "2026-07-06T10:00:00Z",
    });
    const ids = extractReportedRunIds([body]);
    for (const r of many) expect(ids.has(String(r.id))).toBe(true);

    const comment = buildComment({ windowHours: 48, runs: many, nowIso: "2026-07-06T10:00:00Z" });
    const commentIds = extractReportedRunIds([comment]);
    for (const r of many) expect(commentIds.has(String(r.id))).toBe(true);
  });

  test("extractReportedRunIds also falls back to run URLs (hand-written comments)", () => {
    const { extractReportedRunIds } = loadScript();
    const ids = extractReportedRunIds([
      "see https://github.com/o/r/actions/runs/4242 for the fix",
      null,
      "<!-- run-ids: 7 8 -->",
    ]);
    expect(ids.has("4242")).toBe(true);
    expect(ids.has("7")).toBe(true);
    expect(ids.has("8")).toBe(true);
  });

  test("the issue body carries the stable marker the next scan finds it by", () => {
    const { buildIssueBody, MARKER } = loadScript();
    const body = buildIssueBody({
      repo: "o/r",
      windowHours: 48,
      runs: [run()],
      nowIso: "2026-07-06T10:00:00Z",
    });
    expect(MARKER).toBe("<!-- scheduled-run-health-audit -->");
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("https://github.com/o/r/actions/runs/1");
  });

  test("renderFindings caps visible links per workflow and says how many were elided", () => {
    const { renderFindings, MAX_LINKS_PER_WORKFLOW } = loadScript();
    const many = Array.from({ length: MAX_LINKS_PER_WORKFLOW + 4 }, (_, i) =>
      run({ id: 200 + i, html_url: `https://github.com/o/r/actions/runs/${200 + i}` }),
    );
    const md = renderFindings(many);
    const links = md.match(/\/actions\/runs\/\d+/g) || [];
    expect(links.length).toBe(MAX_LINKS_PER_WORKFLOW);
    expect(md).toContain("and 4 more");
  });
});

/*
 * RUNNER STARVATION: GitHub reports the RUN as `failure` when its job(s) were
 * cancelled before a runner was ever assigned, so BAD_CONCLUSIONS (a RUN-level
 * test) alerted on pure infrastructure noise. Every fixture below is a VERIFIED
 * live shape from jodidaniel/jodidaniel.com — field-for-field, including the
 * asymmetry that a starved CANCELLED job carries `runner_id: 0` while a SKIPPED
 * job carries `runner_id: null`.
 */
test.describe("audit-scheduled-runs.js — runner-starvation suppression", () => {
  test("suppresses a run whose only job was cancelled with no runner (run 31118167966)", () => {
    const { isRunnerStarvationRun } = loadScript();
    const r = run({
      id: 31118167966,
      path: ".github/workflows/publish-scheduled-posts.yml",
      conclusion: "failure",
      created_at: "2026-08-06T15:59:06Z",
      run_started_at: "2026-08-06T15:59:06Z",
    });
    const jobs = [
      job({ name: "publish / publish", conclusion: "cancelled", runner_id: 0, runner_name: "", steps: [] }),
    ];
    expect(isRunnerStarvationRun(r, jobs)).toBe(true);
  });

  test("suppresses cancelled-starved + skipped, whose runner_id is null not 0 (run 31120011930)", () => {
    // The skipped job must be tolerated by clause (v) WITHOUT a runner test —
    // keying starvation on `runner_id == null` would mis-classify skipped jobs.
    const { isRunnerStarvationRun, isRunnerStarvedJob } = loadScript();
    const r = run({
      id: 31120011930,
      path: ".github/workflows/cms-media-roundtrip.yml",
      conclusion: "failure",
    });
    const gate = job({
      name: "media-roundtrip / recursion-gate",
      conclusion: "cancelled",
      runner_id: 0,
      runner_name: "",
      steps: [],
    });
    const heavy = job({
      name: "media-roundtrip / media-roundtrip",
      conclusion: "skipped",
      runner_id: null,
      runner_name: null,
      steps: [],
    });
    expect(isRunnerStarvedJob(gate)).toBe(true);
    expect(isRunnerStarvedJob(heavy)).toBe(false);
    expect(isRunnerStarvationRun(r, [gate, heavy])).toBe(true);
  });

  test("NEGATIVE: a job that genuinely FAILED on a real runner still alerts (run 31242320695)", () => {
    const { isRunnerStarvationRun } = loadScript();
    const r = run({
      id: 31242320695,
      path: ".github/workflows/cms-scheduled-publish-loop.yml",
      conclusion: "failure",
    });
    const jobs = [
      job({
        conclusion: "failure",
        runner_id: 1000003871,
        runner_name: "GitHub Actions 1000003871",
        steps: Array.from({ length: 16 }, (_, i) => ({ number: i + 1 })),
      }),
    ];
    expect(isRunnerStarvationRun(r, jobs)).toBe(false);
  });

  test("NEGATIVE: a zero-job startup_failure still alerts (clause (i) — the regression that matters most)", () => {
    // `[].every()` is vacuously true, so an empty job list reaching clause (v)
    // would silence the exact class this audit exists for (jodidaniel's sweep
    // startup-failed 30/30 for a month). Both guards are asserted: no jobs at
    // all, and a startup_failure that somehow reports a starved job.
    const { isRunnerStarvationRun } = loadScript();
    const r = run({ id: 42, conclusion: "startup_failure" });
    expect(isRunnerStarvationRun(r, [])).toBe(false);
    expect(isRunnerStarvationRun(run({ id: 43, conclusion: "failure" }), [])).toBe(false);
    expect(
      isRunnerStarvationRun(r, [job({ conclusion: "cancelled", runner_id: 0, runner_name: "" })]),
    ).toBe(false);
  });

  test("NEGATIVE: a job cancelled MID-RUN on a real runner still alerts", () => {
    // Superseded-by-concurrency is the run-level `cancelled` case BAD_CONCLUSIONS
    // already drops; a real-runner cancellation inside a `failure` run is a
    // genuine signal and must not be swallowed by the starvation carve-out.
    const { isRunnerStarvationRun } = loadScript();
    const jobs = [job({ conclusion: "cancelled", runner_id: 1000003871, runner_name: "GitHub Actions 1000003871" })];
    expect(isRunnerStarvationRun(run({ conclusion: "failure" }), jobs)).toBe(false);
  });

  test("the jobs request is EXPLICITLY paginated at per_page=100 (a bare /jobs returns 30)", () => {
    // A partial job set would evaluate the predicate on a truncated matrix and
    // silently mis-classify a big-matrix run.
    const { runJobsEndpoint } = loadScript();
    expect(runJobsEndpoint("o/r", 31118167966, 1)).toBe(
      "repos/o/r/actions/runs/31118167966/jobs?per_page=100&page=1",
    );
    expect(runJobsEndpoint("o/r", 7, 3)).toContain("per_page=100&page=3");
  });

  test("partitionStarvedRuns fails SOFT: a jobs-fetch error keeps the run alertable", () => {
    const { partitionStarvedRuns } = loadScript();
    const starved = run({ id: 1, conclusion: "failure" });
    const unreadable = run({ id: 2, conclusion: "failure" });
    const { alertable, suppressed } = partitionStarvedRuns([starved, unreadable], (r) => {
      if (r.id === 2) throw new Error("gh: 502 Bad Gateway");
      return [job({ conclusion: "cancelled", runner_id: 0, runner_name: "", steps: [] })];
    });
    expect(suppressed.map((r) => r.id)).toEqual([1]);
    expect(alertable.map((r) => r.id)).toEqual([2]);
  });
});

/*
 * DEAD SCHEDULED WORKFLOWS (#258): the audit alerted only on runs that EXIST
 * and concluded badly. A workflow GitHub auto-disabled for inactivity emits NO
 * runs, so `filterAlertRuns` returned `[]` — byte-identical to a repo with no
 * schedules — and the `failures.length === 0` branch printed "All scheduled
 * workflows healthy" AND closed any open tracking issue. A repo whose crons
 * went dark mid-incident had its own alert actively closed.
 *
 * The signal is one field: GET /repos/{repo}/actions/workflows returns
 * `state` ∈ active | deleted | disabled_fork | disabled_inactivity |
 * disabled_manually. These lock the widened input set (bad runs → bad runs +
 * dead workflows) and the two properties that keep it from re-introducing the
 * bug: the public-repos-only exemption, and never scoring an UNKNOWN answer
 * as health.
 */
test.describe("audit-scheduled-runs.js — dead scheduled workflows (#258)", () => {
  // A workflow entry as GET /actions/workflows returns it.
  function wf(overrides = {}) {
    return {
      id: 1001,
      name: "Some workflow",
      path: ".github/workflows/some.yml",
      state: "active",
      ...overrides,
    };
  }

  test("THE BUG: zero runs + a disabled_inactivity cron workflow is a finding, not health", () => {
    // The headline acceptance from #258. `filterAlertRuns([])` is `[]` and
    // always will be — absence is not a conclusion. The finding set must stop
    // being sourced from runs alone.
    const { filterAlertRuns, filterDeadScheduledWorkflows } = loadScript();
    expect(filterAlertRuns([], "2026-08-14T00:00:00Z")).toEqual([]);

    const dead = filterDeadScheduledWorkflows(
      [wf({ id: 7, path: ".github/workflows/propagation.yml", state: "disabled_inactivity" })],
      () => true,
    );
    expect(dead.map((w) => w.path)).toEqual([".github/workflows/propagation.yml"]);
  });

  test("flags disabled_inactivity + disabled_manually; skips active/deleted/fork", () => {
    // `deleted` and `disabled_fork` are deliberate exclusions: a deleted
    // workflow was removed on purpose (its file is gone), and disabled_fork is
    // a fork-only state, not a broken cron. Alerting on either is pure noise.
    const { filterDeadScheduledWorkflows, DEAD_WORKFLOW_STATES } = loadScript();
    expect(DEAD_WORKFLOW_STATES).toEqual(["disabled_inactivity", "disabled_manually"]);
    const all = [
      wf({ id: 1, path: ".github/workflows/a.yml", state: "active" }),
      wf({ id: 2, path: ".github/workflows/b.yml", state: "disabled_inactivity" }),
      wf({ id: 3, path: ".github/workflows/c.yml", state: "disabled_manually" }),
      wf({ id: 4, path: ".github/workflows/d.yml", state: "deleted" }),
      wf({ id: 5, path: ".github/workflows/e.yml", state: "disabled_fork" }),
    ];
    expect(filterDeadScheduledWorkflows(all, () => true).map((w) => w.id)).toEqual([2, 3]);
  });

  test("a disabled workflow that never fired a cron is NOT reported", () => {
    // Scoping to cron-bearing workflows: a manually-disabled workflow that
    // never had a schedule-event run is not this audit's business.
    const { filterDeadScheduledWorkflows } = loadScript();
    const all = [
      wf({ id: 2, path: ".github/workflows/cron.yml", state: "disabled_inactivity" }),
      wf({ id: 3, path: ".github/workflows/manual.yml", state: "disabled_manually" }),
    ];
    const dead = filterDeadScheduledWorkflows(all, (w) => w.id === 2);
    expect(dead.map((w) => w.id)).toEqual([2]);
  });

  test("the schedule probe fails SOFT: an unreadable workflow stays REPORTED", () => {
    // Same direction as partitionStarvedRuns — silently dropping a possibly
    // dead cron is the worse outcome, so an errored probe reports.
    //
    // THE STATE MATTERS: `disabled_inactivity` short-circuits the probe
    // entirely, so only `disabled_manually` still reaches the try/catch. These
    // fixtures were disabled_inactivity until the short-circuit landed —
    // measured, the test then passed with ZERO probe calls and asserted
    // nothing about fail-soft. Do not change them back.
    const { filterDeadScheduledWorkflows } = loadScript();
    const all = [
      wf({ id: 2, path: ".github/workflows/ok.yml", state: "disabled_manually" }),
      wf({ id: 3, path: ".github/workflows/boom.yml", state: "disabled_manually" }),
    ];
    const dead = filterDeadScheduledWorkflows(all, (w) => {
      if (w.id === 3) throw new Error("gh: 502 Bad Gateway");
      return true;
    });
    expect(dead.map((w) => w.id)).toEqual([2, 3]);
  });

  test("a dead cron whose run RECORDS are gone is STILL a finding (#258 deferred)", () => {
    // The probe answers "no runs" identically for "never a cron" and "the run
    // records are gone" (deleted via DELETE /actions/runs/{id} or the Actions
    // tab). For disabled_inactivity the state already proves the workflow is
    // cron-bearing, so the probe must not get a vote — a "no" there would drop
    // the workflow from the finding set silently, which is #258 all over again.
    const { filterDeadScheduledWorkflows } = loadScript();
    const dead = filterDeadScheduledWorkflows(
      [wf({ id: 99, path: ".github/workflows/sweep.yml", state: "disabled_inactivity" })],
      () => false,
    );
    expect(dead.map((w) => w.id)).toEqual([99]);
  });

  test("a self-evidencing state never CALLS the probe (one fewer API call)", () => {
    const { filterDeadScheduledWorkflows, stateImpliesCron, SELF_EVIDENCING_CRON_STATES } =
      loadScript();
    expect(SELF_EVIDENCING_CRON_STATES).toEqual(["disabled_inactivity"]);
    expect(stateImpliesCron({ state: "disabled_inactivity" })).toBe(true);
    expect(stateImpliesCron({ state: "disabled_manually" })).toBe(false);
    let calls = 0;
    filterDeadScheduledWorkflows([wf({ id: 99, state: "disabled_inactivity" })], () => {
      calls += 1;
      return true;
    });
    expect(calls).toBe(0);
  });

  test("disabled_manually KEEPS the probe: no scheduled runs, not reported", () => {
    // THE NOISE BOUNDARY. This guards a DIFFERENT mutation from the two tests
    // above: widening SELF_EVIDENCING_CRON_STATES to include
    // "disabled_manually". Doing that would report every hand-disabled
    // workflow, making dead.length > 0 permanent — and main()'s close branch is
    // gated on `failures.length === 0 && dead.length === 0`, so the tracking
    // issue could never auto-close again.
    const { filterDeadScheduledWorkflows } = loadScript();
    expect(
      filterDeadScheduledWorkflows([wf({ id: 98, state: "disabled_manually" })], () => false),
    ).toEqual([]);
    expect(
      filterDeadScheduledWorkflows([wf({ id: 98, state: "disabled_manually" })], () => true).map(
        (w) => w.id,
      ),
    ).toEqual([98]);
  });

  test("the schedule probe is a per_page=1 schedule-event runs query", () => {
    const { workflowScheduledRunsEndpoint } = loadScript();
    expect(workflowScheduledRunsEndpoint("o/r", 1001)).toBe(
      "repos/o/r/actions/workflows/1001/runs?event=schedule&per_page=1",
    );
  });

  test("visibility: public runs the check, private is exempt, UNKNOWN is neither", () => {
    // GitHub auto-disables scheduled workflows in PUBLIC repos only, and
    // `repo-settings` is private with crons that are off by intent. A missing
    // or non-boolean `private` must NOT read as public OR as private — an
    // ambiguous answer is a probe failure, never a silent skip (that is the
    // absence-as-health bug in a new costume).
    const { isPublicRepo, isPrivateRepo } = loadScript();
    expect(isPublicRepo({ private: false })).toBe(true);
    expect(isPrivateRepo({ private: false })).toBe(false);
    expect(isPublicRepo({ private: true })).toBe(false);
    expect(isPrivateRepo({ private: true })).toBe(true);
    for (const meta of [null, undefined, {}, { private: "false" }, { visibility: "public" }]) {
      expect(isPublicRepo(meta)).toBe(false);
      expect(isPrivateRepo(meta)).toBe(false);
    }
  });

  test("dead workflows reach the issue body, with their own dedupe block", () => {
    // Runs dedupe by run id; a dead workflow has no run to key on, so it needs
    // a parallel hidden block or every daily audit re-comments the same
    // corpse forever.
    const { buildIssueBody, extractReportedDeadWorkflows, MARKER } = loadScript();
    const dead = [
      {
        id: 7,
        name: "Propagation",
        path: ".github/workflows/propagation.yml",
        state: "disabled_inactivity",
      },
    ];
    const body = buildIssueBody({
      repo: "o/r",
      windowHours: 48,
      runs: [],
      dead,
      nowIso: "2026-08-16T10:00:00Z",
    });
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("propagation.yml");
    expect(body).toContain("disabled_inactivity");
    expect(extractReportedDeadWorkflows([body]).has("propagation.yml")).toBe(true);
  });

  test("dead workflows dedupe through a comment too, and survive a mixed report", () => {
    const { buildComment, extractReportedDeadWorkflows, extractReportedRunIds } = loadScript();
    const dead = [
      { id: 7, path: ".github/workflows/sweep.yml", state: "disabled_manually" },
      { id: 8, path: ".github/workflows/eval.yml", state: "disabled_inactivity" },
    ];
    const comment = buildComment({
      windowHours: 48,
      runs: [run({ id: 4242 })],
      dead,
      nowIso: "2026-08-16T10:00:00Z",
    });
    const names = extractReportedDeadWorkflows([comment]);
    expect(names.has("sweep.yml")).toBe(true);
    expect(names.has("eval.yml")).toBe(true);
    // The two dedupe channels must not clobber each other.
    expect(extractReportedRunIds([comment]).has("4242")).toBe(true);
    expect(extractReportedDeadWorkflows(["<!-- run-ids: 1 2 -->"]).size).toBe(0);
  });

  test("omitting `dead` keeps the runs-only body byte-identical (back-compat)", () => {
    const { buildIssueBody } = loadScript();
    const base = { repo: "o/r", windowHours: 48, runs: [run()], nowIso: "2026-08-16T10:00:00Z" };
    expect(buildIssueBody({ ...base, dead: [] })).toBe(buildIssueBody(base));
  });
});

/*
 * DEFAULT-BRANCH PUSH FAILURES (#279): a `push`-to-default-branch failure is
 * exactly as silent as a scheduled one — no PR to go red on. Live incident,
 * 2026-08: a `.gitleaks.toml` change on adamdaniel.ai passed its PR check but
 * broke `secrets-scan.yml`'s `push`-to-`main` run for 8 CONSECUTIVE pushes,
 * each one a blocked Decap editorial publish, with no tracking issue ever
 * filed. The push lane reuses every mechanism the scheduled lane already has
 * (isAlertRun/filterAlertRuns via the `event` param, the same run-id dedupe
 * channel, the same runner-starvation suppression) and renders as its OWN
 * section — never merged into the scheduled list, because `secrets-scan.yml`
 * fires on BOTH events and a merged list would bury exactly the signal the
 * incident needed: "scheduled green, push on fire".
 */
test.describe("audit-scheduled-runs.js — default-branch push lane (#279)", () => {
  const pushRun = (overrides = {}) =>
    run({
      id: 601,
      event: "push",
      path: ".github/workflows/secrets-scan.yml",
      html_url: "https://github.com/o/r/actions/runs/601",
      ...overrides,
    });

  test("renderSections renders the push lane as its OWN section, never merged with scheduled", () => {
    const { renderSections } = loadScript();
    const scheduled = [run({ id: 1, path: ".github/workflows/a.yml" })];
    const pushed = [pushRun()];
    const rendered = renderSections(scheduled, [], pushed, "main").join("\n");
    expect(rendered).toContain("**Failing scheduled runs**");
    expect(rendered).toContain(
      "**Failing default-branch push runs** (`event=push` on `main` ending in " +
        "`failure` / `startup_failure` / `timed_out`):",
    );
    expect(rendered).toContain("secrets-scan.yml");
    expect(rendered).toContain("https://github.com/o/r/actions/runs/601");
    // Two DISTINCT sections, in order — not one list with both runs interleaved.
    const scheduledIdx = rendered.indexOf("**Failing scheduled runs**");
    const pushIdx = rendered.indexOf("**Failing default-branch push runs**");
    expect(scheduledIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThan(scheduledIdx);
  });

  // The per-workflow line under each heading must name the lane it is IN.
  // `renderFindings` serves both lanes and used to hardcode "scheduled run", so
  // the push section shipped saying "**secrets-scan.yml** — 8 failing SCHEDULED
  // run(s)" under a heading that said PUSH. Observed live on adamdaniel.ai#3173
  // (comment 5350014233), the first time the push lane ever ran against real
  // data. The test above did not catch it because it asserted the HEADING and
  // never the line beneath — so this asserts the line beneath, per lane.
  test("each lane's per-workflow line names its OWN lane, not the other's", () => {
    const { renderSections } = loadScript();
    const rendered = renderSections(
      [run({ id: 1, path: ".github/workflows/a.yml" })],
      [],
      [pushRun()],
      "main",
    ).join("\n");
    expect(rendered).toContain("**a.yml** — 1 failing scheduled run(s):");
    expect(rendered).toContain("**secrets-scan.yml** — 1 failing default-branch push run(s):");
    // And the contradiction itself is impossible: no line may sit under the
    // push heading while calling its runs "scheduled".
    const pushSection = rendered.slice(rendered.indexOf("**Failing default-branch push runs**"));
    expect(pushSection).not.toContain("failing scheduled run(s)");
  });

  test("renderSections omits the push section entirely when pushRuns is empty", () => {
    const { renderSections } = loadScript();
    const rendered = renderSections([run({ id: 1 })], [], [], "main").join("\n");
    expect(rendered).not.toContain("push run");
  });

  test("omitting `pushRuns` keeps the body byte-identical (back-compat)", () => {
    const { buildIssueBody, buildComment } = loadScript();
    const base = { repo: "o/r", windowHours: 48, runs: [run()], nowIso: "2026-08-16T10:00:00Z" };
    expect(buildIssueBody({ ...base, pushRuns: [] })).toBe(buildIssueBody(base));
    const commentBase = { windowHours: 48, runs: [run()], nowIso: "2026-08-16T10:00:00Z" };
    expect(buildComment({ ...commentBase, pushRuns: [] })).toBe(buildComment(commentBase));
  });

  test("run-id dedupe roundtrip: a push run recorded once is filtered out of the next scan's fresh set", () => {
    // The push lane has REAL run ids (unlike a dead workflow), so it dedupes
    // through the SAME hidden run-ids channel as scheduled runs — no second
    // hidden block. This is the exact `fresh`/`freshPush` computation main()
    // does against the shared `reported` set.
    const { buildIssueBody, extractReportedRunIds } = loadScript();
    const scheduled = run({ id: 501 });
    const pushed = pushRun();
    const body = buildIssueBody({
      repo: "o/r",
      windowHours: 48,
      runs: [scheduled],
      pushRuns: [pushed],
      defaultBranch: "main",
      nowIso: "2026-08-16T10:00:00Z",
    });
    const reported = extractReportedRunIds([body]);
    expect(reported.has("501")).toBe(true);
    expect(reported.has("601")).toBe(true);

    // Next scan: run 601 is STILL failing, plus a genuinely new push run 602.
    const nextPushFailures = [pushed, pushRun({ id: 602 })];
    const freshPush = nextPushFailures.filter((r) => !reported.has(String(r.id)));
    expect(freshPush.map((r) => r.id)).toEqual([602]);
  });
});

// ── main() lifecycle: the issue is never closed on an incomplete answer ───────
//
// THE #258 BUG LIVED IN main(), AND NOWHERE ELSE. Every pure helper above can
// be correct while the audit still closes a live alert, because the decision to
// close is two conditions in the lifecycle — `dead.length === 0` and
// `!deadProbeFailed`. Revert either and the bug is back with all the helper
// tests still green, which is how it shipped the first time. These two tests
// drive the real CLI end to end so that can't happen twice.
//
// `ghApi` shells out to `gh`, so a `gh` stub earlier on PATH is the entire
// injection seam: no production code changes shape to be testable, and what
// gets asserted is the argv the script really builds (`-X PATCH -f
// state=closed`) rather than a mock's idea of it.
//
// Deterministic: no network, no sleeps, and both fixtures return ZERO runs, so
// nothing depends on where "now" falls relative to a run's timestamp.

// A `gh` that answers from a canned endpoint table and records every call.
// Routes are tried in order: ["has", substring, body] or ["eq", endpoint, body]
// (`eq` for `repos/o/r`, which is a substring of every other endpoint). A body
// of null forces a non-zero exit. An UNMATCHED endpoint also exits non-zero
// rather than returning something plausible — a silent wrong answer here would
// be indistinguishable from the bug under test.
function ghStubDir(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-"));
  const log = path.join(dir, "calls.jsonl");
  const routesFile = path.join(dir, "routes.json");
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  const bin = path.join(dir, "gh");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
// Logged BEFORE routing, so a call this table refuses to answer is still
// recorded — an attempted close must be visible even when it then fails.
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const endpoint = argv[0] === "api" ? argv[1] : "";
for (const [kind, pattern, body] of JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"))) {
  if (kind === "eq" ? endpoint !== pattern : !endpoint.includes(pattern)) continue;
  if (body === null) {
    console.error("gh stub: forced failure for " + endpoint);
    process.exit(1);
  }
  process.stdout.write(body);
  process.exit(0);
}
console.error("gh stub: no route for " + endpoint);
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

// The one call that must not happen on either path below.
function closeCalls(log) {
  return callsOf(log).filter((argv) => argv.includes("PATCH") && argv.includes("state=closed"));
}

function runAudit(stubDir) {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, "--repo", "o/r"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` },
  });
  return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

const DEAD_WORKFLOW = {
  id: 99,
  name: "Sweep stale CMS PRs",
  path: ".github/workflows/sweep.yml",
  state: "disabled_inactivity",
};

test.describe("audit-scheduled-runs.js — main() lifecycle (#258 regression)", () => {
  test("a DEAD workflow with zero failing runs must NOT close the tracking issue", () => {
    const { MARKER } = loadScript();
    const { dir, log } = ghStubDir([
      // DELIBERATELY UNUSED, and kept that way on purpose: DEAD_WORKFLOW is
      // `disabled_inactivity`, a self-evidencing state that short-circuits the
      // probe, so this route is consulted ZERO times (measured: 1 -> 0 when the
      // short-circuit landed; total gh calls 7 -> 6). It stays as a tripwire —
      // if a change ever re-routes a disabled_inactivity workflow through the
      // probe, this answer keeps THIS test honest rather than turning it into a
      // stub-miss red that hides which behaviour actually changed.
      [
        "has",
        "actions/workflows/99/runs?event=schedule",
        JSON.stringify({ workflow_runs: [{ id: 5 }] }),
      ],
      ["has", "actions/workflows?per_page", JSON.stringify({ workflows: [DEAD_WORKFLOW] })],
      // Zero failing scheduled runs in the window — the state that used to read
      // as "healthy, close the alert".
      ["has", "actions/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      // Push lane (#279): zero failing push runs, so it stays out of this
      // dead-workflow-specific test's assertions.
      ["has", "actions/runs?event=push", JSON.stringify({ workflow_runs: [] })],
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      ["has", "issues/7/comments?per_page", "[]"],
      ["has", "issues/7/comments", "{}"],
      ["eq", "repos/o/r", JSON.stringify({ private: false, default_branch: "main" })],
    ]);

    const { code, out } = runAudit(dir);
    expect(
      closeCalls(log),
      `THE #258 BUG: closed the alert with a dead workflow outstanding:\n${out}`,
    ).toEqual([]);
    // Not closing because it did nothing would be a different bug: prove it
    // actually reported the dead workflow on the open issue.
    const commented = callsOf(log).some(
      (argv) => argv[1] === "repos/o/r/issues/7/comments" && argv.some((a) => a.startsWith("body=")),
    );
    expect(commented, `expected the dead workflow to be reported on issue #7:\n${out}`).toBe(true);
    expect(out).toContain("sweep.yml");
    expect(code, out).toBe(0);
  });

  test("a dead cron whose run records are GONE must NOT close the tracking issue", () => {
    const { MARKER } = loadScript();
    const { dir, log } = ghStubDir([
      // The probe route is supplied ON PURPOSE and answers EMPTY. Omitting it
      // would make the stub exit non-zero, and filterDeadScheduledWorkflows
      // fails SOFT on a THROWING probe — so the test would go green without the
      // fix, for the wrong reason. An empty ANSWER is the condition under test.
      ["has", "actions/workflows/99/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      ["has", "actions/workflows?per_page", JSON.stringify({ workflows: [DEAD_WORKFLOW] })],
      ["has", "actions/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      // Push lane (#279): zero failing push runs, so it stays out of this
      // dead-workflow-specific test's assertions.
      ["has", "actions/runs?event=push", JSON.stringify({ workflow_runs: [] })],
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      ["has", "issues/7/comments?per_page", "[]"],
      ["has", "issues/7/comments", "{}"],
      // The close is ROUTED so that, unfixed, the run exits 0 — the bug's real
      // signature is a GREEN audit that closed a live alert, not an error. It is
      // NOT what makes this test discriminate: closeCalls reads the stub log,
      // which is appended BEFORE routing, so the closeCalls assertion fails
      // pre-fix with or without this route (measured). What the route buys is a
      // clean pre-fix signature instead of a misleading stub-miss error line.
      ["eq", "repos/o/r/issues/7", JSON.stringify({ number: 7, state: "closed" })],
      ["eq", "repos/o/r", JSON.stringify({ private: false, default_branch: "main" })],
    ]);

    const { code, out } = runAudit(dir);
    expect(
      closeCalls(log),
      `#258 DEFERRED: closed the alert because the dead cron's run records were gone:\n${out}`,
    ).toEqual([]);
    // Not closing because it did nothing would be a different bug. NOTE the
    // body= match on `sweep.yml`: a bare "some comment was posted" check does
    // NOT discriminate here — measured, it passes pre-fix too, because the
    // close path posts its own close comment to the same endpoint. Only the
    // CONTENT separates "reported the dead workflow" from "announced health".
    const reported = callsOf(log).some(
      (argv) =>
        argv[1] === "repos/o/r/issues/7/comments" &&
        argv.some((a) => a.startsWith("body=") && a.includes("sweep.yml")),
    );
    expect(reported, `expected the dead workflow to be reported on issue #7:\n${out}`).toBe(true);
    expect(out).toContain("sweep.yml");
    expect(code, out).toBe(0);
  });

  test("an UNKNOWN dead-workflow answer must NOT close the tracking issue either", () => {
    const { MARKER } = loadScript();
    const { dir, log } = ghStubDir([
      ["has", "actions/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      // The visibility probe fails, so the dead-workflow answer is UNKNOWN —
      // not "none". A clean window is unproven and must not be acted on.
      ["eq", "repos/o/r", null],
    ]);

    const { code, out } = runAudit(dir);
    expect(
      closeCalls(log),
      `THE #258 BUG: closed the alert on an UNKNOWN dead-workflow answer:\n${out}`,
    ).toEqual([]);
    expect(out).toContain("Leaving tracking issue #7 OPEN");
    // An audit that could not do its job must go RED, never report health.
    expect(code, out).toBe(1);
  });

  // ── push lane (#279): the SAME close-gate discipline, for the SAME reason ──
  //
  // THE CLOSE-GATE IS TWO CONDITIONS BECOMING THREE. `dead.length === 0` and
  // `!deadProbeFailed` guard the dead-workflow lane; #279 adds
  // `pushFailures.length === 0` and folds `pushProbeFailed` into the same
  // `deadProbeFailed || pushProbeFailed` unknown-answer check. Drop the new
  // term and the gate still compiles, every OTHER test above still passes, and
  // the audit closes a live alert with a push failure outstanding — the #258
  // failure mode in a new lane. These tests drive the real CLI end to end so
  // that can't happen unnoticed a second time.

  // The `run()` fixture default (run_started_at: "2026-07-05T09:00:00Z") is
  // long outside the real 48h `since` window the CLI subprocess computes from
  // the actual wall clock at spawnSync time — filterAlertRuns would drop it
  // silently, making every push-lane assertion below false-negative for the
  // wrong reason. An offset from `Date.now()` (not a network- or sleep-
  // dependent value — see AGENTS.md) keeps it inside the window regardless of
  // when this suite runs.
  const PUSH_RUN = run({
    id: 601,
    event: "push",
    path: ".github/workflows/secrets-scan.yml",
    conclusion: "failure",
    html_url: "https://github.com/o/r/actions/runs/601",
    run_started_at: new Date(Date.now() - 3600_000).toISOString(),
    created_at: new Date(Date.now() - 3600_000).toISOString(),
  });

  test("schedule lane clean but push has a FRESH failure — issue must NOT close (#279 close-gate)", () => {
    const { MARKER } = loadScript();
    const { dir, log } = ghStubDir([
      ["has", "actions/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      ["has", "actions/runs?event=push", JSON.stringify({ workflow_runs: [PUSH_RUN] })],
      ["has", "actions/runs/601/jobs", JSON.stringify({ jobs: [job()] })],
      ["has", "actions/workflows?per_page", JSON.stringify({ workflows: [] })],
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      ["has", "issues/7/comments?per_page", "[]"],
      ["has", "issues/7/comments", "{}"],
      ["eq", "repos/o/r", JSON.stringify({ private: false, default_branch: "main" })],
    ]);

    const { code, out } = runAudit(dir);
    expect(
      closeCalls(log),
      `#279: closed the alert with a live push-lane failure outstanding:\n${out}`,
    ).toEqual([]);
    // NOTE: the comment BODY is a `gh api ... -f body=...` argv element, not
    // console output — check the logged call, not `out` (which only carries
    // the audit's own log lines, never the payload it posts).
    const commented = callsOf(log).some(
      (argv) =>
        argv[1] === "repos/o/r/issues/7/comments" &&
        argv.some((a) => a.startsWith("body=") && a.includes("secrets-scan.yml")),
    );
    expect(commented, `expected the push failure to be reported on issue #7:\n${out}`).toBe(true);
    expect(code, out).toBe(0);
  });

  test("both the schedule and push lanes clean, and no dead workflows — issue closes", () => {
    const { MARKER } = loadScript();
    const { dir, log } = ghStubDir([
      ["has", "actions/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      ["has", "actions/runs?event=push", JSON.stringify({ workflow_runs: [] })],
      ["has", "actions/workflows?per_page", JSON.stringify({ workflows: [] })],
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      ["eq", "repos/o/r/issues/7/comments", "{}"],
      ["eq", "repos/o/r/issues/7", JSON.stringify({ number: 7, state: "closed" })],
      ["eq", "repos/o/r", JSON.stringify({ private: false, default_branch: "main" })],
    ]);

    const { code, out } = runAudit(dir);
    expect(
      closeCalls(log).length,
      `expected the issue to close on a fully clean window (both lanes):\n${out}`,
    ).toBe(1);
    expect(out).toContain("Clean window");
    expect(code, out).toBe(0);
  });

  test("a repo-metadata probe failure SKIPS the push lane (never attempts it) — issue stays open, exit reflects unknown", () => {
    const { MARKER } = loadScript();
    const { dir, log } = ghStubDir([
      ["has", "actions/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      // No route for actions/runs?event=push and no route for
      // actions/workflows — if the push lane (or the dead-workflow lane) were
      // attempted anyway, the stub would raise "no route", so their absence
      // from callsOf(log) below is the discriminating assertion, not a
      // convenience.
      ["eq", "repos/o/r", null],
    ]);

    const { code, out } = runAudit(dir);
    expect(
      closeCalls(log),
      `closed the alert on an UNKNOWN repo-metadata answer:\n${out}`,
    ).toEqual([]);
    const attemptedPush = callsOf(log).some(
      (argv) => argv[0] === "api" && typeof argv[1] === "string" && argv[1].includes("event=push"),
    );
    expect(
      attemptedPush,
      `the push lane must be SKIPPED, not attempted, when repo metadata is unknown:\n${out}`,
    ).toBe(false);
    expect(out).toContain("Leaving tracking issue #7 OPEN");
    expect(out).toContain("the push-run check");
    // An audit that could not do its job must go RED, never report health.
    expect(code, out).toBe(1);
  });

  test("a push run already recorded on the issue is never re-reported (run-id dedupe, main() lifecycle)", () => {
    const { MARKER } = loadScript();
    const { dir, log } = ghStubDir([
      ["has", "actions/runs?event=schedule", JSON.stringify({ workflow_runs: [] })],
      ["has", "actions/runs?event=push", JSON.stringify({ workflow_runs: [PUSH_RUN] })],
      ["has", "actions/runs/601/jobs", JSON.stringify({ jobs: [job()] })],
      ["has", "actions/workflows?per_page", JSON.stringify({ workflows: [] })],
      [
        "has",
        "issues?state=open&labels=",
        // The issue ALREADY carries run 601 in its hidden run-ids block — a
        // prior scan already reported this exact push failure.
        JSON.stringify([{ number: 7, body: `${MARKER}\n<!-- run-ids: 601 -->\nprevious alert` }]),
      ],
      ["has", "issues/7/comments?per_page", "[]"],
      // Deliberately NO route for POSTing a new comment — if the dedupe ever
      // regresses and re-reports run 601, the stub raises "no route" and the
      // `commented` assertion below still catches it (the call is logged
      // before routing), but a missing route also makes the failure mode loud.
      ["eq", "repos/o/r", JSON.stringify({ private: false, default_branch: "main" })],
    ]);

    const { code, out } = runAudit(dir);
    const commented = callsOf(log).some(
      (argv) => argv[1] === "repos/o/r/issues/7/comments" && argv.some((a) => a.startsWith("body=")),
    );
    expect(
      commented,
      `re-reported a push run already recorded in the hidden run-ids block:\n${out}`,
    ).toBe(false);
    expect(out).toContain("Nothing new");
    expect(code, out).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STALENESS LANE (#313).
//
// `repo-settings-apply.yml` fired its daily cron for eleven days and converged
// nothing: twelve runs concluded `cancelled` — evicted from a concurrency group
// held by a run parked at an unapproved environment gate — and every one
// allocated ZERO jobs. `cancelled` is deliberately absent from BAD_CONCLUSIONS
// (the runner-starvation carve-out is itself a cancelled shape), so the audit
// reported the repo healthy throughout.
//
// These lock the lane that closes that blind spot WITHOUT touching the
// carve-out: it never reads a conclusion as bad, only the absence of a recent
// `success`.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("audit-scheduled-runs.js — no-recent-success lane (#313)", () => {
  const NOW = Date.parse("2026-08-27T22:00:00Z");
  const DAY = 86400000;

  function run(conclusion, daysAgo, extra = {}) {
    return {
      id: `${conclusion}-${daysAgo}`,
      conclusion,
      run_started_at: new Date(NOW - daysAgo * DAY).toISOString(),
      workflow_id: 333034951,
      path: ".github/workflows/repo-settings-apply.yml",
      ...extra,
    };
  }

  // The measured shape: 15 scheduled runs, not one of them a success.
  function wedgedHistory() {
    return Array.from({ length: 15 }, (_, i) =>
      run(i % 5 === 0 ? "failure" : "cancelled", i),
    );
  }

  test("a workflow that keeps firing and never succeeds is STALE — the #313 shape", () => {
    const { staleVerdict } = loadScript();
    const v = staleVerdict(wedgedHistory(), NOW, 14);
    expect(v.stale, "eleven days of cancelled runs must not read as healthy").toBe(true);
    expect(v.lastSuccessAt).toBeNull();
    expect(v.runCount).toBe(15);
    expect(v.reason).toMatch(/no successful run/);
  });

  test("it fires on the no-success branch WITHOUT waiting out --stale-days", () => {
    // The whole point of that branch: a daily cron alerts in days, not weeks.
    // Every run here is 0-2 days old, far inside a 14-day threshold.
    const { staleVerdict, STALE_MIN_RUNS } = loadScript();
    const young = [run("cancelled", 0), run("cancelled", 1), run("cancelled", 2)];
    expect(young.length).toBe(STALE_MIN_RUNS);
    expect(staleVerdict(young, NOW, 14).stale).toBe(true);
  });

  test("it is CONCLUSION-AGNOSTIC — `cancelled` is never treated as a bad conclusion", () => {
    // The guard that keeps this lane compatible with the runner-starvation
    // carve-out: adding `cancelled` to BAD_CONCLUSIONS was the tempting fix and
    // is explicitly forbidden. This lane must not have smuggled it in.
    const { BAD_CONCLUSIONS, isAlertRun } = loadScript();
    expect(BAD_CONCLUSIONS).not.toContain("cancelled");
    expect(isAlertRun({ event: "schedule", conclusion: "cancelled" })).toBe(false);
  });

  test("a success inside the threshold is healthy, whatever the newest run concluded", () => {
    // A weekly cron that failed once. Cadence must not manufacture an alert.
    const { staleVerdict } = loadScript();
    const v = staleVerdict([run("failure", 1), run("success", 8)], NOW, 14);
    expect(v.stale, "one failure after a recent success is not staleness").toBe(false);
  });

  test("a success OLDER than the threshold is stale", () => {
    const { staleVerdict } = loadScript();
    const v = staleVerdict([run("cancelled", 1), run("success", 20)], NOW, 14);
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/last succeeded 20 day\(s\) ago/);
  });

  test("a brand-new cron below STALE_MIN_RUNS is never stale", () => {
    const { staleVerdict, STALE_MIN_RUNS } = loadScript();
    const young = Array.from({ length: STALE_MIN_RUNS - 1 }, (_, i) => run("cancelled", i));
    expect(staleVerdict(young, NOW, 14).stale, "a first run still in flight is not a streak").toBe(
      false,
    );
    expect(staleVerdict([], NOW, 14).stale).toBe(false);
  });

  test("candidates come from the runs ALREADY fetched, deduped by workflow_id", () => {
    // No extra listing call, and — the reason this matters — a workflow is only
    // judged on a day it actually fired, so a weekly cron is never scored
    // against a daily threshold.
    const { staleCandidates } = loadScript();
    const runs = [
      run("cancelled", 0),
      run("cancelled", 1),
      run("success", 2, { workflow_id: 999, path: ".github/workflows/other.yml" }),
      { conclusion: "success", run_started_at: "x" }, // no workflow_id — ignored
    ];
    const got = staleCandidates(runs);
    expect(got.map((c) => c.workflow_id).sort()).toEqual([333034951, 999]);
  });

  test("a probe error is UNKNOWN — never a finding, never health", () => {
    // Deliberately the opposite fail-soft direction from partitionStarvedRuns:
    // asserting staleness from a history we could not read would be a FALSE
    // alert. It sets probeFailed instead, which reds the run and blocks the
    // auto-close (the #258 contract).
    const { findStaleWorkflows } = loadScript();
    const r = findStaleWorkflows(
      wedgedHistory(),
      () => {
        throw new Error("API down");
      },
      NOW,
      14,
    );
    expect(r.stale, "an unreadable history must not become a finding").toEqual([]);
    expect(r.probeFailed, "…but it must not read as healthy either").toBe(true);
  });

  test("findings carry the workflow FILE BASENAME, not the run display title", () => {
    const { findStaleWorkflows, renderStaleWorkflows } = loadScript();
    const { stale } = findStaleWorkflows(wedgedHistory(), () => wedgedHistory(), NOW, 14);
    expect(stale).toHaveLength(1);
    expect(renderStaleWorkflows(stale)).toContain("**repo-settings-apply.yml**");
  });

  test("the dedupe channel is separate from the run-id and dead-workflow ones", () => {
    const {
      hiddenStaleWorkflowsBlock,
      extractReportedStaleWorkflows,
      extractReportedDeadWorkflows,
      extractReportedRunIds,
    } = loadScript();
    const block = hiddenStaleWorkflowsBlock([{ path: ".github/workflows/a.yml" }]);
    expect(extractReportedStaleWorkflows([block])).toEqual(new Set(["a.yml"]));
    // …and it must not bleed into either sibling channel.
    expect(extractReportedDeadWorkflows([block]).size).toBe(0);
    expect(extractReportedRunIds([block]).size).toBe(0);
    const dead = loadScript().hiddenDeadWorkflowsBlock([{ path: ".github/workflows/b.yml" }]);
    expect(extractReportedStaleWorkflows([dead]).size).toBe(0);
  });

  test("the issue body renders a stale section, and the close comment mentions it", () => {
    const { buildIssueBody, buildCloseComment } = loadScript();
    const body = buildIssueBody({
      repo: "o/r",
      windowHours: 48,
      runs: [],
      dead: [],
      pushRuns: [],
      defaultBranch: "main",
      stale: [{ path: ".github/workflows/repo-settings-apply.yml", reason: "no successful run" }],
      nowIso: "2026-08-27T22:00:00Z",
    });
    expect(body).toContain("no longer SUCCEED");
    expect(body).toContain("repo-settings-apply.yml");
    expect(body).toContain("<!-- stale-workflows: repo-settings-apply.yml -->");
    expect(buildCloseComment({ windowHours: 48, nowIso: "x" })).toMatch(/recent\s+success/);
  });

  test("the reusable wires --stale-days from an input, built in SHELL from env", () => {
    // The `a && b || c` trap this repo already ate once (run 32280743541): that
    // form is two operators, and an EMPTY STRING is falsy, so the flag emitted
    // its opt-out unconditionally and the lane silently no-op'd while reporting
    // healthy. Flags are built in shell from env, never inline in an expression.
    const doc = parseYaml(readWorkflow("scheduled-run-health.yml"));
    const inputs = doc.on.workflow_call.inputs;
    expect(inputs.stale_days.type, "string, so a dispatch input wires through uncoerced").toBe(
      "string",
    );
    expect(inputs.stale_scan.default, "on by default, like push_scan").toBe(true);
    const step = (doc.jobs.audit.steps || []).find((s) => String(s.run || "").includes("args="));
    expect(step, "no step builds the argv").toBeTruthy();
    expect(step.env.AUDIT_STALE_DAYS).toContain("inputs.stale_days");
    expect(step.run).toContain('args+=(--stale-days "$AUDIT_STALE_DAYS")');
    expect(step.run).toMatch(/if \[\[ "\$AUDIT_STALE_SCAN" != "true" \]\]; then args\+=\(--no-stale-scan\); fi/);
  });
});
