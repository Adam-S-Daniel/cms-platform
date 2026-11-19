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
    // A cancelled run is usually a concurrency group about to replace it, so
    // it only counts once it has stayed the newest run for the grace window;
    // a real failure counts the moment it lands.
    [
      "required cancelled a minute ago: not a failure yet",
      { checkRuns: [run("build", "completed", "cancelled", { completed_at: iso(1) }), run("slow", "in_progress", null)] },
      "in-flight",
    ],
    [
      "required cancelled, alone, a minute ago: still waiting",
      { checkRuns: [run("build", "completed", "cancelled", { completed_at: iso(1) })] },
      "in-flight",
    ],
    [
      "required cancelled with an unreadable time: never stuck by itself",
      { checkRuns: [run("build", "completed", "cancelled", { completed_at: "nonsense" }), run("slow", "in_progress", null)] },
      "in-flight",
    ],
    [
      "required failure a minute ago: stuck at once",
      { checkRuns: [run("build", "completed", "failure", { completed_at: iso(1) })] },
      "stuck",
    ],
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

test.describe("classifyPublish: branch tip, stalls, partial lists, ids", () => {
  const failed = () => [run("build", "completed", "failure")];
  const CASES = [
    ["branch tip differs: in flight even with a required failure on the old head", { branchSha: "f".repeat(40), checkRuns: failed() }, "in-flight"],
    ["branch tip equals head: normal rules apply", { branchSha: "a".repeat(40), checkRuns: failed() }, "stuck"],
    ["branch tip null: normal rules apply", { branchSha: null, checkRuns: failed() }, "stuck"],
    ["branch tip undefined: normal rules apply", { branchSha: undefined, checkRuns: failed() }, "stuck"],
    ["stalled in flight: oldest unfinished run older than stallMinutes", { checkRuns: [run("build", "in_progress", null, { started_at: iso(61) })] }, "stuck"],
    ["in flight but younger than stallMinutes", { checkRuns: [run("build", "in_progress", null, { started_at: iso(59) })] }, "in-flight"],
    ["stall measured from the OLDEST unfinished run", { checkRuns: [run("a", "in_progress", null, { started_at: iso(5) }), run("b", "queued", null, { started_at: iso(90) })] }, "stuck"],
    ["a custom stallMinutes", { stallMinutes: 10, checkRuns: [run("build", "in_progress", null, { started_at: iso(11) })] }, "stuck"],
    ["a waiting run older than the stall window", { checkRuns: [run("gate", "waiting", null, { started_at: iso(120) })] }, "stuck"],
    ["a waiting run younger than the stall window", { checkRuns: [run("gate", "waiting", null, { started_at: iso(5) })] }, "in-flight"],
    ["unfinished run with an unparseable started_at never makes stuck", { checkRuns: [run("build", "in_progress", null, { started_at: "garbage" })], pr: makePr({ updated_at: iso(500) }) }, "in-flight"],
    ["unfinished run with no started_at never makes stuck", { checkRuns: [run("build", "queued", null, { started_at: null })], pr: makePr({ updated_at: iso(500) }) }, "in-flight"],
    ["requiredContexts [] behaves as null: any failure counts", { requiredContexts: [], checkRuns: [run("optional", "completed", "failure")] }, "stuck"],
    ["partial check-run list is in flight", { incomplete: true, checkRuns: [run("build", "completed", "success", { completed_at: iso(60) })] }, "in-flight"],
    [
      "newest by id: a queued re-run with no started_at beats the old failure",
      { checkRuns: [run("build", "completed", "failure", { id: 10, started_at: iso(40) }), run("build", "queued", null, { id: 11, started_at: null })] },
      "in-flight",
    ],
    [
      "newest by id: the larger id wins even with an older started_at",
      { checkRuns: [run("build", "completed", "failure", { id: 20, started_at: iso(50), completed_at: iso(45) }), run("build", "completed", "success", { id: 5, started_at: iso(10), completed_at: iso(1) })] },
      "stuck",
    ],
  ];
  for (const [name, over, state] of CASES) {
    test(`${name} -> ${state}`, () => {
      expect(classify(over).state).toBe(state);
    });
  }

  test("a stalled verdict lists the waiting runs and says how long", () => {
    const v = classify({ checkRuns: [run("gate", "waiting", null, { started_at: iso(120), html_url: "https://example.com/g" })] });
    expect(v.waiting).toEqual([{ name: "gate", status: "waiting", url: "https://example.com/g" }]);
    expect(v.reason).toBe("A check has been waiting for more than 60 minutes.");
  });

  test("a waiting verdict renders the approval wording and no 'red check' sentence", () => {
    const v = classify({ checkRuns: [run("gate", "waiting", null, { started_at: iso(120), html_url: "https://example.com/g" })] });
    const { body } = renderIssue({ repo: "o/r", pr: makePr(), verdict: v });
    expect(body).toContain("waiting for someone to approve or start it");
    expect(body).toContain("[gate](https://example.com/g)");
    expect(body).not.toContain("red check");
    expect(body.startsWith(issueMarker(7))).toBe(true);
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
      openIssues: [{ number: 50, body: `${issueMarker(7)}\nx\n` }],
      nowMs: NOW,
      graceMinutes: 15,
    });
    expect(plan).toEqual({ open: [], close: [] });
  });

  test("an unmarked issue is left alone", () => {
    const plan = planSweep({ prs: [], openIssues: [{ number: 50, body: "unrelated" }, { number: 51, body: null }], nowMs: NOW, graceMinutes: 15 });
    expect(plan).toEqual({ open: [], close: [] });
  });

  test("closes when the PR is merged or closed, gone from the list, or no longer armed; not while it is in flight", () => {
    const plan = planSweep({
      prs: [
        // Still open and armed, checks running again: a watcher that timed out
        // opened this issue, and closing it here would flap.
        inFlightEntry(7),
        { ...stuckEntry(8), pr: makePr({ number: 8, state: "closed" }) },
        { ...stuckEntry(10), pr: makePr({ number: 10, auto_merge: null, labels: [] }) },
      ],
      openIssues: [
        { number: 50, body: issueMarker(7) },
        { number: 51, body: issueMarker(8) },
        { number: 52, body: issueMarker(9) },
        { number: 53, body: issueMarker(10) },
      ],
      nowMs: NOW,
      graceMinutes: 15,
    });
    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([
      { issueNumber: 51, prNumber: 8 },
      { issueNumber: 52, prNumber: 9 },
      { issueNumber: 53, prNumber: 10 },
    ]);
  });

  test("a skipped PR's issue is left open and no duplicate is opened for it", () => {
    const plan = planSweep({
      prs: [],
      openIssues: [{ number: 50, body: issueMarker(7) }],
      nowMs: NOW,
      graceMinutes: 15,
      skipped: new Set([7]),
    });
    expect(plan).toEqual({ open: [], close: [] });
    const plan2 = planSweep({ prs: [], openIssues: [{ number: 50, body: issueMarker(7) }], nowMs: NOW, graceMinutes: 15 });
    expect(plan2.close).toEqual([{ issueNumber: 50, prNumber: 7 }]);
  });

  test("only a marker on the FIRST line counts", () => {
    const plan = planSweep({
      prs: [],
      openIssues: [{ number: 50, body: `Quoting another issue:\n${issueMarker(7)}\n` }],
      nowMs: NOW,
      graceMinutes: 15,
    });
    expect(plan).toEqual({ open: [], close: [] });
  });

  test("an issue stays open while its PR is open and armed, even when not stuck", () => {
    const plan = planSweep({
      prs: [inFlightEntry(7)],
      openIssues: [{ number: 50, body: issueMarker(7) }],
      nowMs: NOW,
      graceMinutes: 15,
    });
    expect(plan).toEqual({ open: [], close: [] });
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
  const SHA_A = "a".repeat(40);
  const SHA_D = "d".repeat(40);
  const pr9 = () => makePr({ number: 9, head: { ref: "cms/posts/other", sha: SHA_D, repo: { full_name: "o/r" } } });

  // `fixtures` maps a file name under fix/ to JSON (or a string for a raw file).
  function setup({ pulls, openIssues = [], fixtures = {}, flags = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
    const fix = path.join(dir, "fix");
    const log = path.join(dir, "log");
    fs.mkdirSync(fix);
    fs.mkdirSync(log);
    const put = (name, value) => fs.writeFileSync(path.join(fix, name), typeof value === "string" ? value : JSON.stringify(value));
    put("pulls.json", pulls);
    put("repo.json", { default_branch: "main" });
    put("rules.json", [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "build" }] } }]);
    put("checks.json", { total_count: 1, check_runs: [run("build", "completed", "failure")] });
    put("files.json", [{ filename: "_posts/2026-11-18-real-post.md" }]);
    put("issues.json", openIssues);
    for (const [name, value] of Object.entries(fixtures)) put(name, value);
    const bin = path.join(dir, "bin");
    writeStubs(bin, {
      gh: `
echo "$*" >> "${log}/argv.log"
ep="$2"
n=$(ls "${log}" | grep -c '^body-' || true)
body=""
case "$*" in *--input*) body=$(cat) ;; esac
if [ -n "$body" ]; then printf '%s' "$body" > "${log}/body-$((n+1)).json"; fi
fail() { echo "SECRET-RESPONSE-BODY"; echo "gh: HTTP $1 SECRET-RESPONSE-BODY" >&2; exit 1; }
case "$ep" in
  repos/o/r/pulls\\?*)
    if [ -f "${fix}/fail-pulls" ]; then fail 500; fi
    cat "${fix}/pulls.json" ;;
  repos/o/r/pulls/*/files*) cat "${fix}/files.json" ;;
  repos/o/r/commits/*/check-runs*)
    sha=\${ep#repos/o/r/commits/}; sha=\${sha%%/*}
    page=\${ep##*page=}
    if [ -f "${fix}/checks-$sha-fail" ]; then fail 502; fi
    if [ -f "${fix}/checks-$sha-$page.json" ]; then cat "${fix}/checks-$sha-$page.json"
    elif [ -f "${fix}/checks-$sha-1.json" ]; then echo '{"total_count": 0, "check_runs": []}'
    else cat "${fix}/checks.json"; fi ;;
  repos/o/r/git/ref/heads/*other*) echo '{"object": {"sha": "${SHA_D}"}}' ;;
  repos/o/r/git/ref/heads/*)
    if [ -f "${fix}/ref.json" ]; then cat "${fix}/ref.json"; else echo '{"object": {"sha": "${SHA_A}"}}'; fi ;;
  repos/o/r/rules/branches/*) cat "${fix}/rules.json" ;;
  repos/o/r/issues\\?*) cat "${fix}/issues.json" ;;
  repos/o/r/issues/*/comments) echo '{}' ;;
  repos/o/r/issues/*) echo '{}' ;;
  repos/o/r/issues)
    if [ -f "${fix}/issue-fail" ]; then fail "$(cat "${fix}/issue-fail")"; fi
    if [ -f "${fix}/issue-fail-labelled" ]; then
      case "$body" in *agent-ready*) echo "gh: HTTP 422" >&2; exit 1 ;; esac
    fi
    echo '{"number": 99}' ;;
  repos/o/r) cat "${fix}/repo.json" ;;
  *) echo "unexpected endpoint" >&2; exit 1 ;;
esac`,
    });
    return { dir, bin, log, flags };
  }

  function runCli(env, extra = []) {
    return spawnSync(
      process.execPath,
      [SCRIPT, "--repo", "o/r", "--now", "2026-11-19T12:00:00Z", ...extra],
      { encoding: "utf8", env: { PATH: `${env.bin}:${process.env.PATH}`, HOME: env.dir } },
    );
  }
  const logged = (env, file) => (fs.existsSync(path.join(env.log, file)) ? fs.readFileSync(path.join(env.log, file), "utf8") : "");
  const argv = (env) => logged(env, "argv.log").split("\n");
  const writes = (env) => argv(env).filter((l) => /-X (POST|PATCH)/.test(l));
  const creates = (env) => writes(env).filter((l) => /repos\/o\/r\/issues( |$)/.test(l));
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
    expect(creates(env)).toHaveLength(1);
    expect(writes(env)).toHaveLength(1);
    const body = JSON.parse(logged(env, "body-1.json"));
    expect(body.body.startsWith("<!-- publish-watchdog:pr=7 -->")).toBe(true);
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
    expect(logged(env, "body-1.json")).toContain("no longer waiting to publish");
  });

  test("a 422 on create retries once without the work label", () => {
    const env = setup({ pulls: stuckPulls(), fixtures: { "issue-fail-labelled": "" } });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(creates(env)).toHaveLength(2);
    expect(JSON.parse(logged(env, "body-2.json")).labels).toEqual(["publish-stuck"]);
  });

  test("a 502 on create makes exactly ONE create call and exits 1 without echoing the body", () => {
    const env = setup({ pulls: stuckPulls(), fixtures: { "issue-fail": "502" } });
    const r = runCli(env);
    expect(r.status).toBe(1);
    expect(creates(env)).toHaveLength(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stderr).toContain("502");
    expect(r.stdout + r.stderr).not.toContain("SECRET-RESPONSE-BODY");
  });

  test("check runs are read across pages", () => {
    const page1 = { total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => run(`ok-${i}`, "completed", "success", { completed_at: iso(1) })) };
    const page2 = { total_count: 101, check_runs: [run("build", "completed", "failure")] };
    const env = setup({ pulls: stuckPulls(), fixtures: { [`checks-${SHA_A}-1.json`]: page1, [`checks-${SHA_A}-2.json`]: page2 } });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(argv(env).some((l) => l.includes("page=2"))).toBe(true);
    expect(creates(env)).toHaveLength(1);
  });

  test("a partial check-run list is in flight, never 'every check finished'", () => {
    const page1 = { total_count: 150, check_runs: Array.from({ length: 100 }, (_, i) => run(`ok-${i}`, "completed", "success", { completed_at: iso(60) })) };
    const env = setup({ pulls: stuckPulls(), fixtures: { [`checks-${SHA_A}-1.json`]: page1 } });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(writes(env)).toEqual([]);
  });

  test("a branch tip that differs from the PR head is in flight (no false alert)", () => {
    const env = setup({ pulls: stuckPulls(), fixtures: { "ref.json": { object: { sha: "e".repeat(40) } } } });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(writes(env)).toEqual([]);
  });

  test("the branch ref is read with each path segment URL-encoded", () => {
    const pulls = [makePr({ head: { ref: "cms/a b#c", sha: SHA_A, repo: { full_name: "o/r" } } })];
    const env = setup({ pulls });
    runCli(env, ["--dry-run"]);
    expect(argv(env).some((l) => l.includes("git/ref/heads/cms/a%20b%23c"))).toBe(true);
  });

  test("one PR's check-run read failing still opens the issue for another stuck PR, and spares the skipped PR's issue", () => {
    const env = setup({
      pulls: [makePr(), pr9()],
      openIssues: [{ number: 50, body: "<!-- publish-watchdog:pr=7 -->" }],
      fixtures: { [`checks-${SHA_A}-fail`]: "" },
    });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::warning::skipping pull request #7");
    expect(creates(env)).toHaveLength(1);
    expect(JSON.parse(logged(env, "body-1.json")).body).toContain("pr=9");
    expect(writes(env).some((l) => l.includes("issues/50"))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain("SECRET-RESPONSE-BODY");
  });

  test("every armed PR failing to read exits 1", () => {
    const env = setup({ pulls: [makePr(), pr9()], fixtures: { [`checks-${SHA_A}-fail`]: "", [`checks-${SHA_D}-fail`]: "" } });
    const r = runCli(env);
    expect(r.status).toBe(1);
    expect(writes(env)).toEqual([]);
  });

  test("an empty or non-numeric --grace-minutes or --stall-minutes is a usage error (exit 2)", () => {
    const env = setup({ pulls: stuckPulls() });
    for (const extra of [["--grace-minutes", ""], ["--grace-minutes", "abc"], ["--stall-minutes", ""], ["--stall-minutes", "-5"], ["--stall-minutes"]]) {
      expect(runCli(env, extra).status, extra.join(" ")).toBe(2);
    }
    expect(writes(env)).toEqual([]);
  });

  test("a list failure exits 1 without echoing the response body", () => {
    const env = setup({ pulls: stuckPulls(), fixtures: { "fail-pulls": "" } });
    const r = runCli(env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stderr).toContain("500");
    expect(r.stdout + r.stderr).not.toContain("SECRET-RESPONSE-BODY");
    expect(writes(env)).toEqual([]);
  });
});

