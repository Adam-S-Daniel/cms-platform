// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (UX round 4 triage package 6: ad A4, jd F13) ─────────
// Decap raises its toasts in a react-toastify container fixed at the top
// right. On a phone the editor toolbar is pinned to the top of the viewport
// (#766), so a toast lands exactly on Publish and the avatar, and the retry
// tap after a failed Publish hit the toast and did nothing. admin-mobile.css
// now sets `pointer-events: none` on the container at 1100px and below and
// `auto` on the toast's close button. These are real hit tests and real clicks
// on the shipped Decap 3.15.1 DOM at 390x844: Playwright's actionability check
// reports "<div class="Toastify__toast ...> intercepts pointer events" on a
// tree without the rule.
//
// Harness: index-test.html (Decap's in-browser test-repo backend), with
// publish_mode forced to `simple` so a new entry shows Publish at once (under
// the editorial workflow it appears only after a first Save). Seed/login
// pattern mirrors cms-validation-feedback.spec.js.

const TOAST = '[class*="Toastify__toast-container"] [class*="Toastify__toast"]';
const CLOSE = '[class*="Toastify__close-button"]';
const AVATAR = '[class*="ToolbarContainer"] [class*="AvatarDropdownButton"]';
const MISSED = /missed a required field/i;

async function openEmptyPage(page) {
  await page.route(/\/admin\/config-test\.yml$/, async (route) => {
    const res = await route.fetch();
    const config = (await res.text()).replace(/^publish_mode: editorial_workflow$/m, "publish_mode: simple");
    await route.fulfill({ status: 200, contentType: "text/yaml", body: config });
  });
  await page.addInitScript(() => {
    window.repoFiles = { _posts: {}, _tags: {}, _projects: {}, pages: {} };
    window.repoFilesUnpublished = [];
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^pages$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/pages/new");
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
}

const publishButton = (page) => page.getByRole("button", { name: /^publish/i }).first();

// A failed Publish: Decap's own "missed a required field" toast (every
// required field is empty). Publish is a menu trigger; "Publish now" is the
// attempt. Returns with the toast on screen.
async function failAPublish(page) {
  await publishButton(page).click();
  await page.getByRole("menuitem", { name: /^publish now$/i }).click();
  await expect(page.getByText(MISSED)).toBeVisible({ timeout: 15_000 });
}

// What a tap at the center of `locator` would land on, as a verdict.
const hitTest = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el === hit || el.contains(hit) ? "self" : `${hit && hit.tagName}.${hit && String(hit.className).slice(0, 60)}`;
  });

test.describe(
  "Decap's toasts do not swallow taps on the toolbar (UX round 4 package 6)",
  // Tagged @admin-write: drives /admin/* and publishes into the in-memory test repo.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ timeout: 180_000 });

    test("a tap on Publish and on the avatar lands while a toast is up", async ({ page }) => {
      await openEmptyPage(page);
      await failAPublish(page);
      // The toast really is over the toolbar, or the checks below prove nothing.
      const toast = await page.locator(TOAST).first().boundingBox();
      const publish = await publishButton(page).boundingBox();
      const avatar = await page.locator(AVATAR).boundingBox();
      for (const box of [publish, avatar]) {
        const cy = box.y + box.height / 2;
        expect(cy, "toast covers the control's center").toBeLessThan(toast.y + toast.height);
      }

      expect(await hitTest(page.locator(AVATAR))).toBe("self");
      expect(await hitTest(publishButton(page))).toBe("self");

      // The retry tap, as the editor makes it: it must open the Publish menu
      // while the toast is still up (a short timeout, well inside its 8 s).
      await publishButton(page).click({ timeout: 3_000 });
      await expect(page.getByRole("menuitem", { name: /^publish now$/i })).toBeVisible();
      await expect(page.getByText(MISSED)).toBeVisible();
    });

    test("the toast's close button still closes it", async ({ page }) => {
      await openEmptyPage(page);
      await failAPublish(page);
      const close = page.locator(CLOSE).first();
      await expect(close).toBeVisible();
      await expect(close).toHaveCSS("pointer-events", "auto");
      await close.click({ timeout: 3_000 });
      await expect(page.getByText(MISSED)).toHaveCount(0);
    });

    test("above 1100px the toast keeps Decap's default pointer behavior", async ({ page }) => {
      await openEmptyPage(page);
      await failAPublish(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      const container = page.locator('[class*="Toastify__toast-container"]').first();
      await expect(container).toHaveCSS("pointer-events", "auto");
      await page.setViewportSize({ width: 1100, height: 800 });
      await expect(container).toHaveCSS("pointer-events", "none");
    });
  },
);
