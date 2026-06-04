// @lane: local — pure-Node sandbox unit tests for the OAuth-App-restriction admin detector
/*
 * Unit tests for admin/oauth-app-restriction-detector.js (issue #26).
 *
 * The detector is a browser IIFE that watches Decap's notification surface
 * for the GitHub "OAuth App access restrictions" persist error and shows a
 * dismissible, actionable banner telling the ORG OWNER to approve the CMS
 * OAuth App. It does NOT block editing, and it does NOT clobber window.fetch
 * (publish-via-auto-merge.js already wraps fetch — see #26 notes).
 *
 * These tests load the source in a vm sandbox (the same pure-Node pattern
 * slugify-parity.test.js / publish-via-auto-merge.test.js use) and exercise
 * the EXPORTED PURE HELPERS the module hangs off window for testability:
 *   - isOAuthAppRestrictionError(text)
 *   - orgFromRepo(repo)
 *   - orgOAuthPolicyUrl(org)
 *
 * The runtime banner/MutationObserver wiring is guarded behind a
 * `typeof window/document` check so loading the module in a minimal sandbox
 * runs nothing but the `window.OAuthAppRestrictionDetector = {...}`
 * assignment — exactly like live-url-derive.js.
 *
 * The browser-driving coverage (inject a Decap toast carrying the
 * restriction text → assert the banner appears + dismisses) lives in
 * e2e/oauth-app-restriction-detector.spec.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC_PATH = path.resolve(__dirname, "../theme/admin/oauth-app-restriction-detector.js");

// Load the IIFE in a sandbox and return its exported helper surface. The
// module touches window/document only INSIDE the registration code, which is
// guarded so it no-ops when there's no real DOM — so empty stubs are safe and
// nothing runs at load except the window assignment.
function loadHelpers() {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  const sandbox = { window: {}, document: undefined };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.OAuthAppRestrictionDetector;
  expect(
    api && typeof api,
    "admin/oauth-app-restriction-detector.js must expose window.OAuthAppRestrictionDetector",
  ).toBe("object");
  return api;
}

test.describe("oauth-app-restriction-detector.js — pure helpers (#26)", () => {
  test("isOAuthAppRestrictionError matches the real GitHub/Decap error text", () => {
    const { isOAuthAppRestrictionError } = loadHelpers();
    // The verbatim message GitHub returns on a write through an
    // unapproved OAuth App (jodidaniel#27 surfaced this exact shape).
    const real =
      "Although you appear to have the correct authorization credentials, the " +
      "`jodidaniel` organization has enabled OAuth App access restrictions, meaning " +
      "that data access to third-parties is limited. For more information on " +
      "restricting access via OAuth Apps, see ...";
    expect(isOAuthAppRestrictionError(real)).toBe(true);
    // The way Decap wraps it in an API_ERROR toast.
    expect(
      isOAuthAppRestrictionError("API_ERROR: OAuth App access restrictions"),
    ).toBe(true);
    // Case-insensitive and substring-tolerant.
    expect(isOAuthAppRestrictionError("oauth app access restrictions")).toBe(true);
    expect(
      isOAuthAppRestrictionError("...enabled OAuth App access restrictions, meaning..."),
    ).toBe(true);
  });

  test("isOAuthAppRestrictionError REJECTS benign / unrelated errors", () => {
    const { isOAuthAppRestrictionError } = loadHelpers();
    const benign = [
      "",
      null,
      undefined,
      "Repository rule violations found",
      "Bad credentials",
      "Not Found",
      "Pull request is in unstable state",
      "Validation Failed",
      "API rate limit exceeded",
      "Network request failed",
      // A message that merely mentions OAuth but isn't the restriction.
      "Your OAuth token has expired, please sign in again",
      // Mentions "restrictions" but not the OAuth-App access kind.
      "branch protection restrictions apply to this push",
    ];
    for (const b of benign) {
      expect(
        isOAuthAppRestrictionError(b),
        `must not flag benign error: ${JSON.stringify(b)}`,
      ).toBe(false);
    }
  });

  test("orgFromRepo splits owner/repo and returns the owner (org)", () => {
    const { orgFromRepo } = loadHelpers();
    expect(orgFromRepo("jodidaniel/jodidaniel.com")).toBe("jodidaniel");
    expect(orgFromRepo("Adam-S-Daniel/adamdaniel.ai")).toBe("Adam-S-Daniel");
    // Defensive: trims and tolerates a leading slash / whitespace.
    expect(orgFromRepo("  acme/site  ")).toBe("acme");
  });

  test("orgFromRepo returns null for malformed input", () => {
    const { orgFromRepo } = loadHelpers();
    for (const bad of ["", null, undefined, "no-slash", "/leadingslash", 42, {}]) {
      expect(orgFromRepo(bad), `malformed repo: ${JSON.stringify(bad)}`).toBe(null);
    }
  });

  test("orgOAuthPolicyUrl builds the org OAuth-App-policy settings URL", () => {
    const { orgOAuthPolicyUrl } = loadHelpers();
    expect(orgOAuthPolicyUrl("jodidaniel")).toBe(
      "https://github.com/organizations/jodidaniel/settings/oauth_application_policy",
    );
    expect(orgOAuthPolicyUrl("Adam-S-Daniel")).toBe(
      "https://github.com/organizations/Adam-S-Daniel/settings/oauth_application_policy",
    );
  });

  test("orgOAuthPolicyUrl returns null when org is missing (degrade, never broken link)", () => {
    const { orgOAuthPolicyUrl } = loadHelpers();
    for (const bad of ["", null, undefined]) {
      expect(orgOAuthPolicyUrl(bad)).toBe(null);
    }
  });

  test("orgOAuthPolicyUrl(orgFromRepo(CMS_REPO)) composes end-to-end from owner/repo", () => {
    const { orgFromRepo, orgOAuthPolicyUrl } = loadHelpers();
    expect(orgOAuthPolicyUrl(orgFromRepo("jodidaniel/jodidaniel.com"))).toBe(
      "https://github.com/organizations/jodidaniel/settings/oauth_application_policy",
    );
  });
});
