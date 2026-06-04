// @lane: local — spins up a local http stub server + reads project fixtures from disk
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");
const { guard } = require("./base-collections-guards");

// Verifies the contributor capability "Build a multi-image project gallery":
// the Projects collection's `images:` field is a `widget: list` with an
// inner `field: image`. We drive the local Decap admin to create a Project,
// add three image entries through the list widget (each picks one of the
// gallery-N.png fixtures via the media library), save, and assert:
//
//   1. File-on-disk: _projects/<slug>.md exists with an `images:` YAML
//      list of three entries, each pointing into /assets/images/uploads/.
//   2. On-disk uploads: each fixture lands DIRECTLY in
//      assets/images/uploads/ (the media_folder is flat +
//      template-free, so the on-disk path is byte-identical to the
//      public URL on every backend).
//   3. Public image URLs: each gallery URL recorded in front matter
//      HEAD-fetches to 200 against the running webServer. Project
//      *pages* (`/projects/<slug>/`) are not built (`_config.yml` has
//      `projects.output: false`), but image *files* are still served
//      by Jekyll's static-file pipeline because Decap writes them under
//      `assets/images/uploads/` — which Jekyll copies as-is.
//   4. Homepage card: the "Featured Projects" homepage section is
//      currently disabled (wrapped in `{% comment %}` in index.html).
//      Re-enable that section to flip this from `test.fixme` to a
//      live assertion. Same disabled-output pattern as
//      cms-project-crud.spec.js.

const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, ".."); // #33 base_collections guard root
const PROJECTS_DIR = path.join(REPO_ROOT, "_projects");
const UPLOADS_ROOT = path.join(REPO_ROOT, "assets", "images", "uploads");
const FIXTURES = [
  path.join(__dirname, "fixtures", "gallery-1.png"),
  path.join(__dirname, "fixtures", "gallery-2.png"),
  path.join(__dirname, "fixtures", "gallery-3.png"),
];

const SMOKE_TITLE = "E2E Gallery Project";
const SMOKE_SLUG = "e2e-gallery-project";
const SMOKE_FILE = path.join(PROJECTS_DIR, `${SMOKE_SLUG}.md`);

function findUploadedFixtures() {
  if (!fs.existsSync(UPLOADS_ROOT)) return [];
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^gallery-\d.*\.png$/i.test(entry.name)) matches.push(full);
    }
  }
  walk(UPLOADS_ROOT);
  return matches;
}

function cleanup() {
  if (fs.existsSync(SMOKE_FILE)) fs.unlinkSync(SMOKE_FILE);
  for (const up of findUploadedFixtures()) {
    fs.unlinkSync(up);
  }
}

// HEAD-fetch a path against the local webServer (port 4000 — same as
// playwright.config.js's `baseURL`). Returns the status code.
function headStatus(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: 4000,
        path: urlPath,
        method: "HEAD",
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`HEAD ${urlPath} timed out`));
    });
    req.end();
  });
}

