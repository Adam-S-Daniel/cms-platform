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

  // WCAG 2.4.11 Focus Not Obscured: the header is `position: sticky`. A link
  // already inside the viewport but within the header's 56px strip (scrolled
  // there by an earlier step) gets no focus scroll at all, so Shift+Tab onto
  // it left it hidden behind the header — unless `scroll-padding-top` shrinks
  // the scrollport the browser measures against. The page is built here, not
  // read from the site, so the geometry holds whatever the site's content is.
  test.describe("focus under the sticky header (phone)", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("Shift+Tab onto a link scrolled up behind the header brings it clear of the header", async ({
      page,
    }) => {
      await page.goto("/blog/");
      const header = page.locator(".site-header");
      test.skip((await header.count()) === 0, "this page renders without the theme's sticky header");

      await page.evaluate(() => {
        const link = (id, text) => {
          const a = document.createElement("a");
          a.id = id;
          a.href = `#${id}`;
          a.textContent = text;
          a.style.display = "block";
          return a;
        };
        const gap = (px) => {
          const d = document.createElement("div");
          d.style.height = `${px}px`;
          return d;
        };
        document
          .querySelector(".site-header")
          .after(gap(1000), link("kbd-probe", "Probe link"), gap(300), link("kbd-next", "Next link"), gap(2000));
        // The probe sits 30px below the viewport top: inside the viewport,
        // behind the 56px header.
        window.scrollTo(0, document.getElementById("kbd-probe").getBoundingClientRect().top + window.scrollY - 30);
        document.getElementById("kbd-next").focus({ preventScroll: true });
      });

      await expect(page.locator("#kbd-next")).toBeFocused();
      const scrolledTo = await page.evaluate(() => window.scrollY);
      expect(scrolledTo, "the page really is scrolled").toBeGreaterThan(500);
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("#kbd-probe")).toBeFocused();

      const [top, bottom] = await Promise.all([
        page.locator("#kbd-probe").evaluate((el) => el.getBoundingClientRect().top),
        header.evaluate((el) => el.getBoundingClientRect().bottom),
      ]);
      expect(top, "the focused link starts at or below the header's bottom edge").toBeGreaterThanOrEqual(bottom);
    });

    test("a fragment jump (skip link target) lands below the header", async ({ page }) => {
      await page.goto("/blog/");
      const header = page.locator(".site-header");
      test.skip((await header.count()) === 0, "this page renders without the theme's sticky header");
      await page.evaluate(() => {
        const spacer = document.createElement("div");
        spacer.style.height = "2400px";
        const target = document.createElement("h2");
        target.id = "kbd-anchor";
        target.textContent = "Anchor target";
        document.querySelector(".site-footer").before(spacer, target, spacer.cloneNode());
      });
      await page.evaluate(() => {
        location.hash = "#kbd-anchor";
      });
      const [top, bottom] = await Promise.all([
        page.locator("#kbd-anchor").evaluate((el) => el.getBoundingClientRect().top),
        header.evaluate((el) => el.getBoundingClientRect().bottom),
      ]);
      expect(top).toBeGreaterThanOrEqual(bottom);
    });
  });
});
