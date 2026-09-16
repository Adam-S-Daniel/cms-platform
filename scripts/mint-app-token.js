#!/usr/bin/env node
/*
 * Mint a short-lived GitHub App INSTALLATION token, scoped down at mint time.
 *
 * WHY THIS EXISTS: repo-settings apply-in-CI (#172) needs a WRITE credential for
 * repo administration across TWO owners, and a fine-grained PAT cannot span
 * owners. A GitHub App installed on both owners can — and its installation
 * tokens expire in ~1 hour, so nothing long-lived sits in CI.
 *
 * THE SCOPE-DOWN IS THE POINT. `POST /app/installations/{id}/access_tokens`
 * accepts a `permissions` object that can only NARROW what the installation
 * already has, never widen it. That lets the ungated plan job mint a token that
 * literally cannot write (`administration: read`) while the reviewer-gated apply
 * job mints `administration: write` — so a bug or an injected step in the plan
 * job cannot mutate repo settings, rather than merely being trusted not to.
 *
 * Pure node + the stdlib `crypto` module, deliberately NOT a marketplace action:
 * repo policy prefers built-ins over bundled third-party JS in a workflow that
 * holds an admin credential, and a new action would owe the 7-day cooling-off.
 *
 * Usage:
 *   node scripts/mint-app-token.js --owner OWNER --repo REPO \
 *     --permissions administration=read[,contents=read...] \
 *     [--repositories REPO[,REPO...]]
 *
 * Reads APP_CLIENT_ID (the App's Client ID — GitHub accepts it as the JWT `iss`,
 * and it is the fleet convention since Adam-S-Daniel/repo-settings PR #12; the
 * legacy APP_ID is still honoured) and APP_PRIVATE_KEY. On success it writes
 * `token=<value>` to $GITHUB_OUTPUT (masking it first) and exits 0.
 *
 * `--repositories` narrows the token to those repos (names, not slugs), the
 * same way `permissions` narrows: GitHub rejects anything outside the
 * installation's grant, so it can only shrink. Since #238 this script also
 * mints the consumer push-back credential (platform-bump / dev-hooks-sync,
 * replacing the CMS_PLATFORM_PAT fine-grained PAT), and the App behind that is
 * installed on BOTH of an owner's repos — without the narrowing, a token minted
 * for adamdaniel.ai would also reach cms-platform.
 *
 * FAILS SOFT (v0.1.76 rule): a missing credential is NOT an error — it prints a
 * ::notice:: and exits 0 with no token, so "never onboarded" stays
 * distinguishable from "misconfigured" and the caller decides. The notice names
 * the ENV VARS this script reads; the CALLER names its own repository knobs
 * (`vars.REPO_SETTINGS_APP_CLIENT_ID` for repo-settings-apply,
 * `vars.CMS_AUTOMATION_APP_ID` for the consumer push-back reusables) in its own
 * pre-check, because a notice that names the wrong caller's knobs is worse than
 * one that names none. A credential that is PRESENT but broken exits non-zero:
 * that is a real fault.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// "administration=write,contents=read" -> { administration: "write", contents: "read" }
function parsePermissions(spec) {
  const out = {};
  for (const pair of String(spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (!k || !v) throw new Error(`bad --permissions entry ${JSON.stringify(pair)} (want key=value)`);
    out[k] = v;
  }
  if (!Object.keys(out).length) throw new Error("--permissions is required and must not be empty");
  return out;
}

// "a, b," -> ["a", "b"]; empty/absent -> null (no narrowing requested).
function parseRepositories(spec) {
  const out = String(spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : null;
}

// The POST /app/installations/{id}/access_tokens body. Both keys can only
// NARROW what the installation already holds; `repositories` is omitted (not
// sent empty) when no narrowing was asked for — an empty list is not "all".
function mintBody(permissions, repositories) {
  return repositories ? { permissions, repositories } : { permissions };
}

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat back-dated 60s for clock skew; exp 9 minutes out (GitHub rejects >10).
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

async function api(url, jwt, method, body) {
  const res = await fetch(url, {
    method: method || "GET",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "cms-platform-mint-app-token",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // Status + method/url only — NEVER the response body. It can quote data and
  // must not land in a public Actions log (the repo's data-exposure rule).
  if (!res.ok) throw new Error(`${method || "GET"} ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const owner = arg("owner");
  const repo = arg("repo");
  const permissions = parsePermissions(arg("permissions"));
  const repositories = parseRepositories(arg("repositories"));
  if (!owner || !repo) throw new Error("--owner and --repo are required");

  const appId = process.env.APP_CLIENT_ID || process.env.APP_ID || "";
  const privateKey = process.env.APP_PRIVATE_KEY || "";
  if (!appId || !privateKey) {
    // Fail SOFT and name the exact knobs.
    console.log(
      "::notice::No GitHub App credential configured — APP_CLIENT_ID and APP_PRIVATE_KEY " +
        "are not both set in this step's env. Skipping (the calling workflow names the " +
        "repository variable / secret that feed them).",
    );
    return;
  }

  const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
  const jwt = appJwt(appId, privateKey);
  // The installation is per OWNER; resolving it via one of that owner's repos
  // is what lets a single App serve both owners with separate tokens.
  const install = await api(`${apiBase}/repos/${owner}/${repo}/installation`, jwt);
  // Scope DOWN. GitHub rejects anything the installation does not already
  // hold — permissions and repositories alike — so this can never escalate,
  // only narrow.
  const minted = await api(
    `${apiBase}/app/installations/${install.id}/access_tokens`,
    jwt,
    "POST",
    mintBody(permissions, repositories),
  );
  if (!minted.token) throw new Error("installation response carried no token");

  // Mask BEFORE the value reaches any other surface.
  console.log(`::add-mask::${minted.token}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `token=${minted.token}\n`);
  }
  console.log(
    `::notice::Minted a ${Object.entries(permissions)
      .map(([k, v]) => `${k}:${v}`)
      .join(",")} installation token for ${owner}${
      repositories ? ` (repositories: ${repositories.join(",")})` : ""
    }.`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`::error::Could not mint a GitHub App installation token — ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parsePermissions, parseRepositories, mintBody, appJwt };
