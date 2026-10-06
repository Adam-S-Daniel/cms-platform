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

async function login(page, { collectionLabel = "Posts" } = {}) {
  if (collectionLabel !== "Posts") {
    // Rename the seeded collection in the served config, so the editor reads
    // "Writing in <label> collection" (jodidaniel.com's longest is "Media
    // Items"). Only the collection's own 4-space `label:` line matches.
    await page.route("**/admin/config-test.yml", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /^( {4}label: )Posts$/m,
        `$1${collectionLabel}`,
      );
      await route.fulfill({ response, body });
    });
  }
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
  await expect(page.getByRole("link", { name: new RegExp(`^${collectionLabel}$`, "i") })).toBeVisible({
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

        // The label is visually clipped to a 1px box inside the circle, yet it
        // stays in the accessible name (getByRole above). An unwrapped text
        // node would spill "Live Preview" out of the 44px circle.
        const label = await button.evaluate((link) => {
          const span = link.querySelector(".floating-link-label");
          const r = span ? span.getBoundingClientRect() : null;
          const bareText = [...link.childNodes].filter(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() !== "",
          );
          return {
            hasSpan: Boolean(span),
            text: span ? span.textContent.trim() : "",
            width: r ? r.width : null,
            height: r ? r.height : null,
            bareTextNodes: bareText.length,
          };
        });
        expect(label.hasSpan, "the label must sit in .floating-link-label").toBe(true);
        expect(label.bareTextNodes, "label text outside .floating-link-label spills out").toBe(0);
        expect(label.text).toBe("Live Preview");
        expect(label.width, "label box is clipped to <= 1px").toBeLessThanOrEqual(1);
        expect(label.height, "label box is clipped to <= 1px").toBeLessThanOrEqual(1);

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

// #731 — at 390x844 the editor toolbar was three stacked rows (~165px): the
// local-mode "saves to your working copy" chip is prepended to the toolbar
// and took the title's width, so "Writing in Media Items collection" wrapped
// to 4-5 lines with the avatar and its divider on top of it, and the buttons
// were 36px tall. Both the short and the longest real label are covered.
//
// A describe of its own, not part of the serial one above: serial skips the
// later cases after the first failure, and each case's verdict should stand
// alone.
// 320px has no height assertions (Delete wraps below Save and Published
// there); it is the width where the title does not fit, so it proves the
// ellipsis and that the title stays inside its own link.
test.describe(
  "CMS admin — phone toolbar (#731)",
  { tag: ["@admin-read"] },
  () => {
    for (const { collectionLabel, width } of [
      { collectionLabel: "Posts", width: 390 },
      { collectionLabel: "Media Items", width: 390 },
      { collectionLabel: "Media Items", width: 320 },
    ]) {
      const tall = width >= 375;
      test(`${width}px: one-line title, no overlap, 44px controls ("${collectionLabel}")`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: PHONE_390.height });
        await login(page, { collectionLabel });
        await openEditor(page);

        const fullTitle = `Writing in ${collectionLabel} collection`;
        const measure = () =>
          page.evaluate(() => {
            const rect = (el) => {
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
              };
            };
            const one = (sel, root = document) => root.querySelector(sel);
            const toolbar = one(
              '[class*="EditorContainer"] > [class*="ToolbarContainer"]',
            );
            const title = one('[class*="BackCollection"]', toolbar);
            const dropdown = one(
              '[class*="PublishedToolbarButton"]',
              toolbar,
            );
            const hits = (el) => {
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(
                r.left + r.width / 2,
                r.top + r.height / 2,
              );
              return !!hit && el.contains(hit);
            };
            const controls = {
              back: one('[class*="ToolbarSectionBackLink"]', toolbar),
              avatar: one('[class*="AvatarDropdownButton"]', toolbar),
              save: one('[class*="SaveButton"]', toolbar),
              published: dropdown,
              delete: one('[class*="DeleteButton"]', toolbar),
            };
            const boxes = {
              arrow: rect(one('[class*="BackArrow"]', toolbar)),
              title: rect(title),
              status: rect(one('[class*="BackStatus"]', toolbar)),
              chip: rect(document.getElementById("cms-local-save-indicator")),
            };
            const controlInfo = {};
            for (const [name, el] of Object.entries(controls)) {
              boxes[name] = rect(el);
              controlInfo[name] = { reachable: hits(el) };
            }
            const cs = getComputedStyle(title);
            return {
              toolbar: rect(toolbar),
              boxes,
              controlInfo,
              titleText: title.textContent.trim(),
              titleStyle: {
                whiteSpace: cs.whiteSpace,
                textOverflow: cs.textOverflow,
              },
              // A second line would at least double the height of a ~1.2em line.
              titleOneLine:
                title.getBoundingClientRect().height <
                parseFloat(cs.fontSize) * 1.6,
              titleScrollWidth: title.scrollWidth,
              titleClientWidth: title.clientWidth,
              meta: rect(one('[class*="ToolbarSectionMeta"]', toolbar)),
              back: rect(controls.back),
              viewport: window.innerWidth,
            };
          });

        // A box that collapsed to nothing (the title squeezed to 0px wide)
        // overlaps nothing, so it must be named on its own.
        const collapsed = (boxes) =>
          Object.entries(boxes)
            .filter(
              ([, b]) => !b || b.right - b.left < 1 || b.bottom - b.top < 1,
            )
            .map(([n]) => n);
        const overlaps = (boxes) => {
          const names = Object.keys(boxes).filter(
            (n) => boxes[n] && !["back"].includes(n),
          );
          const bad = [];
          for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
              const a = boxes[names[i]];
              const b = boxes[names[j]];
              const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (w > 0.5 && h > 0.5) bad.push(`${names[i]} x ${names[j]}`);
            }
          }
          return bad;
        };

        // Without the local chip (the production shell): two rows of 44px.
        // 96 = 2 x 44 plus 8px of slack for sub-pixel text metrics.
        let m = await measure();
        if (tall) {
          expect(
            m.toolbar.bottom - m.toolbar.top,
            "toolbar height without the chip",
          ).toBeLessThanOrEqual(96);
        }

        // With the real local-mode shim loaded, as index-local.html does. The
        // chip sits on its own thin line under the buttons: 44 + 44 + ~27 = 115,
        // so 124 allows it and still fails the old ~165px stack.
        await page.addScriptTag({ url: "/admin/local-save-indicator.js" });
        await expect(page.locator("#cms-local-save-indicator")).toBeVisible();
        m = await measure();
        if (tall) {
          expect(
            m.toolbar.bottom - m.toolbar.top,
            "toolbar height with the local chip",
          ).toBeLessThanOrEqual(124);
        }

        // One line, ellipsis when it does not fit, full text still in the DOM
        // (so the link's accessible name is the whole title).
        expect(m.titleText).toBe(fullTitle);
        expect(m.titleStyle).toEqual({
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        });
        expect(m.titleOneLine, "title wraps to more than one line").toBe(
          true,
        );
        await expect(
          page.getByRole("link", { name: new RegExp(fullTitle) }),
        ).toBeVisible();

        // The title is actually visible: at least its own text width, or 120px
        // when it has to truncate (a title squeezed to 0px is "one line" too).
        const titleWidth = m.boxes.title.right - m.boxes.title.left;
        expect(
          titleWidth,
          `title is ${titleWidth}px wide; its text is ${m.titleScrollWidth}px`,
        ).toBeGreaterThanOrEqual(Math.min(m.titleScrollWidth, 120));
        expect(
          m.titleClientWidth,
          "title clipped to nothing",
        ).toBeGreaterThanOrEqual(Math.min(m.titleScrollWidth, 120));
        expect(collapsed(m.boxes), "boxes with no area").toEqual([]);
        // It stays inside its own link, so it cannot run under the avatar.
        expect(
          m.boxes.title.right,
          "title spills out of the back link",
        ).toBeLessThanOrEqual(m.back.right + 1);
        if (width < 360) {
          // Too narrow for the text: it must be cut with an ellipsis, not wrapped.
          expect(
            m.titleScrollWidth,
            "320px title should truncate",
          ).toBeGreaterThan(m.titleClientWidth);
        }

        // No box covers another, and the divider (the avatar section's left
        // border) is not drawn through the back link's text.
        expect(overlaps(m.boxes), JSON.stringify(m.boxes)).toEqual([]);
        expect(
          m.back.right,
          "back link runs under the avatar section",
        ).toBeLessThanOrEqual(m.meta.left + 1);

        // Every control is a 44px touch target, on-screen, and hit-testable.
        for (const name of [
          "back",
          "avatar",
          "save",
          "published",
          "delete",
        ]) {
          const b = m.boxes[name];
          expect(b.bottom - b.top, `${name} height`).toBeGreaterThanOrEqual(
            43.5,
          );
          expect(b.right - b.left, `${name} width`).toBeGreaterThanOrEqual(
            43.5,
          );
          expect(b.left, `${name} off the left edge`).toBeGreaterThanOrEqual(
            -1,
          );
          expect(b.right, `${name} off the right edge`).toBeLessThanOrEqual(
            m.viewport + 1,
          );
          expect(
            m.controlInfo[name].reachable,
            `${name} is covered by another element`,
          ).toBe(true);
        }

        // Publish stays pinned while the form scrolls (#731, PR #748).
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
        await expect
          .poll(() => page.evaluate(() => window.scrollY))
          .toBeGreaterThan(200);
        m = await measure();
        expect(
          m.toolbar.top,
          "toolbar left the top of the screen",
        ).toBeLessThanOrEqual(1);
        expect(
          m.controlInfo.published.reachable,
          "Publish is covered while scrolled",
        ).toBe(true);
      });
    }
  },
);

