// @lane: local — uses cms-test-backend for hermetic editorial-workflow state checks
const { test, expect } = require("./base");
const { defaultSeed, loadTestAdmin } = require("./cms-test-backend");

// Plan unit B5 — exercise the editorial-workflow STATE TRANSITIONS that
// drive the cms/draft / cms/ready label flip in production. Decap's
// Status dropdown is the editor's primary lever for moving an entry
// through draft → review → ready → published; if any transition silently
// breaks (e.g. a bundle upgrade swaps the menu labels, or the test-repo
// backend stops persisting `status` on the unpublished entry), the
// auto-merge gate stops firing and editors lose the ability to ship.
//
// cms-editorial-workflow.spec.js already exercises a Draft → In Review →
// Ready cycle as one composite test. This spec parametrises the same
// machinery into discrete per-transition cases and adds the missing
// edges — "Ready → Draft" (revert), "Draft → Ready" (skip review),
// "Ready → published" (the actual publish action), plus an invalid-
// transition probe so we lock in that publishing from Draft is *not*
// possible without going through Ready first.
//
// Backend: admin/index-test.html → admin/config-test.yml → backend
// `test-repo` with `publish_mode: editorial_workflow`. The full state
// lives on `window.repoFilesUnpublished[<collection>/<slug>]`; the
// `status` key on that object is the source of truth for the four
// status keys Decap emits internally:
//   "draft"            — UI label "Draft"
//   "pending_review"   — UI label "In Review"
//   "pending_publish"  — UI label "Ready"
//   (no status key)    — entry has been published; moves to repoFiles
//
// Each test case re-seeds repoFiles + repoFilesUnpublished via
// addInitScript so serial-mode state never leaks between cases.

const WORKFLOW_TAG_NAME = "Workflow States Probe";
const WORKFLOW_TAG_SLUG = "workflow-states-probe";

// Build a seed where the workflow draft already exists at a known
// status — bypasses the Save step in every per-transition test, so
// each case can start straight on the toolbar action under test.
function seedWithDraftAt(status) {
  const baseSeed = defaultSeed();
  // Decap's test-repo backend keys unpublished entries by
  // `${collection}/${slug}` and stores the rendered file content under
  // `diffs[0].content` (path/newFile/content/status — see
  // decap-cms-backend-test/src/implementation.ts: persistEntry).
  const fileContent = `---
name: ${WORKFLOW_TAG_NAME}
description: ''
---
`;
  baseSeed.repoFilesUnpublished = {
    [`tags/${WORKFLOW_TAG_SLUG}`]: {
      slug: WORKFLOW_TAG_SLUG,
      collection: "tags",
      status,
      diffs: [
        {
          path: `_tags/${WORKFLOW_TAG_SLUG}.md`,
          newFile: true,
          content: fileContent,
        },
      ],
    },
  };
  return baseSeed;
}

// Read the live status string for the workflow tag. Returns null if the
// entry no longer exists in the unpublished map — that's the signature
// of a successful publish (the entry moves out of repoFilesUnpublished
// into repoFiles).
function readDraftStatus(page) {
  return page.evaluate(
    (key) => window.repoFilesUnpublished?.[key]?.status ?? null,
    `tags/${WORKFLOW_TAG_SLUG}`,
  );
}

