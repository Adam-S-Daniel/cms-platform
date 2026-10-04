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

function routes({ merged = true, mergedAt = MERGED_AT, deploy, base, labels }) {
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

  test("merged into a feature branch → on that branch's preview, the live site later", async () => {
    const { facts, calls } = await factsFor(
      routes({ base: { ref: "feature/x", repo }, deploy: { ...PREVIOUS_DEPLOY, state: "in_progress" } }),
    );
    expect(facts.previewOnly).toBe(true);
    expect(facts.baseRef).toBe("feature/x");
    expect(facts.merged, "production's deploy is not this merge's").toBe(false);
    expect(facts.deployState).toBe(null);
    expect(calls, "production deployments are not read for a feature-branch merge").not.toContain(DEPLOYS);
    const got = derive(facts);
    expect(got.badge).not.toBe("going-live");
    expect(got.detail).toBe(
      "This is on the preview for “feature/x” now. " +
        "It will not reach example.com until the work on “feature/x” goes live there.",
    );
  });

  test("the cms/preview-only label alone marks the merge as a preview's", async () => {
    const { facts } = await factsFor(
      routes({ labels: [{ name: "cms/preview-only" }], deploy: PREVIOUS_DEPLOY }),
    );
    expect(facts.previewOnly).toBe(true);
    expect(facts.merged).toBe(false);
  });
});