// UX round 4, triage package 7: at 820px (an iPad in portrait) Decap's single
// 66px desktop toolbar applies, and the Back link's title block never shrank
// below its longest word. "Writing in <label> collection" and the saved-state
// line wrapped to four lines clipped at the top of the bar, and a long
// collection label ("Accomplishments") made the toolbar 20px wider than the
// viewport, so the avatar sat past the right edge. The one-line ellipsis rules
// (#731) now reach 1100px, and the local-mode chip shrinks instead of taking
// 260px from the title. The chip is the REAL shim, loaded the way
// index-local.html loads it. Own describe, like the phone one: a failure here
// must not skip the other cases.
test.describe(
  "CMS admin — tablet toolbar (820px)",
  { tag: ["@admin-read"] },
  () => {
    for (const collectionLabel of ["Posts", "Accomplishments"]) {
      for (const edited of [false, true]) {
        test(`one-line Back link, nothing past the right edge ("${collectionLabel}", ${edited ? "unsaved edit" : "published entry"})`, async ({
          page,
        }) => {
          await page.setViewportSize({ width: 820, height: 1180 });
          await login(page, { collectionLabel });
          await openEditor(page);
          if (edited) {
            await page.getByLabel(/^Title$/).fill("Replacement test post 1, edited");
            await expect(
              page.locator('[class*="BackStatus"]'),
            ).toHaveText(/unsaved/i);
          }

          const measure = () =>
            page.evaluate(() => {
              const toolbar = document.querySelector(
                '[class*="EditorContainer"] > [class*="ToolbarContainer"]',
              );
              const right = (el) => (el ? el.getBoundingClientRect().right : null);
              const left = (el) => (el ? el.getBoundingClientRect().left : null);
              const oneLine = (el) =>
                el.getBoundingClientRect().height <
                parseFloat(getComputedStyle(el).fontSize) * 1.6;
              const title = toolbar.querySelector('[class*="BackCollection"]');
              const status = toolbar.querySelector('[class*="BackStatus"]');
              const back = toolbar.querySelector('[class*="ToolbarSectionBackLink"]');
              const chip = document.getElementById("cms-local-save-indicator");
              return {
                viewport: window.innerWidth,
                scrollWidth: toolbar.scrollWidth,
                clientWidth: toolbar.clientWidth,
                docScrollWidth: document.documentElement.scrollWidth,
                avatarRight: right(
                  toolbar.querySelector('[class*="AvatarDropdownButton"]'),
                ),
                titleText: title.textContent.trim(),
                titleOneLine: oneLine(title),
                statusOneLine: oneLine(status),
                backHeight: back.getBoundingClientRect().height,
                toolbarHeight: toolbar.getBoundingClientRect().height,
                titleRight: right(title),
                statusRight: right(status),
                backRight: right(back),
                chipLeft: left(chip),
                chipRight: right(chip),
              };
            });

          const check = (m, what) => {
            expect(m.scrollWidth, `${what}: toolbar wider than itself`).toBeLessThanOrEqual(
              m.clientWidth,
            );
            expect(m.docScrollWidth, `${what}: page scrolls sideways`).toBeLessThanOrEqual(
              m.viewport,
            );
            expect(
              m.avatarRight,
              `${what}: avatar past the right edge`,
            ).toBeLessThanOrEqual(m.viewport);
            // Title and saved-state line: one line each, so the link is two
            // lines at most and never taller than the bar.
            expect(m.titleOneLine, `${what}: title wraps`).toBe(true);
            expect(m.statusOneLine, `${what}: saved-state line wraps`).toBe(true);
            expect(m.backHeight, `${what}: Back link outgrew the bar`).toBeLessThanOrEqual(
              m.toolbarHeight + 1,
            );
            expect(m.titleRight, `${what}: title spills out of its link`).toBeLessThanOrEqual(
              m.backRight + 1,
            );
            expect(m.statusRight, `${what}: status spills out of its link`).toBeLessThanOrEqual(
              m.backRight + 1,
            );
          };

          // The production shell: no chip.
          let m = await measure();
          expect(m.titleText).toBe(`Writing in ${collectionLabel} collection`);
          check(m, "without the chip");

          // The local shell: the real chip shim, 260px of nowrap text.
          await page.addScriptTag({ url: "/admin/local-save-indicator.js" });
          await expect(page.locator("#cms-local-save-indicator")).toBeVisible();
          m = await measure();
          check(m, "with the local chip");
          expect(m.chipLeft, "chip off the left edge").toBeGreaterThanOrEqual(0);
          expect(m.chipRight, "chip past the right edge").toBeLessThanOrEqual(m.viewport);
          await expect(
            page.getByRole("link", { name: new RegExp(m.titleText) }),
          ).toBeVisible();
        });
      }
    }
  },
);
