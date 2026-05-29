// @lane: local — drives the in-browser test-repo backend; never touches real GitHub
const { test, expect } = require("./base");
const { publishedSwitch } = require("./cms-editor-ui");

// Accessibility-snapshot CONTRACT for the Decap entry editor (#1769,
// follow-up to #1723 / PR #1767).
//
// Why this exists — the complement to the cms-editor-ui.js lint:
//   - e2e/cms-editor-ui.test.js (shipped, pure-fs) catches *OUR* specs
//     drifting away from the shared helper's selectors.
//   - THIS spec catches *DECAP* drifting out from under the helper — a
//     version bump that re-roles or renames a control. The #1723 flake
//     was, at root, an ARIA role/name drift (the Published widget renders
//     as role="switch", NOT checkbox; a re-edited published entry exposes
//     "Publish ▾" rather than a "Status: Ready" chip). The lint can't see
//     that class of break because it only reads our source; it only ever
//     surfaced latently when a scheduled prod loop tripped over it.
//
// So we pin a tightly-scoped aria snapshot of the two regions the helper's
// selectors depend on — the Published field and the editor toolbar control
// strip — on the read-only canary editor. A role/name change in Decap
// fails this immediately and BY NAME on the cheap admin-read lane, long
// before a prod loop would. Same rationale `cms-config.spec.js` pins config
// invariants by: "Decap's defaults can drift between major versions."
//
// Scope is deliberate (see #1769):
//   - We pin the DRAFT toolbar state (Save + "Status: Draft" + Publish +
//     "Delete unpublished changes"). The published-with-pending-changes
//     state ("Publish ▾", no "Status: Ready" chip) is hard to stage
//     read-only and stays covered by publishViaUi's state-robustness +
//     the loop specs.
//   - The Published-field hint is captured as a bare `- paragraph` (role
//     only, no text): its wording lives in admin/config*.yml and is
//     already pinned by cms-config.spec.js, so binding it here too would
//     churn this contract on a copy edit that has nothing to do with the
//     ARIA role/name drift this guards.
//
// On an intentional Decap upgrade the baselines must be regenerated
// (`--update-snapshots`) — that's a feature: it forces a human to
// acknowledge the editor's a11y contract changed.
//
// Seeding mirrors admin-no-occlusion.spec.js / cms-editorial-workflow.spec.js:
// the test-repo backend reads its initial tree from window.repoFiles +
// window.repoFilesUnpublished. We add an unpublished workflow draft so the
// editor lands on the draft toolbar by pure navigation — no mutation, no
// PAT, no deploy. (Seeding the editor's INITIAL state is the test-repo
// backend's designed entrypoint, not a back door around a chain under test.)

const SLUG = "2026-04-25-replacement-test-post-1";
const POST_CONTENT = [
  "---",
  "title: Replacement test post 1",
  "slug: ''",
  "date: 2026-04-25 16:33:00 -0400",
  "excerpt: ''",
  "tags: []",
  "featured_image: ''",
  "published: true",
  "publish_date: ''",
  "reading_time: null",
  "---",
  "",
  "Wow, a post",
  "",
].join("\n");

async function loadDraftEditor(page) {
  // Seed the published base entry AND an unpublished workflow draft of it,
  // so opening the entry lands on the draft editor (Status: Draft) without
  // any UI mutation. Shape matches the test-repo backend's
  // addOrUpdateUnpublishedEntry (status + diffs[].content).
  await page.addInitScript(
    ({ slug, content }) => {
      window.repoFiles = {
        _posts: { [`${slug}.md`]: { content } },
        _tags: {},
        _projects: {},
        pages: {},
      };
      window.repoFilesUnpublished = {
        [`posts/${slug}`]: {
          slug,
          collection: "posts",
          status: "draft",
          diffs: [
            {
              originalPath: `_posts/${slug}.md`,
              id: `_posts/${slug}.md`,
              path: `_posts/${slug}.md`,
              newFile: false,
              status: "added",
              content,
            },
          ],
          updatedAt: "2026-04-25T16:33:00.000Z",
        },
      };
    },
    { slug: SLUG, content: POST_CONTENT },
  );
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));

  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });

  await page.goto(`/admin/index-test.html#/collections/posts/entries/${SLUG}`);
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
  // Gate on the Published widget being live before snapshotting, so the
  // aria tree is fully hydrated (guards the rare double-mount too).
  await expect(publishedSwitch(page), "Published switch should be visible").toBeVisible({
    timeout: 30_000,
  });
}

test.describe(
  "Decap editor — ARIA contract (drift tripwire for the cms-editor-ui helper)",
  // @admin-read → runs on chromium-desktop-3k AND webkit-iphone16. The aria
  // tree is role/name only (viewport-independent), so a single committed
  // baseline per region covers both resolutions.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 180_000 });

    // One editor load per resolution, both regions snapshotted. `expect.soft`
    // so a drift in EITHER region is reported even if the other also drifted —
    // the matcher names the offending .aria.yml and prints the role/name diff.
    test("Published field + draft toolbar match the pinned ARIA contract", async ({ page }) => {
      await loadDraftEditor(page);

      // (a) Published field — scoped to its ControlContainer (label + widget +
      // hint), NOT the whole form. `publishedSwitch` is the single-sourced
      // selector from cms-editor-ui.js; deriving the region from it keeps the
      // canonical selector out of this spec (the cms-editor-ui.test.js lint).
      const publishedField = page
        .locator('[class*="ControlContainer"]')
        .filter({ has: publishedSwitch(page) })
        .first();
      await expect
        .soft(publishedField, "Published field ARIA drifted (switch role / 'Published' name)")
        .toMatchAriaSnapshot({ name: "published-field.aria.yml" });

      // (b) Toolbar control strip — the first toolbar sub-section holds the
      // workflow controls (Save + Status/Publish + Delete); the deploy-preview
      // controls live in a sibling sub-section and are intentionally excluded.
      const toolbarStrip = page.locator('[class*="ToolbarSubSectionFirst"]').first();
      await expect
        .soft(toolbarStrip, "Editor toolbar ARIA drifted (draft-state control strip)")
        .toMatchAriaSnapshot({ name: "editor-toolbar.aria.yml" });
    });
  },
);
