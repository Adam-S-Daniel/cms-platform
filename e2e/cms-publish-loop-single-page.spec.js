// @lane: real — creates, edits and deletes real content on a single-page site's prod repo through Decap → GitHub
// @select-skip-when-head-ref-prefix: cms/
//
// On `cms/*` PRs (Decap-opened editorial PRs) this spec self-skips at
// runtime — CMS_E2E_PAT and the RUN_* gate aren't wired into the standard PR
// matrix — so selecting it just to no-op is pure waste. The host publish loop
// (cms-publish-loop-host.yml) runs it.

/*
 * Real publish loop for a SINGLE-PAGE site (#1068).
 *
 * A single-page consumer (`cms.base_collections: []`, jodidaniel.com) has no
 * `posts` collection and no `e2e` canaries, so every other real publish loop
 * self-skips there; since `summarize-playwright.js --require-ran` a loop that
 * ran nothing fails. This spec publishes through the site's OWN collections,
 * driving the real Decap editor each time:
 *
 *   Leg A — a `media` FOLDER collection entry (one file per item):
 *     1. Create an item through "+ New" (plain-ASCII title "E2E publish loop
 *        <runId>", a real `date_display`, category, source, an https
 *        article_url, weight), stamped `test_fixture: true` by a Decap
 *        `preSave` listener (the collection has no widget for it).
 *     2. Save → Status:Ready → Publish now → cms PR → auto-merge → deploy.
 *     3. Assert /media/<slug>/ serves 200 and, while the site's go-live gate
 *        (`site_live` in _data/settings.yml) is false, shows NONE of the
 *        item's own copy: the page is the coming-soon shell.
 *     4. Wait for the create PR to merge for real, re-open the entry as a
 *        published entry, Delete → cms PR → auto-merge → deploy.
 *     5. Assert /media/<slug>/ 404s.
 *
 *   Leg B — one field of one `_data/*.yml` FILE collection entry
 *   (the Contact section's heading; a file entry cannot be created or deleted):
 *     1. Edit the heading through the editor, Save → Ready → Publish now.
 *     2. Wait for the PR to merge, assert the merged file carries the edit,
 *        and wait for the deploy of the merge commit to succeed.
 *     3. Re-open the entry as a published entry, type the ORIGINAL heading
 *        back, publish again, wait for the merge, assert the heading is back
 *        and wait for that deploy.
 *
 * Resting state is nothing left behind: no `_media/` item, the contact heading
 * as it was, no open PR, no `cms/` branch. Decap re-serializes a data file it
 * saves, so the restore is judged on the parsed data (single-page-loop-
 * fixture.js sameData / readDataField), never on bytes.
 *
 * What the spec asserts through the API is read-only observation of merged
 * state (the file on main, a PR's merge, a workflow run's conclusion). Every
 * write to the site goes through the editor UI. The afterAll safety net is the
 * one API writer: harness hygiene for a run that died mid-flow (a removal PR
 * for a leftover item, a restore PR for a leftover edit), like
 * cms-publish-loop-prod-mutate.spec.js's.
 *
 * Gating:
 *   - `RUN_HOST_REPO_PUBLISH_LOOP=1` (only cms-publish-loop-host.yml sets it).
 *   - The site must be single-page (`cms.base_collections: []`); a site that
 *     keeps `posts` has the other loops and skips here.
 *   - `CMS_E2E_PAT` must be set.
 *   - `chromium-desktop-3k` only.
 *
 * IMPORTANT: do NOT run this spec locally against a live site. It mutates the
 * real production tree. The workflow runs it daily.
 */
const path = require("node:path");
const cap = require("./site-capabilities");
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");
const { test, expect } = require("./base");
const { seedDecapAuth, getPat, HOST_REPO } = require("./decap-pat");
const {
  closeOpenPrsAddingFile,
  readFileOnRef,
  removeFixtureViaPr,
  seedFixtureViaPr,
} = require("./cms-fixture-pr");
const {
  addLabel,
  gh,
  getFileTextAtRef,
  getPullRequest,
  waitForCmsPullRequest,
  waitForMerge,
  waitForWorkflowRun,
  makeDeployQueueExtender,
  describeError,
} = require("./github-actions-poll");
const { waitForChangeReflected } = require("./deploy-pill");
const {
  chooseSelectOption,
  saveEntry,
  publishViaUi,
  markEphemeralEntry,
  clickEditorDelete,
  confirmEditorDelete,
  reopenForPublishedDelete,
} = require("./cms-editor-ui");
const { prodTarget } = require("./cms-host");
const { loudBail } = require("./fixture-baseline");
const {
  TEST_MEDIA_MARKERS,
  DATA_TARGET,
  SINGLE_PAGE_SLUG_PREFIX,
  buildSinglePageMedia,
  buildEditedValue,
  leakedMarkers,
  missingMediaFields,
  readDataField,
  sameData,
} = require("./single-page-loop-fixture");

