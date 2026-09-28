// @lane: local — pure-Node behavioral test for publish-progress.js (vm sandbox, scripted fetch)
/*
 * publish-progress.js must judge the checks of the commit the entry's branch
 * is ACTUALLY on, not of the `head.sha` the /pulls LIST reports.
 *
 * GitHub updates a PR's `head.sha` asynchronously after a push; the git ref
 * moves at once. Measured on adamdaniel.ai#3857 (2026-09-28): the editor
 * fixed a failing post and pressed Save → Publish; the branch tip was
 * 60716fc, but /pulls still reported eb9ffb8 over a minute later — the
 * commit whose checks had FAILED. The bar read those stale failures and
 * went straight back to "One of the automatic safety checks did not pass"
 * instead of "Going live…", for a publish that was in fact under way.
 *
 * No timers, no network: fetch is a URL router over canned responses.
 */
const { test, expect } = require("./base");
const { API, loadProgress: load } = require("./publish-progress-harness");

const BRANCH = "cms/posts/2026-09-28-hello";
const OLD = "0ld0000000000000000000000000000000000000";
const NEW = "4e40000000000000000000000000000000000000";

const FAILED_RUN = { name: "e2e / e2e", status: "completed", conclusion: "failure", started_at: "2026-09-28T13:16:00Z" };
const RUNNING = { name: "e2e / e2e", status: "in_progress", conclusion: null, started_at: "2026-09-28T13:30:30Z" };

function pr(overrides) {
  return {
    number: 42,
    html_url: "https://github.com/owner/repo/pull/42",
    head: { ref: BRANCH, sha: OLD },
    base: { ref: "main", repo: { default_branch: "main" } },
    labels: [{ name: "cms/ready" }],
    auto_merge: null,
    ...overrides,
  };
}

function baseRoutes() {
  return {
    [`${API}/pulls?state=open&per_page=100`]: [pr()],
    [`${API}/pulls/42`]: { mergeable: true },
    [`${API}/commits/${OLD}/check-runs?per_page=100`]: { check_runs: [FAILED_RUN] },
    [`${API}/actions/runs?head_sha=${NEW}&per_page=20`]: { workflow_runs: [] },
  };
}

test.describe("publish-progress.js reads the branch tip, not the PR list's lagging head.sha (#3857)", () => {
  test("a re-save whose new commit has no checks yet reads as going live, not as the old failure", async () => {
    const routes = baseRoutes();
    routes[`${API}/git/ref/heads/cms/posts/2026-09-28-hello`] = { object: { sha: NEW } };
    routes[`${API}/commits/${NEW}/check-runs?per_page=100`] = { check_runs: [] };
    const { api, calls } = load(routes);
    await api.refresh();
    const facts = api.get().facts;
    expect(facts, "a tick with every read answered must produce facts").toBeTruthy();
    expect(calls, "the old head's checks must not be what is judged").not.toContain(
      `${API}/commits/${OLD}/check-runs?per_page=100`,
    );
    expect(facts.checksFailed).toBe(false);
    expect(facts.armed).toBe(true);
  });

  test("the new commit's own running checks drive the wait, and its own failure still reports", async () => {
    const routes = baseRoutes();
    routes[`${API}/git/ref/heads/cms/posts/2026-09-28-hello`] = { object: { sha: NEW } };
    routes[`${API}/commits/${NEW}/check-runs?per_page=100`] = { check_runs: [RUNNING] };
    let { api } = load(routes);
    await api.refresh();
    expect(api.get().facts.checksFailed).toBe(false);
    expect(api.get().facts.checks).toEqual({ total: 1, pending: ["e2e"] });

    routes[`${API}/commits/${NEW}/check-runs?per_page=100`] = { check_runs: [FAILED_RUN] };
    ({ api } = load(routes));
    await api.refresh();
    expect(api.get().facts.checksFailed, "a genuine failure on the tip must still be reported").toBe(true);
  });

  test("branch names with slashes are encoded per segment, never as one %2F blob", async () => {
    const routes = baseRoutes();
    routes[`${API}/git/ref/heads/cms/posts/2026-09-28-hello`] = { object: { sha: NEW } };
    routes[`${API}/commits/${NEW}/check-runs?per_page=100`] = { check_runs: [] };
    const { api, calls } = load(routes);
    await api.refresh();
    expect(calls).toContain(`${API}/git/ref/heads/cms/posts/2026-09-28-hello`);
  });

  test("when the ref read fails, it falls back to the PR list's head.sha (no worse than before)", async () => {
    const routes = baseRoutes(); // no git/ref route → 404
    const { api, calls } = load(routes);
    await api.refresh();
    expect(calls).toContain(`${API}/commits/${OLD}/check-runs?per_page=100`);
    expect(api.get().facts.checksFailed).toBe(true);
  });

  test("checks are grouped by workflow (a browser matrix is one check) and the clock starts at the first", async () => {
    const routes = baseRoutes();
    routes[`${API}/git/ref/heads/cms/posts/2026-09-28-hello`] = { object: { sha: NEW } };
    const run = (name, status, started) => ({
      name,
      status,
      conclusion: status === "completed" ? "success" : null,
      started_at: started,
    });
    routes[`${API}/commits/${NEW}/check-runs?per_page=100`] = {
      check_runs: [
        run("e2e / project (chromium-laptop)", "completed", "2026-09-28T13:35:14Z"),
        run("e2e / project (webkit-iphone16)", "in_progress", "2026-09-28T13:35:15Z"),
        run("e2e / e2e", "queued", null),
        run("parity / parity-probe", "in_progress", "2026-09-28T13:35:15Z"),
        run("site-verify / verify", "completed", "2026-09-28T13:35:10Z"),
        run("scan / scan", "completed", "2026-09-28T13:35:12Z"),
      ],
    };
    const { api } = load(routes);
    await api.refresh();
    const f = api.get().facts;
    expect(f.checks).toEqual({ total: 4, pending: ["e2e", "parity"] });
    expect(f.startedAt, "the earliest start of ANY check, completed ones included").toBe(
      Date.parse("2026-09-28T13:35:10Z"),
    );
  });
});
