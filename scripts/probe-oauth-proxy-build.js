#!/usr/bin/env node
"use strict";
/*
 * probe-oauth-proxy-build — is a site's live OAuth proxy the build its
 * platform pin says it should be? (#518)
 *
 * ── THE GAP ───────────────────────────────────────────────────────────────
 * The proxy (oauth-proxy/lambda.py) reaches AWS only when someone runs
 * `bash oauth-proxy/deploy.sh` with that site's credentials. A platform
 * release and the consumer bump after it change nothing about the Lambda
 * that is live, so a merged proxy fix can stay un-live indefinitely, and
 * nothing said so. This asks the proxy, with no credentials, and compares.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * GET <base>/prod/health. A proxy deployed from a release that has this
 * probe answers `handler_sha256`, the sha256 of its own lambda.py bytes.
 * That is compared with handlerDigest() of oauth-proxy/lambda.py in the
 * platform checkout the site is pinned to (oauth-proxy-build.yml checks out
 * the commit its caller's `uses:@` names, equal to platform.lock's). The
 * `release` field is only printed: most releases do not change lambda.py,
 * so two different releases can serve the same handler.
 *
 *   current      the digests are equal                                exit 0
 *   stale        the digests differ                                   exit 1
 *   predates     health has no digest, or there is no health route   exit 1
 *                (an older build); GET <base>/prod/auth then says
 *                whether it has the sign-in state check, using the
 *                marker in docs/ADMIN-AUTH-SECURITY.md "Which proxy is
 *                a site running?": a __Host-cms-oauth-state cookie
 *                whose value equals `state=` in the Location. With no
 *                health route, /prod/auth must redirect to GitHub or
 *                the answer is `unexpected`: a 404 alone is not a proxy
 *   unreachable  the request failed (DNS, TLS, timeout)               exit 2
 *   unexpected   anything else: another status, a redirect, a body   exit 2
 *                that is not the proxy's JSON, a malformed digest
 *
 * Only `current` exits 0. Bad usage exits 2 as well.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────
 * It sends no credentials and no cookies, accepts only an https base URL
 * with no userinfo, query or fragment, follows no redirect at all (a 3xx
 * from /prod/health is `unexpected`; /prod/auth's 302 is read, never
 * followed), reads at most MAX_BODY_BYTES of a body, and never prints a
 * body, a header or the URL: only a status code and an outcome. The one
 * value it echoes from the response, `release`, is printed only when it
 * matches RELEASE_RE.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────
 *   node scripts/probe-oauth-proxy-build.js \
 *     --base-url <cms.oauth_base_url> --platform-dir <platform checkout> \
 *     --pinned-release <the release that checkout is>
 *
 * main(argv, deps) takes `fetch`, `readFile`, `out`, `err` and `env`, so the
 * tests in e2e/probe-oauth-proxy-build.test.js run it against canned
 * responses with no network.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// The proxy's handler, relative to a platform checkout.
const HANDLER_PATH = path.join("oauth-proxy", "lambda.py");
const SERVICE = "cms-oauth-proxy";
const STATE_COOKIE = "__Host-cms-oauth-state";
const MAX_BODY_BYTES = 16 * 1024;
const TIMEOUT_MS = 10000;
const DIGEST_RE = /^[0-9a-f]{64}$/;
// Same alphabet as oauth-proxy/template.yaml's PlatformRelease pattern.
const RELEASE_RE = /^[A-Za-z0-9._/+-]{1,100}$/;

const EXIT = { current: 0, stale: 1, predates: 1, unreachable: 2, unexpected: 2 };

// sha256 of the handler's raw bytes, hex. lambda.py computes HANDLER_SHA256
// the same way (hashlib.sha256 over its own file); the test locks the two.
function handlerDigest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// The proxy root to probe, without a trailing slash. Throws on anything but a
// plain https URL.
function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw new Error("--base-url is not a URL");
  }
  if (url.protocol !== "https:") throw new Error("--base-url must be https");
  if (url.username || url.password) throw new Error("--base-url must not carry credentials");
  if (url.search || url.hash) throw new Error("--base-url must not carry a query or fragment");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

// One GET, no redirects, no credentials, a capped body. Resolves to
// { status, contentType, location, setCookies, body } where body is null when
// it exceeded the cap; rejects only when the request itself failed.
async function get(fetchImpl, url) {
  const res = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = "";
  if (res.body) {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        chunks.length = 0;
        size = -1;
        break;
      }
      chunks.push(value);
    }
    body = size < 0 ? null : Buffer.concat(chunks).toString("utf8");
  }
  const headers = res.headers;
  return {
    status: res.status,
    contentType: headers.get("content-type") || "",
    location: headers.get("location") || "",
    setCookies: typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [],
    body,
  };
}

// Does /prod/auth show the sign-in state check? "present", "absent" or
// "unknown" (it did not answer like any known build).
async function stateCheck(fetchImpl, base) {
  let res;
  try {
    res = await get(fetchImpl, `${base}/prod/auth`);
  } catch {
    return { hardening: "unknown", detail: "/prod/auth did not answer" };
  }
  if (res.status !== 302) {
    return { hardening: "unknown", detail: `/prod/auth answered HTTP ${res.status}, not 302` };
  }
  let location;
  try {
    location = new URL(res.location);
  } catch {
    location = null;
  }
  // Every build of the proxy sends /auth to GitHub's consent page.
  if (!location || location.origin !== "https://github.com") {
    return { hardening: "unknown", detail: "/prod/auth answered 302, but not to GitHub" };
  }
  const state = location.searchParams.get("state") || "";
  const cookie = res.setCookies
    .map((c) => c.split(";")[0].trim())
    .find((c) => c.startsWith(`${STATE_COOKIE}=`));
  const value = cookie ? cookie.slice(STATE_COOKIE.length + 1) : "";
  return { hardening: state && value === state ? "present" : "absent", detail: "/prod/auth answered HTTP 302" };
}

// The decision. Resolves to { outcome, message }; never throws for anything
// the proxy answers.
async function probe({ base, expectedDigest, pinnedRelease, fetchImpl }) {
  const redeploy = "Redeploy it: docs/ADMIN-AUTH-SECURITY.md \"A release does not deploy the proxy\".";
  let res;
  try {
    res = await get(fetchImpl, `${base}/prod/health`);
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || (e && e.name) || "error";
    return { outcome: "unreachable", message: `/prod/health could not be fetched (${code}); the build is unknown.` };
  }

  // `proxyKnown`: health already identified the proxy. With no health route,
  // /prod/auth has to, or this is not a proxy at all.
  const predates = async (why, proxyKnown) => {
    const { hardening, detail } = await stateCheck(fetchImpl, base);
    if (!proxyKnown && hardening === "unknown") {
      return { outcome: "unexpected", message: `${why}, and ${detail}: this does not answer like the proxy; the build is unknown.` };
    }
    const verdict = {
      present: "It does have the sign-in state check.",
      absent: "It also LACKS the sign-in state check (no __Host-cms-oauth-state cookie matching state=), so sign-in is not hardened.",
      unknown: `Whether it has the sign-in state check is unknown: ${detail}.`,
    }[hardening];
    return {
      outcome: "predates",
      hardening,
      message: `${why}, so the live proxy predates build reporting and is older than ${pinnedRelease}. ${verdict} ${redeploy}`,
    };
  };

  if (res.status === 404) return predates("/prod/health answered HTTP 404 (no health route)", false);
  if (res.status !== 200) {
    const what = res.status >= 300 && res.status < 400 ? "a redirect, which is not followed" : "not 200";
    return { outcome: "unexpected", message: `/prod/health answered HTTP ${res.status} (${what}); the build is unknown.` };
  }
  if (!/^application\/json\b/i.test(res.contentType)) {
    return { outcome: "unexpected", message: "/prod/health answered HTTP 200 without a JSON content type; the build is unknown." };
  }
  if (res.body === null) {
    return { outcome: "unexpected", message: `/prod/health answered HTTP 200 with a body over ${MAX_BODY_BYTES} bytes; the build is unknown.` };
  }
  let health;
  try {
    health = JSON.parse(res.body);
  } catch {
    health = null;
  }
  if (!health || typeof health !== "object" || Array.isArray(health) || health.service !== SERVICE) {
    return { outcome: "unexpected", message: `/prod/health answered HTTP 200, but not as ${SERVICE}; the build is unknown.` };
  }
  if (!("handler_sha256" in health)) return predates("/prod/health answered HTTP 200 with no handler_sha256", true);
  if (typeof health.handler_sha256 !== "string" || !DIGEST_RE.test(health.handler_sha256)) {
    return { outcome: "unexpected", message: "/prod/health answered HTTP 200 with a malformed handler_sha256; the build is unknown." };
  }
  const live =
    typeof health.release === "string" && RELEASE_RE.test(health.release) ? health.release : "an unrecorded release";
  if (health.handler_sha256 === expectedDigest) {
    return { outcome: "current", message: `the live proxy runs ${pinnedRelease}'s handler (deployed from ${live}).` };
  }
  return {
    outcome: "stale",
    message: `the live proxy was deployed from ${live}, and its handler differs from ${pinnedRelease}'s. ${redeploy}`,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!["--base-url", "--platform-dir", "--pinned-release"].includes(flag) || i + 1 >= argv.length) {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
    args[flag.slice(2)] = argv[i + 1];
  }
  for (const k of ["base-url", "platform-dir", "pinned-release"]) {
    if (!args[k]) throw new Error(`--${k} is required`);
  }
  if (!RELEASE_RE.test(args["pinned-release"])) throw new Error("--pinned-release is not a ref");
  return args;
}

async function main(argv, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const readFile = deps.readFile || fs.readFileSync;
  const out = deps.out || ((s) => process.stdout.write(s + "\n"));
  const err = deps.err || ((s) => process.stderr.write(s + "\n"));
  const env = deps.env || process.env;

  let base;
  let args;
  let expectedDigest;
  try {
    args = parseArgs(argv);
    base = parseBaseUrl(args["base-url"]);
    expectedDigest = handlerDigest(readFile(path.join(args["platform-dir"], HANDLER_PATH)));
  } catch (e) {
    err(`probe-oauth-proxy-build: ${e.message}`);
    return 2;
  }

  const result = await probe({ base, expectedDigest, pinnedRelease: args["pinned-release"], fetchImpl });
  const line = `${result.outcome}: ${result.message}`;
  if (result.outcome === "current") out(line);
  else err(env.GITHUB_ACTIONS === "true" ? `::error title=OAuth proxy build ${result.outcome}::${line}` : line);
  return EXIT[result.outcome];
}

module.exports = { handlerDigest, parseBaseUrl, probe, main, HANDLER_PATH, MAX_BODY_BYTES };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
