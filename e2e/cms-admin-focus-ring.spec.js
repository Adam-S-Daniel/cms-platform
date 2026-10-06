// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (UX round 3: ad-kbd K14, jd-kbd F11b; round 4: menus) ──
// Decap leaves buttons and links on the browser's default focus ring, a dark
// line. On a dark fill ("＋ Post") that is dark on dark, and the collection
// sidebar's links are as wide as their `overflow: auto` list, so the outline
// was clipped at both sides. admin-mobile.css (linked from all three shells)
// now draws a two-tone `:focus-visible` ring and keeps the sidebar's ring
// inside the link. Decap's dropdown menus ("Publish now") are `overflow:
// hidden` with flush items, so their items get the same inside ring (UX round
// 4 triage package 2). These are computed-style checks on the real Decap 3.15.1
// DOM after real Tab presses; a mouse click must not change.
//
// Harness: index-test.html (Decap's in-browser test-repo backend), one seeded
// post and one seeded Ready tag (so the toolbar shows its Publish menu). Seed/login pattern mirrors cms-route-focus.spec.js.

const NEW_BUTTON = '[class*="CollectionTopNewButton"]';
const SIDEBAR_LIST = '[class*="SidebarNavList"]';
const SIDEBAR_LINK = `${SIDEBAR_LIST} a`;
const PUBLISH_TRIGGER = '[role="button"][class*="PublishButton"]';
const MENU_ITEM = '[role="menuitem"]';
const RING_BLUE = "rgb(29, 78, 216)";

async function openList(page) {
  await page.addInitScript(() => {
    window.repoFiles = {
      _posts: { "2026-01-01-hello.md": { content: "---\ntitle: Hello\nslug: hello\ndate: 2026-01-01\n---\nBody" } },
      _tags: {},
      _projects: {},
      pages: {},
    };
    window.repoFilesUnpublished = [];
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  });
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/posts");
  await expect(page.locator(NEW_BUTTON)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(SIDEBAR_LINK).nth(1)).toBeVisible({ timeout: 60_000 });
}

// An editorial-workflow entry that is Ready, so the toolbar renders Decap's
// Publish dropdown ("Publish now" and two siblings). Nothing is published.
async function openReadyEntry(page) {
  await page.addInitScript(() => {
    window.repoFiles = { _posts: {}, _tags: {}, _projects: {}, pages: {} };
    window.repoFilesUnpublished = {
      "tags/ready-tag": {
        slug: "ready-tag",
        collection: "tags",
        status: "pending_publish",
        diffs: [{ path: "_tags/ready-tag.md", newFile: true, content: "---\nname: Ready Tag\ndescription: ''\n---\n" }],
      },
    };
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  });
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/tags/entries/ready-tag");
  await expect(page.getByLabel(/^Name$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(PUBLISH_TRIGGER)).toBeVisible({ timeout: 30_000 });
}

// Tab (real key presses) from the top of the page until the element matching
// `selector` is focused; the page is reset by a click on empty chrome first.
async function tabTo(page, selector, nth = 0) {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate(
      ({ sel, n }) => {
        const a = document.activeElement;
        const all = Array.from(document.querySelectorAll(sel));
        return !!a && all.indexOf(a) === n;
      },
      { sel: selector, n: nth },
    );
    if (hit) return;
  }
  throw new Error(`Tab never reached ${selector}[${nth}] within 60 presses`);
}

const ringOf = (page) =>
  page.evaluate(() => {
    const e = document.activeElement;
    const cs = getComputedStyle(e);
    return {
      focusVisible: e.matches(":focus-visible"),
      outlineStyle: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth),
      outlineColor: cs.outlineColor,
      outlineOffset: parseFloat(cs.outlineOffset),
      boxShadow: cs.boxShadow,
      background: cs.backgroundColor,
    };
  });

