// @lane: real — uploads a real image + creates/deletes an ephemeral prod _posts/ entry through Decap → GitHub
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — CMS_E2E_PAT and the RUN_* gate aren't wired into the
// standard PR matrix — so selecting it just to no-op is pure waste.
// The dedicated cms-media-roundtrip.yml workflow runs it.

/*
 * Real-browser, real-HTTP, real-GitHub, real-production-deploy
 * end-to-end test for the FULL media lifecycle, driven entirely through
 * the Decap UI — now against an EPHEMERAL, born-published, hard-deleted
 * per-run post (#1771 step 4) instead of a persistent committed fixture:
 *
 *   1. Create a born-published ephemeral `_posts/` entry via the "+ New
 *      Post" UI, uploading a unique image via the Media UI (the Featured
 *      Image widget's media library) and attaching it.
 *   2. Save → cms PR → label cms/ready → auto-merge + deploy-production.
 *   3. Assert the post page on https://adamdaniel.ai renders the image
 *      AND that the image URL itself fetches 200 with real bytes. (This is
 *      the exact bug the flat-media-folder change fixes: a post
 *      referencing an image URL that 404s.)
 *   4. DELETE the post via the Decap UI → cms PR → cms/ready → auto-merge.
 *   5. Delete the uploaded asset via the standalone Media UI.
 *   6. Assert the post 404s and the image's live URL 404s.
 *
 * Why ephemeral (the #1771 redesign): the persistent fixture
 * (`_posts/2099-01-03-e2e-media-roundtrip.md`) shared the same
 * self-perpetuating-corruption bug as the prod-mutate twin — a transient
 * failure on the in-place revert left a corrupt shared cell on main, and
 * the next run re-derived its baseline from it. Step 4 removes the class:
 * each run creates a uniquely-pathed post + a uniquely-named image, and
 * deletes both. Resting state is ABSENCE (404). A killed run leaks at most
 * ONE inert orphan post (`_posts/2099-12-31-e2e-media-roundtrip-<runId>.md`)
 * + ONE orphan upload, both swept by sweep-stale-cms-prs.yml — never a
 * corrupt shared baseline. No loop reads a path it also writes.
 *
 * The CREATE leg publishes through Decap's editor (Status → Ready →
 * Publish → "Publish now"), exactly like the proven
 * cms-delete-published.spec.js. The merge lands via cms-editorial-workflow
 * `auto-merge-when-ready`: Status:Ready applies `decap-cms/pending_publish`
 * (engages auto-merge), and Publish Now's synchronous merge is 422'd by
 * branch protection while required checks are pending — admin/publish-via-
 * auto-merge.js catches that 422 and adds the `cms/ready` label, re-
 * engaging the SAME auto-merge job. The PR lands once checks pass. This is
 * the proven prod path (cms-delete-published.spec.js's green host-loop runs
 * land their merge exactly this way). The explicit `cms/ready` labelling of
 * the create + delete PRs is kept belt-and-braces (idempotent).
 *
 * The DELETE leg is the #1771 iteration-3 fix. Publish Now alone is NOT
 * enough to make the UI delete remove the file from main: the shim hands
 * Decap a SYNTHETIC `merged:true` while the create PR auto-merges for real
 * only ~5–15 min later, so the `cms/posts/<slug>` editorial branch lingers.
 * If the delete leg re-opens the entry during that window, Decap's
 * loadUnpublishedEntry re-loads it as an OPEN editorial draft → the editor
 * shows "Delete unpublished entry" → the click drops only the draft branch,
 * never main, so the URL never 404s (run 26529125192's exact failure: post
 * + image live, delete leg idle, NO delete PR opened). The fix: the delete
 * leg first waits for the create PR to MERGE for real, then
 * reopenForPublishedDelete() poll-reloads the editor until Decap drops the
 * (now-merged) editorial entry and re-loads the published file ("Delete
 * published entry", no Status chip), and only THEN clicks delete — so the
 * click hits onDelete (delete from main → a delete PR). See
 * e2e/cms-editor-ui.js's reopenForPublishedDelete for the full analysis.
 * The editor UI is fully driven throughout.
 *
 * Why this exists on top of the local upload specs: the local specs prove
 * the flat media_folder resolves on a local Jekyll build. This spec proves
 * it on the REAL production site through the REAL GitHub backend and the
 * REAL deploy pipeline, including the standalone Media library's delete
 * path. The Contents-API afterAll safety net is test-harness HYGIENE
 * (existence-only delete of a leftover post/upload), not the behaviour
 * under test — see AGENTS.md's harness-hygiene carve-out.
 *
 * Gating:
 *   - `CMS_E2E_PAT` must be set.
 *   - `RUN_PROD_MUTATE_PLAYGROUND=1` (same gate as the prod-mutate spec)
 *     so it only runs in cms-media-roundtrip.yml and never inside the
 *     per-PR e2e matrix or recursively on its own cms/* PR.
 *   - chromium-desktop-3k only.
 *
 * IMPORTANT: do NOT run this spec locally against prod. It mutates the
 * real production tree (a _posts/ entry + an upload). The workflow runs
 * it on a schedule.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const { closeStaleDecapPrOnBranch, removeFixtureViaPr } = require("./cms-fixture-pr");
const {
  addLabel,
  gh,
  getPullRequest,
  waitForCmsPullRequest,
  waitForMerge,
  makeDeployQueueExtender,
} = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const { resolveCmsTarget } = require("./cms-host");
const { loudBail } = require("./fixture-baseline");
const {
  setPublished,
  saveEntry,
  publishViaUi,
  clickEditorDelete,
  confirmEditorDelete,
  reopenForPublishedDelete,
  openMediaLibrary,
  closeMediaLibrary,
} = require("./cms-editor-ui");
const { EPHEMERAL_DATE, buildMediaRoundtripPost } = require("./prod-mutate-fixture");

// Parameterized target: CMS_TARGET=preview (+ PR_NUMBER) drives the PR's
// preview-pr<N> surface; anything else keeps the prod default, so the
// existing prod workflow is behaviour-preserving with no new env. The
// local names stay PROD_* to keep this large spec's diff minimal — the
// *value* is whatever resolveCmsTarget() picks (prod or preview).
const { host: PROD_HOST, adminUrl: PROD_ADMIN, pillId: PILL_PROD } = resolveCmsTarget();

// Source bytes for the upload. Re-uploaded under a per-run unique name so
// the 404-after-delete assertion is unambiguous and looping runs can't
// collide on the same asset.
const SOURCE_FIXTURE_PNG = path.join(__dirname, "fixtures", "tiny-pixel.png");
const UPLOADS_DIR = "assets/images/uploads";

// Read-only daily probe gate (set in canary-prod.yml). The afterAll
// safety net consults this so the probe never tries to write to main.
const PROD_CANARY = process.env.PROD_CANARY === "1";

// #1815 — the URL-reflect budget per deploy leg. RAISED 15 → 30 min so the
// INITIAL wait alone spans the full real-prod auto-merge latency BEFORE the
// deploy-queue extender can mistake "merge still pending, nothing deploying
// yet" for "chain never fired". LIVE EVIDENCE: a real media-roundtrip run
// timed out at ~907s/15min reporting "NO deploy-production run fired" while
// the canary auto-merge was simply slow (it DID merge + deploy ~minutes
// later). Now matches the 30-min waitForMerge budget below, so the reflect
// window can absorb the same ~30-min auto-merge latency waitForMerge tolerates.
// Mirrors the cms-publish-loop-prod-mutate.spec.js reflect/merge budgets
// (locked >= by cms-loop-budget-alignment.test.js).
const REFLECT_TIMEOUT_MS = 30 * 60 * 1000;
// The create PR's real-prod auto-merge regularly takes 15–30 min under runner
// contention / when the CMS-affecting-paths e2e suite re-runs (#1815).
const MERGE_TIMEOUT_MS = 30 * 60 * 1000;

// One full real-prod loop: create+attach → live, delete post → 404,
// delete image → 404. Three deploy waits at 30 min each (#1815) + the enlarged
// 25-min reopenForPublishedDelete resync budget + the 30-min waitForMerge
// budget (#1815) + setup. Bumped 100 → 130 min so the worst-case sum fits
// without truncating a leg now each reflect leg can span the full auto-merge
// latency; typical happy path is still ~25-30 min. Inside the 150-min job
// timeout (cms-media-roundtrip.yml). Retries disabled — mutates real prod; a
// retry re-runs the same broken chain.
const TEST_TIMEOUT_MS = 130 * 60 * 1000;

test.describe.configure({
  mode: "serial",
  timeout: TEST_TIMEOUT_MS,
  retries: 0,
});

// Module-scoped handle for the afterAll existence-only-delete safety net.
let pendingFixture = null;

async function fileExistsOnMain(filePath) {
  try {
    await gh(`/repos/${HOST_REPO}/contents/${encodeURI(filePath)}?ref=main`);
    return true;
  } catch (e) {
    if (/\b404\b/.test(String(e.message))) return false;
    throw e;
  }
}

// Best-effort: delete a media file from main via the Contents API. Only
// used by the afterAll safety net to remove a per-run upload the UI delete
// leg didn't manage to remove. Never part of the behaviour under test.
async function deleteFileFromMainIfPresent(filePath, message) {
  let current;
  try {
    current = await gh(`/repos/${HOST_REPO}/contents/${encodeURI(filePath)}?ref=main`);
  } catch (e) {
    if (e && e.status === 404) return false; // already gone — good
    throw e;
  }
  await gh(`/repos/${HOST_REPO}/contents/${encodeURI(filePath)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha: current.sha, branch: "main" }),
  });
  return true;
}

test(
  "CMS media round trip — create ephemeral post + upload via Media UI → live → delete post + image → 404",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    // Reuse the prod-mutate gate so this spec only runs in its dedicated
    // workflow and self-skips inside the per-PR e2e matrix and on its own
    // cms/* PR. Plain green "not my workflow" skip, FIRST so a shard-1 PR
    // run exits here before the loud guard below.
    test.skip(
      process.env.RUN_PROD_MUTATE_PLAYGROUND !== "1",
      "RUN_PROD_MUTATE_PLAYGROUND not set — only cms-media-roundtrip.yml runs this spec.",
    );

    // Decap delete (and some confirm) flows use native window.confirm.
    // Register BEFORE any interaction so it's never too late.
    page.on("dialog", (d) => d.accept());

    // ── Hard guard ─────────────────────────────────────────────────
    // The ephemeral design has no committed fixture / `published:`
    // precondition (the post is born fresh each run) — only the PAT.
    if (!getPat()) {
      loudBail(test, "CMS_E2E_PAT not set — media round-trip cannot run.");
      return;
    }

    const runId = Date.now();
    const built = buildMediaRoundtripPost({ runId });
    const { slug, filePath, title, body } = built;
    const publicUrl = `${PROD_HOST}${built.publicPath}`;
    // Decap's posts `slug:` template prepends the date; this is the
    // on-disk file slug (entry deeplink segment / Decap branch).
    const fileSlug = `${EPHEMERAL_DATE}-${slug}`;
    const decapBranch = `cms/posts/${fileSlug}`;

    const imageName = `e2e-media-roundtrip-${runId}.png`;
    const imagePath = `${UPLOADS_DIR}/${imageName}`;
    const imagePublicUrl = `/${imagePath}`;
    const imageUrlAbs = `${PROD_HOST}${imagePublicUrl}`;
    const imageBuffer = fs.readFileSync(SOURCE_FIXTURE_PNG);

    pendingFixture = { runId, slug, filePath, imagePath, imageName };
    test.info().annotations.push({ type: "fixture-path", description: filePath });

    // ── 0. Close any stale Decap PR on the (unique) post branch ──────
    await test.step("Close any stale Decap PR on the post branch", async () => {
      await closeStaleDecapPrOnBranch({ branch: decapBranch });
    });

    // ── 1. Confirm clean pre-state on the live site (unique names) ───
    await test.step("Confirm post 404s and image URL 404s before driving admin", async () => {
      const res = await fetch(publicUrl, { cache: "no-store" });
      expect(res.status, `${publicUrl} must not exist yet (unique per-run name)`).toBe(404);
      const imgRes = await fetch(imageUrlAbs, { cache: "no-store" });
      expect(imgRes.status, `${imageUrlAbs} must not exist yet (unique per-run name)`).toBe(404);
    });

    // ── 2. Load prod admin (PAT-seeded session, no OAuth popup) ──────
    await seedDecapAuth(page);
    await test.step("Load production admin", async () => {
      await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
    });

    // ── 3. Create the born-published ephemeral post via the New Post UI
    await test.step("Open + New Post form (collections/posts/new)", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/posts/new`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Fill Title, URL Slug, Date (2099-12-31), Body", async () => {
      await page.getByRole("textbox", { name: /^Title$/i }).fill(title);
      await page.getByLabel(/^URL Slug/).fill(slug);
      await page.getByLabel(/^Date/).fill(`${EPHEMERAL_DATE}T00:00`);
      const bodyEditor = page.locator('[role="textbox"][contenteditable="true"]').last();
      await bodyEditor.click();
      await bodyEditor.pressSequentially(body.trim());
    });

    // ── 4. Upload via the Media UI + attach to the post ──────────────
    // Click the Featured Image widget's "Choose Image" → Decap opens the
    // SAME MediaLibrary modal the standalone Media page uses → drive its
    // hidden <input type=file> with a per-run-unique filename → confirm
    // the selection back into the field. This is exactly "upload a small
    // image using the media UI, then add the image to a post" with no
    // shortcut.
    await test.step("Upload a unique image via the Media UI and attach it", async () => {
      await page
        .getByRole("button", { name: /choose (an |different )?image/i })
        .first()
        .click();
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await fileInput.waitFor({ state: "attached", timeout: 30_000 });
      await fileInput.setInputFiles({
        name: imageName,
        mimeType: "image/png",
        buffer: imageBuffer,
      });
      const insertBtn = page.getByRole("button", { name: /^(choose selected|insert)$/i }).first();
      await expect(insertBtn).toBeVisible({ timeout: 30_000 });
      await insertBtn.click();
      // The widget must now reflect the upload. Assert it surfaces the
      // unique filename so we know the attach took before we Save.
      await expect
        .poll(async () => (await page.locator("body").innerText()).includes(imageName), {
          timeout: 30_000,
        })
        .toBe(true);
    });

    await test.step("Toggle Published → ON (born live)", async () => {
      await setPublished(page, true, { visibleTimeout: 15_000 });
    });

    await test.step("Save (opens cms/... PR)", async () => {
      await saveEntry(page);
    });

    await test.step("Status:Ready → Publish Now (transitions Decap to PUBLISHED, engages auto-merge)", async () => {
      // publishViaUi (shared, #1723) drives Status:Draft → Ready then
      // Publish → "Publish now" — the proven create-leg flow from
      // cms-delete-published.spec.js. Required so the editor reaches the
      // PUBLISHED state and the later delete leg surfaces "Delete published
      // entry" (delete-from-main), not "Delete unpublished entry" (draft
      // branch only, never 404s). Merge lands via auto-merge-when-ready
      // (Status:Ready → decap-cms/pending_publish; Publish Now's 422 →
      // admin/publish-via-auto-merge.js adds cms/ready). cms/ready is also
      // labelled explicitly below, belt-and-braces.
      await publishViaUi(page);
    });

    // ── 5. Find the create cms/... PR, label cms/ready ───────────────
    // Belt-and-braces explicit label: the Publish-Now shim already adds
    // cms/ready on its 422 recovery and Status:Ready applies
    // decap-cms/pending_publish; this guarantees auto-merge-when-ready is
    // engaged even if the shim's recovery is delayed. addLabel is
    // idempotent.
    let createPrNumber = null;
    await test.step("Wait for Decap to open the create cms/... PR, label cms/ready", async () => {
      // The .md diff contains `featured_image:
      // /assets/images/uploads/<imageName>` AND the dated slug — match on
      // the image name (unique per run).
      const pr = await waitForCmsPullRequest({
        base: "main",
        filePath,
        canaryMarker: imageName,
        timeoutMs: 5 * 60 * 1000,
      });
      expect(pr.number, "Decap create PR number").toBeGreaterThan(0);
      createPrNumber = pr.number;
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });

    // ── 6. Wait until the image is LIVE on adamdaniel.ai ─────────────
    // STAY on the entry editor (the deploy-status pill mounts there).
    await test.step("Wait for the post to render the image on adamdaniel.ai", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, { failOnStatusCode: false });
          if (res.status() !== 200) return false;
          return (await res.text()).includes(imagePublicUrl);
        },
        urlTimeoutMs: REFLECT_TIMEOUT_MS,
        // #21: anchor the deploy-lane judgment on THIS run's own deploy.
        // `getMergedAt` lazily fetches the create PR's merged_at (the merge
        // lands DURING this wait via auto-merge); a completed
        // deploy-production run created at/after it ⇒ the deploy fired +
        // finished and the failure is URL-not-served (S3/CloudFront), NOT a
        // chain miss — the error message self-reports which leg broke.
        onBudgetExhausted: makeDeployQueueExtender({
          getMergedAt: async () => {
            const pr = await getPullRequest({ prNumber: createPrNumber });
            return pr && pr.merged_at;
          },
        }),
      });
    });

    // ── 7. The image URL itself must resolve 200 with real bytes ─────
    // THE assertion the whole flat-media-folder fix exists for: the URL
    // the post references must actually serve the image, not 404.
    await test.step("Fetch the image URL on the live site — must be 200 with bytes", async () => {
      const res = await page.request.get(imageUrlAbs, { failOnStatusCode: false });
      expect(
        res.status(),
        `${imageUrlAbs} must resolve 200 on the live site (broken-image regression guard)`,
      ).toBe(200);
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      expect(ct, `unexpected content-type for ${imageUrlAbs}`).toContain("image");
      expect(
        (await res.body()).length,
        "live image response must have non-empty bytes",
      ).toBeGreaterThan(0);
    });

    // ── 8. Delete the post via the Decap UI ──────────────────────────
    //
    // CRITICAL ORDERING (#1771 follow-up, iteration-3 root cause —
    // run 26529125192): the delete leg MUST NOT fire until the create PR
    // has truly MERGED and its `cms/posts/<slug>` editorial branch is
    // gone. In editorial_workflow mode Decap overrides
    // loadEntry → loadUnpublishedEntry (withWorkflow.js); while the create
    // branch still exists (between the publish-via-auto-merge shim's
    // synthetic `merged:true` and the REAL auto-merge ~5–15 min later),
    // re-navigating to the entry re-loads it as an OPEN editorial draft.
    // The editor then shows "Status: Draft" + "Delete unpublished entry",
    // and a Delete click calls onDeleteUnpublishedChanges — dropping only
    // the draft branch, never main. The post keeps serving, no
    // delete-from-main PR opens, and the 404-wait times out (exactly the
    // observed failure: post + image live, delete leg idle, NO delete PR).
    //
    // Gate on the create PR's real merge first; then re-open the editor
    // and poll-reload until Decap loads the now-published entry (no
    // editorial branch ⇒ no Status chip ⇒ "Delete published entry").
    await test.step("Wait for the create PR to actually merge (not just the synthetic Publish-Now ack)", async () => {
      // The Publish-Now shim returns a synthetic merged:true to Decap, but
      // the PR lands for real only once required checks pass + auto-merge
      // fires. The post + image already served above (deploy runs only
      // post-merge), so the merge is usually done; this confirms it
      // deterministically and is what lets the delete leg open a
      // delete-FROM-MAIN change rather than dropping the draft branch.
      // 30-min budget (was 10): real prod create PRs regularly take
      // 15-30 min to auto-merge under runner contention or when the CMS
      // editorial-workflow concurrency cancels intermediate validate-content
      // runs and the SUCCESS only lands on the final reattempt (#1815).
      // The serve gates above hint the deploy completed, but the PR
      // object can still lag flipping `merged:true`; this absorbs that
      // without failing a healthy run.
      expect(createPrNumber, "create PR number captured for merge wait").toBeTruthy();
      await waitForMerge({ prNumber: createPrNumber, timeoutMs: MERGE_TIMEOUT_MS });
    });

    await test.step("Re-open the post in PUBLISHED state for the delete leg", async () => {
      // Poll-reloads the editor until the editorial Status chip is gone
      // and "Delete published entry" is present — i.e. Decap has dropped
      // the (now-merged) editorial entry and re-loaded the published file.
      // Only in that state does the Delete click remove the file from main.
      // Pass the spec's fileExistsOnMain as a Contents-API cross-check so a
      // timeout's error message can tell "Decap is slow" from "merge never
      // landed" (#1815). adminUrl enables the navigate-away-and-back
      // fallback inside the helper.
      await reopenForPublishedDelete(page, `${PROD_ADMIN}#/collections/posts/entries/${fileSlug}`, {
        crossCheck: () => fileExistsOnMain(filePath),
        adminUrl: PROD_ADMIN,
      });
    });

    await test.step("Click the editor's Delete button → opens delete-from-main cms/... PR", async () => {
      // confirmEditorDelete arms a POST /git/trees watcher BEFORE the click
      // and AWAITS it as positive proof Decap dispatched the delete — a
      // silent no-op now throws HERE instead of 900s later in the URL-404
      // wait (#1815 delete-phase, run 26994473112). It also installs the
      // native-confirm auto-accept + the forward-compat in-app modal-confirm
      // fallback, so no inline confirm click is needed.
      await confirmEditorDelete(page, () => clickEditorDelete(page));
    });

    // ── 9. Label the post-delete PR cms/ready if Decap opened one ────
    // Decap may commit the delete directly to main via the git data API
    // OR open a cms/* PR. Handle both: label a PR that removes this file,
    // else the direct commit already triggered deploy-production.
    await test.step("Label the post-delete cms/... PR cms/ready if Decap opened one", async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        let prs = [];
        try {
          prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=50`);
        } catch (_) {
          /* transient — retry */
        }
        const cmsPrs = (prs || []).filter(
          (pr) => pr.head && typeof pr.head.ref === "string" && pr.head.ref.startsWith("cms/"),
        );
        let labelled = false;
        for (const pr of cmsPrs) {
          let files;
          try {
            files = await gh(`/repos/${HOST_REPO}/pulls/${pr.number}/files?per_page=100`);
          } catch (_) {
            continue;
          }
          const removesPost = files.some((f) => f.filename === filePath && f.status === "removed");
          if (removesPost) {
            try {
              await addLabel({ prNumber: pr.number, label: "cms/ready" });
            } catch (e) {
              console.warn(`[media-delete] could not label PR #${pr.number}: ${e && e.message}`);
            }
            labelled = true;
            break;
          }
        }
        if (labelled) break;
        await new Promise((r) => setTimeout(r, 6000));
      }
    });

    await test.step("Wait for the post to stop serving (4xx)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, { failOnStatusCode: false });
          const s = res.status();
          return s >= 400 && s < 500;
        },
        urlTimeoutMs: REFLECT_TIMEOUT_MS,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // ── 10. Delete the uploaded asset via the global Media library UI ─
    await test.step("Delete the image via the Media library modal", async () => {
      // Decap's global media library is a MODAL opened from the top-nav
      // "Media" button — it is NOT a page route. The earlier
      // `page.goto(`${PROD_ADMIN}#/media`)` rendered Decap's NotFound
      // ("Not Found") every time, because Decap registers no `/media`
      // route (the standalone media page does not exist in this 3.14.1
      // setup); the library only opens as an overlay (runs 26597250490 /
      // 26602619236, both screenshots: nav present + "Not Found" body).
      //
      // Bounce through admin root for a clean nav (the post-delete leg
      // left the page on a deep entry route), then CLICK "Media" to open
      // the library overlay and wait for its header. Proven pattern:
      // e2e/admin-no-occlusion.spec.js's media-library modal test.
      await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({
        timeout: 60_000,
      });
      // openMediaLibrary (shared, cms-editor-ui.js) clicks the top-nav
      // "Media" button and waits for the library header — the supported
      // way to reach the global library (there is no `#/media` route).
      await openMediaLibrary(page);
      const card = page.getByText(imageName, { exact: false }).first();
      await expect(
        card,
        `uploaded asset ${imageName} must be visible in the Media library`,
      ).toBeVisible({ timeout: 30_000 });
      await card.click();
      const deleteBtn = page.getByRole("button", { name: /^delete( selected)?$/i }).first();
      await expect(
        deleteBtn,
        "Media library must expose a Delete control for the selected asset",
      ).toBeVisible({ timeout: 30_000 });
      await deleteBtn.click();
      await expect
        .poll(async () => (await page.locator("body").innerText()).includes(imageName), {
          timeout: 30_000,
        })
        .toBe(false);
      // Close the overlay before the next step navigates: Decap's media
      // modal is a Redux-state overlay, not route-bound, so a later
      // page.goto won't dismiss it and the Posts-list nav wait would
      // 60s-time-out behind it (#1815, run 26604334850).
      await closeMediaLibrary(page);
    });

    // ── 11. Drive the image delete through to the live site ──────────
    // Decap's GitHub backend may commit the media delete directly to main
    // OR open a cms/* PR. If a cms/* PR appears whose diff removes the
    // image file, label it cms/ready so auto-merge fires; otherwise the
    // direct commit already triggered deploy-production. Ground truth is
    // the live image URL going 404.
    await test.step("Label the media-delete PR cms/ready if Decap opened one", async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        let prs = [];
        try {
          prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=50`);
        } catch (_) {
          /* transient — retry */
        }
        const cmsPrs = (prs || []).filter(
          (pr) => pr.head && typeof pr.head.ref === "string" && pr.head.ref.startsWith("cms/"),
        );
        let labelled = false;
        for (const pr of cmsPrs) {
          let files;
          try {
            files = await gh(`/repos/${HOST_REPO}/pulls/${pr.number}/files?per_page=100`);
          } catch (_) {
            continue;
          }
          const removesImage = files.some(
            (f) => f.filename === imagePath && f.status === "removed",
          );
          if (removesImage) {
            try {
              await addLabel({ prNumber: pr.number, label: "cms/ready" });
            } catch (e) {
              console.warn(`[media-delete] could not label PR #${pr.number}: ${e && e.message}`);
            }
            labelled = true;
            break;
          }
        }
        if (labelled) break;
        await new Promise((r) => setTimeout(r, 6000));
      }
      // Not finding a PR is fine — Decap committed the delete straight to main.
    });

    await test.step("Wait for the image URL to 404 on adamdaniel.ai", async () => {
      // Back to a stable pill-mount route. The deleted post's editor is
      // gone; the /media route has no pill, so navigate to the Posts list.
      // Reload after the hash-nav: belt-and-braces so any lingering media
      // overlay is cleared and the posts list remounts cleanly before we
      // wait on its nav link (#1815).
      await page.goto(`${PROD_ADMIN}#/collections/posts`, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: /^Posts$/i })).toBeVisible({ timeout: 60_000 });
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(imageUrlAbs, { failOnStatusCode: false });
          return res.status() === 404;
        },
        urlTimeoutMs: REFLECT_TIMEOUT_MS,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    // ── 12. Final ground-truth assertions ────────────────────────────
    await test.step("Assert image URL 404s and post 4xx (final)", async () => {
      const imgRes = await fetch(imageUrlAbs, { cache: "no-store" });
      expect(imgRes.status, `${imageUrlAbs} must 404 after the Media-UI delete`).toBe(404);
      const postRes = await fetch(publicUrl, { cache: "no-store" });
      expect(
        postRes.status >= 400 && postRes.status < 500,
        `${publicUrl} must 4xx after delete`,
      ).toBe(true);
    });
  },
);

