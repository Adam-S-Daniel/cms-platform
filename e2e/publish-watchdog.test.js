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
const vm = require("node:vm");
const acorn = require("acorn");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, runScripts } = require("./workflow-yaml-utils");
const { writeStubs, runStep } = require("./workflow-step-harness");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/publish-watchdog.js");
const REUSABLE = path.join(ROOT, ".github/workflows/publish-watchdog.yml");
const CALLER_DIR = path.join(ROOT, "examples/site/.github/workflows");
const CALLER = path.join(CALLER_DIR, "publish-watchdog.yml");
const { classifyPublish, issueMarker, renderIssue, planSweep, sweepWithFollowUps } = require(SCRIPT);

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
      "requiredContexts null: any failure counts once nothing is still running",
      { requiredContexts: null, checkRuns: [run("optional", "completed", "failure"), run("build", "completed", "success", { completed_at: iso(1) })] },
      "stuck",
    ],
    [
      "requiredContexts null: a failure does not alert while another check still runs",
      { requiredContexts: null, checkRuns: [run("optional", "completed", "failure"), run("build", "in_progress", null)] },
      "in-flight",
    ],
    [
      "requiredContexts readable: a required failure alerts at once while others run",
      { requiredContexts: ["optional"], checkRuns: [run("optional", "completed", "failure"), run("build", "in_progress", null)] },
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
    ["branch tip differs: in flight even with a required failure on the old head", { pr: makePr({ updated_at: iso(5) }), branchSha: "f".repeat(40), checkRuns: failed() }, "in-flight"],
    ["branch tip equals head: normal rules apply", { branchSha: "a".repeat(40), checkRuns: failed() }, "stuck"],
    ["branch tip null: normal rules apply", { branchSha: null, checkRuns: failed() }, "stuck"],
    ["branch tip undefined: normal rules apply", { branchSha: undefined, checkRuns: failed() }, "stuck"],
    ["stalled in flight: oldest unfinished run older than stallMinutes", { checkRuns: [run("build", "in_progress", null, { started_at: iso(61) })] }, "stuck"],
    ["in flight but younger than stallMinutes", { checkRuns: [run("build", "in_progress", null, { started_at: iso(59) })] }, "in-flight"],
    ["stall measured from the OLDEST unfinished run", { checkRuns: [run("a", "in_progress", null, { started_at: iso(5) }), run("b", "queued", null, { started_at: iso(90) })] }, "stuck"],
    ["a custom stallMinutes", { stallMinutes: 10, checkRuns: [run("build", "in_progress", null, { started_at: iso(11) })] }, "stuck"],
    ["a waiting run older than the stall window", { checkRuns: [run("gate", "waiting", null, { started_at: iso(120) })] }, "stuck"],
    ["a waiting run younger than the stall window", { checkRuns: [run("gate", "waiting", null, { started_at: iso(5) })] }, "in-flight"],
    ["unfinished run with an unparseable started_at: aged from a recent pr.updated_at, in flight", { checkRuns: [run("build", "in_progress", null, { started_at: "garbage" })], pr: makePr({ updated_at: iso(5) }) }, "in-flight"],
    ["unfinished run with no started_at: aged from an old pr.updated_at, stuck", { checkRuns: [run("build", "queued", null, { started_at: null })], pr: makePr({ updated_at: iso(500) }) }, "stuck"],
    ["unfinished run with no usable start AND no usable updated_at never alerts", { checkRuns: [run("build", "queued", null, { started_at: null })], pr: makePr({ updated_at: "garbage" }) }, "in-flight"],
    ["requiredContexts [] behaves as null: any failure counts", { requiredContexts: [], checkRuns: [run("optional", "completed", "failure")] }, "stuck"],
    ["partial check-run list is in flight", { pr: makePr({ updated_at: iso(5) }), incomplete: true, checkRuns: [run("build", "completed", "success", { completed_at: iso(60) })] }, "in-flight"],
    ["partial list and a PR untouched for the stall window: stuck, GitHub has not caught up", { pr: makePr({ updated_at: iso(61) }), incomplete: true, checkRuns: [] }, "stuck"],
    ["branch tip differs and a PR untouched for the stall window: stuck", { pr: makePr({ updated_at: iso(61) }), branchSha: "f".repeat(40), checkRuns: [] }, "stuck"],
    ["branch tip differs with an unparseable updated_at: in flight", { pr: makePr({ updated_at: "x" }), branchSha: "f".repeat(40), checkRuns: [] }, "in-flight"],
    [
      "newest by id: a queued re-run with no started_at beats the old failure",
      { pr: makePr({ updated_at: iso(5) }), checkRuns: [run("build", "completed", "failure", { id: 10, started_at: iso(40) }), run("build", "queued", null, { id: 11, started_at: null })] },
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
    expect(body).toContain("waiting for someone to approve it");
    expect(body).toContain("[gate](https://example.com/g)");
    expect(body).not.toContain("red check");
    expect(body.startsWith(issueMarker(7, "a".repeat(40)))).toBe(true);
  });

  test("each stalled run is described by its status", () => {
    const v = classify({
      checkRuns: [
        run("gate", "waiting", null, { started_at: iso(120), html_url: "https://example.com/g" }),
        run("slow", "queued", null, { started_at: iso(90), html_url: "https://example.com/s" }),
        run("long", "in_progress", null, { started_at: iso(80), html_url: "https://example.com/l" }),
      ],
    });
    const { body } = renderIssue({ repo: "o/r", pr: makePr(), verdict: v });
    expect(body).toContain("[gate](https://example.com/g): waiting for someone to approve it");
    expect(body).toContain("[slow](https://example.com/s): has not started");
    expect(body).toContain("[long](https://example.com/l): has been running for more than 60 minutes");
    expect(body).not.toContain("red check");
  });

  test("a lagging verdict has a neutral body and no red-check sentence", () => {
    const v = classify({ pr: makePr({ updated_at: iso(61) }), incomplete: true, checkRuns: [] });
    expect(v.reason).toBe("GitHub has not caught up with this pull request for more than 60 minutes.");
    const { body } = renderIssue({ repo: "o/r", pr: makePr(), verdict: v });
    expect(body).toContain("GitHub has not caught up with this pull request for more than 60 minutes.");
    expect(body).not.toContain("red check");
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
    expect(body.startsWith(issueMarker(7, "a".repeat(40)))).toBe(true);
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
  const bot = (number, body, state = "open", login = "github-actions[bot]") => ({ number, body, state, user: { login } });
  const sweep = (over) => planSweep({ prs: [], issues: [], nowMs: NOW, graceMinutes: 15, ...over });
  const SHA = "a".repeat(40);

  test("opens one issue for a stuck PR with no issue", () => {
    const plan = sweep({ prs: [stuckEntry(7)] });
    expect(plan.open.map((o) => o.pr.number)).toEqual([7]);
    expect(plan.open[0].verdict.state).toBe("stuck");
    expect(plan.close).toEqual([]);
    expect(plan.pending).toBe(0);
  });

  test("no duplicate when an open issue carries the marker", () => {
    const plan = sweep({ prs: [stuckEntry(7)], issues: [bot(50, `${issueMarker(7, SHA)}\nx\n`)] });
    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([]);
  });

  test("a marker without a sha matches any head commit", () => {
    expect(sweep({ prs: [stuckEntry(7)], issues: [bot(50, issueMarker(7))] }).open).toEqual([]);
  });

  test("a CLOSED issue for the same pull request and head sha is respected (no new issue)", () => {
    const plan = sweep({ prs: [stuckEntry(7)], issues: [bot(50, issueMarker(7, SHA), "closed")] });
    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([]);
  });

  test("a closed issue for an OLDER head sha does not block a new alert for the new commit", () => {
    const plan = sweep({ prs: [stuckEntry(7)], issues: [bot(50, issueMarker(7, "b".repeat(40)), "closed")] });
    expect(plan.open.map((o) => o.pr.number)).toEqual([7]);
  });

  test("closed issues are never closed again", () => {
    const plan = sweep({ issues: [bot(50, issueMarker(9, SHA), "closed")] });
    expect(plan.close).toEqual([]);
  });

  test("marker text in an issue not authored by the Actions bot is ignored", () => {
    const plan = sweep({ prs: [stuckEntry(7)], issues: [bot(50, issueMarker(7, SHA), "open", "someone-else"), { number: 51, body: issueMarker(7, SHA) }] });
    expect(plan.open.map((o) => o.pr.number)).toEqual([7]);
    expect(plan.close).toEqual([]);
  });

  test("a marker anywhere in a bot-authored body counts", () => {
    const plan = sweep({ prs: [stuckEntry(7)], issues: [bot(50, `Some text\n${issueMarker(7, SHA)}\n`)] });
    expect(plan.open).toEqual([]);
  });

  test("an unmarked issue is left alone", () => {
    const plan = sweep({ issues: [bot(50, "unrelated"), bot(51, null)] });
    expect(plan.close).toEqual([]);
  });

  test("closes when the PR is merged or closed, gone from the list, or no longer armed; not while it is in flight", () => {
    const plan = sweep({
      prs: [
        inFlightEntry(7),
        { ...stuckEntry(8), pr: makePr({ number: 8, state: "closed" }) },
        { ...stuckEntry(10), pr: makePr({ number: 10, auto_merge: null, labels: [] }) },
      ],
      issues: [bot(50, issueMarker(7)), bot(51, issueMarker(8)), bot(52, issueMarker(9)), bot(53, issueMarker(10))],
    });
    expect(plan.open).toEqual([]);
    expect(plan.close).toEqual([
      { issueNumber: 51, prNumber: 8 },
      { issueNumber: 52, prNumber: 9 },
      { issueNumber: 53, prNumber: 10 },
    ]);
  });

  test("a skipped PR's issue is left open and no duplicate is opened for it", () => {
    const plan = sweep({ issues: [bot(50, issueMarker(7))], skipped: new Set([7]) });
    expect(plan.close).toEqual([]);
    expect(sweep({ issues: [bot(50, issueMarker(7))] }).close).toEqual([{ issueNumber: 50, prNumber: 7 }]);
    expect(sweep({ prs: [stuckEntry(7)], skipped: [7] }).open).toEqual([]);
  });

  test("an issue stays open while its PR is open and armed, even when not stuck", () => {
    const plan = sweep({ prs: [inFlightEntry(7)], issues: [bot(50, issueMarker(7))] });
    expect(plan.close).toEqual([]);
    expect(plan.pending).toBe(1);
  });

  test("pending counts only in-flight armed PRs", () => {
    const plan = sweep({ prs: [inFlightEntry(7), stuckEntry(8), { ...stuckEntry(9), pr: makePr({ number: 9, draft: true }) }] });
    expect(plan.pending).toBe(1);
  });

  test("one issue per PR across several stuck PRs", () => {
    const plan = sweep({ prs: [stuckEntry(7), stuckEntry(8)], issues: [bot(50, issueMarker(8))] });
    expect(plan.open.map((o) => o.pr.number)).toEqual([7]);
  });
});

