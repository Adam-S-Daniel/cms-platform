// @lane: local — drives the local test-repo /admin shell; no real GitHub
/**
 * @file e2e/cms-mobile-layout.spec.js
 *
 * Locks the responsive behaviour of admin/admin-mobile.css against
 * regression. Decap 3.15.1 is desktop-first: on an iPhone 16 (393 CSS px)
 * the shell renders ~800px wide (dead horizontal scroll), the editor is a
 * fixed side-by-side react-split-pane whose preview iframe wastes half the
 * width, the toolbar's Save/Delete controls slide off-screen, and 15px
 * inputs trigger iOS Safari's focus-zoom. admin-mobile.css overrides all
 * of that at a 768px breakpoint without forking Decap (see
 * docs/decisions/0003-extend-decap-for-mobile-instead-of-forking.md).
 *
 * The spec drives admin/index-test.html — Decap's in-browser test-repo
 * backend, so the full editor renders with no GitHub OAuth or
 * decap-server. It sets the viewport explicitly (rather than relying on
 * the project viewport) so the same assertions run on BOTH admin engines:
 * Chromium (chromium-desktop-3k, resized down) and WebKit
 * (webkit-iphone16). iOS-anything is WebKit, so the WebKit pass is the
 * load-bearing one; the Chromium pass is a cheap second engine.
 */
const { test, expect } = require("./base");

const IPHONE_16 = { width: 393, height: 852 };
const DESKTOP = { width: 1400, height: 900 };
const PHONE_390 = { width: 390, height: 844 };

const SEED_POST_SLUG = "2026-04-25-replacement-test-post-1";

async function login(page) {
  await page.addInitScript(() => {
    window.repoFiles = {
      _posts: {
        "2026-04-25-replacement-test-post-1.md": {
          content: [
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
          ].join("\n"),
        },
      },
      _tags: {},
      _projects: {},
      pages: {},
    };
    window.repoFilesUnpublished = [];
  });

  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));

  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({
    timeout: 30_000,
  });
}

async function openEditor(page) {
  await page.goto(`/admin/index-test.html#/collections/posts/entries/${SEED_POST_SLUG}`);
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
  // The split-pane + toolbar settle a beat after the editor mounts.
  await page.waitForTimeout(800);
}

