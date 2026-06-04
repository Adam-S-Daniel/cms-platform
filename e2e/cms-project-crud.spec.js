// @lane: local — needs decap-server file IO to round-trip project CRUD locally
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { guard } = require("./base-collections-guards");

// Verifies the contributor capability "Create / edit / delete a Project":
// the Projects collection is configured in admin/config.yml with title,
// technology, url_link, featured, images (gallery), description fields.
// We drive the local Decap admin to create an entry, edit it, and delete
// it, asserting the on-disk file at each step.
//
// _config.yml has `output: false` for projects (individual /projects/<slug>/
// pages are intentionally not built right now), so this spec only verifies
// the file-on-disk contract — same as cms-smoke covers for tags. If the
// projects route is ever re-enabled, copy the live-URL pattern from
// cms-publish-flow.spec.js.

const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, ".."); // #33 base_collections guard root
const PROJECTS_DIR = path.join(REPO_ROOT, "_projects");

const SMOKE_TITLE = "Decap Project CRUD Smoke";
const SMOKE_SLUG = "decap-project-crud-smoke";
const SMOKE_FILE = path.join(PROJECTS_DIR, `${SMOKE_SLUG}.md`);

function removeSmokeFile() {
  if (fs.existsSync(SMOKE_FILE)) fs.unlinkSync(SMOKE_FILE);
}

test.describe(
  "Projects collection: create / edit / delete",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    // #33 — a base_collections:[] consumer strips the Projects block from config-local.yml,
    // so this spec's admin/index-local.html collection routes never render.
    test.skip(...guard(SITE_ROOT, "cms-project-crud.spec.js"));

    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => {
      if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
      removeSmokeFile();
    });
    test.afterAll(() => removeSmokeFile());

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("create → edit → delete a Project end-to-end", async ({ page }) => {
      // ── Load admin and open New Project ──────────────────────────────
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^projects$/i }).waitFor({ timeout: 30_000 });
      await page.goto("/admin/index-local.html#/collections/projects/new");

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      await titleField.fill(SMOKE_TITLE);

      // Decap appends "(optional)" to non-required labels — match by prefix.
      await page.getByLabel(/^Technology \/ Stack/).fill("Rust · Tokio");
      await page.getByLabel(/^Project URL/).fill("https://example.com/cool-project");

      // Featured = true so the entry exercises the boolean-toggle write
      // path (the same write the homepage's featured filter relies on).
      await page
        .getByLabel(/^Featured$/)
        .first()
        .click();

      // ── Create ───────────────────────────────────────────────────────
      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click();

      await expect.poll(() => fs.existsSync(SMOKE_FILE), { timeout: 60_000 }).toBe(true);

      const saved = fs.readFileSync(SMOKE_FILE, "utf8");
      expect(saved).toContain(`title: ${SMOKE_TITLE}`);
      expect(saved).toMatch(/technology:\s*['"]?Rust ·/);
      expect(saved).toMatch(/url_link:\s*['"]?https:\/\/example\.com/);
      expect(saved).toMatch(/featured:\s*true/);

      // ── Edit ─────────────────────────────────────────────────────────
      // Re-open the entry through the admin and change Technology, save.
      await page.goto(`/admin/index-local.html#/collections/projects/entries/${SMOKE_SLUG}`);
      const techField = page.getByLabel(/^Technology \/ Stack/);
      await expect(techField).toBeVisible({ timeout: 30_000 });
      await techField.fill("Python · FastAPI");
      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: /publish now( and create new)?$/i })
        .first()
        .click();

      await expect
        .poll(() => fs.readFileSync(SMOKE_FILE, "utf8").includes("Python · FastAPI"), {
          timeout: 60_000,
        })
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