// ── Test-harness cleanup safety net — existence-only DELETE ───────────
// #1771 step 4: existence-only delete, NOT a content restore. The forward
// DELETE legs ARE the cleanup. If the test completed, the post + upload
// are gone and the harness no-ops. If the test threw mid-flow, remove a
// leftover ephemeral post (via a labelled removal PR — same auto-merge
// path) and any leftover per-run upload (direct Contents-API delete). A
// failure here leaks at most ONE inert post + ONE upload the daily sweeper
// reaps — never a corrupt shared baseline. Per AGENTS.md's harness-hygiene
// carve-out, this API path is cleanup, not the behaviour under test.
test.afterAll(async () => {
  if (PROD_CANARY) return;
  if (!getPat()) return;
  if (process.env.RUN_PROD_MUTATE_PLAYGROUND !== "1") return;
  if (!pendingFixture) return; // test never ran (skipped)

  // Bump the hook timeout off Playwright's 30s default. This safety net
  // reads main + opens a labelled removal PR + deletes a leftover upload
  // via the GitHub API; 30s is too tight under runner contention even
  // with skipWaitForMerge below. 2 min covers the worst case without the
  // hook ever blocking on the 25-min waitForMerge (the failure mode the
  // ephemeral prod-mutate twin's afterAll hit).
  test.setTimeout(2 * 60 * 1000);

  const { filePath, slug, runId, imagePath } = pendingFixture;

  // Leftover ephemeral post → labelled removal PR.
  const postStillThere = await fileExistsOnMain(filePath).catch(() => false);
  if (postStillThere) {
    console.warn(
      `[cleanup-harness] ${filePath} still on main; opening removal PR (existence-only delete, #1771 step 4)`,
    );
    try {
      await removeFixtureViaPr({
        slug,
        runId,
        filePath,
        message: `test(media-roundtrip): cleanup leftover ephemeral post run ${runId}`,
        prTitle: `test(media-roundtrip): cleanup leftover ephemeral post run ${runId}`,
        prBody:
          "Existence-only cleanup PR opened by `cms-media-roundtrip.spec.js` after a test " +
          "failure left the throw-away ephemeral post on main. Auto-merges via `cms/ready` " +
          "(#1771 step 4 — resting state is absence/404).",
        // Fire-and-forget: open + label the removal PR, then return. The
        // editorial-workflow auto-merges it in the background; the daily
        // sweep reaps any orphan. Without this the 25-min waitForMerge
        // blew the (now 2-min) hook timeout.
        skipWaitForMerge: true,
      });
      console.warn(`[cleanup-harness] removed ${filePath} via removal PR`);
    } catch (e) {
      console.warn(`[cleanup-harness] could not remove ${filePath}: ${e && e.message}`);
    }
  } else {
    console.log(
      `[cleanup-harness] ${filePath} gone from main; UI delete succeeded — no safety net needed`,
    );
  }

  // Leftover per-run upload → direct Contents-API delete (the name is
  // unique to this run so this can't touch real media).
  try {
    await deleteFileFromMainIfPresent(
      imagePath,
      `test(media-roundtrip): harness safety-net delete of leftover upload ${path.basename(imagePath)}`,
    );
  } catch (e) {
    console.warn(`[cleanup-harness] couldn't remove ${imagePath}: ${e && e.message}`);
  }
});
