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
const { classifyPublish, issueMarker, renderIssue, planSweep, watchPublish } = require(SCRIPT);

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

  test("the watcher's own check run is ignored, so it never counts as pending", () => {
    const own = run("publish-watchdog / watch", "in_progress", null);
    const done = run("build", "completed", "success", { completed_at: iso(1) });
    expect(classify({ checkRuns: [own, done] }).state).toBe("in-flight");
    const old = run("build", "completed", "success", { completed_at: iso(30) });
    expect(classify({ checkRuns: [own, old] }).state).toBe("stuck");
    // an in-progress run of any other name still counts
    expect(classify({ checkRuns: [run("other", "in_progress", null), old] }).state).toBe("in-flight");
    // a custom prefix replaces the default
    expect(classify({ checkRuns: [own, old], selfCheckPrefix: "zzz" }).state).toBe("in-flight");
  });

  test("a failing check named like the watcher is also dropped", () => {
    const v = classify({ checkRuns: [run("publish-watchdog / watch", "completed", "failure")] });
    expect(v.failing).toEqual([]);
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

  test("a timeout verdict says how long it waited", () => {
    const { body } = renderIssue({ repo: "o/r", pr: makePr(), verdict: { state: "stuck", reason: "x", failing: [], waitedMinutes: 25 } });
    expect(body).toContain("not gone live after 25 minutes");
    expect(body).toContain(issueMarker(7));
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

test.describe("watchPublish", () => {
  // A scripted sequence of states with a fake clock: sleep() advances time, so
  // no real timers run. The last state repeats once the script runs out.
  function harness(states, { watchMinutes = 25, pollSeconds = 20, graceMinutes = 3 } = {}) {
    let t = NOW;
    let i = 0;
    const calls = { opened: [], closed: [], slept: 0, sleeps: 0, polls: 0 };
    const out = {
      calls,
      go: () =>
        watchPublish({
          prNumber: 7,
          watchMinutes,
          pollSeconds,
          graceMinutes,
          now: () => t,
          sleep: async (ms) => {
            calls.slept += ms;
            calls.sleeps++;
            t += ms;
          },
          fetchState: async () => {
            calls.polls++;
            const st = states[Math.min(i++, states.length - 1)];
            return typeof st === "function" ? st(t) : st;
          },
          act: {
            openIssue: async (pr, verdict) => calls.opened.push({ pr: pr.number, verdict }),
            closeIssue: async (n, p) => calls.closed.push([n, p]),
          },
        }),
    };
    return out;
  }
  const base = { requiredContexts: ["build"], files: ["_posts/2026-11-18-real-post.md"], openIssues: [] };
  const pending = () => ({ ...base, pr: makePr(), checkRuns: [run("build", "in_progress", null), run("publish-watchdog / watch", "in_progress", null)] });
  const merged = (openIssues = []) => ({ ...base, openIssues, pr: makePr({ state: "closed" }), checkRuns: [] });
  const failed = () => ({ ...base, pr: makePr(), checkRuns: [run("build", "completed", "failure"), run("slow", "in_progress", null)] });

  test("merges on the 3rd poll: resolved, no issue", async () => {
    const h = harness([pending(), pending(), merged()]);
    const r = await h.go();
    expect(r.outcome).toBe("resolved");
    expect(h.calls.polls).toBe(3);
    expect(h.calls.sleeps).toBe(2);
    expect(h.calls.opened).toEqual([]);
    expect(h.calls.closed).toEqual([]);
  });

  test("a required check fails on the 2nd poll: exactly one issue, no further polls", async () => {
    const h = harness([pending(), failed(), failed()]);
    const r = await h.go();
    expect(r.outcome).toBe("stuck");
    expect(h.calls.polls).toBe(2);
    expect(h.calls.opened).toHaveLength(1);
    expect(h.calls.opened[0].verdict.failing[0].name).toBe("build");
  });

  test("an unarmed draft is ignored with zero sleeps", async () => {
    const h = harness([{ ...pending(), pr: makePr({ draft: true, auto_merge: null }) }]);
    const r = await h.go();
    expect(r.outcome).toBe("ignored");
    expect(h.calls.sleeps).toBe(0);
    expect(h.calls.opened).toEqual([]);
  });

  test("a fixture-only PR is ignored at once", async () => {
    const h = harness([{ ...pending(), files: ["_e2e/a.md"] }]);
    expect((await h.go()).outcome).toBe("ignored");
    expect(h.calls.sleeps).toBe(0);
  });

  test("in flight until the deadline: timeout issue, slept time within one poll of watchMinutes", async () => {
    const h = harness([pending()]);
    const r = await h.go();
    expect(r.outcome).toBe("timeout");
    expect(h.calls.opened).toHaveLength(1);
    expect(h.calls.opened[0].verdict.waitedMinutes).toBe(25);
    expect(h.calls.slept).toBeLessThanOrEqual(25 * 60000);
    expect(h.calls.slept).toBeGreaterThan(25 * 60000 - 20000);
  });

  test("never sleeps past the deadline when the poll does not divide the watch time", async () => {
    const h = harness([pending()], { watchMinutes: 1, pollSeconds: 45 });
    await h.go();
    // polls at 0 and 45 s sleep; the poll at 90 s is past the deadline and does not
    expect(h.calls.sleeps).toBe(2);
    expect(h.calls.polls).toBe(3);
  });

  test("watchMinutes 0 times out at once with no sleep", async () => {
    const h = harness([pending()], { watchMinutes: 0 });
    expect((await h.go()).outcome).toBe("timeout");
    expect(h.calls.sleeps).toBe(0);
  });

  test("an existing open issue with the marker means no second issue", async () => {
    const withIssue = (st) => ({ ...st, openIssues: [{ number: 50, body: issueMarker(7) }] });
    const h1 = harness([withIssue(failed())]);
    expect((await h1.go()).outcome).toBe("stuck");
    expect(h1.calls.opened).toEqual([]);
    const h2 = harness([withIssue(pending())]);
    expect((await h2.go()).outcome).toBe("timeout");
    expect(h2.calls.opened).toEqual([]);
  });

  test("a merged PR with an open watchdog issue closes that issue", async () => {
    const h = harness([merged([{ number: 50, body: issueMarker(7) }, { number: 51, body: issueMarker(8) }])]);
    expect((await h.go()).outcome).toBe("resolved");
    expect(h.calls.closed).toEqual([[50, 7]]);
  });

  test("its own pending check run is not counted as pending", async () => {
    const settled = {
      ...base,
      pr: makePr(),
      checkRuns: [
        run("build", "completed", "success", { completed_at: iso(10) }),
        run("publish-watchdog / watch", "in_progress", null),
      ],
    };
    const h = harness([settled]);
    expect((await h.go()).outcome).toBe("stuck");
    expect(h.calls.sleeps).toBe(0);
  });

  test("a failed poll is retried on the next poll", async () => {
    const h = harness([() => { throw new Error("boom"); }, merged()]);
    const r = await h.go();
    expect(r.outcome).toBe("resolved");
    expect(r.failures).toBe(1);
    expect(h.calls.sleeps).toBe(1);
  });

  test("every poll failing reports unknown, never an issue", async () => {
    const h = harness([() => { throw new Error("boom"); }], { watchMinutes: 1 });
    const r = await h.go();
    expect(r.outcome).toBe("unknown");
    expect(r.failures).toBe(r.polls);
    expect(h.calls.opened).toEqual([]);
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
    put("pr.json", Array.isArray(pulls) ? pulls[0] : pulls);
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
  repos/o/r/pulls/[0-9]*) cat "${fix}/pr.json" ;;
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

  test("--watch on a stuck PR opens exactly one issue and exits 0", () => {
    const env = setup({ pulls: stuckPulls() });
    const r = runCli(env, ["--watch", "7"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("outcome stuck");
    expect(writes(env)).toHaveLength(1);
    expect(JSON.parse(logged(env, "body-1.json")).body).toContain("<!-- publish-watchdog:pr=7 -->");
  });

  test("--watch with an existing marked issue opens nothing", () => {
    const env = setup({ pulls: stuckPulls(), openIssues: [{ number: 50, body: "<!-- publish-watchdog:pr=7 -->" }] });
    const r = runCli(env, ["--watch", "7"]);
    expect(r.status).toBe(0);
    expect(writes(env)).toEqual([]);
  });

  test("--watch --dry-run writes nothing", () => {
    const env = setup({ pulls: stuckPulls() });
    const r = runCli(env, ["--watch", "7", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("would open an issue");
    expect(writes(env)).toEqual([]);
  });

  test("--watch reaching its deadline while in flight opens a timeout issue", () => {
    const env = setup({ pulls: stuckPulls() });
    fs.writeFileSync(path.join(env.dir, "fix", "checks.json"), JSON.stringify({ check_runs: [run("build", "in_progress", null)] }));
    const r = runCli(env, ["--watch", "7", "--watch-minutes", "0"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("outcome timeout");
    expect(JSON.parse(logged(env, "body-1.json")).body).toContain("not gone live after 0 minutes");
  });

  test("--watch where every poll fails exits 1 without echoing the body", () => {
    const env = setup({ pulls: stuckPulls() });
    fs.writeFileSync(path.join(env.dir, "fix", "fail-pulls"), "");
    // the single-PR endpoint fails too: point the stub's pr read at the failing list path
    const gh = path.join(env.bin, "gh");
    fs.writeFileSync(gh, '#!/bin/sh\necho "SECRET-RESPONSE-BODY"\necho "gh: HTTP 500 SECRET-RESPONSE-BODY" >&2\nexit 1\n');
    const r = runCli(env, ["--watch", "7", "--watch-minutes", "0"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stdout + r.stderr).not.toContain("SECRET-RESPONSE-BODY");
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

  test("neither workflow declares workflow_run", () => {
    expect(Object.keys(caller.on)).not.toContain("workflow_run");
    expect(Object.keys(reusable.on)).not.toContain("workflow_run");
  });

  test("caller triggers: pull_request on main, 6-hourly off-peak schedule, coerced dry_run dispatch", () => {
    expect(Object.keys(caller.on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
    expect(caller.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "labeled"]);
    expect(caller.on.pull_request.branches).toEqual(["main"]);
    expect(caller.on.schedule[0].cron).toMatch(/^([1-9]|[1-5][0-9]) \*\/6 \* \* \*$/);
    expect(caller.on.workflow_dispatch.inputs.dry_run.type).toBe("string");
    expect(callerText).toContain("fromJSON(inputs.dry_run)");
    expect(caller["run-name"]).toContain("github.event_name");
  });

  test("caller job if restricts pull_request to same-repository cms/ branches", () => {
    const cond = caller.jobs["publish-watchdog"].if;
    expect(cond).toContain("github.event_name != 'pull_request'");
    expect(cond).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(cond).toContain("startsWith(github.event.pull_request.head.ref, 'cms/')");
  });

  test("caller wires mode and pr_number to the reusable and cancels superseded watchers", () => {
    const w = caller.jobs["publish-watchdog"].with;
    expect(w.mode).toContain("'watch'");
    expect(w.mode).toContain("'sweep'");
    expect(w.pr_number).toContain("github.event.pull_request.number");
    expect(caller.concurrency["cancel-in-progress"]).toBe(true);
    expect(caller.concurrency.group).toContain("github.event.pull_request.number");
    expect(caller.concurrency.group).toContain("'sweep'");
  });

  test("reusable job is named watch with a timeout above watch_minutes", () => {
    expect(Object.keys(reusable.jobs)).toEqual(["watch"]);
    const watchMinutes = Number(reusable.on.workflow_call.inputs.watch_minutes.default);
    expect(reusable.jobs.watch["timeout-minutes"]).toBeGreaterThan(watchMinutes + 5);
  });

  test("reusable passes mode and pr_number to the script only through env", () => {
    const step = reusable.jobs.watch.steps.find((st) => st.name === "Look for stuck publishes");
    expect(step.env.WATCHDOG_MODE).toBe("${{ inputs.mode }}");
    expect(step.env.WATCHDOG_PR_NUMBER).toBe("${{ inputs.pr_number }}");
  });

  test("caller calls the reusable at a release tag and its permissions cover the reusable's", () => {
    expect(caller.jobs["publish-watchdog"].uses).toMatch(/^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/publish-watchdog\.yml@v\d+\.\d+\.\d+$/);
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
  });

  test("reusable inputs have the documented defaults", () => {
    const i = reusable.on.workflow_call.inputs;
    expect(i.mode.default).toBe("sweep");
    expect(i.pr_number.default).toBe("");
    expect(i.watch_minutes.default).toBe("25");
    expect(i.poll_seconds.default).toBe("20");
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
