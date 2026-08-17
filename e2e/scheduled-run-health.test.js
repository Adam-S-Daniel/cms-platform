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

  test("the audit step passes --repo ${{ github.repository }}", () => {
    // The reusable SPARSE-checks-out only the audit script — github.workspace
    // is not a git repo, so gh cannot infer the repo from a local remote.
    expect(raw).toMatch(/--repo\s+"?\$\{\{\s*github\.repository\s*\}\}"?/);
  });

  test("declares actions: read + issues: write (list runs / file the alert)", () => {
    expect(doc.permissions).toMatchObject({ actions: "read", issues: "write" });
  });

  test("dry_run input (boolean, default false) wires through to --dry-run", () => {
    const inputs = doc.on.workflow_call.inputs;
    expect(inputs.dry_run).toMatchObject({ type: "boolean", default: false });
    expect(raw).toMatch(/\$\{\{\s*inputs\.dry_run\s*&&\s*'--dry-run'\s*\|\|\s*''\s*\}\}/);
  });

  test("window_hours and issue_label pass through to the script", () => {
    const inputs = doc.on.workflow_call.inputs;
    // Strings, so thin callers can wire dispatch inputs straight through.
    expect(inputs.window_hours).toMatchObject({ type: "string", default: "48" });
    expect(inputs.issue_label).toMatchObject({ type: "string", default: "ci" });
    expect(raw).toMatch(/--window-hours\s+"\$\{\{\s*inputs\.window_hours\s*\}\}"/);
    expect(raw).toMatch(/--label\s+"\$\{\{\s*inputs\.issue_label\s*\}\}"/);
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
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      ["has", "issues/7/comments?per_page", "[]"],
      ["has", "issues/7/comments", "{}"],
      ["eq", "repos/o/r", JSON.stringify({ private: false })],
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
      [
        "has",
        "issues?state=open&labels=",
        JSON.stringify([{ number: 7, body: `${MARKER}\nprevious alert` }]),
      ],
      ["has", "issues/7/comments?per_page", "[]"],
      ["has", "issues/7/comments", "{}"],
      // The close is ROUTED so that, unfixed, it SUCCEEDS and the run exits 0 —
      // the bug's real signature is a GREEN audit that closed a live alert, not
      // an error. Without this route the pre-fix run reds on a stub miss and
      // the test could pass on the exit code rather than on the close.
      ["eq", "repos/o/r/issues/7", JSON.stringify({ number: 7, state: "closed" })],
      ["eq", "repos/o/r", JSON.stringify({ private: false })],
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
});
