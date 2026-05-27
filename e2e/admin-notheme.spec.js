// @lane: local — drives the local Jekyll-served /admin shell over the test base URL
const { test, expect } = require("./base");

// Verifies the contributor capability "?notheme kill-switch in admin":
// historically the admin shipped a cobalt-thermal theme that an editor
// could disable by appending `?notheme` to the URL when the theme broke
// rendering. The theme was retired in PR #81 — admin/index.html now ships
// only the floating-link + commit-pill chrome and Decap's own styling.
//
// This spec is a regression guardrail: assert that the admin does NOT
// inject a cobalt theme element, regardless of `?notheme`. If anyone
// re-introduces the theme without re-introducing the kill-switch, this
// fails — pointing future maintainers at the editor-facing escape hatch
// they need to ship alongside any new theme.

test.describe(
  "/admin/?notheme — cobalt theme is not shipped",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    for (const url of ["/admin/", "/admin/?notheme"]) {
      test(`no cobalt theme markers on ${url}`, async ({ page }) => {
        await page.goto(url);

        // No data-cobalt-popup attribute anywhere in the document. That
        // attribute was the cobalt theme's signature hook for Decap's
        // toolbar popups.
        await expect(page.locator("[data-cobalt-popup]")).toHaveCount(0);

        // No #inline-cobalt-theme stylesheet element with an active media
        // query. The retired theme injected its CSS via this element; if
        // it's present with media != 'not all', the theme is back on.
        const themeEl = page.locator("#inline-cobalt-theme");
        const themeCount = await themeEl.count();
        if (themeCount > 0) {
          const media = await themeEl.first().getAttribute("media");
          expect(
            media,
            "If #inline-cobalt-theme is present at all, it must be disabled via media='not all'",
          ).toBe("not all");
        }
      });
    }
  },
);