const { host: PROD_HOST, adminUrl: PROD_ADMIN, pillId: PILL_PROD } = prodTarget();

const MEDIA_NAV = /^Writing, talks & press$/i;
const DATA_BRANCH = `cms/${DATA_TARGET.collection}/${DATA_TARGET.entry}`;
const DATA_ENTRY_URL = `${PROD_ADMIN}#/collections/${DATA_TARGET.collection}/entries/${DATA_TARGET.entry}`;
const SETTINGS_PATH = "_data/settings.yml";

// Each leg is two editorial-workflow auto-merge cycles (create/edit +
// delete/restore): validate-content + auto-merge + deploy-production +
// CloudFront each, plus the in-browser drive, the 30-min waitForMerge budget
// (#1815) and the 25-min reopen resync budget, as in cms-publish-loop-prod-
// mutate.spec.js (80 min). Leg B has no URL wait, so it is shorter. The sum
// (150 min) is inside the host loop job's timeout-minutes (180). Retries are
// off: this mutates a real site, and a retry re-runs the same broken chain.
const LEG_A_TIMEOUT_MS = 80 * 60 * 1000;
const LEG_B_TIMEOUT_MS = 70 * 60 * 1000;

test.describe.configure({ mode: "serial", retries: 0 });

// Module-scoped handles for the afterAll safety net.
let pendingMedia = null;
let pendingData = null;

function decodeContents(file) {
  return Buffer.from(file.content, "base64").toString("utf8");
}

// Text of a file on main, or null when it is not there. Read-only.
async function mainText(filePath) {
  const file = await readFileOnRef({ ref: "main", filePath });
  return file === null ? null : decodeContents(file);
}

// While the go-live gate is closed the item must not show up publicly.
async function gateIsClosed() {
  const settings = await mainText(SETTINGS_PATH);
  return settings !== null && readDataField(settings, "site_live") === false;
}

// Loud preconditions shared by both legs. Returns false when the leg must stop.
function preconditions() {
  test.skip(
    process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1",
    "RUN_HOST_REPO_PUBLISH_LOOP not set — only the host publish loop runs this spec.",
  );
  test.skip(
    !cap.isSinglePageConsumer(SITE_ROOT),
    "site keeps the base collections (cms.base_collections is not []) — the posts, e2e and media loops cover it; this loop is for a single-page site (#1068).",
  );
  if (!getPat()) {
    loudBail(test, "CMS_E2E_PAT not set — the single-page publish loop cannot run.");
    return false;
  }
  return true;
}

// The Decap editor on the production admin, past login.
async function openAdmin(page, navLinkName) {
  await seedDecapAuth(page);
  await page.goto(PROD_ADMIN, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: navLinkName })).toBeVisible({ timeout: 60_000 });
}

// Belt-and-braces `cms/ready` on a delete PR the shim opened for the file.
async function labelPrRemoving(filePath) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    let prs = [];
    try {
      prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=50`);
    } catch (_) {
      /* transient — retry */
    }
    for (const pr of (prs || []).filter(
      (p) => p.head && typeof p.head.ref === "string" && p.head.ref.startsWith("cms/"),
    )) {
      let files;
      try {
        files = await gh(`/repos/${HOST_REPO}/pulls/${pr.number}/files?per_page=100`);
      } catch (_) {
        continue;
      }
      if (files.some((f) => f.filename === filePath && f.status === "removed")) {
        try {
          await addLabel({ prNumber: pr.number, label: "cms/ready" });
        } catch (e) {
          console.warn(`[single-page-loop] could not label PR #${pr.number}: ${describeError(e)}`);
        }
        return pr.number;
      }
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  // Not finding one is fine: Decap committed the delete straight to main.
  return null;
}

