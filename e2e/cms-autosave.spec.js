// @lane: local — drives the in-browser test-repo (editorial_workflow) backend; never touches real GitHub
const { test, expect } = require("./base");

// Autosave-on-hide + idle DOM coupling (#161 Part B). The riskiest change in
// the batch: the shim (theme/admin/autosave-on-hide.js) finds the toolbar Save
// button by its trimmed textContent === "Save" and clicks it on tab-hide /
// after idle. That coupling can't be exercised by a pure-fs lint — it needs the
// REAL Decap-rendered toolbar. This spec drives it end-to-end.
//
// ── Why index-test.html (editorial_workflow), NOT index-local.html ─────
// #161 specifies clicking the "Save" button. That button ONLY exists in
// `publish_mode: editorial_workflow` (Decap's renderWorkflowControls). The
// LOCAL backend (index-local.html → config-local.yml, local_backend:true)
// forces SIMPLE mode regardless of publish_mode — its toolbar has a "Publish"
// button and NO "Save" button (cms-publish-flow.spec.js:19-22), so the
// autosave Save-click is inert there and an index-local spec could not exercise
// it. The harness's ONLY editorial_workflow admin is index-test.html (Decap's
// in-browser test-repo backend, config-test.yml — a FIXED config that
// base_collections never strips, so this spec needs NO #33 guard and runs
// identically on every consumer, single-page included). We mirror
// cms-editorial-workflow.spec.js exactly: seed the repo via addInitScript, log
// in, open the seeded post, edit it, then FIRE THE TRIGGER (visibilitychange→
// hidden / idle) instead of clicking Save by hand, and assert the edit landed
// as an editorial draft.
//
// ── #161's "commits land on cms/<collection>/<slug>, not main" acceptance ──
// The test-repo backend registers a saved editorial-workflow entry under
// `window.repoFilesUnpublished` keyed `${collection}/${slug}` — Decap's
// in-browser representation of the `cms/<collection>/<slug>` PR branch draft
// (no real Git branch exists in-browser). Asserting the edit shows up there is
// the harness-level proof that the autosave Save-click routed through the
// EDITORIAL path (a draft), NOT a direct publish to main. The real cms/-branch
// Git semantics are inherited from Save and are covered by the real-GitHub
// editorial-workflow / prod-loop suites (cms-publish-loop*, cms-editorial-
// workflow); this spec's job is the DOM coupling: trigger → real Save click →
// persisted draft.

const SEED_POST_SLUG = "2026-04-25-replacement-test-post-1";
const SEED_POST_TITLE = "Replacement test post 1";
// The test-repo backend keys unpublished (editorial) entries by
// `${collection}/${slug}`, where slug is the FULL date-prefixed filename stem —
// NO date stripping (mirrors cms-editorial-workflow.spec.js).
const UNPUBLISHED_KEY = "posts/2026-04-25-replacement-test-post-1";

const SEED_POST_CONTENT = `---
title: ${SEED_POST_TITLE}
slug: ''
date: 2026-04-25 16:33:00 -0400
excerpt: ''
tags: []
featured_image: ''
published: true
publish_date: ''
reading_time: null
---

Wow, a post
`;

function buildSeed() {
  return {
    repoFiles: {
      _posts: {
        "2026-04-25-replacement-test-post-1.md": { content: SEED_POST_CONTENT },
      },
      _tags: {},
      _projects: {},
      pages: {},
    },
    repoFilesUnpublished: [],
  };
}

// Seed the repo + set the autosave idle override BEFORE any document script
// runs (Decap reads window.repoFiles at backend init; autosave-on-hide.js reads
// window.__AUTOSAVE_IDLE_MS when it arms the idle timer). idleMs=high parks the
// idle path for the tab-hide test; low drives it for the idle test.
async function seedAdmin(page, idleMs) {
  const seed = buildSeed();
  await page.addInitScript(
    (args) => {
      const s = JSON.parse(args.seedJson);
      window.repoFiles = s.repoFiles;
      window.repoFilesUnpublished = s.repoFilesUnpublished;
      window.__AUTOSAVE_IDLE_MS = args.idleMs;
    },
    { seedJson: JSON.stringify(seed), idleMs },
  );
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
}

async function loginAndOpenEntry(page) {
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });

  await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);
  const titleField = page.getByLabel(/^Title$/);
  await expect(titleField).toBeVisible({ timeout: 60_000 });
  return titleField;
}

// Read the editorial draft the test-repo backend registered for the seeded
// entry (null until a Save routes through the workflow path).
async function draftContent(page) {
  return page.evaluate((key) => {
    const map = window.repoFilesUnpublished || {};
    const entry = map[key];
    if (!entry || !entry.diffs || !entry.diffs.length) return null;
    return entry.diffs[0].content;
  }, UNPUBLISHED_KEY);
}

test.describe(
  "CMS autosave: tab-hide + idle click the real Save button (#161)",
  // Tagged @admin-write: drives /admin/* and writes (an editorial draft).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("visibilitychange→hidden autosaves the dirty entry as an editorial draft", async ({
      page,
    }) => {
      // High idle override so the idle timer can't fire during this test —
      // the tab-hide trigger is the sole cause of the save.
      await seedAdmin(page, 3_600_000);
      const titleField = await loginAndOpenEntry(page);

      const NEW_TITLE = `${SEED_POST_TITLE} — autosaved on tab-hide`;
      await titleField.fill(NEW_TITLE);

      // Confirm we did NOT save by hand: no draft yet.
      expect(await draftContent(page)).toBeNull();

      // Fire the tab-hide trigger the shim listens for. Overriding
      // visibilityState is required because Playwright keeps the page visible.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // The shim's Save click routes through the editorial path → the
      // test-repo backend registers the draft with our edit. This is the
      // cms/<collection>/<slug> PR-branch analog (see header).
      await expect
        .poll(() => draftContent(page), { timeout: 30_000 })
        .toContain(NEW_TITLE);

      // The toolbar transitions to the persisted ("Saving..."/saved) state:
      // once the draft lands, Decap disables Save (no unsaved changes).
      await expect(page.getByRole("button", { name: /^save$/i }).first()).toBeDisabled({
        timeout: 30_000,
      });
    });

    test("idle timeout autosaves the dirty entry (low __AUTOSAVE_IDLE_MS override)", async ({
      page,
    }) => {
      // Low idle override so the idle path fires quickly after the edit's input
      // events settle (the shim resets the timer on each keydown/input, then
      // fires once ~idleMs after typing stops — not per keystroke).
      await seedAdmin(page, 1_500);
      const titleField = await loginAndOpenEntry(page);

      const NEW_TITLE = `${SEED_POST_TITLE} — autosaved on idle`;
      await titleField.fill(NEW_TITLE);

      // No tab-hide, no manual Save — just wait out the idle threshold. The
      // shim fires once and the editorial draft lands.
      await expect
        .poll(() => draftContent(page), { timeout: 30_000 })
        .toContain(NEW_TITLE);
    });
  },
);