test.describe(
  "CMS admin — mobile layout (iPhone 16)",
  // Tagged @admin-read: drives /admin/* but is read-only — runs on
  // chromium-desktop-3k + webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("entry editor fits the viewport with no dead horizontal scroll", async ({ page }) => {
      await page.setViewportSize(IPHONE_16);
      await login(page);
      await openEditor(page);

      // 1. The document must not scroll horizontally. overflow-x:hidden
      //    clamps scrollWidth, so this is a sanity floor; the element-edge
      //    checks below are what actually prove the layout reflowed.
      const widths = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        widths.scrollWidth,
        "Document scrolls horizontally on a phone — the shell isn't reflowing",
      ).toBeLessThanOrEqual(widths.clientWidth + 1);

      // 2. The live-preview iframe pane is dropped on mobile (the form
      //    gets the full width; /preview/ is the editor's WYSIWYG).
      const previewFrame = page.locator('[class*="PreviewPaneFrame"]');
      if (await previewFrame.count()) {
        await expect(previewFrame.first()).toBeHidden();
      }

      // 3. Every visible form field is laid out within the viewport — no
      //    field is clipped off the right edge or pushed past the left.
      const fieldOverflow = await page.evaluate(() => {
        const vw = window.innerWidth;
        const bad = [];
        for (const el of document.querySelectorAll('[class*="ControlContainer"]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > vw + 1 || r.left < -1) {
            bad.push({ right: Math.round(r.right), left: Math.round(r.left) });
          }
        }
        return bad;
      });
      expect(
        fieldOverflow,
        `Form fields overflow the viewport: ${JSON.stringify(fieldOverflow)}`,
      ).toEqual([]);
    });

    test("form inputs are ≥16px so iOS Safari doesn't zoom on focus", async ({ page }) => {
      await page.setViewportSize(IPHONE_16);
      await login(page);
      await openEditor(page);

      const tooSmall = await page.evaluate(() => {
        const out = [];
        const fields = document.querySelectorAll(
          '[class*="AppMainContainer"] input:not([type=hidden]), ' +
            '[class*="AppMainContainer"] textarea, ' +
            '[class*="AppMainContainer"] [role="textbox"]',
        );
        for (const el of fields) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // not rendered
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs < 16) out.push({ tag: el.tagName, fontSize: fs });
        }
        return out;
      });
      expect(
        tooSmall,
        `Inputs under 16px trigger iOS focus-zoom: ${JSON.stringify(tooSmall)}`,
      ).toEqual([]);
    });

    test("Save and Delete toolbar controls are on-screen and full-label", async ({ page }) => {
      await page.setViewportSize(IPHONE_16);
      await login(page);
      await openEditor(page);

      // The Save button and the "Delete published entry" control must be
      // visible AND inside the viewport (the desktop toolbar pushed them
      // off the right edge). Their full labels prove they didn't collapse
      // to a truncated sliver ("S." / "Delete …").
      for (const name of [/^Save$/, /Delete published entry/]) {
        const btn = page.getByRole("button", { name }).first();
        await expect(btn).toBeVisible();
        const box = await btn.boundingBox();
        const vw = page.viewportSize().width;
        expect(
          box.x + box.width,
          `Toolbar control ${name} is clipped off the right edge`,
        ).toBeLessThanOrEqual(vw + 1);
        expect(box.x, `Toolbar control ${name} is off the left edge`).toBeGreaterThanOrEqual(-1);
      }
    });

    test("742px: no empty band above the toolbar; list reserves room for the floating stamps", async ({
      page,
    }) => {
      // #625.10/.11 — at a ~742px window the editor sat below an empty ~65px
      // band (Decap's reserved toolbar height, left behind once the toolbar
      // goes static), and the collection list had no bottom clearance for the
      // fixed commit/platform pills, so its last row could not scroll clear.
      await page.setViewportSize({ width: 742, height: 900 });
      await login(page);
      await openEditor(page);
      const gap = await page.evaluate(() => {
        // The editor box starts where the notice banner (if any) ends; its toolbar
        // is the page header in the editor, so nothing should sit between them.
        const editor = document.querySelector('[class*="EditorContainer"]');
        const toolbar = document.querySelector('[class*="ToolbarContainer"]');
        return Math.round(
          toolbar.getBoundingClientRect().top - editor.getBoundingClientRect().top,
        );
      });
      expect(gap, `empty band above the editor toolbar: ${gap}px`).toBeLessThan(24);

      await page.goto("/admin/index-test.html#/collections/posts");
      await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
      // The two bottom-right pills + Live Preview stack reach ~ 8.5rem; the list's
      // own clearance must at least cover the 2-line pill stack (~3rem).
      const padding = await page.evaluate(() => {
        const main = document.querySelector('[class*="CollectionMain"]');
        return parseFloat(getComputedStyle(main).paddingBottom);
      });
      expect(padding, "CollectionMain bottom clearance (px)").toBeGreaterThanOrEqual(64);
    });

    // #757.1 — on a 390px phone the fixed bottom-right "Live Preview" button
    // floated over the Markdown / Rich Text toggle label and the Published
    // toggle while an editor scrolled the form. The button lives in the SHELLS
    // (admin/index.html, admin/index-local.html), not in the test-repo shell
    // this spec drives, so the shell's own element and inline styles are lifted
    // into the editor page with the real HTML parser; admin-mobile.css (linked
    // by index-test.html too) is the layer under test.
    for (const shell of ["index.html", "index-local.html"]) {
      test(`390px phone (${shell}): the Live Preview button stays off the editor toggles`, async ({
        page,
      }) => {
        await page.setViewportSize(PHONE_390);
        await login(page);
        await openEditor(page);

        const lifted = await page.evaluate(async (shellFile) => {
          const html = await (await fetch(`/admin/${shellFile}`)).text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          const link = doc.getElementById("live-preview-link");
          if (!link) return false;
          for (const style of doc.querySelectorAll("style")) {
            if (style.textContent.includes(".floating-link")) {
              document.head.appendChild(document.importNode(style, true));
            }
          }
          document.body.appendChild(document.importNode(link, true));
          return true;
        }, shell);
        expect(lifted, `admin/${shell} must carry #live-preview-link`).toBe(true);

        const button = page.getByRole("link", { name: "Live Preview" });
        await expect(button).toBeVisible();

        // Reachable and tappable: fully inside the viewport, >= 44 CSS px.
        const box = await button.boundingBox();
        const vp = page.viewportSize();
        expect.soft(box.width, "tap target width").toBeGreaterThanOrEqual(44);
        expect.soft(box.height, "tap target height").toBeGreaterThanOrEqual(44);
        expect.soft(box.x + box.width, "clipped off the right edge").toBeLessThanOrEqual(vp.width);
        expect.soft(box.y + box.height, "clipped off the bottom edge").toBeLessThanOrEqual(vp.height);

        // Scroll the whole form past the button in small steps; at every stop,
        // none of the toggle controls on screen may intersect it: the Markdown /
        // Rich Text toggle (its row, both mode labels and its switch) and the
        // Published toggle (its switch and its label chip).
        const overlaps = await page.evaluate(async () => {
          const btn = document.getElementById("live-preview-link").getBoundingClientRect();
          const editor = document.querySelector('[class*="EditorContainer"]');
          const targets = [
            ...[...editor.querySelectorAll('[class*="ToolbarToggle"]')].map((n) => ["modeToggle", n]),
            ...[...editor.querySelectorAll('button[role="switch"]')].map((n) => ["switch", n]),
            ...[...editor.querySelectorAll("label, span")]
              .filter((n) => n.children.length === 0 && n.textContent.trim() === "Published")
              .map((n) => ["publishedLabel", n]),
          ];
          const hits = [];
          for (let y = 0; y <= document.documentElement.scrollHeight; y += 20) {
            window.scrollTo(0, y);
            await new Promise((r) => requestAnimationFrame(() => r()));
            for (const [name, n] of targets) {
              const r = n.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.bottom < 0 || r.top > window.innerHeight) continue;
              const w = Math.min(r.right, btn.right) - Math.max(r.left, btn.left);
              const h = Math.min(r.bottom, btn.bottom) - Math.max(r.top, btn.top);
              if (w > 1 && h > 1) hits.push(`${name} at scrollY=${y}`);
            }
          }
          window.scrollTo(0, 0);
          return { hits, names: [...new Set(targets.map(([name]) => name))] };
        });
        expect(overlaps.names, "the toggles under test must be on the page").toEqual(
          expect.arrayContaining(["modeToggle", "switch", "publishedLabel"]),
        );
        expect(overlaps.hits, "Live Preview overlaps an editor toggle").toEqual([]);

        // With a text field focused (keyboard up) the button steps aside, and
        // comes back on blur. It keeps its accessible name either way.
        const title = page.getByLabel(/^Title$/);
        await title.focus();
        await expect(button).toBeHidden();
        await title.blur();
        await expect(button).toBeVisible();

        // Desktop keeps the labeled pill.
        await page.setViewportSize(DESKTOP);
        await expect(button).toBeVisible();
        expect(
          (await button.boundingBox()).width,
          "desktop Live Preview button lost its visible label",
        ).toBeGreaterThan(100);
      });
    }

    test("desktop layout is untouched — the preview pane still renders wide", async ({ page }) => {
      // Guard against the breakpoint creeping up and stealing the
      // side-by-side preview from desktop editors.
      await page.setViewportSize(DESKTOP);
      await login(page);
      await openEditor(page);

      const previewFrame = page.locator('[class*="PreviewPaneFrame"]').first();
      await expect(previewFrame).toBeVisible();
      const box = await previewFrame.boundingBox();
      expect(
        box.width,
        "Desktop preview pane collapsed — the mobile breakpoint is too wide",
      ).toBeGreaterThan(200);
    });
  },
);
