// @lane: local — public-site accessibility polish (cms-platform#657): skip
// link, readable meta text, footer follow links. The decorative featured-image
// alt is locked at build level by theme/spec/public_a11y_polish_build_test.rb;
// this spec re-checks it on whatever post the site serves.
const { test, expect } = require("./base");
const cap = require("./site-capabilities");

// The skip link and the footer follow links are the THEME default layout's
// markup. A site whose home page renders through its own layout (jodidaniel.com's
// _layouts/home.html) never asked for them, so the `/` checks skip there —
// decided from the site's source, so a theme-layout site that loses the markup
// still fails. Evaluated inside each test, never at file load: a throw (no
// theme layouts found) then fails that test instead of loading zero tests.
function skipUnlessHomeUsesTheme() {
  test.skip(
    !cap.homeUsesThemeLayout(),
    "the home page renders through a site-owned layout, not the theme's default.html",
  );
}

// Meta, nav and hero text was 11.2-11.5px; WCAG has no minimum but 12px is
// the floor the issue asked for.
const MIN_FONT_PX = 12;

test.describe("Public-site accessibility polish", () => {
  test("first Tab stop is a skip link that reveals itself and moves focus to main", async ({
    page,
  }) => {
    skipUnlessHomeUsesTheme();
    await page.goto("/");
    await page.keyboard.press("Tab");

    const skip = page.locator("a.skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText("Skip to content");
    // Revealed on focus: fully inside the viewport, not clipped off-screen.
    const box = await skip.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);

    await page.keyboard.press("Enter");
    await expect(page.locator("main#main-content")).toBeFocused();
  });

  test("skip link is hidden until focused", async ({ page }) => {
    skipUnlessHomeUsesTheme();
    await page.goto("/");
    const box = await page.locator("a.skip-link").boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(0);
  });

  test("nav, footer and meta text are at least 12px", async ({ page }) => {
    await page.goto("/blog/");
    for (const selector of [".site-nav a", ".site-footer p", ".footer-follow a", ".post-date"]) {
      const matches = page.locator(selector);
      const count = await matches.count();
      for (let i = 0; i < count; i += 1) {
        const px = await matches
          .nth(i)
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(px, `${selector} #${i} font-size`).toBeGreaterThanOrEqual(MIN_FONT_PX);
      }
    }
  });

  test("footer offers the feed as a follow link", async ({ page }) => {
    skipUnlessHomeUsesTheme();
    await page.goto("/");
    const follow = page.locator(".site-footer .footer-follow");
    await expect(follow).toHaveAttribute("aria-label", "Follow");
    await expect(follow.getByRole("link", { name: "RSS" })).toHaveAttribute("href", /\/feed\.xml$/);
  });

  test("a featured image is decorative (empty alt), never a repeat of the title", async ({
    page,
  }) => {
    await page.goto("/blog/");
    const links = await page.locator("a[href^='/blog/']").evaluateAll((as) => [
      ...new Set(as.map((a) => a.getAttribute("href"))),
    ]);
    let checked = 0;
    for (const href of links.filter((h) => h !== "/blog/")) {
      await page.goto(href);
      const imgs = page.locator("img.featured-image");
      const count = await imgs.count();
      for (let i = 0; i < count; i += 1) {
        await expect(imgs.nth(i)).toHaveAttribute("alt", "");
        checked += 1;
      }
    }
    test.skip(checked === 0, "no served post has a featured image");
  });
});