test(
  "single-page publish loop A — media folder entry: create, publish, delete",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    const proceed = preconditions();
    if (!proceed) return;
    test.setTimeout(LEG_A_TIMEOUT_MS);
    // Decap's "Delete published entry" uses a native window.confirm.
    page.on("dialog", (d) => d.accept());

    const runId = Date.now();
    const media = buildSinglePageMedia({ runId });
    const publicUrl = `${PROD_HOST}${media.publicPath}`;
    pendingMedia = media;
    test.info().annotations.push({ type: "fixture-path", description: media.filePath });

    await test.step("The item's public URL 404s before the run (unique per-run name)", async () => {
      const res = await fetch(publicUrl, { cache: "no-store" });
      expect(res.status, `${publicUrl} must not exist yet — got ${res.status}`).toBe(404);
    });

    await test.step("Load the production admin", async () => {
      await openAdmin(page, MEDIA_NAV);
    });

    await test.step("Open the new media entry form", async () => {
      await page.goto(`${PROD_ADMIN}#/collections/media/new`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("textbox", { name: /^Title$/i })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Fill category, title, source, date, article URL and order", async () => {
      await chooseSelectOption(page, /^Category$/, media.fields.category);
      await page.getByRole("textbox", { name: /^Title$/i }).fill(media.title);
      await page.getByLabel(/^Source$/).fill(media.fields.source);
      await page.getByLabel(/^When \(month and year\)/).fill(media.fields.date_display);
      await page.getByLabel(/^Article URL$/).fill(media.fields.article_url);
      await page.getByLabel(/^Order within category/).fill(String(media.fields.weight));
    });

    await test.step("Mark it disposable (test_fixture) before the first Save", async () => {
      await markEphemeralEntry(page, {
        collection: "media",
        title: media.title,
        markers: { ...TEST_MEDIA_MARKERS },
      });
    });

    await test.step("Save (opens the cms/media PR)", async () => {
      await saveEntry(page);
    });

    await test.step("Status:Ready → Publish now (engages auto-merge)", async () => {
      await publishViaUi(page);
    });

    let createPrNumber = null;
    await test.step("Find the create PR, label cms/ready, check the committed file", async () => {
      const pr = await waitForCmsPullRequest({
        base: "main",
        filePath: media.filePath,
        canaryMarker: media.slug,
        timeoutMs: 5 * 60 * 1000,
      });
      expect(pr.number, "Decap create PR number").toBeGreaterThan(0);
      createPrNumber = pr.number;
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
      const committed = await getFileTextAtRef({ filePath: media.filePath, ref: pr.head.sha });
      expect(
        missingMediaFields(committed, media),
        `${media.filePath} at the create PR head must carry the typed fields and test_fixture`,
      ).toEqual([]);
    });

    await test.step("Wait for the item's page to serve (pill terminal-hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, { failOnStatusCode: false });
          return res.status() === 200;
        },
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender({
          getPr: () => getPullRequest({ prNumber: createPrNumber }),
        }),
      });
    });

    await test.step("While the go-live gate is closed the page shows none of the item's copy", async () => {
      if (!(await gateIsClosed())) {
        test.info().annotations.push({
          type: "gate",
          description: "site_live is not false — the leak check does not apply",
        });
        return;
      }
      const res = await fetch(publicUrl, { cache: "no-store" });
      expect(res.status).toBe(200);
      expect(
        leakedMarkers(await res.text(), media),
        `${publicUrl} must show only the coming-soon shell while site_live is false`,
      ).toEqual([]);
    });

    await test.step("Wait for the create PR to merge for real", async () => {
      expect(createPrNumber, "create PR number").toBeTruthy();
      await waitForMerge({ prNumber: createPrNumber, timeoutMs: 30 * 60 * 1000 });
    });

    await test.step("Re-open the entry as a published entry", async () => {
      await reopenForPublishedDelete(page, `${PROD_ADMIN}#${media.entryPath}`, {
        crossCheck: async () => (await mainText(media.filePath)) !== null,
        adminUrl: PROD_ADMIN,
        navLinkName: MEDIA_NAV,
      });
    });

    await test.step("Delete the entry through the editor (opens the delete PR)", async () => {
      await confirmEditorDelete(page, () => clickEditorDelete(page));
    });

    await test.step("Label the delete PR cms/ready if the shim opened one", async () => {
      await labelPrRemoving(media.filePath);
    });

    await test.step("Wait for the item's page to 404 (pill terminal-hidden)", async () => {
      await waitForChangeReflected({
        page,
        pillId: PILL_PROD,
        urlCheck: async () => {
          const res = await page.request.get(publicUrl, { failOnStatusCode: false });
          return res.status() >= 400 && res.status() < 500;
        },
        urlTimeoutMs: 15 * 60 * 1000,
        onBudgetExhausted: makeDeployQueueExtender(),
      });
    });

    await test.step("Nothing is left behind: the file is off main and the page 4xxs", async () => {
      expect(await mainText(media.filePath), `${media.filePath} must be gone from main`).toBeNull();
      const res = await fetch(publicUrl, { cache: "no-store" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  },
);

test(
  "single-page publish loop B — data file section: edit, publish, restore",
  { tag: ["@admin-write"] },
  async ({ page }) => {
    const proceed = preconditions();
    if (!proceed) return;
    test.setTimeout(LEG_B_TIMEOUT_MS);

    const runId = Date.now();
    const { filePath, field } = DATA_TARGET;

    const originalText = await mainText(filePath);
    expect(originalText, `${filePath} must exist on main`).not.toBeNull();
    const original = readDataField(originalText, field);
    expect(typeof original === "string" && original.length > 0, `${filePath} needs a ${field}`).toBe(
      true,
    );
    const edited = buildEditedValue({ original, runId });
    pendingData = { runId, originalText, original, edited };
    test.info().annotations.push({ type: "fixture-path", description: filePath });

    await test.step("No editor already has this entry open as a draft", async () => {
      // The entry is the site owner's real content: refuse to run over, or
      // close, a draft that is hers.
      const prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=100`);
      const open = (prs || []).filter((p) => p.head && p.head.ref === DATA_BRANCH);
      expect(
        open.map((p) => p.number),
        `${DATA_BRANCH} already has an open PR; the loop will not touch an editor's draft`,
      ).toEqual([]);
    });

    await test.step("Load the production admin and open the entry", async () => {
      await openAdmin(page, new RegExp(`^${DATA_TARGET.navLabel}$`, "i"));
      await page.goto(DATA_ENTRY_URL, { waitUntil: "domcontentloaded" });
      await expect(page.getByLabel(/^Heading$/)).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByLabel(/^Heading$/),
        "the editor must show the value that is on main",
      ).toHaveValue(original);
    });

    await test.step("Edit the heading, Save, Status:Ready → Publish now", async () => {
      await page.getByLabel(/^Heading$/).fill(edited);
      await saveEntry(page);
      await publishViaUi(page);
    });

    let editPr = null;
    await test.step("Find the edit PR, label cms/ready, check the committed value", async () => {
      editPr = await waitForCmsPullRequest({
        base: "main",
        filePath,
        canaryMarker: `e2e ${runId}`,
        timeoutMs: 5 * 60 * 1000,
      });
      await addLabel({ prNumber: editPr.number, label: "cms/ready" });
      const committed = await getFileTextAtRef({ filePath, ref: editPr.head.sha });
      expect(readDataField(committed, field), "the PR head carries the edited value").toBe(edited);
    });

    await test.step("Wait for the edit to merge and deploy", async () => {
      const merged = await waitForMerge({ prNumber: editPr.number, timeoutMs: 30 * 60 * 1000 });
      expect(readDataField(await mainText(filePath), field), "main carries the edit").toBe(edited);
      await waitForWorkflowRun({
        workflow: "deploy-production.yml",
        branch: "main",
        headSha: merged.merge_commit_sha,
        timeoutMs: 25 * 60 * 1000,
      });
    });

    await test.step("Re-open the entry as a published entry", async () => {
      await reopenForPublishedDelete(page, DATA_ENTRY_URL, {
        titleName: /^Heading$/i,
        navLinkName: new RegExp(`^${DATA_TARGET.navLabel}$`, "i"),
        requireDeleteButton: false,
        crossCheck: async () => readDataField(await mainText(filePath), field) === edited,
        adminUrl: PROD_ADMIN,
      });
    });

    let restorePr = null;
    await test.step("Type the original heading back, Save, Status:Ready → Publish now", async () => {
      await page.getByLabel(/^Heading$/).fill(original);
      await saveEntry(page);
      await publishViaUi(page);
    });

    await test.step("Find the restore PR and label cms/ready", async () => {
      restorePr = await waitForCmsPullRequest({
        base: "main",
        filePath,
        canaryMarker: `e2e ${runId}`, // the diff removes the edited line
        timeoutMs: 5 * 60 * 1000,
      });
      await addLabel({ prNumber: restorePr.number, label: "cms/ready" });
    });

    await test.step("Wait for the restore to merge and deploy", async () => {
      const merged = await waitForMerge({ prNumber: restorePr.number, timeoutMs: 30 * 60 * 1000 });
      await waitForWorkflowRun({
        workflow: "deploy-production.yml",
        branch: "main",
        headSha: merged.merge_commit_sha,
        timeoutMs: 25 * 60 * 1000,
      });
    });

    await test.step("Nothing is left behind: the data is as it was", async () => {
      const finalText = await mainText(filePath);
      expect(readDataField(finalText, field), "the heading is back").toBe(original);
      // Decap re-serializes the file, so compare the data, not the bytes.
      expect(sameData(finalText, originalText), `${filePath} must hold the original data`).toBe(
        true,
      );
    });
  },
);