test.describe(
  "Projects gallery: multi-image list widget",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    // #33 — a base_collections:[] consumer strips the Projects block from config-local.yml,
    // so this spec's admin/index-local.html collection routes never render.
    test.skip(...guard(SITE_ROOT, "cms-project-gallery.spec.js"));

    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => {
      if (!fs.existsSync(PROJECTS_DIR)) {
        fs.mkdirSync(PROJECTS_DIR, { recursive: true });
      }
      cleanup();
    });
    test.afterAll(() => cleanup());

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("project saved with 3-image gallery; uploads land on disk; image URLs resolve", async ({
      page,
    }) => {
      // ── Load admin and open New Project ──────────────────────────────
      await page.goto("/admin/index-local.html");
      await page.getByRole("button", { name: /login/i }).click();
      await page.getByRole("link", { name: /^projects$/i }).waitFor({ timeout: 30_000 });
      await page.goto("/admin/index-local.html#/collections/projects/new");

      const titleField = page.getByLabel(/^Title$/);
      await expect(titleField).toBeVisible({ timeout: 60_000 });
      await titleField.fill(SMOKE_TITLE);

      // Required slug — Projects collection uses {{slug}}, so this is what
      // the on-disk file is named after.
      await page.getByLabel(/^Technology \/ Stack/).fill("HTML · CSS");
      await page.getByLabel(/^Project URL/).fill("https://example.com/gallery-project");

      // ── Add 3 images via the list widget ─────────────────────────────
      // The Images field is a `widget: list` with `field.name: image,
      // field.label: Image, field.widget: image`. Decap renders one
      // "Add <field.label>" button per list widget — clicking it appends
      // a new collapsed item with an image picker inside. We loop:
      // click Add → open the new item's "Choose an Image" → setInputFiles
      // on the hidden file input → confirm via "Choose selected"/"Insert".
      for (let i = 0; i < FIXTURES.length; i++) {
        // Decap's list-widget Add button renders the i18n template
        // `Add %{item}` — `%{item}` is filled by either the outer list
        // label ("Images" in this collection) or the inner field label
        // ("Image"), depending on Decap version. We've also seen "Add"
        // bare, "Add more images" (with files), "Add Item" on older
        // themes. Match anything that starts with "Add " to absorb the
        // drift; `.first()` keeps us bound to the only list widget on
        // the New Project form.
        const addBtn = page.getByRole("button", { name: /^add\b/i }).first();
        await expect(
          addBtn,
          `Add-image button should be visible before adding fixture ${i + 1}`,
        ).toBeVisible({ timeout: 30_000 });
        await addBtn.click();

        // After Add, a new "Choose an Image" picker becomes available for
        // the freshly-appended item. Already-filled items show "Choose
        // different image" instead. The regex below matches *both* labels
        // so the count of choosers === number of list items, and `.last()`
        // always binds to the newest (just-added) item — it's appended at
        // the end of the list in DOM order.
        const choosers = page.getByRole("button", {
          name: /choose (an |different )?image/i,
        });
        await expect(choosers.last()).toBeVisible({ timeout: 15_000 });
        await choosers.last().click();

        // Decap's media library shares one hidden <input type="file"> per
        // open dialog — same pattern as cms-image-upload.spec.js.
        const fileInput = page.locator('input[type="file"][accept*="image"]').first();
        await fileInput.waitFor({ state: "attached", timeout: 30_000 });
        await fileInput.setInputFiles(FIXTURES[i]);

        const insertBtn = page.getByRole("button", { name: /^(choose selected|insert)$/i }).first();
        await expect(insertBtn).toBeVisible({ timeout: 30_000 });
        await insertBtn.click();
      }

      // ── Save ─────────────────────────────────────────────────────────
      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click();

      // ── Assertion 1: file on disk ────────────────────────────────────
      await expect.poll(() => fs.existsSync(SMOKE_FILE), { timeout: 60_000 }).toBe(true);

      const saved = fs.readFileSync(SMOKE_FILE, "utf8");
      expect(saved).toContain(`title: ${SMOKE_TITLE}`);
      expect(saved).toMatch(/^images:/m);
      // Each list entry is one line `  - /assets/images/uploads/<file>.png`.
      // `[^/\s]+` (no path separator) is the regression guard against a
      // nested/templated media_folder reappearing.
      const imageLines = saved.match(/-\s+\/assets\/images\/uploads\/[^/\s]+\.png/g);
      expect(imageLines, "front matter should contain 3 image-URL list entries").not.toBeNull();
      expect(imageLines.length).toBe(3);

      // ── Assertion 2: 3 fixtures on disk under uploads/ ───────────────
      const uploaded = findUploadedFixtures();
      expect(
        uploaded.length,
        "all 3 gallery PNG fixtures should land under assets/images/uploads/",
      ).toBe(3);

      // The webServer is `bundle exec jekyll build` ONCE at startup then
      // `npx serve _site` — it does NOT watch or rebuild. decap-server
      // wrote the uploads into the SOURCE tree (assets/images/uploads/),
      // so we must rebuild for `_site/` (what port 4000 serves) to
      // actually contain them. Every other upload spec
      // (cms-image-upload, cms-featured-image-lifecycle,
      // manual-walkthrough-first-post) does this explicit rebuild; this
      // spec historically masked its absence by tolerating a 404.
      execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });

      // ── Assertion 3: public image URLs resolve (strict 200) ──────────
      // Extract the raw URL from each YAML list line and HEAD-fetch it.
      // The serve webServer streams assets/ directly out of _site/ (Jekyll
      // rebuilds copy uploads as-is), and decap-server writes inside the
      // on-disk source tree.
      //
      // Because media_folder is flat + template-free, the URL written
      // into front matter is byte-identical to the file's on-disk path —
      // exactly what production does too. There is no template-expansion
      // gap to tolerate: every URL MUST 200. A 404 is the broken-image
      // regression this whole change exists to prevent.
      const urls = imageLines.map((line) => line.replace(/^-\s+/, "").trim());
      expect(urls.length).toBe(3);
      for (const u of urls) {
        expect(u).toMatch(/^\/assets\/images\/uploads\/[^/]+\.png$/);
        const status = await headStatus(u).catch(() => 0);
        expect(status, `HEAD ${u} must return 200 (gallery image must resolve end-to-end)`).toBe(
          200,
        );
      }

      // ── Assertion 4 (homepage card): currently disabled section ──────
      // Re-enable Featured Projects on index.html to flip this fixme.
    });

    test.fixme("homepage shows the new Featured Projects card", async ({ page }) => {
      // index.html wraps the Featured Projects section in `{% comment %}`
      // so the projects-grid never renders. Removing that comment will
      // make this test runnable. Until then it stays a `fixme` so the
      // intent is tracked next to the rest of the gallery contract.
      await page.goto("/");
      await expect(
        page.locator(".projects-grid"),
        "Featured Projects section is currently disabled in index.html",
      ).toBeVisible();
    });
  },
);