// Relative luminance and contrast of two "rgb(r, g, b)" strings.
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.match(/\d+/g).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe("Admin keyboard focus ring", { tag: ["@admin-write"] }, () => {
  test.describe.configure({ timeout: 180_000 });

  test("all three admin shells link the stylesheet that carries the ring", async ({ page }) => {
    // Fetched over HTTP, not read from theme/admin: a consumer-mode run has no
    // platform tree (AGENTS.md, consumer-context spec rule).
    for (const shell of ["index.html", "index-local.html", "index-test.html"]) {
      const res = await page.request.get(`/admin/${shell}`);
      expect(res.status(), `${shell} is served`).toBe(200);
      expect(await res.text(), `${shell} must <link> admin-mobile.css`).toMatch(
        /<link\b[^>]*rel="stylesheet"[^>]*href="admin-mobile\.css"/,
      );
    }
    const css = await (await page.request.get("/admin/admin-mobile.css")).text();
    expect(css, "the ring rule must be outside any @media block").toMatch(
      /^#nc-root :is\([^)]*\):focus-visible\s*\{/m,
    );
  });

  test("a dark button shows a two-tone ring on keyboard focus", async ({ page }) => {
    await openList(page);
    await tabTo(page, NEW_BUTTON);
    const ring = await ringOf(page);

    expect(ring.focusVisible, "keyboard focus matches :focus-visible").toBe(true);
    // The target really is a dark fill, or this test proves nothing.
    expect(contrast(ring.background, "rgb(255, 255, 255)"), `"＋ Post" is dark (${ring.background})`).toBeGreaterThan(4.5);

    expect(ring.outlineStyle, "a solid outline, not the browser's `auto` ring").toBe("solid");
    expect(ring.outlineWidth).toBeGreaterThanOrEqual(2);
    expect(ring.outlineColor, "white tone").toBe("rgb(255, 255, 255)");
    expect(ring.boxShadow, "blue tone outside the outline").toContain(RING_BLUE);
    expect(ring.boxShadow).not.toContain("inset");
    expect(contrast(ring.outlineColor, ring.background), "white tone against the dark fill").toBeGreaterThanOrEqual(3);
  });

  test("a sidebar collection link keeps its whole ring inside the clipping list", async ({ page }) => {
    await openList(page);
    await tabTo(page, SIDEBAR_LINK, 1);
    const ring = await ringOf(page);

    expect(ring.focusVisible).toBe(true);
    expect(ring.outlineStyle).toBe("solid");
    expect(ring.outlineWidth).toBeGreaterThanOrEqual(2);
    // The outline's outer edge is `offset + width` from the link's border
    // box; at or below zero it cannot leave the link.
    expect(ring.outlineOffset + ring.outlineWidth, "outline stays inside the link box").toBeLessThanOrEqual(0);
    expect(ring.boxShadow, "second tone is an inset shadow, which cannot be clipped").toContain("inset");
    expect(ring.boxShadow).toContain("rgb(255, 255, 255)");
    expect(ring.outlineColor).toBe(RING_BLUE);

    // And the geometry that made it clip: link box inside its overflowing list.
    const fits = await page.evaluate((listSel) => {
      const a = document.activeElement.getBoundingClientRect();
      const l = document.activeElement.closest(listSel).getBoundingClientRect();
      return { overflow: getComputedStyle(document.activeElement.closest(listSel)).overflowX, left: a.left - l.left, right: l.right - a.right };
    }, SIDEBAR_LIST);
    expect(["auto", "scroll", "hidden"], "the list clips").toContain(fits.overflow);
    expect(fits.left, "link starts inside the list").toBeGreaterThanOrEqual(0);
    expect(fits.right, "link ends inside the list").toBeGreaterThanOrEqual(0);
  });

  test("a mouse click leaves the link's appearance alone", async ({ page }) => {
    await openList(page);
    await page.locator(SIDEBAR_LINK).nth(1).click();
    const ring = await ringOf(page);
    expect(ring.focusVisible, "a click does not match :focus-visible").toBe(false);
    expect(ring.boxShadow, "no ring shadow after a click").not.toContain(RING_BLUE);
    expect(ring.outlineColor).not.toBe(RING_BLUE);
  });

  test("a Publish menu item keeps its whole ring inside the clipping menu", async ({ page }) => {
    await openReadyEntry(page);
    await tabTo(page, PUBLISH_TRIGGER);
    await page.keyboard.press("Enter");
    const item = page.getByRole("menuitem", { name: /publish now/i });
    await expect(item).toBeVisible({ timeout: 5_000 });
    // Opening the menu from the keyboard moves focus onto its first item.
    await expect(item).toBeFocused();
    const ring = await ringOf(page);

    expect(ring.focusVisible, "keyboard-opened menu item matches :focus-visible").toBe(true);
    expect(ring.outlineStyle).toBe("solid");
    expect(ring.outlineWidth).toBeGreaterThanOrEqual(2);
    // Same arithmetic as the sidebar test: at or below zero the outline
    // cannot leave the item's box, so the menu's `overflow: hidden` cannot cut it.
    expect(ring.outlineOffset + ring.outlineWidth, "outline stays inside the item box").toBeLessThanOrEqual(0);
    expect(ring.boxShadow, "second tone is an inset shadow, which cannot be clipped").toContain("inset");
    expect(ring.boxShadow).toContain("rgb(255, 255, 255)");
    expect(ring.outlineColor).toBe(RING_BLUE);

    // And the geometry that made it clip: item box inside its hidden-overflow list.
    const fits = await page.evaluate((itemSel) => {
      const el = document.activeElement;
      const a = el.getBoundingClientRect();
      const list = el.parentElement;
      const l = list.getBoundingClientRect();
      return {
        isMenuItem: el.matches(itemSel),
        overflow: getComputedStyle(list).overflowX,
        left: a.left - l.left,
        right: l.right - a.right,
        top: a.top - l.top,
      };
    }, MENU_ITEM);
    expect(fits.isMenuItem).toBe(true);
    expect(["auto", "scroll", "hidden"], "the menu clips").toContain(fits.overflow);
    expect(fits.left, "item starts inside the menu").toBeGreaterThanOrEqual(0);
    expect(fits.right, "item ends inside the menu").toBeGreaterThanOrEqual(0);
    expect(fits.top, "first item sits inside the menu top").toBeGreaterThanOrEqual(0);
  });

  test("a mouse-opened menu leaves its item's appearance alone", async ({ page }) => {
    await openReadyEntry(page);
    await page.locator(PUBLISH_TRIGGER).click();
    const item = page.getByRole("menuitem", { name: /publish now/i });
    await expect(item).toBeVisible({ timeout: 5_000 });
    // Focus the item without a key press; after a mouse click that is not
    // keyboard focus, so it must not match :focus-visible or get the ring.
    await item.evaluate((el) => el.focus());
    const ring = await ringOf(page);
    expect(ring.focusVisible, "a mouse-driven focus does not match :focus-visible").toBe(false);
    expect(ring.boxShadow, "no ring shadow").not.toContain(RING_BLUE);
    expect(ring.outlineColor).not.toBe(RING_BLUE);
  });
});