test.describe("workflow files", () => {
  const SIGNAL_REUSABLE = path.join(ROOT, ".github/workflows/publish-watchdog-signal.yml");
  const SIGNAL_CALLER = path.join(CALLER_DIR, "publish-watchdog-signal.yml");
  const read = (f) => fs.readFileSync(f, "utf8");
  const sweepReusable = parseYaml(read(REUSABLE));
  const sweepCallerText = read(CALLER);
  const sweepCaller = parseYaml(sweepCallerText);
  const signalReusableText = read(SIGNAL_REUSABLE);
  const signalReusable = parseYaml(signalReusableText);
  const signalCallerText = read(SIGNAL_CALLER);
  const signalCaller = parseYaml(signalCallerText);

  test("neither sweep file declares pull_request or workflow_run", () => {
    for (const w of [sweepCaller, sweepReusable]) {
      expect(Object.keys(w.on)).not.toContain("pull_request");
      expect(Object.keys(w.on)).not.toContain("workflow_run");
    }
  });

  test("sweep caller triggers are exactly repository_dispatch, schedule and workflow_dispatch", () => {
    expect(Object.keys(sweepCaller.on).sort()).toEqual(["repository_dispatch", "schedule", "workflow_dispatch"]);
    expect(sweepCaller.on.repository_dispatch.types).toEqual(["publish-watchdog"]);
    expect(sweepCaller.on.schedule[0].cron).toMatch(/^([1-9]|[1-5][0-9]) \*\/6 \* \* \*$/);
    expect(sweepCaller.on.workflow_dispatch.inputs.dry_run.type).toBe("string");
    expect(sweepCallerText).toContain("fromJSON(inputs.dry_run)");
    expect(sweepCaller["run-name"]).toContain("github.event_name");
  });

  test("sweep caller serializes sweeps and never cancels one mid-write", () => {
    expect(sweepCaller.concurrency).toEqual({ group: "publish-watchdog", "cancel-in-progress": false });
    expect(sweepCaller.jobs.sweep.if).toBeUndefined();
  });

  test("sweep caller calls the reusable at a release tag and its permissions cover the reusable's", () => {
    expect(sweepCaller.jobs.sweep.uses).toMatch(/^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/publish-watchdog\.yml@v\d+\.\d+\.\d+$/);
    expect(sweepCaller.permissions).toEqual(sweepReusable.permissions);
  });

  test("sweep reusable: four permissions, one job named sweep, no mode or watch inputs, persist-credentials false", () => {
    expect(sweepReusable.permissions).toEqual({ contents: "read", "pull-requests": "read", checks: "read", issues: "write" });
    expect(Object.keys(sweepReusable.on)).toEqual(["workflow_call"]);
    expect(Object.keys(sweepReusable.jobs)).toEqual(["sweep"]);
    expect(sweepReusable.jobs.sweep["timeout-minutes"]).toBe(10);
    const i = sweepReusable.on.workflow_call.inputs;
    expect(Object.keys(i).sort()).toEqual(["dry_run", "grace_minutes", "issue_label", "stall_minutes", "work_label"]);
    expect(i.grace_minutes.default).toBe("15");
    expect(i.stall_minutes.default).toBe("60");
    expect(i.issue_label.default).toBe("publish-stuck");
    expect(i.work_label.default).toBe("agent-ready");
    expect(i.dry_run.type).toBe("boolean");
    const checkout = sweepReusable.jobs.sweep.steps.find((st) => String(st.uses || "").startsWith("actions/checkout"));
    expect(checkout.with["persist-credentials"]).toBe(false);
  });

  test("signal caller declares only workflow_run, names real examples/site callers, read-only token, one named secret", () => {
    expect(Object.keys(signalCaller.on)).toEqual(["workflow_run"]);
    expect(signalCaller.on.workflow_run.types).toEqual(["completed"]);
    const byName = new Map();
    for (const f of fs.readdirSync(CALLER_DIR)) byName.set(parseYaml(read(path.join(CALLER_DIR, f))).name, parseYaml(read(path.join(CALLER_DIR, f))));
    const names = signalCaller.on.workflow_run.workflows;
    for (const n of names) expect(byName.has(n), `no examples/site caller is named ${n}`).toBe(true);
    for (const n of names.filter((x) => x !== "Deploy to Production")) {
      expect(Object.keys(byName.get(n).on), `${n} must trigger on pull_request`).toContain("pull_request");
    }
    expect(names).toContain("Deploy to Production");
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(signalCaller.permissions).toEqual({ contents: "read" });
    const job = signalCaller.jobs.signal;
    expect(job.with).toBeUndefined();
    expect(job.secrets).toEqual({ app_private_key: "${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}" });
    expect(signalCallerText).not.toContain("secrets: inherit");
    expect(job.uses).toMatch(/^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/publish-watchdog-signal\.yml@v\d+\.\d+\.\d+$/);
  });

  test("signal caller if: same repository; failed cms/ pull_request run, or a successful production deploy", () => {
    const cond = signalCaller.jobs.signal.if;
    expect(cond).toContain("head_repository.full_name == github.repository");
    expect(cond).toContain("workflow_run.event == 'pull_request'");
    expect(cond).toContain("startsWith(github.event.workflow_run.head_branch, 'cms/')");
    for (const c of ["failure", "timed_out", "startup_failure"]) expect(cond).toContain(`"${c}"`);
    expect(cond).toContain("workflow_run.name == 'Deploy to Production'");
    expect(cond).toContain("conclusion == 'success'");
  });

  test("signal reusable: no issues or pull-requests write, persist-credentials false, sparse list exactly the minting script, contents=write narrowed to the repository", () => {
    expect(signalReusable.permissions).toEqual({ contents: "read" });
    expect(signalReusableText).not.toContain("issues: write");
    expect(signalReusableText).not.toContain("pull-requests: write");
    expect(Object.keys(signalReusable.jobs)).toEqual(["signal"]);
    expect(signalReusable.jobs.signal["timeout-minutes"]).toBe(5);
    const checkouts = signalReusable.jobs.signal.steps.filter((st) => String(st.uses || "").startsWith("actions/checkout"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with["persist-credentials"]).toBe(false);
    expect(checkouts[0].with["sparse-checkout"].trim().split("\n").map((l) => l.trim())).toEqual(["scripts/mint-app-token.js"]);
    const mint = signalReusable.jobs.signal.steps.find((st) => st.id === "app");
    expect(mint.run).toContain("--permissions contents=write");
    expect(mint.run).toContain("--repositories");
    expect(mint.run).not.toMatch(/contents=write,/);
  });

  test("the event_type the signal sends equals the types the sweep caller listens for", () => {
    const send = signalReusable.jobs.signal.steps.find((st) => st.name === "Knock the publish watchdog sweep");
    const m = /event_type=([A-Za-z0-9_-]+)/.exec(send.run);
    expect(m).not.toBeNull();
    expect(sweepCaller.on.repository_dispatch.types).toEqual([m[1]]);
    expect(send.run).toContain("client_payload={}");
  });

  test("the signal's missing-credentials path is a notice and success", () => {
    const gate = signalReusable.jobs.signal.steps.find((st) => st.id === "gate");
    expect(gate.run).toContain("::notice::");
    expect(gate.run).toContain("CMS_AUTOMATION_APP_ID");
    expect(gate.run).toContain("CMS_AUTOMATION_APP_PRIVATE_KEY");
    expect(gate.run).not.toContain("exit 1");
  });

  test("no `${{` inside any run: block of the four files", () => {
    for (const file of [REUSABLE, CALLER, SIGNAL_REUSABLE, SIGNAL_CALLER]) {
      for (const { script, line } of runScripts(read(file))) {
        expect(script, `${path.basename(file)}:${line}`).not.toContain("${{");
      }
    }
  });
});
