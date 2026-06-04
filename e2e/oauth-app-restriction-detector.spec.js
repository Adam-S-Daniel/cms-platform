// @lane: local — browser runtime test for the OAuth-App-restriction admin banner (#26)
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");

// Runtime coverage for admin/oauth-app-restriction-detector.js (#26).
//
// The detector watches Decap's notification surface for GitHub's "OAuth App
// access restrictions" persist error and shows a dismissible banner telling the
// ORG OWNER where to approve the CMS OAuth App. Staging a REAL persist failure
// would need the live github backend + an unapproved org OAuth App (exactly the
// state we can't reproduce in CI — see #26). So instead of driving Decap, this
// spec loads the detector source onto a blank page, sets window.CMS_REPO, and
// SIMULATES the DOM mutation Decap makes when it renders the error toast: we
// insert a node carrying the restriction text and assert the observer fires.
//
// This keeps the test hermetic (no decap-server, no github backend, no /admin
// route) and non-flaky, while still exercising the real MutationObserver →
// banner → dismiss path in a real browser. The pure helpers are covered by the
// pure-Node sibling e2e/oauth-app-restriction-detector.test.js.
//
// Tagged @admin-read: read-only, runs on chromium-desktop-3k + webkit-iphone16.

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../theme/admin/oauth-app-restriction-detector.js"),
  "utf8",
);

const BANNER = '[data-testid="cms-oauth-app-restriction-banner"]';
const DISMISS = '[data-testid="cms-oauth-app-restriction-dismiss"]';
const RESTRICTION_MSG =
  "Although you appear to have the correct authorization credentials, the " +
  "`jodidaniel` organization has enabled OAuth App access restrictions, " +
  "meaning that data access to third-parties is limited.";

test.describe(
  "oauth-app-restriction-detector.js — runtime banner (#26)",
  { tag: ["@admin-read"] },
  () => {
    // Load the detector onto a blank page with a known org repo, simulating
    // the prod admin shell's window.CMS_REPO injection.
    async function bootDetector(page, repo = "jodidaniel/jodidaniel.com") {
      await page.setContent("<!doctype html><html><head></head><body></body></html>");
      await page.evaluate((r) => {
        window.CMS_REPO = r;
      }, repo);
      await page.addScriptTag({ content: SRC });
      await expect
        .poll(() => page.evaluate(() => !!window.__oauthAppRestrictionDetector))
        .toBe(true);
    }

    // Mimic Decap rendering its error toast: append a node carrying the error
    // text to the body (what the MutationObserver watches).
    async function emitDecapError(page, text) {
      await page.evaluate((t) => {
        const toast = document.createElement("div");
        toast.className = "notif__message"; // Decap-ish toast class (illustrative)
        toast.textContent = t;
        document.body.appendChild(toast);
      }, text);
    }

    test("shows an actionable banner when the restriction error toast appears", async ({
      page,
    }) => {
      await bootDetector(page);
      // No banner before any error.
      await expect(page.locator(BANNER)).toHaveCount(0);

      await emitDecapError(page, RESTRICTION_MSG);

      const banner = page.locator(BANNER);
      await expect(banner).toBeVisible();
      // Names the failure mode and the fix location.
      await expect(banner).toContainText(/OAuth App access restrictions/i);
      await expect(banner).toContainText(/org owner/i);
      // Org-specific deep-link to the OAuth App policy settings page.
      const link = banner.locator(
        'a[href="https://github.com/organizations/jodidaniel/settings/oauth_application_policy"]',
      );
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute("target", "_blank");
    });

    test("does NOT show the banner for a benign error toast", async ({ page }) => {
      await bootDetector(page);
      await emitDecapError(page, "Repository rule violations found");
      await emitDecapError(page, "Bad credentials");
      // Give the observer a chance to (not) fire.
      await page.waitForTimeout(150);
      await expect(page.locator(BANNER)).toHaveCount(0);
    });

    test("banner is dismissible, and re-shows on the NEXT failed save", async ({ page }) => {
      await bootDetector(page);

      await emitDecapError(page, RESTRICTION_MSG);
      await expect(page.locator(BANNER)).toBeVisible();

      // Dismiss → banner removed (editing is never blocked).
      await page.locator(DISMISS).click();
      await expect(page.locator(BANNER)).toHaveCount(0);

      // A subsequent failed save (another error toast) re-shows it.
      await emitDecapError(page, RESTRICTION_MSG);
      await expect(page.locator(BANNER)).toBeVisible();
    });

    test("degrades to generic guidance (no broken link) when CMS_REPO is absent", async ({
      page,
    }) => {
      // Empty repo → org can't be derived → no deep link, but still a banner.
      await bootDetector(page, "");
      await emitDecapError(page, RESTRICTION_MSG);
      const banner = page.locator(BANNER);
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(/OAuth App policy/i);
      // No org-policy anchor when we couldn't derive the org.
      await expect(banner.locator('a[href*="oauth_application_policy"]')).toHaveCount(0);
    });
  },
);
