// @lane: local — pure-Node behavioral test for publish-progress.js (vm sandbox, scripted fetch, fixed clock)
/*
 * Between the moment an entry's PR merges and the moment production has
 * deployed it, the editor bar must keep saying "Going live…". It used to go
 * blank: with no open PR, the poller read the NEWEST production deployment,
 * which for the first ~seconds after a merge is still the PREVIOUS one
 * (state `success`), so the model said "Live" — and a plain Live bar is
 * hidden. Measured on adamdaniel.ai#3857 (2026-09-28): merged 13:40:14; the
 * editor's bar vanished without a refresh; only a reload showed "waiting for
 * adamdaniel.ai to finish updating".
 *
 * The fix reads the entry's most recent MERGED PR (one request, head-filtered)
 * and holds "going live" until a production deployment that covers the merge
 * has succeeded.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");
const { API, loadProgress } = require("./publish-progress-harness");

const MERGE_SHA = "3e40000000000000000000000000000000000000";
const PREV_SHA = "9e40000000000000000000000000000000000000";
const NOW = Date.UTC(2026, 8, 28, 13, 40, 30); // 16 s after the merge
const MERGED_AT = "2026-09-28T13:40:14Z";

const OPEN = `${API}/pulls?state=open&per_page=100`;
const CLOSED = `${API}/pulls?state=closed&head=owner%3Acms%2Fposts%2F2026-09-28-hello&per_page=5`;
const DEPLOYS = `${API}/deployments?environment=production&per_page=1`;

function statuses(id) {
  return `${API}/deployments/${id}/statuses?per_page=1`;
}

// GitHub's list response always carries `base`; a merge into the default
// branch is the ordinary case. `base: null` drops it to test missing data.
const DEFAULT_BASE = { ref: "main", repo: { default_branch: "main" } };

function routes({ merged = true, mergedAt = MERGED_AT, deploy, base = DEFAULT_BASE, labels }) {
  const r = {
    [OPEN]: [],
    [CLOSED]: [
      {
        number: 42,
        html_url: "https://github.com/owner/repo/pull/42",
        head: { ref: "cms/posts/2026-09-28-hello" },
        ...(base ? { base } : {}),
        ...(labels ? { labels } : {}),
        merged_at: merged ? mergedAt : null,
        merge_commit_sha: merged ? MERGE_SHA : null,
      },
    ],
  };
  if (deploy) {
    r[DEPLOYS] = [{ id: 7, sha: deploy.sha, created_at: deploy.createdAt }];
    r[statuses(7)] = [{ state: deploy.state, created_at: deploy.createdAt }];
  } else {
    r[DEPLOYS] = [];
  }
  return r;
}

async function factsFor(r, now = NOW) {
  const { api, calls } = loadProgress(r, { now });
  await api.refresh();
  return { facts: api.get().facts, calls };
}

test.describe("publish-progress.js holds 'going live' from merge until production has it (#3857)", () => {
  test("merged, production still on the PREVIOUS deploy → going live, not Live", async () => {
    const { facts, calls } = await factsFor(
      routes({ deploy: { sha: PREV_SHA, createdAt: "2026-09-28T12:16:23Z", state: "success" } }),
    );
    expect(calls, "the entry's merged PR is looked up by head branch").toContain(CLOSED);
    expect(facts.hasOpenPr).toBe(false);
    expect(facts.merged, "a merge production has not deployed yet is in flight").toBe(true);
    expect(facts.startedAt, "the deploy-stage clock starts at the merge").toBe(Date.parse(MERGED_AT));
  });

  test("merged, production deploying the merge → going live", async () => {
    const { facts } = await factsFor(
      routes({ deploy: { sha: MERGE_SHA, createdAt: "2026-09-28T13:40:16Z", state: "in_progress" } }),
    );
    expect(facts.merged).toBe(true);
    expect(facts.deployState).toBe("in_progress");
  });

  test("merged, production deployed the merge → Live", async () => {
    const { facts } = await factsFor(
      routes({ deploy: { sha: MERGE_SHA, createdAt: "2026-09-28T13:40:16Z", state: "success" } }),
      Date.UTC(2026, 8, 28, 13, 41, 0),
    );
    expect(facts.merged).toBe(false);
    expect(facts.deployState).toBe("success");
  });

  test("a LATER push's successful deploy also covers the merge → Live", async () => {
    const { facts } = await factsFor(
      routes({ deploy: { sha: PREV_SHA, createdAt: "2026-09-28T13:45:00Z", state: "success" } }),
      Date.UTC(2026, 8, 28, 13, 46, 0),
    );
    expect(facts.merged).toBe(false);
  });

  test("merged, production deploy of the merge FAILED → the failure is reported", async () => {
    const { facts } = await factsFor(
      routes({ deploy: { sha: MERGE_SHA, createdAt: "2026-09-28T13:40:16Z", state: "failure" } }),
    );
    expect(facts.deployState).toBe("failure");
  });

  test("a merge long past with no covering deploy is not claimed as in flight forever", async () => {
    const { facts } = await factsFor(
      routes({ mergedAt: "2026-09-28T10:00:00Z", deploy: { sha: PREV_SHA, createdAt: "2026-09-28T09:00:00Z", state: "success" } }),
    );
    expect(facts.merged).toBe(false);
  });

  test("a closed-without-merging PR changes nothing", async () => {
    const { facts } = await factsFor(
      routes({ merged: false, deploy: { sha: PREV_SHA, createdAt: "2026-09-28T12:16:23Z", state: "success" } }),
    );
    expect(facts.merged).toBe(false);
    expect(facts.deployState).toBe("success");
  });

  test("the merged-PR read failing degrades to the old reading, never an error", async () => {
    const r = routes({ deploy: { sha: PREV_SHA, createdAt: "2026-09-28T12:16:23Z", state: "success" } });
    delete r[CLOSED];
    const { facts } = await factsFor(r);
    expect(facts).toBeTruthy();
    expect(facts.merged).toBe(false);
  });
});

// #532: only a merge into the default branch goes to production. A
// preview-only PR merges into its feature branch, and the bar used to read
// "Going live… on its way to example.com" for it, with production's deploy
// state, for the whole merge watch.
function derive(facts) {
  const sandbox = { window: {}, Math, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../theme/admin/entry-status-model.js"), "utf8"), sandbox);
  return sandbox.window.CMSEntryStatus.derive(facts, {
    now: NOW,
    currentHostname: "example.com",
    canonicalHostname: "example.com",
  });
}

const PREVIOUS_DEPLOY = { sha: PREV_SHA, createdAt: "2026-09-28T12:16:23Z", state: "success" };
const repo = { default_branch: "main" };

const PREVIEW_IN_FLIGHT =
  "This is on its way to the preview for “feature/x”. It is waiting for the preview for “feature/x” " +
  "to finish updating. You can close this tab — it carries on without you. " +
  "It will not reach example.com until the work on “feature/x” goes live there.";

test.describe("publish-progress.js: where a merge goes depends on the PR's base (#532)", () => {
  test("merged into the default branch → going live on the live site", async () => {
    const { facts, calls } = await factsFor(routes({ base: { ref: "main", repo }, deploy: PREVIOUS_DEPLOY }));
    expect(facts.previewOnly).toBe(false);
    expect(facts.merged).toBe(true);
    expect(calls).toContain(DEPLOYS);
    const got = derive(facts);
    expect(got.badge).toBe("going-live");
    expect(got.detail).toMatch(/^This is on its way to example\.com\. /);
  });

  test("merged into a non-`main` default branch → going live on the live site", async () => {
    const { facts } = await factsFor(
      routes({ base: { ref: "trunk", repo: { default_branch: "trunk" } }, deploy: PREVIOUS_DEPLOY }),
    );
    expect(facts.previewOnly).toBe(false);
    expect(facts.merged).toBe(true);
    expect(derive(facts).detail).toMatch(/^This is on its way to example\.com\. /);
  });

  test("merged into `main` where the default branch is `trunk` → a preview", async () => {
    const { facts } = await factsFor(
      routes({ base: { ref: "main", repo: { default_branch: "trunk" } }, deploy: PREVIOUS_DEPLOY }),
    );
    expect(facts.previewOnly).toBe(true);
    expect(facts.baseRef).toBe("main");
  });

  test("merged into a feature branch → on its way to that branch's preview, the live site later", async () => {
    const { facts, calls } = await factsFor(
      routes({ base: { ref: "feature/x", repo }, deploy: { ...PREVIOUS_DEPLOY, state: "failure" } }),
    );
    expect(facts.previewOnly).toBe(true);
    expect(facts.baseRef).toBe("feature/x");
    expect(facts.merged).toBe(true);
    expect(facts.startedAt).toBe(Date.parse(MERGED_AT));
    expect(facts.deployState, "production's deploy is not this merge's").toBe(null);
    expect(calls, "production deployments are not read for a feature-branch merge").not.toContain(DEPLOYS);
    const got = derive(facts);
    expect(got.badge).toBe("going-live");
    expect(got.detail).toBe(PREVIEW_IN_FLIGHT);
    expect(got.detail, "no preview deployment covers the merge yet").not.toMatch(/ now\./);
  });

  test("labeled cms/preview-only but merged into the default branch (retargeted) → going live", async () => {
    const { facts, calls } = await factsFor(
      routes({ base: { ref: "main", repo }, labels: [{ name: "cms/preview-only" }], deploy: PREVIOUS_DEPLOY }),
    );
    expect(facts.previewOnly).toBe(false);
    expect(facts.merged).toBe(true);
    expect(calls).toContain(DEPLOYS);
    expect(derive(facts).detail).not.toMatch(/preview|“main”/);
  });

  for (const [what, labels] of [
    ["labeled", [{ name: "cms/preview-only" }]],
    ["unlabeled", undefined],
  ]) {
    test(`${what}, with no base in the response → never claims the live site`, async () => {
      const { facts, calls } = await factsFor(routes({ base: null, labels, deploy: PREVIOUS_DEPLOY }));
      expect(facts.previewOnly).toBe(true);
      expect(facts.baseRef).toBe(null);
      expect(calls).not.toContain(DEPLOYS);
      const got = derive(facts);
      expect(got.detail).toMatch(/^This is on its way to the preview for this branch\. /);
      expect(got.detail).toMatch(/It will not reach example\.com until the work on this branch goes live there\.$/);
    });
  }

  test("a feature-branch merge older than the merge watch → the entry's ordinary state", async () => {
    const { facts, calls } = await factsFor(
      routes({ base: { ref: "feature/x", repo }, mergedAt: "2026-09-25T10:00:00Z", deploy: PREVIOUS_DEPLOY }),
    );
    expect(facts.previewOnly).toBe(false);
    expect(facts.merged).toBe(false);
    expect(facts.deployState).toBe("success");
    expect(calls).toContain(DEPLOYS);
  });

  test("one minute inside the merge watch is still the preview's", async () => {
    const { facts } = await factsFor(
      routes({ base: { ref: "feature/x", repo }, deploy: PREVIOUS_DEPLOY }),
      Date.parse(MERGED_AT) + 29 * 60 * 1000,
    );
    expect(facts.previewOnly).toBe(true);
    expect(facts.merged).toBe(true);
  });
});

// #643: on a preview admin the merge watch never ended. The bar read "Going
// live… (taking a little longer than usual) … It is waiting for
// preview-pr4072.<apex> to finish updating." 188 s after the page served
// 200, and after a reload, because nothing read the preview's own deploy.
// deploy-preview.yml registers one per push to the preview PR, in the
// environment `preview-pr-<N>`.
const PREVIEW_PULL = `${API}/pulls?state=open&head=owner%3Afeature%2Fx&per_page=5`;
const PREVIEW_DEPLOYS = `${API}/deployments?environment=preview-pr-4072&per_page=1`;
const HEAD_SHA = "4e40000000000000000000000000000000000000";
const HEAD_CHECKS = `${API}/commits/${HEAD_SHA}/check-runs?per_page=100`;

function previewRoutes({ previewDeploy, headSha, checkRuns } = {}) {
  const r = routes({ base: { ref: "feature/x", repo }, deploy: PREVIOUS_DEPLOY });
  if (headSha) r[CLOSED][0].head.sha = headSha;
  if (checkRuns) r[HEAD_CHECKS] = { check_runs: checkRuns };
  r[PREVIEW_PULL] = [{ number: 4072, head: { ref: "feature/x" } }];
  if (previewDeploy) {
    r[PREVIEW_DEPLOYS] = [{ id: 9, sha: previewDeploy.sha, created_at: previewDeploy.createdAt }];
    r[statuses(9)] = [{ state: previewDeploy.state }];
  } else {
    r[PREVIEW_DEPLOYS] = [];
  }
  return r;
}

function deriveOnPreview(facts, now = NOW) {
  const sandbox = { window: {}, Math, isFinite };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../theme/admin/entry-status-model.js"), "utf8"), sandbox);
  return sandbox.window.CMSEntryStatus.derive(facts, {
    now,
    currentHostname: "preview-pr4072.example.com",
    canonicalHostname: "example.com",
  });
}

test.describe("publish-progress.js: a merge into a preview branch finishes when the preview has it (#643)", () => {
  test("the preview deployed the merge → Live, on the preview host now", async () => {
    const { facts, calls } = await factsFor(
      previewRoutes({ previewDeploy: { sha: MERGE_SHA, createdAt: "2026-09-28T13:41:00Z", state: "success" } }),
      Date.UTC(2026, 8, 28, 13, 41, 10),
    );
    // The harness records the second tick only: the PR number came from the
    // first one's head-branch lookup, and is remembered rather than re-read.
    expect(calls, "the preview PR's environment is read").toContain(PREVIEW_DEPLOYS);
    expect(calls, "a branch's preview PR is looked up once").not.toContain(PREVIEW_PULL);
    expect(calls, "production says nothing about a preview merge").not.toContain(DEPLOYS);
    expect(facts.merged).toBe(false);
    expect(facts.deployState).toBe("success");
    expect(facts.previewOnly).toBe(true);
    const got = deriveOnPreview(facts);
    expect(got.badge).toBe("live");
    expect(got.detail).toBe(
      "This is on preview-pr4072.example.com now. " +
        "It will not reach example.com until the work on “feature/x” goes live there.",
    );
  });

  test("a later push's preview deploy also covers the merge → Live", async () => {
    const { facts } = await factsFor(
      previewRoutes({ previewDeploy: { sha: PREV_SHA, createdAt: "2026-09-28T13:42:00Z", state: "success" } }),
      Date.UTC(2026, 8, 28, 13, 43, 0),
    );
    expect(facts.merged).toBe(false);
    expect(deriveOnPreview(facts).badge).toBe("live");
  });

  test("the preview still on the deploy from BEFORE the merge → still going live", async () => {
    const { facts } = await factsFor(
      previewRoutes({ previewDeploy: { sha: PREV_SHA, createdAt: "2026-09-28T13:30:00Z", state: "success" } }),
    );
    expect(facts.merged).toBe(true);
    expect(facts.deployState).toBe(null);
    expect(deriveOnPreview(facts).badge).toBe("going-live");
  });

  test("the preview PR lookup failing degrades to going live, never an error", async () => {
    const r = previewRoutes({ previewDeploy: { sha: MERGE_SHA, createdAt: "2026-09-28T13:41:00Z", state: "success" } });
    delete r[PREVIEW_PULL];
    const { facts, calls } = await factsFor(r);
    expect(calls).not.toContain(PREVIEW_DEPLOYS);
    expect(facts.merged).toBe(true);
  });

  test("the merged head's first check start is reported, so the countdown cannot jump back up", async () => {
    const { facts, calls } = await factsFor(
      previewRoutes({
        headSha: HEAD_SHA,
        checkRuns: [
          { name: "e2e / x", status: "completed", started_at: "2026-09-28T13:37:00Z" },
          { name: "parity / x", status: "completed", started_at: "2026-09-28T13:36:20Z" },
        ],
      }),
    );
    expect(calls, "a merged head's checks are read once, then remembered").not.toContain(HEAD_CHECKS);
    expect(facts.merged).toBe(true);
    expect(facts.checksStartedAt).toBe(Date.parse("2026-09-28T13:36:20Z"));
  });

  test("a default-branch merge reports the trip start too", async () => {
    const r = routes({ deploy: PREVIOUS_DEPLOY });
    r[CLOSED][0].head.sha = HEAD_SHA;
    r[HEAD_CHECKS] = { check_runs: [{ name: "e2e / x", status: "completed", started_at: "2026-09-28T13:36:20Z" }] };
    const { facts } = await factsFor(r);
    expect(facts.merged).toBe(true);
    expect(facts.checksStartedAt).toBe(Date.parse("2026-09-28T13:36:20Z"));
  });
});