test.describe("sweepWithFollowUps", () => {
  // Fake clock; sleep() advances it. `script` is the sequence of runOnce results
  // (a number is { pending }, an Error is thrown); the last repeats.
  function harness(script, followUpMinutes) {
    let t = 0;
    let i = 0;
    const slept = [];
    return {
      slept,
      go: () =>
        sweepWithFollowUps({
          now: () => t,
          sleep: async (ms) => {
            slept.push(ms);
            t += ms;
          },
          followUpMinutes,
          runOnce: async () => {
            const r = script[Math.min(i++, script.length - 1)];
            if (r instanceof Error) throw r;
            return { pending: r };
          },
        }),
    };
  }
  const min = (n) => n * 60000;

  test("nothing pending: one pass, zero sleeps", async () => {
    const h = harness([0], [5, 16]);
    expect(await h.go()).toEqual({ passes: 1, failures: 0 });
    expect(h.slept).toEqual([]);
  });

  test("pending, resolved at the first follow-up: two passes", async () => {
    const h = harness([1, 0], [5, 16]);
    expect(await h.go()).toEqual({ passes: 2, failures: 0 });
    expect(h.slept).toEqual([min(5)]);
  });

  test("pending throughout: exactly three passes and 16 minutes of sleep", async () => {
    const h = harness([2], [5, 16]);
    expect(await h.go()).toEqual({ passes: 3, failures: 0 });
    expect(h.slept).toEqual([min(5), min(11)]);
    expect(h.slept.reduce((a, b) => a + b, 0)).toBe(min(16));
  });

  test("an empty follow-up list is one pass", async () => {
    const h = harness([3], []);
    expect(await h.go()).toEqual({ passes: 1, failures: 0 });
    expect(h.slept).toEqual([]);
  });

  test("a pass that throws does not cancel the remaining follow-ups, and is reported", async () => {
    const h = harness([new Error("boom"), 0], [5, 16]);
    expect(await h.go()).toEqual({ passes: 2, failures: 1 });
    expect(h.slept).toEqual([min(5)]);
    const all = harness([new Error("boom")], [5, 16]);
    expect(await all.go()).toEqual({ passes: 3, failures: 3 });
  });
});

