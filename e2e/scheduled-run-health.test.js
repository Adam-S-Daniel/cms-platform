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
const path = require("node:path");
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
    const { filterDeadScheduledWorkflows } = loadScript();
    const all = [
      wf({ id: 2, path: ".github/workflows/ok.yml", state: "disabled_inactivity" }),
      wf({ id: 3, path: ".github/workflows/boom.yml", state: "disabled_inactivity" }),
    ];
    const dead = filterDeadScheduledWorkflows(all, (w) => {
      if (w.id === 3) throw new Error("gh: 502 Bad Gateway");
      return true;
    });
    expect(dead.map((w) => w.id)).toEqual([2, 3]);
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