// Open the entry editor for the seeded workflow tag. Decap's editorial
// workflow renders existing unpublished entries on the same path as
// published ones — `#/collections/<col>/entries/<slug>` — but the
// toolbar shape differs (Status dropdown + Publish button instead of
// the simple-mode split Publish control).
async function openWorkflowEntry(page, status) {
  await loadTestAdmin(page, { seed: seedWithDraftAt(status) });
  await page.goto(`/admin/index-test.html#/collections/tags/entries/${WORKFLOW_TAG_SLUG}`);
  // Name field is the canary — confirms the entry editor mounted on
  // the seeded draft (not a 404 / empty form / collection list).
  await expect(page.getByLabel(/^Name$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel(/^Name$/)).toHaveValue(WORKFLOW_TAG_NAME);
  // Sanity-check the seed actually mounted at the expected status —
  // if the test-repo backend ever shape-drifts the `status` field,
  // every transition test would fail with a confusing "menu item
  // not found" instead of the real cause.
  await expect.poll(() => readDraftStatus(page), { timeout: 10_000 }).toBe(status);
}

// Click the Status dropdown trigger and pick the menu item with the
// given label. The trigger renders as plain text "Status: <Current>"
// (DropdownButton in Decap's EditorToolbar). Match the prefix so we
// don't have to know the current status before each click.
async function setStatus(page, menuLabel) {
  const trigger = page.getByText(/^Status:\s/i).first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  const item = page.getByRole("menuitem", { name: menuLabel }).first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();
}

test.describe(
  "Decap editorial workflow — state transitions (B5)",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeEach(async () => {});

    // ── 1. draft → review ───────────────────────────────────────────────
    //
    // The first state move every CMS PR sees: editor saves, then bumps
    // the entry into "In Review" so the team can read the preview and
    // the regression video. Asserts both the in-page badge text and the
    // backend `status` field — if Decap renamed the menu item but kept
    // the internal key, the badge check would catch it.
    test("draft → In Review updates badge + repoFilesUnpublished[*].status", async ({ page }) => {
      await openWorkflowEntry(page, "draft");

      // Pre-condition: the badge text should show "Status: Draft".
      await expect(page.getByText(/^Status:\s*Draft$/i)).toBeVisible();

      await setStatus(page, /in review/i);

      await expect.poll(() => readDraftStatus(page), { timeout: 10_000 }).toBe("pending_review");
      await expect(page.getByText(/^Status:\s*In Review$/i)).toBeVisible({
        timeout: 5_000,
      });
    });

    // ── 2. review → ready ───────────────────────────────────────────────
    //
    // Locks in that the green-pill "Ready" state is reachable from
    // "In Review". This is the transition that the cms/ready label is
    // derived from in the GitHub-backed flow — auto-merge fires off it.
    test("review → Ready advances to pending_publish", async ({ page }) => {
      await openWorkflowEntry(page, "pending_review");
      await expect(page.getByText(/^Status:\s*In Review$/i)).toBeVisible();

      await setStatus(page, /^ready$/i);

      await expect.poll(() => readDraftStatus(page), { timeout: 10_000 }).toBe("pending_publish");
      await expect(page.getByText(/^Status:\s*Ready$/i)).toBeVisible({
        timeout: 5_000,
      });
    });

    // ── 3. ready → draft (revert) ───────────────────────────────────────
    //
    // Reverting a Ready entry back to Draft is the editor's escape hatch
    // when a regression-video review surfaces something blocking. If
    // Decap ever made this transition forward-only, an editor would have
    // no way to un-stage the entry without deleting + recreating it.
    test("ready → Draft reverts the status backwards", async ({ page }) => {
      await openWorkflowEntry(page, "pending_publish");
      await expect(page.getByText(/^Status:\s*Ready$/i)).toBeVisible();

      await setStatus(page, /^draft$/i);

      await expect.poll(() => readDraftStatus(page), { timeout: 10_000 }).toBe("draft");
      await expect(page.getByText(/^Status:\s*Draft$/i)).toBeVisible({
        timeout: 5_000,
      });
    });

    // ── 4. draft → ready (skip review) ──────────────────────────────────
    //
    // Decap allows direct Draft → Ready transitions — the "In Review"
    // step is conventional, not enforced. A solo editor frequently uses
    // this skip to ship trivial fixes without parking a PR for the
    // (non-existent) reviewer to see. If a future bundle introduces an
    // intermediate-state requirement, this test catches the regression.
    test("draft → Ready (skip review) is allowed as a direct transition", async ({ page }) => {
      await openWorkflowEntry(page, "draft");
      await expect(page.getByText(/^Status:\s*Draft$/i)).toBeVisible();

      await setStatus(page, /^ready$/i);

      await expect.poll(() => readDraftStatus(page), { timeout: 10_000 }).toBe("pending_publish");
      await expect(page.getByText(/^Status:\s*Ready$/i)).toBeVisible({
        timeout: 5_000,
      });
    });

    // ── 5. ready → published ────────────────────────────────────────────
    //
    // The actual publish action. From the "Ready" state, the toolbar
    // shows a Publish split button (separate from Save). Clicking
    // "Publish now" should:
    //   a) Move the entry out of repoFilesUnpublished, AND
    //   b) Write the file content into repoFiles under the collection's
    //      folder (`_tags/<slug>.md`).
    //
    // Both flips matter — if Decap published only on disk but kept the
    // unpublished entry around, an editor would see two copies in the
    // dashboard. If it cleared the unpublished entry without writing
    // the file, the publish would be a silent data-loss bug.
    test("ready → publish moves entry from repoFilesUnpublished to repoFiles", async ({ page }) => {
      test.fixme(
        true,
        "test-repo backend (admin/index-test.html) doesn't actually flip " +
          "the entry from repoFilesUnpublished to repoFiles when the Publish " +
          "menuitem is clicked — the click fires Decap's publish action, but " +
          "the in-browser mock backend has no commit-and-push wiring to " +
          "complete the move. Verified at runtime: 32s timeout while polling " +
          "readDraftStatus, status stays at 'pending_publish'. The four " +
          "preceding state transitions (draft↔review, review→ready, ready→ " +
          "draft, draft→ready) all pass — those are pure state-machine " +
          "advances that test-repo handles. The publish-completes step needs " +
          "either a richer mock backend or a real local-backend run; track " +
          "with C3-style end-to-end coverage instead.",
      );
      await openWorkflowEntry(page, "pending_publish");

      // Pre-condition: the file is NOT yet in the published repo tree.
      const beforePublished = await page.evaluate(
        (slug) => window.repoFiles?._tags?.[`${slug}.md`]?.content || null,
        WORKFLOW_TAG_SLUG,
      );
      expect(
        beforePublished,
        "Seeded entry must start as unpublished only — repoFiles._tags should not contain it yet.",
      ).toBeNull();

      // Decap's editorial-workflow Publish button is a split control
      // ("Publish" trigger → menu with "Publish now" / "Publish and
      // Create New"), identical in shape to simple-mode but only enabled
      // once `status === pending_publish`.
      await page
        .getByRole("button", { name: /^publish$/i })
        .first()
        .click();
      const publishNow = page.getByRole("menuitem", { name: /publish now/i }).first();
      await expect(publishNow).toBeVisible({ timeout: 5_000 });
      await publishNow.click();

      // Post-condition (a): the unpublished entry is gone.
      await expect.poll(() => readDraftStatus(page), { timeout: 30_000 }).toBe(null);

      // Post-condition (b): the file landed in the published repo tree.
      await expect
        .poll(
          () =>
            page.evaluate(
              (slug) => window.repoFiles?._tags?.[`${slug}.md`]?.content || null,
              WORKFLOW_TAG_SLUG,
            ),
          { timeout: 30_000 },
        )
        .toContain(`name: ${WORKFLOW_TAG_NAME}`);
    });

    // ── 6. invalid: publish-from-draft ──────────────────────────────────
    //
    // Decap gates the Publish button on `status === pending_publish`.
    // For a Draft (or In Review) entry, the toolbar Publish button
    // should be either absent or disabled — the editor shouldn't be
    // able to one-click skip the workflow gate.
    //
    // We assert the more pragmatic of the two outcomes: if a Publish
    // button is rendered for a Draft entry, attempting to use it must
    // NOT cause the entry to move out of repoFilesUnpublished. That
    // covers both "button is hidden" (locator never resolves) and "button
    // is rendered-but-inert" (clicking is a no-op) — Decap has shipped
    // both shapes across versions and either is acceptable from an
    // editor-experience standpoint.
    test("invalid: Publish from Draft is refused (button absent or no-op)", async ({ page }) => {
      test.fixme(
        true,
        "Pairs with the ready→publish fixme above — test-repo's mock " +
          "publish action doesn't reliably round-trip through the unpublished/" +
          "published split, so we can't distinguish 'button refused the click' " +
          "(the contract this test asserts) from 'button accepted the click " +
          "but mock didn't follow through' (a backend gap). Re-enable when " +
          "the publish path lands a real backend or the mock is extended.",
      );
      await openWorkflowEntry(page, "draft");
      await expect(page.getByText(/^Status:\s*Draft$/i)).toBeVisible();

      // Capture the published-tree state before the attempt.
      const filesBefore = await page.evaluate(() => Object.keys(window.repoFiles?._tags || {}));

      const publishBtn = page.getByRole("button", { name: /^publish$/i }).first();
      const isVisible = await publishBtn.isVisible().catch(() => false);

      if (!isVisible) {
        // Acceptable shape A: Decap hides the Publish button entirely
        // for non-Ready entries. Nothing to click; nothing to assert
        // beyond the unchanged state below.
      } else {
        // Acceptable shape B: button is rendered but inert. Try the
        // full split-button menu path (Publish now); if the menuitem
        // never appears or the click is a no-op, the entry stays
        // exactly where it was. The catches here are deliberate — an
        // inert split button is one of the two acceptable shapes the
        // assertion below tolerates — so we surface the swallowed
        // error instead of silently dropping it (silent-catch-lint
        // bans `() => {}`).
        await publishBtn
          .click()
          .catch((err) => console.warn("publishBtn click failed (likely inert):", err.message));
        const publishNow = page.getByRole("menuitem", { name: /publish now/i }).first();
        const menuVisible = await publishNow.isVisible({ timeout: 1_500 }).catch(() => false);
        if (menuVisible) {
          await publishNow
            .click()
            .catch((err) => console.warn("publishNow click failed (no-op menu):", err.message));
        }
        // Close any half-open menu so subsequent state poll isn't racing
        // a transient overlay.
        await page.keyboard
          .press("Escape")
          .catch((err) => console.warn("Escape press failed:", err.message));
      }

      // Wait long enough that any in-flight publish would have committed
      // by now (real Decap publishes resolve in <1 second on the
      // in-memory test backend). Then assert the entry is unchanged:
      //   - still in repoFilesUnpublished with status="draft"
      //   - repoFiles._tags has not gained a new entry
      await page.waitForTimeout(1_500);

      expect(
        await readDraftStatus(page),
        "Publish from Draft must not move the entry out of repoFilesUnpublished — status stays 'draft'.",
      ).toBe("draft");

      const filesAfter = await page.evaluate(() => Object.keys(window.repoFiles?._tags || {}));
      expect(
        filesAfter,
        "Publish from Draft must not write a new file into repoFiles._tags — the workflow gate should refuse.",
      ).toEqual(filesBefore);
    });
  },
);
