// @lane: local — no network, no browser. Platform-internal (runs scripts/
// from this repo's tree), so it is registered in playwright.config.js
// PLATFORM_META_SPECS.
//
// Output from scripts/diagnose-stuck-pr.js, scripts/auto-resolve-newline-
// conflict.js and e2e/base.js's TARGET=preview PR lookup lands in public
// consumer CI logs (and the stuck-PR report is appended to a failing test's
// error). None of it may quote a GitHub API response body — not on an HTTP
// error, and not on a malformed 2xx, where a JSON SyntaxError's message
// quotes the text it failed to parse (the whole body when it is short, which
// is why MARKER below is short and is the ENTIRE malformed body). Each case
// asserts the status (or exit/spawn code) IS reported and MARKER is not.
//
// The scripts run as real child processes with `fetch` stubbed by a
// `--require` preload, so their own top-level error printing is what is
// checked. base.js's lookup runs in-process against a fake `gh` on PATH.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect, resolvePreviewBaseURL } = require("./base");

const MARKER = "leak.example.com";
const SCRIPTS = path.join(__dirname, "..", "scripts");

let tmp;
let preload;
test.beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "api-body-redaction-"));
  preload = path.join(tmp, "stub-fetch.js");
  // Every request answers STUB_STATUS with STUB_BODY. A generous rate-limit
  // header keeps diagnose-stuck-pr.js off its rate-limit branch.
  fs.writeFileSync(
    preload,
    `globalThis.fetch = async () => new Response(process.env.STUB_BODY, {
      status: Number(process.env.STUB_STATUS),
      headers: { "x-ratelimit-remaining": "5000" },
    });\n`,
  );
});
test.afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runScript(name, env) {
  const r = spawnSync(process.execPath, ["--require", preload, path.join(SCRIPTS, name)], {
    env: {
      PATH: process.env.PATH,
      GH_TOKEN: "dummy",
      GH_REPO: "o/r",
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const CASES = [
  // An HTTP error whose JSON body carries the marker.
  { label: "HTTP 502 error body", status: 502, body: JSON.stringify({ message: MARKER }) },
  // A 2xx whose body is not JSON: res.json() throws a SyntaxError quoting it.
  { label: "malformed 200 body", status: 200, body: MARKER },
];

test.describe("scripts/diagnose-stuck-pr.js keeps API bodies out of its report", () => {
  for (const c of CASES) {
    test(`${c.label}: the report names the status, never the body, and exits 0`, () => {
      const { code, out } = runScript("diagnose-stuck-pr.js", {
        WAIT_PR_NUMBER: "7",
        WAITING_FOR_KIND: "merge",
        STUB_STATUS: String(c.status),
        STUB_BODY: c.body,
      });
      expect(out).not.toContain(MARKER);
      expect(code, out).toBe(0);
      expect(out).toContain(`_couldn't fetch: GH API /repos/o/r/pulls/7 → ${c.status}`);
      expect(out).toContain(`_couldn't list open PRs: GH API /repos/o/r/pulls?state=open`);
      expect(out).toContain(`_couldn't fetch deploy-production runs:`);
    });
  }
});

test.describe("scripts/auto-resolve-newline-conflict.js keeps API bodies out of its error log", () => {
  for (const c of CASES) {
    test(`${c.label}: exits 1 naming the status, with no body in message or stack`, () => {
      const { code, out } = runScript("auto-resolve-newline-conflict.js", {
        PR_NUMBER: "7",
        DRY_RUN: "true",
        STUB_STATUS: String(c.status),
        STUB_BODY: c.body,
      });
      expect(out).not.toContain(MARKER);
      expect(code, out).toBe(1);
      expect(out).toContain(`[auto-resolve-newline] ERROR: GH API GET /repos/o/r/pulls/7 → ${c.status}`);
    });
  }
});

test.describe("e2e/base.js TARGET=preview PR lookup keeps gh output out of its error", () => {
  test.describe.configure({ mode: "serial" });

  const saved = {};
  const KEYS = ["PATH", "PR_NUMBER", "GITHUB_PR_NUMBER", "CMS_REPO", "FAKE_GH_MODE"];
  let binDir;
  test.beforeAll(() => {
    binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    // A fake `gh` that either fails with the marker on stderr or "succeeds"
    // with the marker as a non-JSON body on stdout.
    fs.writeFileSync(
      path.join(binDir, "gh"),
      [
        "#!/bin/sh",
        'if [ "$FAKE_GH_MODE" = fail ]; then',
        `  echo 'gh: ${MARKER} (HTTP 502)' >&2`,
        "  exit 1",
        "fi",
        'if [ "$FAKE_GH_MODE" = kill ]; then',
        `  echo 'gh: ${MARKER} (HTTP 502)' >&2`,
        "  kill -9 $$",
        "fi",
        // More than execFileSync's default 1 MiB buffer: Node kills the child
        // with SIGTERM and sets err.code = ENOBUFS although gh did start.
        'if [ "$FAKE_GH_MODE" = flood ]; then',
        // Shell builtins only: PATH holds just this directory in these tests.
        "  i=0; while [ $i -lt 2100 ]; do printf '%01000d' 0; i=$((i+1)); done",
        "fi",
        `printf '%s' '${MARKER}'`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });
  test.beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.PR_NUMBER;
    delete process.env.GITHUB_PR_NUMBER;
    process.env.CMS_REPO = "o/r";
  });
  test.afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function lookupError() {
    try {
      resolvePreviewBaseURL();
    } catch (e) {
      return e;
    }
    throw new Error("expected resolvePreviewBaseURL() to throw");
  }

  test("gh exits non-zero: the error names the exit code, not gh's stderr", () => {
    process.env.PATH = binDir;
    process.env.FAKE_GH_MODE = "fail";
    const err = lookupError();
    expect(err.message).not.toContain(MARKER);
    expect(err.message).toContain("(gh exited 1)");
    expect(err.cause).toBeUndefined();
  });

  test("gh prints a non-JSON body: the error gives its length, not its text", () => {
    process.env.PATH = binDir;
    process.env.FAKE_GH_MODE = "ok";
    const err = lookupError();
    expect(err.message).not.toContain(MARKER);
    expect(err.message).toContain(`returned non-JSON (${MARKER.length} bytes)`);
    expect(err.cause).toBeUndefined();
  });

  test("gh is not on PATH: the error names the spawn error code, not `exited null`", () => {
    process.env.PATH = path.join(tmp, "empty-bin-that-does-not-exist");
    const err = lookupError();
    expect(err.message).toContain("(gh could not start: ENOENT)");
    expect(err.message).not.toContain("null");
  });

  test("gh is killed by a signal: the error names the signal, never `exited null`", () => {
    process.env.PATH = binDir;
    process.env.FAKE_GH_MODE = "kill";
    const err = lookupError();
    expect(err.message).not.toContain(MARKER);
    expect(err.message).toContain("(gh was killed by SIGKILL)");
    expect(err.message).not.toContain("null");
    expect(err.cause).toBeUndefined();
  });

  test("gh is killed with a spawn error code (ENOBUFS): says killed, not `could not start`", () => {
    process.env.PATH = binDir;
    process.env.FAKE_GH_MODE = "flood";
    const err = lookupError();
    expect(err.message).toContain("(gh was killed by SIGTERM (ENOBUFS))");
    expect(err.message).not.toContain("could not start");
    expect(err.message).not.toContain("0000");
    expect(err.cause).toBeUndefined();
  });
});
