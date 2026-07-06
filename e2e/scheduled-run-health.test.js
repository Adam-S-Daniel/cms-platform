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

  test("groupByWorkflow groups by name, newest run first", () => {
    const { groupByWorkflow } = loadScript();
    const grouped = groupByWorkflow([
      run({ id: 1, name: "A", run_started_at: "2026-07-05T01:00:00Z" }),
      run({ id: 2, name: "B", run_started_at: "2026-07-05T03:00:00Z" }),
      run({ id: 3, name: "A", run_started_at: "2026-07-05T02:00:00Z" }),
    ]);
    expect([...grouped.keys()]).toEqual(["B", "A"]); // most recent breakage first
    expect(grouped.get("A").map((r) => r.id)).toEqual([3, 1]);
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
