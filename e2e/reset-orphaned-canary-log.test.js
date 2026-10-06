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
    // #689: a stale canary tag on main. "tagsopenpr" already has its
    // removal PR open; "tagsremove500" fails opening one.
    case "tagsopenpr":
    case "tagsremove500":
      // The sweep lists _tags through the git trees API: main's root
      // tree, then the _tags subtree.
      if (method === "GET" && url.endsWith("/git/trees/main")) {
        return Response.json({ tree: [{ path: "_tags", type: "tree", sha: "tagsha" }] });
      }
      if (method === "GET" && url.endsWith("/git/trees/tagsha")) {
        return Response.json({
          truncated: false,
          tree: [{ path: "e2e-tags-canary-1000000000000.md", type: "blob", sha: "x" }],
        });
      }
      if (method === "GET" && url.includes("/pulls?")) {
        return Response.json(
          process.env.FETCH_SCENARIO === "tagsopenpr"
            ? [{ number: 1, head: { ref: "cms/e2e-fixture/remove-e2e-tags-canary-1000000000000-x" } }]
            : [],
        );
      }
      if (method === "GET" && !url.includes("/git/refs/")) {
        return new Response(body, { status: 404, statusText: "Not Found" });
      }
      return new Response(body, { status: 500, statusText: "Server Error" });
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
    const outputFile = path.join(dir, "github-output");
    fs.writeFileSync(outputFile, "");
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
        GITHUB_OUTPUT: outputFile,
        ...extraEnv,
      },
    });
    return {
      code: res.status,
      out: `${res.stdout}${res.stderr}`,
      output: fs.readFileSync(outputFile, "utf8"),
    };
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

// #689: on main the script also sweeps _tags/ for leftover e2e tags and
// reports the count as the step output the host loop fails on.
test.describe("reset-orphaned-canary.sh leftover e2e tag output (#689)", () => {
  test("no _tags directory reports zero", () => {
    const { code, output } = run("http404");
    expect(code).toBe(0);
    expect(output).toBe("leftover_e2e_tags=0\n");
  });

  test("a stale canary tag whose removal PR is open still reports one", () => {
    const { code, out, output } = run("tagsopenpr");
    expect(code).toBe(0);
    expect(output).toBe("leftover_e2e_tags=1\n");
    expect(out).toContain("_tags/e2e-tags-canary-1000000000000.md@main");
    expect(out).toContain("a removal PR is already open");
  });

  test("a failed removal reports error and logs only status and type", () => {
    const { code, out, output } = run("tagsremove500");
    expect(code).toBe(0);
    expect(output).toBe("leftover_e2e_tags=error\n");
    expect(out).toContain("leftover e2e tag check errored: HTTP 500 Error");
    expect(out).not.toContain(MARKER);
    expect(out).not.toContain("api.github.com");
    expect(out).not.toMatch(/^\s+at /m);
  });

  test("a network error on the listing reports error and logs only its type", () => {
    const { code, out, output } = run("network");
    expect(code).toBe(0);
    expect(output).toBe("leftover_e2e_tags=error\n");
    expect(out).toContain("leftover e2e tag check errored: TypeError");
    expect(out).not.toContain(MARKER);
  });

  test("a preview branch run does not sweep tags", () => {
    const { code, output } = run("http404", { CANARY_RESET_BRANCH: "example-branch" });
    expect(code).toBe(0);
    expect(output).toBe("");
  });
});
