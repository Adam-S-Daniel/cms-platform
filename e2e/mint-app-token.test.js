// @lane: local — pure unit lint of scripts/mint-app-token.js; no network.
// Platform-internal (reads this repo's scripts/), so it is registered in
// playwright.config.js PLATFORM_META_SPECS.
//
// The script mints a GitHub App installation token for two callers with
// different blast radii: repo-settings-apply (Administration on both owners)
// and, since #238, the consumer push-back reusables (platform-bump,
// dev-hooks-sync). Two properties keep the second caller from inheriting the
// first's reach:
//   - `--repositories` narrows the token to the repo the job runs in. GitHub's
//     `access_tokens` endpoint accepts a `repositories` list that can only
//     NARROW the installation's grant, exactly like `permissions`; without it
//     a token minted on the Adam-S-Daniel installation would also cover
//     cms-platform itself, because the App is installed on both.
//   - the fail-soft notice names the ENV VARS the script reads, never one
//     caller's repository knobs. It used to hardcode `REPO_SETTINGS_*`, so a
//     CMS-context skip named the wrong knobs — the v0.1.76 rule is that the
//     notice must let "never onboarded" be told from "misconfigured", and a
//     wrong name defeats that. Each caller pre-checks and names its own.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const SCRIPT = path.join(__dirname, "..", "scripts", "mint-app-token.js");
const { parsePermissions, parseRepositories, mintBody } = require(SCRIPT);

// Strip every APP_* credential from the child's env so the test cannot pick
// one up from the session (this file must never mint anything).
function run(args, extraEnv = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^APP_/.test(k) && k !== "GITHUB_OUTPUT"),
  );
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test.describe("scripts/mint-app-token.js (#172, #238)", () => {
  test("--repositories parses to a list and lands in the mint body; absent means unscoped", () => {
    expect(parseRepositories("adamdaniel.ai")).toEqual(["adamdaniel.ai"]);
    expect(parseRepositories(" a , b ,")).toEqual(["a", "b"]);
    expect(parseRepositories("")).toBeNull();
    expect(parseRepositories(undefined)).toBeNull();
    const perms = parsePermissions("contents=write,workflows=write");
    expect(mintBody(perms, ["x"])).toEqual({ permissions: perms, repositories: ["x"] });
    expect(mintBody(perms, null)).toEqual({ permissions: perms });
    expect(Object.keys(mintBody(perms, null))).not.toContain("repositories");
  });

  test("no credential → exit 0 with a ::notice:: naming the env vars, not one caller's knobs", () => {
    const { code, out } = run(["--owner", "o", "--repo", "r", "--permissions", "contents=read"]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/::notice::/);
    expect(out).toMatch(/APP_CLIENT_ID/);
    expect(out).toMatch(/APP_PRIVATE_KEY/);
    expect(out, "the caller names its repository knobs; the script must not").not.toMatch(
      /REPO_SETTINGS/,
    );
    expect(out).not.toMatch(/^token=/m);
  });

  test("a credential that is PRESENT but broken is loud: ::error:: and exit 1", () => {
    // A garbage private key fails inside crypto before any network call.
    const { code, out } = run(["--owner", "o", "--repo", "r", "--permissions", "contents=read"], {
      APP_CLIENT_ID: "Iv1.deadbeef",
      APP_PRIVATE_KEY: "not a pem",
    });
    expect(code, out).toBe(1);
    expect(out).toMatch(/::error::Could not mint/);
  });

  test("--permissions is mandatory and must be key=value pairs", () => {
    expect(() => parsePermissions("")).toThrow(/required/);
    expect(() => parsePermissions("contents")).toThrow(/want key=value/);
    const { code, out } = run(["--owner", "o", "--repo", "r"]);
    expect(code, out).toBe(1);
  });
});