// ── Harness hygiene — the only API writer ─────────────────────────────────
// A run that died mid-flow can leave the throw-away item or the edited heading
// on main. Each is repaired through a labelled PR that auto-merges in the
// background (skipWaitForMerge: the hook's timeout is far shorter than a merge),
// and the daily sweep reaps one that cannot merge. A run that finished leaves
// nothing to do.
test.afterAll(async () => {
  if (!getPat()) return;
  if (process.env.RUN_HOST_REPO_PUBLISH_LOOP !== "1") return;
  if (!pendingMedia && !pendingData) return; // neither leg ran (skipped)
  test.setTimeout(3 * 60 * 1000);

  const problems = [];

  if (pendingMedia) {
    const { filePath, slug, runId } = pendingMedia;
    try {
      // Stop this run's in-flight create PR first (#689): it is armed, and a
      // main-only check would read "gone" and then watch it merge.
      const { closed } = await closeOpenPrsAddingFile({ base: "main", filePath });
      if (closed.length > 0) {
        console.warn(`[cleanup-harness] closed in-flight PR(s) ${closed.join(", ")} adding ${filePath}`);
      }
      if ((await mainText(filePath)) === null) {
        console.log(`[cleanup-harness] ${filePath} is not on main; nothing to remove`);
      } else {
        console.warn(`[cleanup-harness] ${filePath} is still on main; opening a removal PR`);
        await removeFixtureViaPr({
          slug,
          runId,
          filePath,
          message: `test(single-page-loop): remove leftover ${SINGLE_PAGE_SLUG_PREFIX} item, run ${runId}`,
          prTitle: `test(single-page-loop): remove leftover item, run ${runId}`,
          prBody:
            "Removal PR opened by `cms-publish-loop-single-page.spec.js` after a failure left its " +
            "throw-away media item on main. Auto-merges via `cms/ready`.",
          skipWaitForMerge: true,
        });
      }
    } catch (e) {
      problems.push(`media item ${filePath}: ${describeError(e)}`);
    }
  }

  if (pendingData) {
    const { filePath, field } = DATA_TARGET;
    const { runId, originalText, original, edited } = pendingData;
    try {
      // Close only THIS run's open PR (its diff carries the run marker), never
      // an editor's draft on the same branch.
      const prs = await gh(`/repos/${HOST_REPO}/pulls?state=open&base=main&per_page=100`);
      for (const pr of (prs || []).filter((p) => p.head && p.head.ref === DATA_BRANCH)) {
        const files = await gh(`/repos/${HOST_REPO}/pulls/${pr.number}/files?per_page=100`);
        const ours = files.some(
          (f) => f.filename === filePath && typeof f.patch === "string" && f.patch.includes(`e2e ${runId}`),
        );
        if (ours) {
          await gh(`/repos/${HOST_REPO}/pulls/${pr.number}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state: "closed" }),
          });
          console.warn(`[cleanup-harness] closed in-flight PR #${pr.number} editing ${filePath}`);
        }
      }
      const current = await mainText(filePath);
      if (current !== null && readDataField(current, field) === edited) {
        console.warn(`[cleanup-harness] ${filePath} still carries the edit; opening a restore PR`);
        await seedFixtureViaPr({
          slug: `${SINGLE_PAGE_SLUG_PREFIX}-restore`,
          runId,
          filePath,
          bodyText: originalText,
          message: `test(single-page-loop): restore ${filePath}, run ${runId}`,
          prTitle: `test(single-page-loop): restore ${filePath}, run ${runId}`,
          prBody:
            "Restore PR opened by `cms-publish-loop-single-page.spec.js` after a failure left its " +
            `edit of \`${field}\` on main. Auto-merges via \`cms/ready\`.`,
          skipWaitForMerge: true,
        });
      } else if (current !== null && readDataField(current, field) !== original) {
        console.warn(`[cleanup-harness] ${filePath} ${field} is neither the edit nor the original; leaving it`);
      }
    } catch (e) {
      problems.push(`data file ${filePath}: ${describeError(e)}`);
    }
  }

  if (problems.length > 0) {
    // Loud: something this run created may still be on main.
    throw new Error(`[cleanup-harness] could not repair: ${problems.join("; ")}`);
  }
});
