// @lane: local — pure-Node unit tests of scripts/publish-watchdog.js plus a stub-`gh`
// CLI run and a parse of the two workflow files. No browser, no network, no clock.
// Platform-internal (reads ../scripts and the workflow definitions) — registered in
// playwright.config.js PLATFORM_META_SPECS.
/*
 * REGRESSION GUARD for the publish watchdog (adamdaniel.ai PR 5001, 2026-11-18):
 * a real post's required check failed and nothing told anyone for a day. The
 * watchdog opens one issue per stuck `cms/` pull request. These tests lock the
 * classification, the issue text (no title, no branch name), the sweep plan,
 * the CLI's write behavior and the shape of the two workflows.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, runScripts } = require("./workflow-yaml-utils");
const { writeStubs } = require("./workflow-step-harness");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/publish-watchdog.js");
const REUSABLE = path.join(ROOT, ".github/workflows/publish-watchdog.yml");
const CALLER_DIR = path.join(ROOT, "examples/site/.github/workflows");
const CALLER = path.join(CALLER_DIR, "publish-watchdog.yml");
const { classifyPublish, issueMarker, renderIssue, planSweep } = require(SCRIPT);

const NOW = Date.parse("2026-11-19T12:00:00Z");
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

function makePr(over = {}) {
  return {
    number: 7,
    state: "open",
    draft: false,
    labels: [],
    auto_merge: { merge_method: "merge" },
    head: { ref: "cms/posts/hello", sha: "a".repeat(40), repo: { full_name: "o/r" } },
    base: { repo: { full_name: "o/r" } },
    updated_at: iso(60),
    html_url: "https://github.com/o/r/pull/7",
    ...over,
  };
}
let nextId = 1;
function run(name, status, conclusion, over = {}) {
  return {
    id: nextId++,
    name,
    status,
    conclusion,
    started_at: iso(30),
    completed_at: status === "completed" ? iso(20) : null,
    html_url: `https://github.com/o/r/runs/${name}`,
    ...over,
  };
}
function classify(over = {}) {
  return classifyPublish({
    pr: makePr(),
    checkRuns: [],
    requiredContexts: ["build"],
    files: ["_posts/2026-11-18-real-post.md"],
    nowMs: NOW,
    graceMinutes: 15,
    ...over,
  });
}

test.describe("classifyPublish", () => {
  const CASES = [
    ["PR closed", { pr: makePr({ state: "closed" }) }, "ignored"],
    ["draft", { pr: makePr({ draft: true }) }, "ignored"],
    [
      "fork head",
      { pr: makePr({ head: { ref: "cms/x", sha: "b", repo: { full_name: "fork/r" } } }) },
      "ignored",
    ],
    [
      "head repo missing",
      { pr: makePr({ head: { ref: "cms/x", sha: "b", repo: null } }) },
      "ignored",
    ],
    [
      "not a cms/ branch",
      { pr: makePr({ head: { ref: "feat/x", sha: "b", repo: { full_name: "o/r" } } }) },
      "ignored",
    ],
    ["on-hold label", { pr: makePr({ labels: [{ name: "on-hold" }] }) }, "ignored"],
    ["automated-test label", { pr: makePr({ labels: [{ name: "automated-test" }] }) }, "ignored"],
    ["unarmed", { pr: makePr({ auto_merge: null }) }, "ignored"],
    [
      "armed by cms/ready label",
      { pr: makePr({ auto_merge: null, labels: [{ name: "cms/ready" }] }), checkRuns: [run("build", "in_progress", null)] },
      "in-flight",
    ],
    [
      "armed by decap-cms/pending_publish label",
      { pr: makePr({ auto_merge: null, labels: [{ name: "decap-cms/pending_publish" }] }), checkRuns: [run("build", "queued", null)] },
      "in-flight",
    ],
    ["fixture-only PR (_e2e dir)", { files: ["_e2e/a.md"] }, "ignored"],
    ["fixture-only PR (e2e- basename)", { files: ["assets/img/e2e-photo.png"] }, "ignored"],
    ["fixture-only PR (e2e post slug)", { files: ["_posts/2099-12-31-e2e-media-1.md"] }, "ignored"],
    [
      "fixture mixed with a real post",
      { files: ["_posts/2099-12-31-e2e-media-1.md", "_posts/2026-11-18-real-post.md"], checkRuns: [run("build", "completed", "failure")] },
      "stuck",
    ],
    [
      "an e2e-looking slug outside _posts is not a fixture",
      { files: ["pages/2099-12-31-e2e-thing.md"], checkRuns: [run("build", "completed", "failure")] },
      "stuck",
    ],
    ["files null is not all-fixtures", { files: null, checkRuns: [run("build", "completed", "failure")] }, "stuck"],
    ["files empty is not all-fixtures", { files: [], checkRuns: [run("build", "completed", "failure")] }, "stuck"],
    [
      "required failure is stuck at once even with others pending",
      { checkRuns: [run("build", "completed", "failure"), run("slow", "in_progress", null)] },
      "stuck",
    ],
    ...["failure", "cancelled", "timed_out", "action_required", "startup_failure"].map((c) => [
      `required ${c}`,
      { checkRuns: [run("build", "completed", c)] },
      "stuck",
    ]),
    [
      "failing NON-required check while others pend",
      { checkRuns: [run("optional", "completed", "failure"), run("build", "in_progress", null)] },
      "in-flight",
    ],
    [
      "requiredContexts null: any failure counts",
      { requiredContexts: null, checkRuns: [run("optional", "completed", "failure"), run("build", "in_progress", null)] },
      "stuck",
    ],
    [
      "a neutral or skipped conclusion is not failing",
      { checkRuns: [run("build", "completed", "skipped", { completed_at: iso(1) })] },
      "in-flight",
    ],
    [
      "all green and older than grace",
      { checkRuns: [run("build", "completed", "success", { completed_at: iso(16) })] },
      "stuck",
    ],
    [
      "all green exactly at grace",
      { checkRuns: [run("build", "completed", "success", { completed_at: iso(15) })] },
      "stuck",
    ],
    [
      "all green inside grace",
      { checkRuns: [run("build", "completed", "success", { completed_at: iso(5) })] },
      "in-flight",
    ],
    [
      "earlier failed attempt then a passing re-run",
      {
        checkRuns: [
          run("build", "completed", "failure", { started_at: iso(40), completed_at: iso(35) }),
          run("build", "completed", "success", { started_at: iso(10), completed_at: iso(5) }),
        ],
      },
      "in-flight",
    ],
    [
      "same start time: the larger id wins",
      {
        checkRuns: [
          run("build", "completed", "success", { id: 900, started_at: iso(10), completed_at: iso(5) }),
          run("build", "completed", "failure", { id: 100, started_at: iso(10), completed_at: iso(5) }),
        ],
      },
      "in-flight",
    ],
    [
      "newer attempt failing after an older pass",
      {
        checkRuns: [
          run("build", "completed", "success", { started_at: iso(40), completed_at: iso(35) }),
          run("build", "completed", "failure", { started_at: iso(10), completed_at: iso(5) }),
        ],
      },
      "stuck",
    ],
    ["no checks and PR updated long ago", { checkRuns: [], pr: makePr({ updated_at: iso(120) }) }, "stuck"],
    ["no checks and PR just updated", { checkRuns: [], pr: makePr({ updated_at: iso(2) }) }, "in-flight"],
    [
      "unparseable completed_at never makes stuck",
      { checkRuns: [run("build", "completed", "success", { completed_at: "garbage" })] },
      "in-flight",
    ],
    ["unparseable updated_at with no checks never makes stuck", { checkRuns: [], pr: makePr({ updated_at: "garbage" }) }, "in-flight"],
    [
      "unparseable started_at on a pass does not make stuck inside grace",
      { checkRuns: [run("build", "completed", "success", { started_at: "x", completed_at: iso(1) })] },
      "in-flight",
    ],
  ];
  for (const [name, over, state] of CASES) {
    test(`${name} -> ${state}`, () => {
      const v = classify(over);
      expect(v.state).toBe(state);
      expect(typeof v.reason).toBe("string");
      expect(Array.isArray(v.failing)).toBe(true);
    });
  }

  test("failing lists name, conclusion and url of the newest failing runs only", () => {
    const v = classify({
      checkRuns: [
        run("build", "completed", "failure", { html_url: "https://example.com/b" }),
        run("lint", "completed", "success"),
      ],
    });
    expect(v.failing).toEqual([{ name: "build", conclusion: "failure", url: "https://example.com/b" }]);
  });

  test("graceMinutes defaults to 15", () => {
    const runs = [run("build", "completed", "success", { completed_at: iso(16) })];
    expect(classify({ checkRuns: runs, graceMinutes: undefined }).state).toBe("stuck");
    expect(classify({ checkRuns: runs, graceMinutes: 30 }).state).toBe("in-flight");
  });
});

test.describe("renderIssue and issueMarker", () => {
  test("marker shape", () => {
    expect(issueMarker(42)).toBe("<!-- publish-watchdog:pr=42 -->");
  });

  test("failing checks render as links; the body carries the marker", () => {
    const verdict = { state: "stuck", reason: "x", failing: [{ name: "build", conclusion: "failure", url: "https://example.com/r/1" }] };
    const { title, body } = renderIssue({ repo: "o/r", pr: makePr(), verdict });
    expect(title).toBe("Publish stuck: pull request #7 has not gone live");
    expect(body).toContain(issueMarker(7));
    expect(body).toContain("https://github.com/o/r/pull/7");
    expect(body).toContain("[build](https://example.com/r/1)");
    expect(body).toContain("failure");
    expect(body).toContain("closes by itself");
  });

  test("with no failing checks it says every check finished", () => {
    const { body } = renderIssue({ repo: "o/r", pr: makePr(), verdict: { state: "stuck", reason: "x", failing: [] } });
    expect(body).toContain("Every check finished");
  });

  test("a hostile title and branch name never reach the issue", () => {
    const evilTitle = "EVIL-TITLE\n::error::boom";
    const evilRef = "cms/EVIL-BRANCH\n::error::boom";
    const pr = makePr({ title: evilTitle, head: { ref: evilRef, sha: "a", repo: { full_name: "o/r" } } });
    const { title, body } = renderIssue({ repo: "o/r", pr, verdict: { state: "stuck", reason: "x", failing: [] } });
    for (const text of [title, body]) {
      expect(text).not.toContain("EVIL-TITLE");
      expect(text).not.toContain("EVIL-BRANCH");
      expect(text).not.toContain("::error::");
    }
  });
});

test.describe("planSweep", () => {
  const stuckEntry = (n) => ({
    pr: makePr({ number: n }),
    checkRuns: [run("build", "completed", "failure")],
    requiredContexts: ["build"],
    files: ["_posts/2026-11-18-real-post.md"],
  });
  const inFlightEntry = (n) => ({ ...stuckEntry(n), checkRuns: [run("build", "in_progress", null)] });

  test("opens one issue for a stuck PR with no issue", () => {
    const plan = planSweep({ prs: [stuckEntry(7)], openIssues: [], nowMs: NOW, graceMinutes: 15 });
    expect(plan.open.map((o) => o.pr.number)).toEqual([7]);
    expect(plan.open[0].verdict.state).toBe("stuck");
    expect(plan.close).toEqual([]);
  });

  test("no duplicate when an open issue carries the marker", () => {
    const plan = planSweep({
      prs: [stuckEntry(7)],
      openIssues: [{ number: 50, body: `x\n${issueMarker(7)}\n` }],
      nowMs: NOW,
      graceMinutes: 15,
    });
    expect(plan).toEqual({ open: [], close: [] });
  });

  test("an unmarked issue is left alone", () => {
    const plan = planSweep({ prs: [], openIssues: [{ number: 50, body: "unrelated" }, { number: 51, body: null }], nowMs: NOW, graceMinutes: 15 });
    expect(plan).toEqual({ open: [], close: [] });
  });

  test("closes when the PR is back in flight, merged (closed), or gone from the list", () => {
    const plan = planSweep({
      prs: [inFlightEntry(7), { ...stuckEntry(8), pr: makePr({ number: 8, state: "closed" }) }],
      openIssues: [
        { number: 50, body: issueMarker(7) },
        { number: 51, body: issueMarker(8) },
        { number: 52, body: issueMarker(9) },
      ],
      nowMs: NOW,
      graceMinutes: 15,
    });
    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([
      { issueNumber: 50, prNumber: 7 },
      { issueNumber: 51, prNumber: 8 },
      { issueNumber: 52, prNumber: 9 },
    ]);
  });

  test("one issue per PR across several stuck PRs", () => {
    const plan = planSweep({
      prs: [stuckEntry(7), stuckEntry(8)],
      openIssues: [{ number: 50, body: issueMarker(8) }],
      nowMs: NOW,
      graceMinutes: 15,
    });
    expect(plan.open.map((o) => o.pr.number)).toEqual([7]);
  });
});

test.describe("CLI with a stub gh", () => {
  function setup({ pulls, failPulls = false, failIssueWithLabels = false, openIssues = [] }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
    const fix = path.join(dir, "fix");
    const log = path.join(dir, "log");
    fs.mkdirSync(fix);
    fs.mkdirSync(log);
    const put = (name, value) => fs.writeFileSync(path.join(fix, name), JSON.stringify(value));
    put("pulls.json", pulls);
    put("repo.json", { default_branch: "main" });
    put("rules.json", [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }]);
    put("checks.json", { check_runs: [run("build", "completed", "failure")] });
    put("files.json", [{ filename: "_posts/2026-11-18-real-post.md" }]);
    put("issues.json", openIssues);
    if (failPulls) fs.writeFileSync(path.join(fix, "fail-pulls"), "");
    if (failIssueWithLabels) fs.writeFileSync(path.join(fix, "fail-labelled-issue"), "");
    const bin = path.join(dir, "bin");
    writeStubs(bin, {
      gh: `
echo "$*" >> "${log}/argv.log"
ep="$2"
n=$(ls "${log}" | grep -c '^body-' || true)
body=""
case "$*" in *--input*) body=$(cat) ;; esac
if [ -n "$body" ]; then printf '%s' "$body" > "${log}/body-$((n+1)).json"; fi
case "$ep" in
  repos/o/r/pulls\\?*)
    if [ -f "${fix}/fail-pulls" ]; then echo "SECRET-RESPONSE-BODY"; echo "gh: HTTP 500 SECRET-RESPONSE-BODY" >&2; exit 1; fi
    cat "${fix}/pulls.json" ;;
  repos/o/r/pulls/*/files*) cat "${fix}/files.json" ;;
  repos/o/r/commits/*/check-runs*) cat "${fix}/checks.json" ;;
  repos/o/r/rules/branches/*) cat "${fix}/rules.json" ;;
  repos/o/r/issues\\?*) cat "${fix}/issues.json" ;;
  repos/o/r/issues/*/comments) echo '{}' ;;
  repos/o/r/issues/*) echo '{}' ;;
  repos/o/r/issues)
    if [ -f "${fix}/fail-labelled-issue" ]; then
      case "$body" in *agent-ready*) echo "gh: HTTP 422" >&2; exit 1 ;; esac
    fi
    echo '{"number": 99}' ;;
  repos/o/r) cat "${fix}/repo.json" ;;
  *) echo "unexpected endpoint" >&2; exit 1 ;;
esac`,
    });
    return { dir, bin, log };
  }

  function runCli(env, extra = []) {
    return spawnSync(
      process.execPath,
      [SCRIPT, "--repo", "o/r", "--now", "2026-11-19T12:00:00Z", ...extra],
      { encoding: "utf8", env: { PATH: `${env.bin}:${process.env.PATH}`, HOME: env.dir } },
    );
  }
  const logged = (env, file) => (fs.existsSync(path.join(env.log, file)) ? fs.readFileSync(path.join(env.log, file), "utf8") : "");
  const writes = (env) => logged(env, "argv.log").split("\n").filter((l) => /-X (POST|PATCH)/.test(l));
  const stuckPulls = () => [makePr(), makePr({ number: 8, head: { ref: "feat/other", sha: "c".repeat(40), repo: { full_name: "o/r" } } })];

  test("--dry-run prints the plan and writes nothing", () => {
    const env = setup({ pulls: stuckPulls() });
    const r = runCli(env, ["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("stuck: #7");
    expect(r.stdout).toContain("build");
    expect(r.stdout).toContain("Dry run");
    expect(writes(env)).toEqual([]);
  });

  test("a stuck PR produces exactly one issue-create call whose body has the marker", () => {
    const env = setup({ pulls: stuckPulls() });
    const r = runCli(env);
    expect(r.status).toBe(0);
    const w = writes(env);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("repos/o/r/issues");
    const body = JSON.parse(logged(env, "body-1.json"));
    expect(body.body).toContain("<!-- publish-watchdog:pr=7 -->");
    expect(body.labels).toEqual(["publish-stuck", "agent-ready"]);
    expect(body.title).not.toContain("cms/");
  });

  test("an existing marked issue means no new issue; a stale marked issue is commented then closed", () => {
    const env = setup({
      pulls: stuckPulls(),
      openIssues: [
        { number: 50, body: "<!-- publish-watchdog:pr=7 -->" },
        { number: 51, body: "<!-- publish-watchdog:pr=3 -->" },
      ],
    });
    const r = runCli(env);
    expect(r.status).toBe(0);
    const w = writes(env);
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("issues/51/comments");
    expect(w[1]).toContain("-X PATCH");
    expect(w[1]).toContain("issues/51");
  });

  test("when the labelled issue create fails it retries once without the work label", () => {
    const env = setup({ pulls: stuckPulls(), failIssueWithLabels: true });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(writes(env)).toHaveLength(2);
    expect(JSON.parse(logged(env, "body-2.json")).labels).toEqual(["publish-stuck"]);
  });

  test("a list failure exits 1 without echoing the response body", () => {
    const env = setup({ pulls: stuckPulls(), failPulls: true });
    const r = runCli(env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stderr).toContain("500");
    expect(r.stdout + r.stderr).not.toContain("SECRET-RESPONSE-BODY");
    expect(writes(env)).toEqual([]);
  });
});

test.describe("workflow files", () => {
  const reusable = parseYaml(fs.readFileSync(REUSABLE, "utf8"));
  const callerText = fs.readFileSync(CALLER, "utf8");
  const caller = parseYaml(callerText);

  test("caller workflow_run names equal the name: of examples/site callers that run on pull_request", () => {
    const byName = new Map();
    for (const f of fs.readdirSync(CALLER_DIR)) {
      const w = parseYaml(fs.readFileSync(path.join(CALLER_DIR, f), "utf8"));
      byName.set(w.name, w);
    }
    const names = caller.on.workflow_run.workflows;
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const n of names) {
      expect(byName.has(n), `no examples/site caller is named ${n}`).toBe(true);
      expect(Object.keys(byName.get(n).on), `${n} must trigger on pull_request`).toContain("pull_request");
    }
    expect(caller.on.workflow_run.types).toEqual(["completed"]);
  });

  test("caller has an hourly off-peak schedule, a coerced dry_run dispatch and no cancel-in-progress", () => {
    const cron = caller.on.schedule[0].cron;
    expect(cron).toMatch(/^([1-9]|[1-5][0-9]) \* \* \* \*$/);
    expect(caller.on.workflow_dispatch.inputs.dry_run.type).toBe("string");
    expect(callerText).toContain("fromJSON(inputs.dry_run)");
    expect(callerText).not.toContain("cancel-in-progress: true");
    expect(caller["run-name"]).toContain("github.event_name");
  });

  test("caller job if restricts workflow_run to same-repo cms/ failures", () => {
    const cond = caller.jobs.watchdog.if;
    expect(cond).toContain("github.event_name != 'workflow_run'");
    expect(cond).toContain("startsWith(github.event.workflow_run.head_branch, 'cms/')");
    expect(cond).toContain("head_repository.full_name == github.repository");
    expect(cond).toContain("event == 'pull_request'");
    expect(cond).toContain("conclusion != 'success'");
    expect(cond).toContain("conclusion != 'skipped'");
  });

  test("caller calls the reusable at a release tag and its permissions cover the reusable's", () => {
    expect(caller.jobs.watchdog.uses).toMatch(/^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/publish-watchdog\.yml@v\d+\.\d+\.\d+$/);
    expect(caller.permissions).toEqual(reusable.permissions);
  });

  test("reusable declares exactly the four permissions", () => {
    expect(reusable.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      checks: "read",
      issues: "write",
    });
    expect(Object.keys(reusable.on)).toEqual(["workflow_call"]);
    expect(Object.keys(reusable.jobs)).toHaveLength(1);
    expect(reusable.jobs.watchdog["timeout-minutes"]).toBeGreaterThan(0);
  });

  test("reusable inputs have the documented defaults", () => {
    const i = reusable.on.workflow_call.inputs;
    expect(i.grace_minutes.default).toBe("15");
    expect(i.issue_label.default).toBe("publish-stuck");
    expect(i.work_label.default).toBe("agent-ready");
    expect(i.dry_run.type).toBe("boolean");
  });

  test("no `${{` inside any run: block", () => {
    for (const file of [REUSABLE, CALLER]) {
      for (const { script, line } of runScripts(fs.readFileSync(file, "utf8"))) {
        expect(script, `${path.basename(file)}:${line}`).not.toContain("${{");
      }
    }
  });
});
