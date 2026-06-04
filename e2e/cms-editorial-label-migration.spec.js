// @lane: local — the editorial-workflow label-migration dialog must terminate (never persist)
const { test, expect } = require("./base");

// Regression guard for the "stuck label-migration dialog" bug.
//
// Decap's editorial workflow tracks each entry's status via PR LABELS
// (decap-cms/draft | decap-cms/pending_review | decap-cms/pending_publish).
// On load, if an editorial-workflow entry is MISSING its label, Decap runs a
// one-time migration and shows a dialog:
//   "Decap CMS is adding labels to N of your Editorial Workflow entries.
//    The 'Workflow' tab will be unavailable during this migration. You may use
//    other areas of the CMS during this time. Note that closing the CMS will
//    pause the migration."
// That migration MUST TERMINATE: once it has run (or when every entry is
// already labeled) the dialog must NOT re-appear on the next load. A
// stuck/unlabeled entry makes Decap re-migrate on every CMS open — the dialog
// PERSISTS after dismiss + refresh and the Workflow tab churns. (Observed on
// prod adamdaniel.ai: a canary editorial entry whose PR couldn't auto-merge
// never got its label committed, so the migration re-ran forever.)
//
// This drives the in-browser test-repo backend (index-test.html,
// publish_mode: editorial_workflow) so it never touches real GitHub. It asserts
// the INVARIANT: the migration dialog is ABSENT — or, if it shows, is GONE
// after the user dismisses it, waits 30s (long enough for the label commit),
// and refreshes. The dialog must never survive that cycle.
//
// NB: the test-repo backend does not perform the real GitHub label commit, so
// in CI this normally takes the "never shown" branch (a clean pass) and the 30s
// wait is skipped. The dismiss → 30s → reload path runs only if the dialog ever
// appears — which is exactly the regression we want to fail loudly on.

const DIALOG = /adding labels to\s+\d+\s+of your Editorial Workflow entries/i;

// Minimal published repo for the test-repo backend (top-level keys = folders,
// leaf objects = { content }). Mirrors cms-editorial-workflow.spec.js's seed.
const SEED = {
  repoFiles: {
    _posts: {
      "2026-04-25-seed-post.md": {
        content:
          "---\ntitle: Seed post\nslug: ''\ndate: 2026-04-25 12:00:00 -0400\ntags: []\npublished: true\n---\n\nSeed body\n",
      },
    },
    _tags: {},
    _projects: {},
    pages: {},
  },
  repoFilesUnpublished: [],
};

test.describe(
  "editorial-workflow label migration terminates (dialog must not persist)",
  // Drives /admin read-only (a dismiss click + a reload; no content writes).
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 120_000 });

    test("'adding labels' dialog is absent — or gone after dismiss + 30s + refresh", async ({
      page,
    }) => {
      await page.addInitScript((seedJson) => {
        const s = JSON.parse(seedJson);
        window.repoFiles = s.repoFiles;
        window.repoFilesUnpublished = s.repoFilesUnpublished;
      }, JSON.stringify(SEED));

      await page.goto("/admin/index-test.html");
      // test-repo backend renders a "Login" button identical to local_backend.
      const loginBtn = page.getByRole("button", { name: /login/i });
      await expect(loginBtn).toBeVisible({ timeout: 60_000 });
      await loginBtn.click();
      // CMS is ready when the collections sidebar mounts.
      await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });

      const dialog = page.getByText(DIALOG);
      const shownInitially = await dialog.isVisible().catch(() => false);

      if (shownInitially) {
        // Dismiss the migration dialog, give Decap time to commit the labels,
        // then reload — the migration must be DONE, not restart.
        const closeBtn = page.getByRole("button", { name: /^close$/i });
        if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
        await page.waitForTimeout(30_000);
        await page.reload();
        await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 60_000 });
      }

      // INVARIANT: the migration dialog must not be present now — either it was
      // never shown, or it terminated after dismiss + 30s + reload.
      await expect(
        page.getByText(DIALOG),
        shownInitially
          ? "editorial-workflow label-migration dialog RE-APPEARED after dismiss + 30s + refresh — it is not terminating (a stuck/unlabeled editorial-workflow entry)"
          : "editorial-workflow label-migration dialog appeared on a clean load (no migration should be pending)",
      ).toBeHidden();
    });
  },
);
