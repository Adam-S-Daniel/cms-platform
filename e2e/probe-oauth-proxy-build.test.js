// @lane: local — pure-fs + in-process: runs scripts/probe-oauth-proxy-build.js
// against canned responses through an injected fetch (no network), runs
// oauth-proxy/lambda.py's import once under python3 to read its digest, and
// parses the reusable + thin-caller workflow YAML. No browser, no build.
//
// THE GAP (#518): a release and the consumer bump after it never redeploy the
// OAuth proxy Lambda, and nothing reported which build a site was running.
// The proxy now reports sha256(lambda.py) from /prod/health and the probe
// compares it with the same digest of the pinned platform checkout.
//
// WHAT THIS FILE PROVES
//   - the digest the probe computes is the digest lambda.py reports for the
//     same file — two languages, one definition, locked by running both;
//   - each outcome (current, stale, predates with each state-check verdict,
//     unreachable, unexpected) comes from its canned answer, and only
//     `current` exits 0;
//   - a hostile answer (an endless body, a redirect, the wrong content type,
//     a non-proxy 404, a forged release string) is never `current`, the body
//     is never read past the cap, no redirect is followed, and nothing from a
//     body or the URL reaches the output;
//   - no request carries credentials, and the base URL must be plain https;
//   - the reusable runs with `contents: read`, resolves its own platform
//     commit (#424) and reads the URL without interpolating into `run:`, and
//     the dictated caller is on a
//     `schedule`, which is what puts it under scheduled-run-health's watch.
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: it reads scripts/,
// oauth-proxy/ and this repo's workflow definitions, none of which a
// consumer ships.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, readWorkflow } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const probeModule = require(path.join(REPO_ROOT, "scripts", "probe-oauth-proxy-build.js"));
const { handlerDigest, parseBaseUrl, main, MAX_BODY_BYTES } = probeModule;

const LAMBDA = path.join(REPO_ROOT, "oauth-proxy", "lambda.py");
const BASE = "https://proxy.example.test";
const PINNED = "v9.9.9";
// Low-entropy stand-ins; the real digest is computed, never committed.
const OTHER_DIGEST = "b".repeat(64);
const SENTINEL = "BODY-SENTINEL-must-not-be-printed";
const STATE = "fixture-state";

