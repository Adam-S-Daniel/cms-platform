// @lane: local — pure-fs lint locking the visual-regression PROD baseline origin
// (issue #123). Platform-internal (reads e2e/regression-video.spec.js source), so
// it's registered in playwright.config.js PLATFORM_META_SPECS and testIgnore'd on
// consumer lanes.
//
// The regression video pipeline captures each changed page's PRODUCTION screenshot
// from `${PROD_BASE}${pagePath}`. PROD_BASE MUST derive from the consuming site's
// apex (APEX_DOMAIN / CMS_APEX) so every consumer diffs its PR against ITS OWN prod.
// A bare hardcoded `https://adamdaniel.ai` made every non-adamdaniel consumer diff
// against Adam's site → always "visually different". This guard prevents regression.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const SPEC = path.join(__dirname, "regression-video.spec.js");

test.describe("visual-regression PROD baseline origin (#123)", () => {
  const src = fs.readFileSync(SPEC, "utf8");

  test("PROD_BASE derives from the consumer apex (APEX_DOMAIN), not a hardcoded site", () => {
    // The PROD_BASE definition must reference the apex env var.
    expect(src).toMatch(/PROD_BASE\s*=[\s\S]{0,260}process\.env\.APEX_DOMAIN/);
  });

  test("PROD_BASE is NOT a bare hardcoded production domain", () => {
    // adamdaniel.ai may appear ONLY as a trailing `|| "..."` fallback, never as
    // the whole right-hand side of the assignment.
    expect(src).not.toMatch(/PROD_BASE\s*=\s*["']https:\/\/[a-z0-9.-]+["']\s*;/i);
  });
});
