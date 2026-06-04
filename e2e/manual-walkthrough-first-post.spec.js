// @lane: local — exercises the local Decap admin loop with decap-server file IO
/*
 * C3 — End-to-end "first post" walkthrough that mirrors what a brand-new
 * contributor would actually do in the admin: open the editor, fill a
 * title + slug + body, attach a featured image, save, mark ready, watch
 * it publish, then verify the rendered post on the public URL.
 *
 * allowed: literal slug used for known fixture (the e2e-first-post-sim
 * test fixture)
 *
 * Why this exists separately from `cms-publish-flow.spec.js` and
 * `cms-image-upload.spec.js`:
 *   - Those specs each cover ONE leg of the loop (publish, upload).
 *   - The contributor manual claims you can do the whole flow in one
 *     session: create → fill → image → save → ready → publish → see
 *     it live. C3 is the runtime probe that the *whole* claim still
 *     holds end-to-end, not just the legs in isolation.
 *   - This spec calls `captureStep` at every major step, so its run
 *     produces the screenshots + step records that feed
 *     `docs/CONTRIBUTOR_MANUAL.md` via
 *     `scripts/build-contributor-manual.js`.
 *
 * Local-backend, not editorial-workflow: `admin/index-local.html` sets
 * `local_backend: true`, which forces simple mode regardless of
 * `publish_mode: editorial_workflow` (see cms-publish-flow.spec.js for
 * the same trade-off). That gives us a synchronous Save → file-on-disk
 * loop without standing up GitHub. The contributor manual narrates the
 * editorial-workflow flow on production; the runtime bones are the
 * same — Save commits, the post becomes part of `site.posts`, the
 * permalink renders. The "Ready" step on local-backend collapses to the
 * Publish action since there is no PR to label.
 *
 * CRITICAL — Jekyll rebuild gotcha: earlier specs (B7/B8) discovered
 * that Decap's Save resolves before Jekyll's `--watch` rebuild has
 * picked up the new file. The fix is to invoke
 * `bundle exec jekyll build --quiet` EXPLICITLY between save and the
 * public-URL fetch. We do NOT rely on `--watch` here.
 *
 * Per-step timing: each step is wrapped in `measure()`, which records a
 * Date.now() delta and asserts a soft budget. Single-step budget is 30s
 * (the editor mounts, save, etc.); the explicit Jekyll rebuild gets a
 * 60s budget since it's slower than the in-test browser actions.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");
const { guard } = require("./base-collections-guards");
const { captureStep } = require("./manual-capture");

const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");  // #33 base_collections guard root
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const UPLOADS_ROOT = path.join(REPO_ROOT, "assets", "images", "uploads");
const FIXTURE_PNG = path.join(__dirname, "fixtures", "tiny-pixel.png");

// Unique slug — must not collide with existing fixtures
// (`e2e-image-upload-smoke`, `e2e-publish-flow-smoke`, `e2e-mutation-canary`).
// Naming: "first-post-sim" makes it obvious this is the brand-new
// contributor walkthrough, not one of the leg-tests.
//
// IMPORTANT: SMOKE_TITLE is chosen so its slugified form matches
// SMOKE_SLUG exactly. Decap's slug widget auto-derives from the title
// AND a separately-filled slug input fights with that derive (last
// keystroke wins). If we picked a fancier title, Decap would
// occasionally clobber the explicit slug fill with its own re-derive
// and the post would land at the wrong filename. Keep them aligned.
const SMOKE_TITLE = "E2E First Post Sim";
const SMOKE_SLUG = "e2e-first-post-sim";
const SMOKE_BODY =
  "This is the first-post walkthrough fixture body. The C3 spec writes this " +
  "post to exercise the brand-new-contributor flow end-to-end. Safe to delete.";

const PER_STEP_BUDGET_MS = 30_000;
const JEKYLL_REBUILD_BUDGET_MS = 60_000;
// The "wait for Decap to commit through decap-server" poll has a
// generous 60s envelope — same as cms-publish-flow.spec.js — because
// the decap-server file-write race + Decap's YAML serialization +
// disk write of the post + image bundles into one observable lag
// between Save click and file-on-disk. Budget the step generously so a
// borderline-slow commit doesn't fail the whole walkthrough.
const COMMIT_POLL_BUDGET_MS = 60_000;

// Track step durations so the final assertion message can show the
// whole timeline at a glance when something is slow.
const stepTimings = [];

function findSmokePostFile() {
  if (!fs.existsSync(POSTS_DIR)) return null;
  const match = fs.readdirSync(POSTS_DIR).find((f) => f.endsWith(`-${SMOKE_SLUG}.md`));
  return match ? path.join(POSTS_DIR, match) : null;
}

// Walk uploads/ for the fixture's basename. Decap may dedupe-suffix the
// filename (tiny-pixel-1.png on a re-upload), so accept any file whose
// stem starts with `tiny-pixel`.
function findUploadedFixture() {
  if (!fs.existsSync(UPLOADS_ROOT)) return null;
  const matches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^tiny-pixel.*\.png$/i.test(entry.name)) matches.push(full);
    }
  }
  walk(UPLOADS_ROOT);
  return matches[0] || null;
}

function jekyllBuild() {
  // Quiet rebuild into the `_site/` the playwright webServer is
  // serving. The webServer pre-builds once at startup; without this
  // explicit rebuild the new post / upload aren't reachable at the
  // public URL during the test.
  execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

function cleanup() {
  const f = findSmokePostFile();
  if (f) fs.unlinkSync(f);
  const up = findUploadedFixture();
  if (up) fs.unlinkSync(up);
  // Clear the rendered output from `_site/` so the next run isn't
  // serving a stale copy from a previous build.
  const site = path.join(REPO_ROOT, "_site", "blog", SMOKE_SLUG);
  if (fs.existsSync(site)) fs.rmSync(site, { recursive: true, force: true });
}

/**
 * Wrap an async block in a Date.now() delta and assert a soft budget.
 * If the block exceeds `budgetMs`, the test fails with a message
 * showing the cumulative timeline so the slowest step is obvious.
 */