const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const healthOf = (fields) => json(200, { status: "ok", service: "cms-oauth-proxy", note: SENTINEL, ...fields });
const authRedirect = ({ cookieState = STATE, locationState = STATE, host = "https://github.com" } = {}) => {
  const headers = new Headers();
  headers.append("location", `${host}/login/oauth/authorize?client_id=x&state=${locationState}`);
  if (cookieState !== null) {
    headers.append("set-cookie", `__Host-cms-oauth-state=${cookieState}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  }
  return new Response(null, { status: 302, headers });
};

// A fetch that answers per path and records every call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const route = routes[new URL(url).pathname];
    if (!route) throw new Error(`unexpected request to ${new URL(url).pathname}`);
    return route();
  };
  fn.calls = calls;
  return fn;
}

// Runs main() against a stand-in pinned handler (see PINNED_BYTES_DIGEST).
async function run(routes, { baseUrl = BASE, env = {} } = {}) {
  const fetch = fakeFetch(routes);
  const lines = [];
  const code = await main(["--base-url", baseUrl, "--platform-dir", "/platform", "--pinned-release", PINNED], {
    fetch,
    // Stands in for the pinned lambda.py; its digest is PINNED_BYTES_DIGEST.
    readFile: () => Buffer.from("pinned handler"),
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    env,
  });
  return { code, output: lines.join("\n"), calls: fetch.calls };
}
const PINNED_BYTES_DIGEST = handlerDigest(Buffer.from("pinned handler"));

test.describe("probe-oauth-proxy-build: the digest is one definition in two languages (#518)", () => {
  test("lambda.py reports the digest the probe computes for the same file", () => {
    const res = spawnSync(
      "python3",
      ["-c", "import importlib, sys; sys.path.insert(0, '.'); print(importlib.import_module('lambda').HANDLER_SHA256)"],
      {
        cwd: path.dirname(LAMBDA),
        encoding: "utf8",
        env: { ...process.env, GITHUB_CLIENT_ID: "fixture-id", GITHUB_CLIENT_SECRET: "fixture-value", PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    expect(res.status, `python3 failed: ${res.stderr}`).toBe(0);
    expect(res.stdout.trim()).toBe(handlerDigest(fs.readFileSync(LAMBDA)));
    expect(res.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

test.describe("probe-oauth-proxy-build: outcomes (#518)", () => {
  test("current: the reported digest equals the pinned handler's", async () => {
    const r = await run({ "/prod/health": () => healthOf({ release: "v9.9.8", handler_sha256: PINNED_BYTES_DIGEST }) });
    expect(r.code).toBe(0);
    expect(r.output).toMatch(/^current: /);
    expect(r.output).toContain("v9.9.8");
    expect(r.calls).toHaveLength(1);
  });

  test("stale: a different digest names both releases and exits 1", async () => {
    const r = await run({ "/prod/health": () => healthOf({ release: "v9.9.1", handler_sha256: OTHER_DIGEST }) });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^stale: /);
    expect(r.output).toContain("v9.9.1");
    expect(r.output).toContain(PINNED);
  });

  test("the release string never decides: same release, different digest is stale", async () => {
    const r = await run({ "/prod/health": () => healthOf({ release: PINNED, handler_sha256: OTHER_DIGEST }) });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^stale: /);
  });

  test("predates: health with no digest, state check present", async () => {
    const r = await run({ "/prod/health": () => healthOf({}), "/prod/auth": () => authRedirect() });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^predates: /);
    expect(r.output).toContain("does have the sign-in state check");
  });

  test("predates: no health route, state check absent (no cookie)", async () => {
    const r = await run({
      "/prod/health": () => json(404, { message: "Not Found" }),
      "/prod/auth": () => authRedirect({ cookieState: null, locationState: "" }),
    });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^predates: /);
    expect(r.output).toContain("LACKS the sign-in state check");
  });

  test("predates: a cookie that does not match state= is not the state check", async () => {
    const r = await run({
      "/prod/health": () => healthOf({}),
      "/prod/auth": () => authRedirect({ cookieState: "other" }),
    });
    expect(r.output).toContain("LACKS the sign-in state check");
  });

  test("predates: health identified the proxy, /prod/auth did not answer 302", async () => {
    const r = await run({ "/prod/health": () => healthOf({}), "/prod/auth": () => json(500, {}) });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/^predates: /);
    expect(r.output).toContain("unknown: /prod/auth answered HTTP 500");
  });

  test("unreachable: a failed request is its own outcome and exits 2", async () => {
    const r = await run({
      "/prod/health": () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      },
    });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unreachable: .*ENOTFOUND/);
  });

  test("unexpected: a 5xx from health", async () => {
    const r = await run({ "/prod/health": () => json(503, {}) });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unexpected: \/prod\/health answered HTTP 503/);
  });

  test("on a runner the failure is an error annotation", async () => {
    const r = await run({ "/prod/health": () => json(503, {}) }, { env: { GITHUB_ACTIONS: "true" } });
    expect(r.output).toMatch(/^::error title=OAuth proxy build unexpected::unexpected: /);
  });
});

test.describe("probe-oauth-proxy-build: hostile answers are never current (#518)", () => {
  test("an endless body is cut at the cap, not read to the end", async () => {
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1024;
            controller.enqueue(new Uint8Array(1024).fill(97));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const r = await run({ "/prod/health": endless });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unexpected: .*over \d+ bytes/);
    expect(pulled).toBeLessThan(MAX_BODY_BYTES * 4);
  });

  test("a redirect from health is reported, not followed", async () => {
    const r = await run({
      "/prod/health": () =>
        new Response(null, { status: 301, headers: { location: "https://elsewhere.example.net/prod/health" } }),
    });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unexpected: .*HTTP 301 \(a redirect, which is not followed\)/);
    expect(r.calls.map((c) => new URL(c.url).host)).toEqual(["proxy.example.test"]);
  });

  test("the wrong content type is unexpected, even with a matching digest inside", async () => {
    const r = await run({
      "/prod/health": () =>
        new Response(JSON.stringify({ service: "cms-oauth-proxy", handler_sha256: PINNED_BYTES_DIGEST }), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unexpected: .*without a JSON content type/);
  });

  test("JSON that is not the proxy's is unexpected", async () => {
    const r = await run({ "/prod/health": () => json(200, { handler_sha256: PINNED_BYTES_DIGEST }) });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unexpected: .*not as cms-oauth-proxy/);
  });

  test("a malformed digest is unexpected", async () => {
    const r = await run({ "/prod/health": () => healthOf({ handler_sha256: `${PINNED_BYTES_DIGEST}\n::error::x` }) });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unexpected: .*malformed handler_sha256/);
  });

  test("a 404 from something that is not the proxy is unexpected, not predates", async () => {
    const r = await run({
      "/prod/health": () => json(404, {}),
      "/prod/auth": () => authRedirect({ host: "https://login.example.net" }),
    });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/^unexpected: .*not to GitHub/);
  });

  test("a forged release string is not echoed", async () => {
    const r = await run({
      "/prod/health": () => healthOf({ release: "v1\n::error::forged", handler_sha256: OTHER_DIGEST }),
    });
    expect(r.output).toMatch(/^stale: .*an unrecorded release/);
    expect(r.output).not.toContain("forged");
  });

  test("no body content and no URL reach the output, whatever the outcome", async () => {
    for (const routes of [
      { "/prod/health": () => healthOf({ handler_sha256: PINNED_BYTES_DIGEST }) },
      { "/prod/health": () => healthOf({}), "/prod/auth": () => authRedirect() },
      { "/prod/health": () => json(500, { note: SENTINEL }) },
    ]) {
      const r = await run(routes);
      expect(r.output).not.toContain(SENTINEL);
      expect(r.output).not.toContain("proxy.example.test");
      expect(r.output).not.toContain(STATE);
    }
  });

  test("requests carry no credentials and follow no redirects", async () => {
    const r = await run({ "/prod/health": () => healthOf({}), "/prod/auth": () => authRedirect() });
    expect(r.calls).toHaveLength(2);
    for (const { init } of r.calls) {
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      const names = Object.keys(init.headers || {}).map((h) => h.toLowerCase());
      expect(names).not.toContain("authorization");
      expect(names).not.toContain("cookie");
    }
  });
});

test.describe("probe-oauth-proxy-build: the base URL (#518)", () => {
  test("accepts a plain https URL and drops a trailing slash", () => {
    expect(parseBaseUrl("https://proxy.example.test/")).toBe("https://proxy.example.test");
    expect(parseBaseUrl("https://proxy.example.test/api/")).toBe("https://proxy.example.test/api");
  });

  for (const bad of [
    "http://proxy.example.test",
    "https://user:pw@proxy.example.test",
    "https://proxy.example.test/?x=1",
    "https://proxy.example.test/#x",
    "file:///etc/passwd",
    "not a url",
  ]) {
    test(`refuses ${bad} with exit 2 and no request`, async () => {
      const r = await run({}, { baseUrl: bad });
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    });
  }
});

test.describe("oauth-proxy-build workflows: shape (#518)", () => {
  const reusable = parseYaml(readWorkflow("oauth-proxy-build.yml"));
  const caller = parseYaml(
    fs.readFileSync(path.join(REPO_ROOT, "examples", "site", ".github", "workflows", "oauth-proxy-build.yml"), "utf8"),
  );
  const steps = reusable.jobs.probe.steps;

  test("the reusable is workflow_call-only with contents: read", () => {
    expect(Object.keys(reusable.on)).toEqual(["workflow_call"]);
    expect(reusable.permissions).toEqual({ contents: "read" });
    expect(reusable.jobs.probe.permissions).toBeUndefined();
  });

  test("no run: block interpolates an expression", () => {
    for (const s of steps.filter((x) => x.run)) {
      expect(s.run, `step "${s.name}"`).not.toContain("${{");
    }
  });

  test("checkouts persist no credentials and fetch only what the probe reads", () => {
    const checkouts = steps.filter((s) => /^actions\/checkout@[0-9a-f]{40}$/.test(String(s.uses || "")));
    expect(checkouts).toHaveLength(2);
    for (const c of checkouts) expect(c.with["persist-credentials"]).toBe(false);
    const platform = checkouts.find((c) => c.with.path === ".cms-platform");
    // The platform commit comes from the job context (#424), never an input.
    expect(platform.with.repository).toBe("${{ steps.self.outputs.repository }}");
    expect(platform.with.ref).toBe("${{ steps.self.outputs.sha }}");
    expect(steps.find((s) => s.id === "self").env.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(platform.with["sparse-checkout"].trim().split("\n").sort()).toEqual([
      "oauth-proxy/lambda.py",
      "scripts/probe-oauth-proxy-build.js",
    ]);
  });

  test("the probe step runs the script against the pinned checkout", () => {
    const probeStep = steps.find((s) => String(s.run || "").includes("probe-oauth-proxy-build.js"));
    expect(probeStep).toBeTruthy();
    expect(probeStep.env.PINNED_RELEASE).toBe("${{ steps.self.outputs.ref }}");
    expect(probeStep.run).toContain("--platform-dir .cms-platform");
  });

  test("the dictated caller is scheduled (so the health audit sees its runs) with contents: read", () => {
    expect(Array.isArray(caller.on.schedule) && caller.on.schedule.length).toBeTruthy();
    expect(caller.permissions).toEqual({ contents: "read" });
    expect(Object.keys(caller.jobs)).toEqual(["probe"]);
    expect(caller.jobs.probe.uses).toMatch(
      /^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/oauth-proxy-build\.yml@v\d+\.\d+\.\d+$/,
    );
    expect(caller.concurrency).toBeUndefined();
  });
});
