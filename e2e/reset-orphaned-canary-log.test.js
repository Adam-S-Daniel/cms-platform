// @lane: local — pure-fs/process: runs scripts/reset-orphaned-canary.sh with a
// preloaded fetch stub, no network.
//
// The script runs in the publish-loop jobs of PUBLIC consumer repos, so its
// log is public. gh() in github-actions-poll.js puts up to 300 bytes of the
// raw API response body into its error message; the script must log only a
// status code plus the error type, never that message, a stack or the body.
// These scenarios run the REAL script, the REAL harness modules and the REAL
// gh(); only global fetch is replaced, so the error shape under test is the
// one production produces.
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "reset-orphaned-canary.sh");
const MARKER = "SECRET-BODY-MARKER-4f2a9c";

// Preloaded via NODE_OPTIONS. Scenario comes from FETCH_SCENARIO.
const FETCH_STUB = `
const marker = process.env.MARKER;
const body = JSON.stringify({
  message: "Not Found",
  detail: marker,
  documentation_url: "https://example.com/docs",
});
const file = Buffer.from(
  "---\\ntitle: x\\n---\\nleftover e2e-publish-loop:post:123\\n",
  "utf8",
).toString("base64");
globalThis.fetch = async (url, init = {}) => {
  const method = (init && init.method) || "GET";
  switch (process.env.FETCH_SCENARIO) {
    case "http404":
      return new Response(body, { status: 404, statusText: "Not Found" });
    case "network":
      throw new TypeError("fetch failed: " + marker);
    case "put500":
      if (method === "GET") return Response.json({ content: file, sha: "abc123" });
      return new Response(body, { status: 500, statusText: "Server Error" });
    case "putnetwork":
      if (method === "GET") return Response.json({ content: file, sha: "abc123" });
      throw new TypeError("fetch failed: " + marker);
    default:
      throw new Error("unknown FETCH_SCENARIO");
  }
};
`;

function run(scenario, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roc-log-"));
  try {
    const stub = path.join(dir, "fetch-stub.js");
    fs.writeFileSync(stub, FETCH_STUB);
    const res = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        NODE_OPTIONS: `--require ${stub}`,
        CMS_E2E_PAT: "not-a-real-credential",
        CMS_REPO: "example-owner/example-site",
        FETCH_SCENARIO: scenario,
        MARKER,
        ...extraEnv,
      },
    });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.describe("reset-orphaned-canary.sh logs no API body or error message", () => {
  test("a 404 on the read logs the status and error type only", () => {
    const { code, out } = run("http404");
    expect(code).toBe(0);
    expect(out).toContain("skip (HTTP 404 Error)");
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain("Not Found");
    expect(out).not.toContain("example.com/docs");
    expect(out).not.toContain("api.github.com");
  });

  test("a non-HTTP error on the read logs only its type", () => {
    const { code, out } = run("network");
    expect(code).toBe(0);
    expect(out).toContain("skip (TypeError)");
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain("fetch failed");
  });

  test("an HTTP error in the fail-open catch-all logs the status and type, no stack", () => {
    const { code, out } = run("put500", { CANARY_RESET_BRANCH: "example-branch" });
    expect(code).toBe(0);
    expect(out).toContain(
      "::warning::reset-orphaned-canary: self-heal errored (continuing, fail-open): HTTP 500 Error",
    );
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain("api.github.com");
    expect(out).not.toMatch(/^\s+at /m);
  });

  test("a non-HTTP error in the fail-open catch-all logs only its type, no stack", () => {
    const { code, out } = run("putnetwork", { CANARY_RESET_BRANCH: "example-branch" });
    expect(code).toBe(0);
    expect(out).toContain("fail-open): TypeError");
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain("fetch failed");
    expect(out).not.toMatch(/^\s+at /m);
  });
});