async function measure(label, budgetMs, fn) {
  const start = Date.now();
  let result;
  // Run `fn`, always RECORD the step timing (even on failure), but never
  // raise the budget error from a `finally` — doing so would mask a real
  // error thrown by `fn`. So: on failure, record the timing and rethrow the
  // original error untouched; on success, record then enforce the budget.
  try {
    result = await fn();
  } catch (err) {
    stepTimings.push({ label, elapsed: Date.now() - start, budgetMs });
    throw err;
  }
  const elapsed = Date.now() - start;
  stepTimings.push({ label, elapsed, budgetMs });
  if (elapsed > budgetMs) {
    const timeline = stepTimings
      .map((s) => `  ${s.label}: ${s.elapsed}ms (budget ${s.budgetMs}ms)`)
      .join("\n");
    throw new Error(
      `Step "${label}" exceeded its ${budgetMs}ms budget (took ${elapsed}ms). Timeline so far:\n${timeline}`,
    );
  }
  return result;
}

test.describe(
  "First-post walkthrough — full create → publish → verify cycle",
  // Tagged @admin-screenshots: drives local /admin through full
  // publish-loop to capture first-post-walkthrough screenshots.
  // Single-browser by design — manual-capture writes to project-
  // INDEPENDENT paths. (Also writes via local decap-server, but
  // since we're already pinned to one browser for screenshots, no
  // separate @admin-write tag needed.) See playwright.config.js.
  { tag: ["@admin-screenshots"] },
  () => {
    // #33 — a base_collections:[] consumer strips the Posts block from
    // config-local.yml, so the first-post walkthrough's index-local Posts
    // editor route never renders. Skip unless posts is kept.
    test.skip(...guard(SITE_ROOT, "manual-walkthrough-first-post.spec.js"));

    // 10-minute envelope — full publish loop with explicit Jekyll rebuild
    // and on-disk polls is slower than a single-leg spec; 600s gives the
    // whole thing room without inviting a runaway.
    test.describe.configure({ mode: "serial", timeout: 600_000 });

    test.beforeAll(() => cleanup());
    test.afterAll(() => {
      cleanup();
      // Rebuild Jekyll on the way out so the next spec/run sees a clean
      // `_site/` (no orphan rendered post under /blog/<slug>/). This also
      // exercises the same path the cleanup branch uses in production
      // when a real editor deletes a post.
      try {
        jekyllBuild();
      } catch (_) {
        // Cleanup-best-effort — don't mask the test result with a
        // post-run rebuild error.
      }
    });

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
      // Decap CMS uses native window.confirm() for delete and unpublish
      // confirmations; without a persistent listener, Playwright's
      // default behavior auto-dismisses the dialog and Decap reads it
      // as "user cancelled." Defensive in case the walkthrough ever
      // exercises a destructive action — see AGENTS.md "Test-Driven
      // Design" section.
      page.on("dialog", (d) => d.accept());
    });

    test("brand-new contributor: create → fill → image → save → publish → verify", async ({
      page,
    }) => {
      // ── Step 1: Open admin and Login ────────────────────────────────
      // decap-server doesn't actually authenticate — the Login button is
      // there because the Decap UI demands one. We click it to drive
      // through the same affordance a real contributor would meet.
      await measure("01-open-admin-and-login", PER_STEP_BUDGET_MS, async () => {
        await page.goto("/admin/index-local.html");
        const loginBtn = page.getByRole("button", { name: /login/i });
        await expect(loginBtn).toBeVisible({ timeout: 60_000 });
        await loginBtn.click();
        await page.getByRole("link", { name: /^posts$/i }).waitFor({ timeout: 30_000 });
        await captureStep(page, {
          section: "First post walkthrough",
          step: "C3.1",
          title: "Sign in to the admin",
          body: "Open `/admin/`. The Decap login screen shows a single button. On production this hands off to GitHub OAuth; locally (here) `decap-server` skips auth so the test can drive the next steps directly.",
        });
      });

      // ── Step 2: Navigate to Posts → New Post ────────────────────────
      await measure("02-navigate-new-post", PER_STEP_BUDGET_MS, async () => {
        await page.goto("/admin/index-local.html#/collections/posts/new");
        const titleField = page.getByLabel(/^Title$/);
        await expect(titleField).toBeVisible({ timeout: 60_000 });
        await captureStep(page, {
          section: "First post walkthrough",
          step: "C3.2",
          title: "Open the New Post form",
          body: "Click **Posts** in the left sidebar, then **New Post**. The form mounts with empty fields for Title, URL Slug, Date, Excerpt, Body, Tags, Featured Image, Published, and Publish Date.",
        });
      });

      // ── Step 3: Fill title, slug, body ──────────────────────────────
      await measure("03-fill-title-slug-body", PER_STEP_BUDGET_MS, async () => {
        const titleField = page.getByLabel(/^Title$/);
        await titleField.fill(SMOKE_TITLE);

        // Explicit slug so the post lands at a predictable URL — the
        // auto-derive can drift between Decap versions.
        const slugField = page.getByLabel(/^URL Slug/);
        await slugField.fill(SMOKE_SLUG);

        // Decap's markdown widget defaults to rich-text mode. The
        // contentEditable surface accepts plain typed text, which is
        // what a contributor would see when they start typing into the
        // empty body field.
        const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
        await bodyEditor.waitFor({ timeout: 30_000 });
        await bodyEditor.click();
        await bodyEditor.fill(SMOKE_BODY);

        await captureStep(page, {
          section: "First post walkthrough",
          step: "C3.3",
          title: "Fill in the post fields",
          body: "Type a Title (the page heading), set a URL Slug (the path under `/blog/`), and write the Body. The slug is the only field with a constraint — keep it lowercase + hyphens so the public URL stays clean.",
        });
      });

      // ── Step 4: Add featured image ──────────────────────────────────
      // Click the "Choose Image" button on the Featured Image widget,
      // then drive Decap's hidden <input type="file"> directly via
      // setInputFiles (Playwright accepts that on inputs even when
      // they're not visible). Decap watches the input's `change` event
      // and runs the same upload + select pipeline as a real picker
      // click.
      await measure("04-add-featured-image", PER_STEP_BUDGET_MS, async () => {
        await page
          .getByRole("button", { name: /choose (an )?image/i })
          .first()
          .click();
        const fileInput = page.locator('input[type="file"][accept*="image"]').first();
        await fileInput.waitFor({ state: "attached", timeout: 30_000 });
        await fileInput.setInputFiles(FIXTURE_PNG);
        // Library's confirm button label varies between Decap versions
        // ("Choose selected" in 3.x, "Insert" historically). Match either.
        const insertBtn = page.getByRole("button", { name: /^(choose selected|insert)$/i }).first();
        await expect(insertBtn).toBeVisible({ timeout: 30_000 });
        await insertBtn.click();
        await captureStep(page, {
          section: "First post walkthrough",
          step: "C3.4",
          title: "Attach a Featured Image",
          body: "Click **Choose Image** on the Featured Image widget. The media library opens; either pick an existing upload or use the **Upload** control to add a new one. After choosing, the path lands in the field's text and a thumbnail renders below it.",
        });
      });

      // ── Step 5: Save ────────────────────────────────────────────────
      // On local backend, simple mode forces the toolbar's primary
      // action to be Publish (not Save → Status). We flip Published =
      // ON first so Jekyll picks the post up in the rebuild, then go
      // through the split publish menu — same shape as
      // `cms-publish-flow.spec.js`.
      await measure("05-save-and-publish", PER_STEP_BUDGET_MS, async () => {
        const publishedToggle = page.getByLabel(/^Published$/).first();
        await publishedToggle.click();
        await page
          .getByRole("button", { name: /^publish$/i })
          .first()
          .click();
        await captureStep(page, {
          section: "First post walkthrough",
          step: "C3.5",
          title: "Save (and Mark Ready)",
          body: "Hit **Save**. On production (`publish_mode: editorial_workflow`), Save commits to a `cms/posts/<slug>` branch and opens a PR with the `cms/draft` label. Switch the Status dropdown to **Ready** to flip the label to `cms/ready`, which is what triggers the auto-merge pipeline. Locally (here) the toolbar collapses Save+Ready+Publish into a single Publish menu since there is no PR to label.",
        });
        await page
          .getByRole("menuitem", { name: /publish now/i })
          .first()
          .click();
      });

      // ── Step 6: Wait for the file to land in `_posts/` ─────────────
      // Polls `fs.existsSync` rather than relying on a Decap UI signal,
      // because the Decap toast can appear before the file write
      // completes (decap-server-side race).
      await measure("06-wait-for-post-file", COMMIT_POLL_BUDGET_MS, async () => {
        await expect.poll(() => findSmokePostFile() !== null, { timeout: 60_000 }).toBe(true);
        const written = fs.readFileSync(findSmokePostFile(), "utf8");
        expect(written, "front matter delimiter").toMatch(/^---/);
        expect(written).toContain(`title: ${SMOKE_TITLE}`);
        expect(written).toContain(`slug: ${SMOKE_SLUG}`);
        expect(written).toContain("published: true");
        expect(
          written,
          "front matter must reference the uploaded image directly in /assets/images/uploads/ (no subdirectory)",
        ).toMatch(/featured_image:\s*['"]?\/assets\/images\/uploads\/[^/\s'"]+\.\w+/);
      });

      // ── Step 7: Trigger Jekyll rebuild explicitly ───────────────────
      // CRITICAL: do NOT rely on `--watch` to be fast enough between
      // Decap's save and the next fetch. Earlier B7/B8 specs flaked
      // exactly here. The synchronous `bundle exec jekyll build` is the
      // path-of-least-regression — it returns when `_site/` is current.
      await measure("07-jekyll-rebuild", JEKYLL_REBUILD_BUDGET_MS, async () => {
        jekyllBuild();
      });

      // ── Step 8: Fetch /blog/<slug>/ and assert 200 ─────────────────
      // The webServer serves `_site/` directly, so a fresh build means
      // the post is now reachable at its public URL.
      await measure("08-fetch-public-url", PER_STEP_BUDGET_MS, async () => {
        const liveURL = `/blog/${SMOKE_SLUG}/`;
        const resp = await page.goto(liveURL);
        expect(resp.status(), `${liveURL} should be 200`).toBe(200);
        await captureStep(page, {
          section: "First post walkthrough",
          step: "C3.6",
          title: "View the published post live",
          body: "After Save settles, the post is reachable at `/blog/<slug>/`. On production this happens once `deploy-production.yml` finishes its `aws s3 sync` and CloudFront invalidation, typically within ~2 minutes of the merge.",
        });
      });

      // ── Step 9: Assert the featured image rendered ─────────────────
      // The post layout (`_layouts/post.html`) renders
      // `<img class="featured-image" ...>` inside the .post-header when
      // `page.featured_image` is non-empty. If the front matter wrote
      // the wrong path or the layout regressed, this fails clearly.
      await measure("09-assert-featured-image", PER_STEP_BUDGET_MS, async () => {
        const img = page.locator(".post-header img.featured-image");
        await expect(img, "Rendered post must include the featured-image <img>").toBeVisible({
          timeout: 10_000,
        });
        const imgSrc = await img.getAttribute("src");
        expect(
          imgSrc,
          "featured-image src must point directly under /assets/images/uploads/ (no subdirectory)",
        ).toMatch(/\/assets\/images\/uploads\/[^/]*tiny-pixel[^/]*\.png$/i);
        // Prove the src actually resolves — the flat media_folder means
        // this local run writes the identical path production would, so
        // a 404 here is a real broken-image regression.
        const imgAbs = new URL(imgSrc, page.url()).toString();
        const imgResp = await page.request.get(imgAbs);
        expect(imgResp.status(), `Featured image ${imgAbs} must resolve 200`).toBe(200);
        await expect(page.locator(".post-header h1")).toHaveText(SMOKE_TITLE);
        await expect(page.locator(".post-content")).toContainText(SMOKE_BODY);
        await captureStep(page, {
          section: "First post walkthrough",
          step: "C3.7",
          title: "Featured image renders on the live post",
          body: 'The post layout renders `<img class="featured-image">` inside the `.post-header` block when `featured_image` is set. On production the same `<img>` resolves through CloudFront → S3, so the contributor sees the image they uploaded without any further action.',
        });
      });

      // Final timing summary — surface the full timeline as a console
      // breadcrumb so a slow run leaves a trail even when nothing failed.
      const timeline = stepTimings
        .map((s) => `  ${s.label}: ${s.elapsed}ms (budget ${s.budgetMs}ms)`)
        .join("\n");
      console.log(`First-post walkthrough timing:\n${timeline}`);
    });
  },
);
