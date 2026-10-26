// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (UX round 4 triage package 6: ad A4, jd F13) ─────────
// Decap raises its toasts in a react-toastify container fixed at the top
// right. On a phone the editor toolbar is pinned to the top of the viewport
// (#766), so a toast lands exactly on Publish and the avatar, and the retry
// tap after a failed Publish hit the toast and did nothing. admin-mobile.css
// sets `pointer-events: none` on the container at 1100px and below and
// `auto` on the toast's close button. Phones <= 600px move the toast halfway
// down the viewport, keeping its 44px dismiss target clear of the toolbar
// throughout its bounce animation. These are real hit tests and real clicks
// on the shipped Decap 3.15.1 DOM at 320x844 and 390x844.
//
// Harness: index-test.html (Decap's in-browser test-repo backend), with
// publish_mode forced to `simple` so a new entry shows Publish at once (under
// the editorial workflow it appears only after a first Save). Seed/login
// pattern mirrors cms-validation-feedback.spec.js.

const TOAST = '[class*="Toastify__toast-container"] [class*="Toastify__toast"]';
const CLOSE = '[class*="Toastify__close-button"]';
const AVATAR = '[class*="ToolbarContainer"] [class*="AvatarDropdownButton"]';
const MISSED = /missed a required field/i;

async function openEmptyPage(page, width = 390) {
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
  await page.setViewportSize({ width, height: 844 });
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

// Resolve on animation completion rather than an arbitrary timer; tablets
// still use the top-right toast, while phone toasts sit mid-screen.
const toastSettled = (page) =>
  page.locator(TOAST).first().evaluate((el) => Promise.allSettled(el.getAnimations().map((a) => a.finished)));

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
      await toastSettled(page);
      // The phone toast now sits below the toolbar; its dismiss target must
      // never cover the account control even though it accepts pointer events.
      const toast = await page.locator(TOAST).first().boundingBox();
      const publish = await publishButton(page).boundingBox();
      const avatar = await page.locator(AVATAR).boundingBox();
      for (const box of [publish, avatar]) {
        expect(box.y + box.height, "phone toast clears the toolbar").toBeLessThanOrEqual(toast.y);
      }

      expect(await hitTest(page.locator(AVATAR))).toBe("self");
      expect(await hitTest(publishButton(page))).toBe("self");

      // The retry tap, as the editor makes it: it must open the Publish menu
      // while the toast is still up (a short timeout, well inside its 8 s).
      await publishButton(page).click({ timeout: 3_000 });
      await expect(page.getByRole("menuitem", { name: /^publish now$/i })).toBeVisible();
      await expect(page.getByText(MISSED)).toBeVisible();
    });

    for (const width of [320, 390]) {
      test(`${width}px: 44px dismiss and account targets stay separate and work`, async ({ page }) => {
        await openEmptyPage(page, width);
        await failAPublish(page);
        const close = page.locator(CLOSE).first();
        const account = page.getByRole("button", { name: "Account options dropdown", exact: true });
        await expect(close).toBeVisible();
        await expect(account).toBeVisible();

        // Sample real rectangles on each remaining entrance-animation frame,
        // including its overshoot, rather than checking only the resting toast.
        const overlap = await close.evaluate(async (dismiss) => {
          const toast = dismiss.closest('[class*="Toastify__toast"]');
          const toolbar = document.querySelector('[class*="EditorContainer"] > [class*="ToolbarContainer"]');
          const collisions = [];
          do {
            const closeRect = dismiss.getBoundingClientRect();
            for (const control of toolbar.querySelectorAll("button, a")) {
              const rect = control.getBoundingClientRect();
              const style = getComputedStyle(control);
              if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") continue;
              if (closeRect.left < rect.right && closeRect.right > rect.left &&
                  closeRect.top < rect.bottom && closeRect.bottom > rect.top) {
                collisions.push(control.getAttribute("aria-label") || control.textContent.trim());
              }
            }
            if (!toast.getAnimations().some((animation) => animation.playState === "running")) break;
            await new Promise(requestAnimationFrame);
          } while (dismiss.isConnected);
          return collisions;
        });
        expect(overlap, "toast dismiss intersects a visible native toolbar control").toEqual([]);
        for (const target of [close, account]) {
          const box = await target.boundingBox();
          expect(box.width, "touch target width").toBeGreaterThanOrEqual(44);
          expect(box.height, "touch target height").toBeGreaterThanOrEqual(44);
          expect(await hitTest(target)).toBe("self");
        }
        await expect(close).toHaveCSS("pointer-events", "auto");
        await account.click({ timeout: 3_000 });
        const logout = page.getByRole("menuitem", { name: /^log out$/i });
        await expect(logout).toBeVisible();
        await expect(page.getByText(MISSED)).toBeVisible();
        await account.click({ timeout: 3_000 });
        await expect(logout).toBeHidden();
        await close.click({ timeout: 3_000 });
        await expect(page.getByText(MISSED)).toHaveCount(0);
      });
    }

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
      for (const width of [820, 1100]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(container).toHaveCSS("pointer-events", "none");
        await expect(page.locator(CLOSE).first()).toHaveCSS("pointer-events", "auto");
      }
    });
  },
);
