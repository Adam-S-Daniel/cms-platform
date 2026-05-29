// @lane: local — pure-fs unit test for e2e/live-failures-reporter.js
//
// Exercises the reporter's gating logic without hitting the GitHub API:
// the `enabled` check (no-op when GITHUB_TOKEN / PR_NUMBER missing) and
// the final-attempt guard (no-op while retries remain). The actual POST
// is monkey-patched on globalThis.fetch so the test can assert how many
// network calls would have fired.

const path = require("node:path");
const { test, expect } = require("./base");

const REPORTER_PATH = path.resolve(__dirname, "live-failures-reporter.js");

function loadReporter(envOverrides) {
  // Reporter reads env at module load. Reset module cache for each
  // load so different env shapes produce different reporter instances.
  delete require.cache[REPORTER_PATH];
  // Also drop the scrub-secrets module if it was loaded — the scrub
  // path forks a child process and reads from disk, not env, so it
  // doesn't actually need a reset, but defence in depth.
  const original = { ...process.env };
  Object.assign(process.env, envOverrides);
  try {
    const Reporter = require(REPORTER_PATH);
    return new Reporter();
  } finally {
    // Restore env so subsequent tests see a clean slate.
    for (const k of Object.keys(envOverrides)) delete process.env[k];
    for (const [k, v] of Object.entries(original)) process.env[k] = v;
  }
}

function fakeTest({ retries = 0 } = {}) {
  return {
    id: "fake-test-id",
    retries,
    titlePath: () => ["fake.spec.js", "describe", "test name"],
    location: { file: __filename, line: 1, column: 1 },
    parent: { project: () => ({ name: "chromium-desktop-1080" }) },
  };
}

function fakeResult({ status = "failed", retry = 0, errorMsg = "boom" } = {}) {
  return {
    status,
    retry,
    error: { message: errorMsg },
  };
}

test.describe("LiveFailuresReporter gating", () => {
  test.describe.configure({ mode: "serial" });

  let originalFetch;
  let fetchCalls;

  test.beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, method: (opts && opts.method) || "GET" });
      // Pretend "no existing comment" + "post succeeded".
      return {
        ok: true,
        json: async () => [],
      };
    };
  });

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("no-op when GITHUB_TOKEN is missing", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "",
      PR_NUMBER: "1209",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_RUN_ID: "12345",
    });
    expect(reporter.enabled).toBe(false);
    await reporter.onTestEnd(fakeTest(), fakeResult());
    expect(fetchCalls).toEqual([]);
  });

  test("no-op when PR_NUMBER is missing AND GITHUB_REF lacks a pull/ ref", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "ghs_FAKE",
      PR_NUMBER: "",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_REF: "refs/heads/main",
      GITHUB_RUN_ID: "12345",
    });
    expect(reporter.enabled).toBe(false);
    await reporter.onTestEnd(fakeTest(), fakeResult());
    expect(fetchCalls).toEqual([]);
  });

  test("derives PR number from GITHUB_REF when PR_NUMBER is unset", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "ghs_FAKE",
      PR_NUMBER: "",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_REF: "refs/pull/1209/merge",
      GITHUB_RUN_ID: "12345",
    });
    expect(reporter.enabled).toBe(true);
  });

  test("PR_NUMBER='local' is treated as unset", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "ghs_FAKE",
      PR_NUMBER: "local",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_REF: "refs/heads/main",
      GITHUB_RUN_ID: "12345",
    });
    expect(reporter.enabled).toBe(false);
  });

  test("posts on every failed attempt — both retry=0 and retry=1 fire", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "ghs_FAKE",
      PR_NUMBER: "1209",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_RUN_ID: "12345",
    });
    // Agents want signal on the first failure, not after Playwright's
    // retry layer finishes. Each attempt gets its own marker (the
    // marker template embeds result.retry) so a retry=0 failure
    // followed by a retry=1 failure lands as two separate comments.
    await reporter.onTestEnd(fakeTest({ retries: 1 }), fakeResult({ retry: 0 }));
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(true);
  });

  test("ignores passing tests", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "ghs_FAKE",
      PR_NUMBER: "1209",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_RUN_ID: "12345",
    });
    await reporter.onTestEnd(fakeTest(), fakeResult({ status: "passed" }));
    expect(fetchCalls).toEqual([]);
  });

  test("posts on final failed attempt", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "ghs_FAKE",
      PR_NUMBER: "1209",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_RUN_ID: "12345",
    });
    await reporter.onTestEnd(
      fakeTest({ retries: 1 }),
      fakeResult({ retry: 1, errorMsg: "expected 200, got 404" }),
    );
    // Two calls: one GET to scan existing comments (commentExists),
    // one POST to create the new comment.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const post = fetchCalls.find((c) => c.method === "POST");
    expect(post, "expected a POST to the comments endpoint").toBeTruthy();
    expect(post.url).toContain("/repos/Adam-S-Daniel/adamdaniel.ai/issues/1209/comments");
  });

  test("posts on final timedOut attempt", async () => {
    const reporter = loadReporter({
      GITHUB_TOKEN: "ghs_FAKE",
      PR_NUMBER: "1209",
      GITHUB_REPOSITORY: "Adam-S-Daniel/adamdaniel.ai",
      GITHUB_RUN_ID: "12345",
    });
    await reporter.onTestEnd(
      fakeTest({ retries: 0 }),
      fakeResult({ retry: 0, status: "timedOut" }),
    );
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(true);
  });
});