// The reviewer's scenario for the old 15-minute grace: Save and Publish
// together, so the sweep starts while the checks are still running; they go
// green a few minutes later and the pull request never merges. Every pass
// must be judged against the DEFAULT grace, and the follow-up that comes
// three settled minutes after the last check must alert.
test.describe("green but never merged, with checks finishing after the first pass", () => {
  const { sweepWithFollowUps: follow } = require(SCRIPT);
  const T0 = Date.parse("2026-11-19T12:00:00Z"); // Publish pressed
  const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();

  async function drive(checksGreenAtMinute) {
    let clock = T0 + 1.5 * 60000; // the signal's sweep starts 90 seconds after Publish
    const passes = [];
    const result = await follow({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      runOnce: async () => {
        const minute = (clock - T0) / 60000;
        const done = minute >= checksGreenAtMinute;
        const plan = planSweep({
          prs: [
            {
              pr: makePr({ updated_at: at(0) }),
              checkRuns: [
                run("build", done ? "completed" : "in_progress", done ? "success" : null, {
                  started_at: at(0.2),
                  completed_at: done ? at(checksGreenAtMinute) : null,
                }),
              ],
              requiredContexts: ["build"],
              files: ["_posts/2026-11-18-real-post.md"],
            },
          ],
          issues: [],
          nowMs: clock,
        });
        passes.push({ minute, opened: plan.open.length, pending: plan.pending });
        return { pending: plan.pending };
      },
    });
    return { passes, result };
  }

  test("checks green 3.2 minutes after Publish: alerted at the first follow-up, 6.5 minutes in", async () => {
    const { passes } = await drive(3.2);
    expect(passes.map((p) => p.minute)).toEqual([1.5, 6.5]);
    expect(passes[0]).toMatchObject({ opened: 0, pending: 1 });
    expect(passes[1]).toMatchObject({ opened: 1, pending: 0 });
  });

  test("checks green 10 minutes after Publish: alerted at the second follow-up, 17.5 minutes in", async () => {
    const { passes } = await drive(10);
    expect(passes.map((p) => p.minute)).toEqual([1.5, 6.5, 17.5]);
    expect(passes.map((p) => p.opened)).toEqual([0, 0, 1]);
  });

  test("checks still running at the last follow-up: no alert from this sweep (the stall rule's job)", async () => {
    const { passes } = await drive(30);
    expect(passes.map((p) => p.minute)).toEqual([1.5, 6.5, 17.5]);
    expect(passes.map((p) => p.opened)).toEqual([0, 0, 0]);
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
    if [ -f "${fix}/issue-fail-assigned" ]; then
      case "$body" in *assignees*) echo "gh: HTTP 422" >&2; exit 1 ;; esac
    fi
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
      [SCRIPT, "--repo", "o/r", "--now", "2026-11-19T12:00:00Z", ...extra, "--follow-up-minutes", ""],
      { encoding: "utf8", timeout: 20000, env: { PATH: `${env.bin}:${process.env.PATH}`, HOME: env.dir } },
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
    expect(body.body.startsWith(`<!-- publish-watchdog:pr=7 sha=${SHA_A} -->`)).toBe(true);
    expect(body.labels).toEqual(["publish-stuck", "agent-ready"]);
    expect(body.title).not.toContain("cms/");
  });

  test("an existing marked issue means no new issue; a stale marked issue is commented then closed", () => {
    const env = setup({
      pulls: stuckPulls(),
      openIssues: [
        { number: 50, state: "open", user: { login: "github-actions[bot]" }, body: "<!-- publish-watchdog:pr=7 -->" },
        { number: 51, state: "open", user: { login: "github-actions[bot]" }, body: "<!-- publish-watchdog:pr=3 -->" },
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
    // The close rewrites the marker, so an issue the SWEEP closed does not
    // suppress a later alert for the same commit; only a person's close does.
    const patch = JSON.parse(logged(env, "body-2.json"));
    expect(patch.state).toBe("closed");
    expect(patch.body).toBe("<!-- publish-watchdog-resolved:pr=3 -->");
  });

  test("an issue the sweep closed itself does not suppress a new alert for the same commit", () => {
    // What the close above leaves behind: a closed issue with the resolved marker.
    const env = setup({
      pulls: stuckPulls(),
      openIssues: [{ number: 50, state: "closed", user: { login: "github-actions[bot]" }, body: `<!-- publish-watchdog-resolved:pr=7 sha=${SHA_A} -->` }],
    });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(creates(env)).toHaveLength(1);
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
    const env = setup({ pulls: [makePr({ updated_at: iso(5) })], fixtures: { [`checks-${SHA_A}-1.json`]: page1 } });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(writes(env)).toEqual([]);
  });

  test("a branch tip that differs from the PR head is in flight (no false alert)", () => {
    const env = setup({ pulls: [makePr({ updated_at: iso(5) })], fixtures: { "ref.json": { object: { sha: "e".repeat(40) } } } });
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
      openIssues: [{ number: 50, state: "open", user: { login: "github-actions[bot]" }, body: "<!-- publish-watchdog:pr=7 -->" }],
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

  test("held, test, draft and unarmed PRs cost no per-PR API call", () => {
    const mk = (n, over) => makePr({ number: n, head: { ref: `cms/p${n}`, sha: String(n).repeat(40).slice(0, 40), repo: { full_name: "o/r" } }, ...over });
    const pulls = [
      mk(1, { labels: [{ name: "on-hold" }] }),
      mk(2, { labels: [{ name: "automated-test" }] }),
      mk(3, { draft: true }),
      mk(4, { auto_merge: null }),
    ];
    const env = setup({ pulls });
    const r = runCli(env);
    expect(r.status).toBe(0);
    const calls = argv(env).filter(Boolean);
    expect(calls.filter((l) => /check-runs|git\/ref|\/files|rules\/branches|api repos\/o\/r$/.test(l))).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("repos/o/r/pulls?state=open");
    expect(calls[1]).toContain("repos/o/r/issues?state=open");
    expect(calls[2]).toContain("repos/o/r/issues?state=closed");
  });

  test("every open issue is listed however old; closed ones only from the last 14 days", () => {
    // An alert on a pull request stuck for weeks must still be found, or the
    // sweep opens a duplicate and never closes the original.
    const env = setup({ pulls: stuckPulls() });
    runCli(env, ["--dry-run"]);
    const calls = argv(env).filter((l) => l.includes("repos/o/r/issues?"));
    expect(calls).toHaveLength(2);
    const open = calls.find((l) => l.includes("state=open"));
    const closed = calls.find((l) => l.includes("state=closed"));
    expect(open).toContain("labels=publish-stuck");
    expect(open).not.toContain("since=");
    expect(closed).toContain("labels=publish-stuck");
    expect(closed).toContain("since=2026-11-05T12%3A00%3A00.000Z");
  });

  test("--follow-up-minutes is bounded so it cannot outlast the job", () => {
    const env = setup({ pulls: stuckPulls() });
    expect(runCli(env, ["--dry-run", "--follow-up-minutes", "1,2,3,4,5"]).status).toBe(2);
    expect(runCli(env, ["--dry-run", "--follow-up-minutes", "5,26"]).status).toBe(2);
    expect(runCli(env, ["--dry-run", "--follow-up-minutes", "5,16,25"]).status).toBe(0);
  });

  test("assignees typed with spaces are accepted", () => {
    const env = setup({ pulls: stuckPulls() });
    const r = runCli(env, ["--assignees", "alice, bob"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(logged(env, "body-1.json")).assignees).toEqual(["alice", "bob"]);
  });

  test("a closed issue for the same head sha means no new issue", () => {
    const env = setup({
      pulls: stuckPulls(),
      openIssues: [{ number: 50, state: "closed", user: { login: "github-actions[bot]" }, body: `<!-- publish-watchdog:pr=7 sha=${SHA_A} -->` }],
    });
    const r = runCli(env);
    expect(r.status).toBe(0);
    expect(writes(env)).toEqual([]);
  });

  test("assignees are sent on create when valid", () => {
    const env = setup({ pulls: stuckPulls() });
    expect(runCli(env, ["--assignees", "octo-cat,hubot"]).status).toBe(0);
    expect(JSON.parse(logged(env, "body-1.json")).assignees).toEqual(["octo-cat", "hubot"]);
  });

  test("invalid assignees are a warning and no assignees, never a failed alert", () => {
    const env = setup({ pulls: stuckPulls() });
    const r = runCli(env, ["--assignees", "bad login,$(x)"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::warning::");
    expect(JSON.parse(logged(env, "body-1.json")).assignees).toBeUndefined();
    expect(creates(env)).toHaveLength(1);
  });

  test("a 422 with assignees retries once without assignees AND without the work label", () => {
    const env = setup({ pulls: stuckPulls(), fixtures: { "issue-fail-assigned": "" } });
    const r = runCli(env, ["--assignees", "nobody-here"]);
    expect(r.status).toBe(0);
    expect(creates(env)).toHaveLength(2);
    const retry = JSON.parse(logged(env, "body-2.json"));
    expect(retry.assignees).toBeUndefined();
    expect(retry.labels).toEqual(["publish-stuck"]);
  });

  test("follow-ups re-run the sweep while a publish is in flight (0,0 means two extra passes, no real wait)", () => {
    const env = setup({ pulls: [makePr({ updated_at: iso(5) })], fixtures: { "checks.json": { total_count: 1, check_runs: [run("build", "in_progress", null)] } } });
    const r = runCli(env, ["--follow-up-minutes", "0,0"]);
    expect(r.status).toBe(0);
    expect(argv(env).filter((l) => l.includes("repos/o/r/pulls?state=open"))).toHaveLength(3);
  });

  test("nothing in flight: one pass even with follow-ups configured", () => {
    const env = setup({ pulls: stuckPulls() });
    runCli(env, ["--follow-up-minutes", "0,0"]);
    expect(argv(env).filter((l) => l.includes("repos/o/r/pulls?state=open"))).toHaveLength(1);
  });

  test("--dry-run never sleeps: one pass even while in flight", () => {
    const env = setup({ pulls: [makePr({ updated_at: iso(5) })], fixtures: { "checks.json": { total_count: 1, check_runs: [run("build", "in_progress", null)] } } });
    const r = runCli(env, ["--dry-run", "--follow-up-minutes", "5,16"]);
    expect(r.status).toBe(0);
    expect(argv(env).filter((l) => l.includes("repos/o/r/pulls?state=open"))).toHaveLength(1);
  });

  test("a non-numeric --follow-up-minutes is a usage error (exit 2)", () => {
    const env = setup({ pulls: stuckPulls() });
    for (const extra of [["--follow-up-minutes", "5,abc"], ["--follow-up-minutes", "-1"], ["--follow-up-minutes"]]) {
      expect(runCli(env, extra).status, extra.join(" ")).toBe(2);
    }
    expect(argv(env).filter(Boolean)).toEqual([]);
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
  // Named `-knock`, not `-signal`: the rename is how the bump retires the
  // v0.1.182 caller (whose body held a wrong `if`) and seeds this one.
  const SIGNAL_CALLER = path.join(CALLER_DIR, "publish-watchdog-knock.yml");
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

  test("sweep caller passes the assignees variable and no site-specific literal", () => {
    expect(sweepCaller.jobs.sweep.with.assignees).toBe("${{ vars.PUBLISH_ALERT_ASSIGNEES }}");
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
    expect(sweepReusable.jobs.sweep["timeout-minutes"]).toBe(30);
    const i = sweepReusable.on.workflow_call.inputs;
    expect(Object.keys(i).sort()).toEqual(["assignees", "dry_run", "follow_up_minutes", "grace_minutes", "issue_label", "stall_minutes", "work_label"]);
    expect(i.grace_minutes.default).toBe("3");
    expect(i.stall_minutes.default).toBe("60");
    expect(i.follow_up_minutes.default).toBe("5,16");
    expect(i.assignees.default).toBe("");
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

  test("the decision lives in the reusable, not the caller: a release can correct it only there", () => {
    // A bump re-pins an existing caller and never rewrites its body.
    expect(signalCaller.jobs.signal.if, "the thin caller has no `if`").toBeUndefined();
    expect(fs.existsSync(path.join(CALLER_DIR, "publish-watchdog-signal.yml")), "the v0.1.182 caller name is retired").toBe(false);
    const cond = String(signalReusable.jobs.signal.if);
    expect(cond).toContain("github.event_name == 'workflow_run'");
    expect(cond).toContain("head_repository.full_name == github.repository");
    expect(cond).toContain("workflow_run.event == 'pull_request'");
    expect(cond).toContain("startsWith(github.event.workflow_run.head_branch, 'cms/')");
    for (const c of ["failure", "timed_out", "startup_failure", "cancelled"]) expect(cond).toContain(`"${c}"`);
    expect(cond).toContain("github.event.workflow.path == '.github/workflows/deploy-production.yml'");
    expect(cond).toContain("conclusion == 'success'");
    // `workflow_run.name` is the run's DISPLAY TITLE (the workflow's
    // `run-name`), not the workflow's name; comparing it shipped two dead
    // branches in v0.1.182. Nothing here may read it, the run-name included.
    expect(cond).not.toContain("workflow_run.name");
    expect(String(signalCaller["run-name"])).not.toContain("workflow_run.name");
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

  function runSend(extraStub = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-signal-"));
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "argv.log");
    writeStubs(bin, {
      gh: `for a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n${extraStub}`,
    });
    const step = signalReusable.jobs.signal.steps.find((st) => st.name === "Knock the publish watchdog sweep");
    const r = runStep(step, {
      cwd: dir,
      scratch: path.join(dir, "scratch"),
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", HOME: dir },
      stepEnv: { GH_TOKEN: "stub-token" },
    });
    return { r, args: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
  }

  test("the signal's send step EXECUTES with exactly one event_type field, no client_payload, POST to /dispatches", () => {
    const { r, args } = runSend();
    expect(r.status).toBe(0);
    expect(args.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/o/r/dispatches"]);
    expect(args.filter((a) => a.startsWith("event_type="))).toEqual(["event_type=publish-watchdog"]);
    expect(args.join(" ")).not.toContain("client_payload");
    expect(args).toEqual(["api", "-X", "POST", "repos/o/r/dispatches", "-f", "event_type=publish-watchdog"]);
  });

  test("a failed dispatch is a status-only ::error:: and exit 1, never the response body", () => {
    const { r } = runSend('echo "SECRET-RESPONSE-BODY"; echo "gh: HTTP 422 SECRET-RESPONSE-BODY" >&2; exit 1');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error::");
    expect(r.stdout).toContain("HTTP 422");
    expect(r.stdout + r.stderr).not.toContain("SECRET-RESPONSE-BODY");
  });

  test("the event_type the signal sends equals the types the sweep caller listens for", () => {
    const { args } = runSend();
    const sent = args.find((a) => a.startsWith("event_type=")).slice("event_type=".length);
    expect(sweepCaller.on.repository_dispatch.types).toEqual([sent]);
  });

  // Evaluate the signal caller's job `if` the way GitHub does, with a fake
  // `github` context shaped like a real `workflow_run` event: `workflow` is the
  // workflow FILE (name and path), and `workflow_run.name` is that run's
  // display title, which for a workflow with a `run-name` is NOT its name.
  const WORKFLOWS = {
    editorial: { name: "CMS Editorial Workflow", path: ".github/workflows/cms-editorial-workflow.yml", title: "PR #7 — Update Post “hello”" },
    e2e: { name: "E2E Tests", path: ".github/workflows/e2e-tests.yml", title: "PR #7 — Update Post “hello”" },
    verify: { name: "Site verify", path: ".github/workflows/site-verify.yml", title: "PR #7 — Update Post “hello”" },
    scan: { name: "Secrets scan", path: ".github/workflows/secrets-scan.yml", title: "Secrets scan" },
    deploy: { name: "Deploy to Production", path: ".github/workflows/deploy-production.yml", title: "push — main @someone" },
  };
  function signalFires({ wf, title, event = "pull_request", branch = "cms/posts/x", conclusion, head = "o/r" }) {
    const expression = String(signalReusable.jobs.signal.if).trim();
    const ast = acorn.parse(`(${expression})`, { ecmaVersion: "latest" });
    expect(ast.body).toHaveLength(1);
    const w = WORKFLOWS[wf];
    const context = {
      github: {
        repository: "o/r",
        event_name: "workflow_run",
        event: {
          workflow: { name: w.name, path: w.path },
          workflow_run: {
            name: title === undefined ? w.title : title,
            path: w.path,
            event,
            head_branch: branch,
            conclusion,
            head_repository: { full_name: head },
          },
        },
      },
      startsWith: (a, b) => String(a).startsWith(String(b)),
      contains: (a, b) => (Array.isArray(a) ? a.includes(b) : String(a).includes(String(b))),
      fromJSON: (x) => JSON.parse(x),
    };
    return Boolean(vm.runInNewContext(`(${expression})`, context, { timeout: 1000 }));
  }

  const FIRE = [
    ["a failure on a cms PR", { wf: "e2e", conclusion: "failure" }, true],
    ["a timeout on a cms PR", { wf: "e2e", conclusion: "timed_out" }, true],
    ["a startup failure on a cms PR", { wf: "verify", conclusion: "startup_failure" }, true],
    ["a cancellation on a cms PR", { wf: "e2e", conclusion: "cancelled" }, true],
    ["a success of a non-editorial gating workflow on a cms PR", { wf: "e2e", conclusion: "success" }, false],
    ["a skipped non-editorial gating workflow on a cms PR", { wf: "e2e", conclusion: "skipped" }, false],
    ["a success of the editorial workflow on a cms PR (Publish pressed)", { wf: "editorial", conclusion: "success" }, true],
    ["a failure of the editorial workflow on a cms PR", { wf: "editorial", conclusion: "failure" }, true],
    ["a skipped editorial workflow on a cms PR", { wf: "editorial", conclusion: "skipped" }, true],
    ["a failure on a non-cms branch", { wf: "e2e", conclusion: "failure", branch: "feat/x" }, false],
    ["the editorial workflow on a non-cms branch", { wf: "editorial", conclusion: "success", branch: "feat/x" }, false],
    ["a failure from a fork head repository", { wf: "e2e", conclusion: "failure", head: "fork/r" }, false],
    ["the editorial workflow from a fork head repository", { wf: "editorial", conclusion: "success", head: "fork/r" }, false],
    ["a failure on a push (not a pull_request run)", { wf: "e2e", conclusion: "failure", event: "push" }, false],
    ["a production deploy success", { wf: "deploy", conclusion: "success", event: "push", branch: "main" }, true],
    ["a production deploy failure", { wf: "deploy", conclusion: "failure", event: "push", branch: "main" }, false],
    // A display title is author-chosen text: a pull request TITLED like a
    // workflow must not be taken for that workflow.
    ["a green gating run whose title spells the editorial workflow's name", { wf: "e2e", title: "CMS Editorial Workflow", conclusion: "success" }, false],
    ["a green gating run on main whose title spells the deploy workflow's name", { wf: "scan", title: "Deploy to Production", conclusion: "success", event: "push", branch: "main" }, false],
  ];
  for (const [label, ev, expected] of FIRE) {
    test(`signal if: ${label} -> ${expected}`, () => {
      expect(signalFires(ev)).toBe(expected);
    });
  }

  test("the workflow files the signal's if names exist, and they are the two with a dynamic run-name", () => {
    const cond = String(signalReusable.jobs.signal.if);
    const paths = [...cond.matchAll(/'\.github\/workflows\/([^']+)'/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(["cms-editorial-workflow.yml", "deploy-production.yml"]);
    for (const file of paths) {
      const caller = parseYaml(read(path.join(CALLER_DIR, file)));
      expect(signalCaller.on.workflow_run.workflows, `${file} is one of the workflows the signal listens to`).toContain(caller.name);
      // The reason a name comparison cannot work for them.
      expect(typeof caller["run-name"], `${file} sets a run-name`).toBe("string");
    }
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
