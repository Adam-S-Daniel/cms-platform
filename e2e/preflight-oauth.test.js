// @lane: local — pure-Node unit tests for scripts/preflight-oauth.js helpers (#26)
/*
 * scripts/preflight-oauth.js is the org-owner go-live preflight CLI for the
 * OAuth-App-restriction failure mode (issue #26): for an ORG-owned consumer it
 * prints the actionable "approve the CMS OAuth App" instructions + the settings
 * URL; for a USER-owned consumer it prints "no org approval needed". It detects
 * the owner type via `gh` and is resilient when gh is unavailable (prints the
 * manual instructions anyway).
 *
 * The network/gh detection isn't unit-testable cheaply, so the script EXPORTS
 * its pure helpers (parseRepo, messageFor) for these tests; the require.main
 * guard keeps the CLI from running on import. The end-to-end gh-driven runs are
 * verified manually (see the PR's verify evidence + AGENTS.md).
 */
const path = require("node:path");
const { test, expect } = require("./base");

const SCRIPT_PATH = path.resolve(__dirname, "../scripts/preflight-oauth.js");

function load() {
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

test.describe("preflight-oauth.js — parseRepo (#26)", () => {
  test("splits OWNER/REPO into structured parts", () => {
    const { parseRepo } = load();
    expect(parseRepo("jodidaniel/jodidaniel.com")).toEqual({
      owner: "jodidaniel",
      repo: "jodidaniel.com",
    });
    expect(parseRepo("Adam-S-Daniel/adamdaniel.ai")).toEqual({
      owner: "Adam-S-Daniel",
      repo: "adamdaniel.ai",
    });
  });

  test("trims surrounding whitespace", () => {
    const { parseRepo } = load();
    expect(parseRepo("  acme/site  ")).toEqual({ owner: "acme", repo: "site" });
  });

  test("returns null for malformed input", () => {
    const { parseRepo } = load();
    for (const bad of ["", null, undefined, "no-slash", "owner/", "/repo", "a/b/c", 7]) {
      expect(parseRepo(bad), `malformed: ${JSON.stringify(bad)}`).toBe(null);
    }
  });
});

test.describe("preflight-oauth.js — messageFor (#26)", () => {
  const REPO = "jodidaniel/jodidaniel.com";

  test("Organization owner → actionable approve-the-app guidance + settings URL", () => {
    const { messageFor } = load();
    const msg = messageFor("Organization", REPO);
    expect(typeof msg).toBe("string");
    // Names the failure mode in the org owner's terms.
    expect(msg).toMatch(/OAuth App access restrictions/i);
    // Tells them WHERE to fix it.
    expect(msg).toMatch(/Third-party access/i);
    expect(msg).toMatch(/OAuth App policy/i);
    // The exact settings deep-link, derived from the repo owner.
    expect(msg).toContain(
      "https://github.com/organizations/jodidaniel/settings/oauth_application_policy",
    );
    // Explains login works but SAVE fails until approved (the whole point).
    expect(msg).toMatch(/log in/i);
    expect(msg).toMatch(/save/i);
    // Calls out that a PAT probe would false-green, so we don't do one.
    expect(msg).toMatch(/PAT/);
    expect(msg).toMatch(/false[- ]green/i);
  });

  test("User owner → 'no org approval needed' message", () => {
    const { messageFor } = load();
    const msg = messageFor("User", "Adam-S-Daniel/adamdaniel.ai");
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/user-owned/i);
    expect(msg).toMatch(/no org OAuth approval needed/i);
    // Must NOT push the org owner to the settings page (irrelevant here).
    expect(msg).not.toContain("oauth_application_policy");
  });

  test("Unknown owner type (gh unavailable) → manual instructions, never a crash", () => {
    const { messageFor } = load();
    // When gh can't determine the type we still want actionable guidance.
    const msg = messageFor(null, REPO);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
    // Falls back to surfacing the org-approval path (the conservative,
    // safe-by-default guidance) including the settings URL.
    expect(msg).toContain(
      "https://github.com/organizations/jodidaniel/settings/oauth_application_policy",
    );
  });

  test("does not execute the CLI on import (require.main guard)", () => {
    // load() returning helpers without printing/exiting proves the guard.
    const api = load();
    expect(typeof api.parseRepo).toBe("function");
    expect(typeof api.messageFor).toBe("function");
  });
});
