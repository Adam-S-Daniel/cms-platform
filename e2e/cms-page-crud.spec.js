// @lane: local — needs decap-server file IO + git execs to round-trip page CRUD
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// Verifies the contributor capability "Create / edit / delete a Page"
// (with permalink) — Pages collection in admin/config.yml has
// title / permalink / published / body fields.
//
// Beyond the on-disk contract, this spec does what cms-publish-flow does
// for posts: rebuild Jekyll, fetch the rendered URL, assert the body lands.
// Pages are real public routes (per `defaults` in _config.yml: layout=page),
// so the live-URL check is meaningful here.

const REPO_ROOT = path.join(__dirname, "..");
const PAGES_DIR = path.join(REPO_ROOT, "pages");

const SMOKE_TITLE = "Decap Page CRUD Smoke";
const SMOKE_SLUG = "decap-page-crud-smoke";
const SMOKE_PERMALINK = `/pages/${SMOKE_SLUG}/`;
const SMOKE_FILE = path.join(PAGES_DIR, `${SMOKE_SLUG}.md`);
const SMOKE_BODY = "Body content for the Page CRUD smoke spec.";

function removeSmokeFile() {
  if (fs.existsSync(SMOKE_FILE)) fs.unlinkSync(SMOKE_FILE);
  // Also wipe the rendered output so a stale copy can't satisfy the live
  // URL assertion after a delete.
  const site = path.join(REPO_ROOT, "_site", "pages", SMOKE_SLUG);
  if (fs.existsSync(site)) fs.rmSync(site, { recursive: true, force: true });
}

test.describe(
  "Pages collection: create / edit / delete with permalink",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => removeSmokeFile());
    test.afterAll(() => removeSmokeFile());

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("create page → render at permalink → edit → delete", async ({ page }) => {
      // ── Load admin, create new Page ───────────────────────────────────
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^pages$/i }).waitFor({ timeout: 30_000 });
      await page.goto("/admin/index-local.html#/collections/pages/new");

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      await titleField.fill(SMOKE_TITLE);

      // Permalink is required — defaults to "/pages/", we replace with the
      // full slug-bearing path the live page should resolve at.
      const permalinkField = page.getByLabel(/^Permalink$/);
      await permalinkField.fill(SMOKE_PERMALINK);

      // Flip Published on so Jekyll includes the page in the build.
      await page
        .getByLabel(/^Published$/)
        .first()
        .click();

      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.waitFor({ timeout: 30_000 });
      await bodyEditor.click();
      await bodyEditor.fill(SMOKE_BODY);

      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click();

      // ── On-disk asserts ──────────────────────────────────────────────
      await expect.poll(() => fs.existsSync(SMOKE_FILE), { timeout: 60_000 }).toBe(true);
      const saved = fs.readFileSync(SMOKE_FILE, "utf8");
      expect(saved).toContain(`title: ${SMOKE_TITLE}`);
      expect(saved).toContain(`permalink: ${SMOKE_PERMALINK}`);
      expect(saved).toMatch(/published:\s*true/);

      // ── Live URL render ──────────────────────────────────────────────
      execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      const resp = await page.goto(SMOKE_PERMALINK);
      expect(resp.status(), `${SMOKE_PERMALINK} should be 200`).toBe(200);
      await expect(page.locator(".page-header h1, h1").first()).toContainText(SMOKE_TITLE);
      await expect(page.locator(".page-content, .post-content").first()).toContainText(SMOKE_BODY);

      // ── Edit ─────────────────────────────────────────────────────────
      await page.goto(`/admin/index-local.html#/collections/pages/entries/${SMOKE_SLUG}`);
      const titleField2 = page.getByLabel(/^Title$/);
      await expect(titleField2).toBeVisible({ timeout: 30_000 });
      const EDITED_TITLE = `${SMOKE_TITLE} (edited)`;
      await titleField2.fill(EDITED_TITLE);
      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: /publish now( and create new)?$/i })
        .first()
        .click();
      await expect
        .poll(() => fs.readFileSync(SMOKE_FILE, "utf8").includes(EDITED_TITLE), { timeout: 60_000 })
        .toBe(true);

      // ── Delete ───────────────────────────────────────────────────────
      const deleteBtn = page
        .getByRole("button", { name: /^delete (entry|published entry)$/i })
        .first();
      await expect(deleteBtn).toBeVisible({ timeout: 30_000 });
      page.on("dialog", (d) => d.accept());
      await deleteBtn.click();
      const inDomConfirm = page.getByRole("button", {
        name: /^(confirm|delete|yes)$/i,
      });
      if (await inDomConfirm.isVisible({ timeout: 1000 }).catch(() => false)) {
        await inDomConfirm.click();
      }
      await expect.poll(() => fs.existsSync(SMOKE_FILE), { timeout: 30_000 }).toBe(false);
    });
  },
);
