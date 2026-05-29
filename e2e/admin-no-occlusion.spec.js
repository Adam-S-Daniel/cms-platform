// @lane: local — drives the local test-repo /admin shell; no real GitHub
/**
 * @file e2e/admin-no-occlusion.spec.js
 *
 * Guards the admin UI against the "visible but unusable" class of bug —
 * controls that render off the viewport edge or behind another element.
 * A plain `toBeVisible()` misses both; `expectReachable` (see
 * e2e/ui-visibility.js) checks each control is within the viewport
 * horizontally AND is the topmost element at its center point.
 *
 * This spec deliberately does NOT pin a viewport: tagged `@admin-read`,
 * it runs at BOTH admin resolutions — chromium-desktop-3k (3000×1500)
 * and webkit-iphone16 (393×852) — so a control that's reachable on the
 * desktop layout but clipped/occluded on the phone layout (or vice
 * versa) fails the build. This is the regression guard for PR #1654
 * (media-library "Delete selected" rendered behind the asset grid on a
 * phone) and the editor-toolbar / collection-list overflow fixed earlier
 * in ADR-0003.
 *
 * Every new admin screen should add its key controls here.
 */
const { test, expect } = require("./base");
const { expectReachable } = require("./ui-visibility");
const { openMediaLibrary, MEDIA_LIBRARY_TOP_SELECTOR } = require("./cms-editor-ui");

const SEED_POST_SLUG = "2026-04-25-replacement-test-post-1";
const SEED_POST_CONTENT = [
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

async function login(page) {
  await page.addInitScript((content) => {
    window.repoFiles = {
      _posts: { "2026-04-25-replacement-test-post-1.md": { content } },
      _tags: {},
      _projects: {},
      pages: {},
    };
    window.repoFilesUnpublished = [];
  }, SEED_POST_CONTENT);
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
  await page.goto("/admin/index-test.html");
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe(
  "Admin UI — controls are reachable (not clipped or occluded)",
  // @admin-read → runs on chromium-desktop-3k AND webkit-iphone16, each
  // at its native viewport, so both admin resolutions are covered.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("collection list — New button and nav are reachable", async ({ page }) => {
      await login(page);
      await expectReachable(
        page,
        page.locator('[class*="CollectionTopNewButton"]').first(),
        '"New Post" button',
      );
      await expectReachable(
        page,
        page.getByRole("link", { name: /^posts$/i }).first(),
        "Posts collection nav link",
      );
    });

    test("entry editor — Save / Publish / Delete are reachable", async ({ page }) => {
      await login(page);
      await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);
      await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });

      await expectReachable(
        page,
        page.getByRole("button", { name: /^Save$/ }).first(),
        "editor Save button",
      );
      await expectReachable(
        page,
        page.getByRole("button", { name: /^Publish/ }).first(),
        "editor Publish control",
      );
      await expectReachable(
        page,
        page.getByRole("button", { name: /Delete .*entry/i }).first(),
        "editor Delete button",
      );
    });

    test("editorial workflow board — New control and columns are reachable", async ({ page }) => {
      await login(page);
      await page.goto("/admin/index-test.html#/workflow");
      await expect(page.getByRole("heading", { name: /Editorial Workflow/i })).toBeVisible({
        timeout: 30_000,
      });

      await expectReachable(
        page,
        page.getByRole("button", { name: /^New/ }).first(),
        "workflow New button",
      );
      for (const col of ["Drafts", "In Review", "Ready"]) {
        await expectReachable(
          page,
          page.getByText(col, { exact: true }).first(),
          `workflow "${col}" column`,
        );
      }
    });

    test("media-library modal — action buttons reachable and not pushed behind the asset grid", async ({
      page,
    }) => {
      await login(page);
      // openMediaLibrary (shared, cms-editor-ui.js): click "Media" + wait
      // for the library header.
      const libraryTop = await openMediaLibrary(page);
      // The selection-dependent controls (Copy Path / Download / Delete
      // selected) render immediately, disabled, even on an empty library
      // — so we exercise the header layout without depending on the
      // in-browser test-repo's flaky media upload.
      await expect(libraryTop.getByText(/Delete/i).first()).toBeVisible({
        timeout: 30_000,
      });

      // 1. Each action button is reachable (within the viewport
      //    horizontally and not covered). This catches the original
      //    overflow where the buttons ran off the right edge on a phone.
      for (const [name, re] of [
        ["Copy", /Copy/i],
        ["Download", /Download/i],
        ["Delete selected", /Delete/i],
        ["Upload", /Upload/i],
      ]) {
        await expectReachable(
          page,
          libraryTop.getByText(re).first(),
          `media-library "${name}" control`,
        );
      }

      // 2. The header must not clip its own content, and every action
      //    button must sit WITHIN the header's box. The desktop modal is
      //    a CSS grid with a fixed-height header row; once the buttons
      //    wrap on a phone, the wrapped row overflowed that fixed height
      //    and rendered behind the asset grid below (so "Delete selected"
      //    vanished). These two facts — header not clipped, buttons
      //    inside the header — fail if that regresses, without needing a
      //    populated grid to occlude against.
      const header = await page.evaluate((sel) => {
        const lt = document.querySelector(sel);
        const ltRect = lt.getBoundingClientRect();
        const overflowing = [];
        for (const b of lt.querySelectorAll("button, label")) {
          const r = b.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.bottom > ltRect.bottom + 1) {
            overflowing.push({
              txt: (b.textContent || "").trim().slice(0, 18),
              bottom: Math.round(r.bottom),
              headerBottom: Math.round(ltRect.bottom),
            });
          }
        }
        return {
          clientH: lt.clientHeight,
          scrollH: lt.scrollHeight,
          overflowing,
        };
      }, MEDIA_LIBRARY_TOP_SELECTOR);
      expect(
        header.scrollH,
        `Media-library header is clipped (scrollHeight ${header.scrollH} > clientHeight ${header.clientH}) — wrapped controls are hidden`,
      ).toBeLessThanOrEqual(header.clientH + 1);
      expect(
        header.overflowing,
        `Media-library action buttons overflow below the header (into the asset grid), hiding them: ${JSON.stringify(header.overflowing)}`,
      ).toEqual([]);

      // 3. The asset grid must keep its height. Decap's asset list is a
      //    react-window virtual list whose height comes from the modal's
      //    grid body track; dropping the modal to display:block collapses
      //    that track to 0 so NO images render (regressed on this PR).
      //    Assert the modal stays a grid and its body region (the empty-
      //    state message here, the card list when populated) fills below
      //    the header — no upload needed.
      const body = await page.evaluate(() => {
        const sm = document.querySelector('[class*="StyledModal"]');
        const region = sm && sm.children[1]; // [0] = header, [1] = asset area
        return {
          display: sm ? getComputedStyle(sm).display : null,
          regionH: region ? Math.round(region.getBoundingClientRect().height) : 0,
        };
      });
      expect(
        body.display,
        "media modal must stay a CSS grid — display:block collapses the virtualized asset grid to 0 height and no images render",
      ).toBe("grid");
      expect(
        body.regionH,
        `media asset region collapsed to ${body.regionH}px — the grid's body track lost its height, so images won't render`,
      ).toBeGreaterThan(150);
    });
  },
);
