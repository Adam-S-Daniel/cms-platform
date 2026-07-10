// @lane: local — needs decap-server file IO + git execs to round-trip a scheduled post
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// Verifies the contributor capability "Schedule a Post for future publishing":
//
//   1. UI half — drive the local Decap admin to create a draft post with
//      Published=OFF and a future Publish Date. Assert the file lands in
//      _posts/ with the expected front matter.
//   2. Workflow half — run scripts/publish_scheduled_posts.py against a
//      fixture file with a past publish_date and assert it flips
//      `published: false` → `published: true`. The workflow YAML itself is
//      a thin wrapper around this script (see
//      .github/workflows/publish-scheduled-posts.yml), so testing the
//      script + asserting the YAML wires it up gives end-to-end coverage
//      without needing to run a cron-driven Action live.

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const PUBLISH_SCRIPT = path.join(REPO_ROOT, "scripts", "publish_scheduled_posts.py");
const WORKFLOW_FILE = path.join(REPO_ROOT, ".github", "workflows", "publish-scheduled-posts.yml");

const SMOKE_TITLE = "E2E Scheduled Post Smoke";
const SMOKE_SLUG = "e2e-scheduled-post-smoke";

function findSmokePostFile() {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const match = fs.readdirSync(POSTS_DIR).find((f) => f.endsWith(`-${SMOKE_SLUG}.md`));
  return match ? path.join(POSTS_DIR, match) : null;
}

function removeSmokePost() {
  const f = findSmokePostFile();
  if (f) fs.unlinkSync(f);
}

test.describe(
  "Schedule a post for future publishing",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => removeSmokePost());
    test.afterAll(() => removeSmokePost());

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("CMS save lands a scheduled draft with future publish_date", async ({ page }) => {
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
      await page.goto("/admin/index-local.html#/collections/posts/new");

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      await titleField.fill(SMOKE_TITLE);

      const slugField = page.getByLabel(/^URL Slug/);
      await slugField.fill(SMOKE_SLUG);

      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.waitFor({ timeout: 30_000 });
      await bodyEditor.click();
      await bodyEditor.fill("Body content for the scheduled post.");

      // Future publish_date — pick a year well past current to avoid races.
      // The widget's <input type="datetime-local"> accepts YYYY-MM-DDTHH:mm.
      // Decap appends "(optional)" to non-required field labels at render time;
      // match a prefix so we don't lock to that locale-string.
      const FUTURE_ISO = "2099-01-15T12:00";
      const publishDate = page.getByLabel(/^Publish Date/);
      await publishDate.fill(FUTURE_ISO);

      // Leave Published OFF — that's the whole point of scheduling.

      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click();

      await expect.poll(() => findSmokePostFile() !== null, { timeout: 60_000 }).toBe(true);
      const written = fs.readFileSync(findSmokePostFile(), "utf8");
      expect(written).toContain(`title: ${SMOKE_TITLE}`);
      expect(written).toMatch(/published:\s*false/);
      // Year 2099 is the canary; no need to assert the full timestamp shape
      // (that's locked down by the publish_scheduled_posts.py date-format
      // tolerance — see DATE_FORMATS in scripts/publish_scheduled_posts.py).
      expect(written).toMatch(/publish_date:\s*['"]?2099/);
    });

    test("publish_scheduled_posts.py flips published when publish_date has passed", () => {
      // Self-contained: write a fixture post with a past publish_date,
      // run the script, assert the file was rewritten with published: true.
      // Use a slug that won't collide with the CMS-driven test above.
      const fixtureName = "1999-01-01-scheduled-post-script-fixture.md";
      const fixturePath = path.join(POSTS_DIR, fixtureName);
      const fixtureContent = `---
title: Scheduled post fixture
date: 1999-01-01 00:00:00 +0000
published: false
publish_date: 1999-01-02 00:00:00 +0000
---

Body.
`;
      try {
        fs.writeFileSync(fixturePath, fixtureContent);
        execFileSync("python3", [PUBLISH_SCRIPT], {
          cwd: REPO_ROOT,
          stdio: "inherit",
        });
        const after = fs.readFileSync(fixturePath, "utf8");
        expect(after).toMatch(/^published:\s*true/m);
        // publish_date is left in place — the workflow only flips published.
        expect(after).toContain("publish_date: 1999-01-02");
      } finally {
        if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath);
      }
    });

    test("workflow YAML wires up the publish script and lands the flips via a PR", () => {
      // Light text probe — no need to exec the workflow, just confirm the
      // wiring an editor would expect: the script is invoked and the
      // flips land through the PR + auto-merge flow, never a direct push
      // to main (the ruleset rejects it, and a GITHUB_TOKEN push would
      // not fire the deploy — see the workflow's header). The daily cron
      // lives on the thin caller, not this reusable. The full structural
      // lock is e2e/publish-scheduled-posts-flow.test.js.
      const yaml = fs.readFileSync(WORKFLOW_FILE, "utf8");
      expect(yaml).toContain("scripts/publish_scheduled_posts.py");
      expect(yaml).toMatch(/git add _posts\//);
      expect(yaml).toContain("cms/posts/scheduled-publish-");
      expect(yaml).not.toMatch(/git push origin main\b/);
    });
  },
);
