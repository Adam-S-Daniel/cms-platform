// @lane: local — drives the local test-repo /admin shell; no real GitHub
/**
 * @file e2e/cms-mobile-layout.spec.js
 *
 * Locks the responsive behavior of admin/admin-mobile.css against
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
const { expectReachable } = require("./ui-visibility");

const IPHONE_16 = { width: 393, height: 852 };
const DESKTOP = { width: 1400, height: 900 };
const PHONE_390 = { width: 390, height: 844 };

// Production puts Publish in a sibling bar, rather than Decap's toolbar.
// Use the real served shims and shared status model with a fixed draft
// snapshot: the test backend has no GitHub PR, and this layout test must
// neither poll GitHub nor send a publish request.
async function installProductionPublish(page) {
  const githubRequests = [];
  await page.route("https://api.github.com/**", async (route) => {
    githubRequests.push(route.request().method());
    await route.abort();
  });
  await page.evaluate(() => {
    window.CMSPublishProgress = {
      get: () => ({ ready: true, facts: { hasOpenPr: true, armed: false } }),
      subscribe: () => {},
    };
    window.CMS_SITE_ORIGIN = "https://example.com";
  });
  await page.addScriptTag({ url: "/admin/publish-button.js" });
  await expect(page.locator("#cms-publish-state")).toHaveAttribute("data-state", "draft");
  await expect(page.locator("#cms-publish-button")).toBeEnabled();
  return githubRequests;
}

async function expectPinnedPublish(page) {
  // Do not use expectReachable here: its scrollIntoView could conceal a
  // bar that scrolled away. Probe the position the editor actually sees.
  await expect(async () => {
    const geometry = await page.evaluate(() => {
      const toolbar = document.querySelector('[class*="EditorContainer"] > [class*="ToolbarContainer"]');
      const bar = document.getElementById("cms-publish-state");
      const toolbarBox = toolbar.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      const style = getComputedStyle(bar);
      const controls = [...bar.querySelectorAll("button")].map((button) => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          name: button.textContent,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          reachable: Boolean(hit && button.contains(hit)),
        };
      });
      return {
        scrollY: window.scrollY,
        toolbarTop: toolbarBox.top,
        toolbarHeight: toolbarBox.height,
        toolbarBottom: toolbarBox.bottom,
        barTop: barBox.top,
        offset: parseFloat(style.top),
        position: style.position,
        controls,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    });
    expect(geometry.scrollY, "the form must really scroll").toBeGreaterThan(400);
    expect(geometry.position).toBe("sticky");
    expect(geometry.toolbarTop).toBeCloseTo(0, 0);
    expect(geometry.offset).toBeCloseTo(geometry.toolbarHeight, 0);
    expect(geometry.barTop, "the Publish bar overlaps the toolbar").toBeGreaterThanOrEqual(geometry.toolbarBottom - 0.5);
    expect(geometry.barTop).toBeCloseTo(geometry.toolbarBottom, 0);
    expect(geometry.controls.length).toBeGreaterThan(0);
    for (const control of geometry.controls) {
      expect(control.left, `${control.name} left edge`).toBeGreaterThanOrEqual(0);
      expect(control.right, `${control.name} right edge`).toBeLessThanOrEqual(geometry.width);
      expect(control.top, `${control.name} top edge`).toBeGreaterThanOrEqual(geometry.toolbarBottom - 0.5);
      expect(control.bottom, `${control.name} bottom edge`).toBeLessThanOrEqual(geometry.height);
      expect(control.width, `${control.name} tap target width`).toBeGreaterThanOrEqual(44);
      expect(control.height, `${control.name} tap target height`).toBeGreaterThanOrEqual(44);
      expect(control.reachable, `${control.name} is covered after scrolling`).toBe(true);
    }
  }).toPass({ timeout: 15_000 });
}

async function expectCompactNativeToolbar(page, { chip = false, scrolled = false, workflow = false } = {}) {
  await expect(page.getByRole("link", { name: /^Back to Writing in / })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account options dropdown", exact: true })).toBeVisible();
  await expect(async () => {
    const layout = await page.evaluate(() => {
      const toolbar = document.querySelector('[class*="EditorContainer"] > [class*="ToolbarContainer"]');
      const back = toolbar.querySelector('[class*="ToolbarSectionBackLink"]');
      const metadata = back.querySelector(':scope > :not([class*="BackArrow"])');
      const rect = toolbar.getBoundingClientRect();
      const nodes = [...new Set([back, ...toolbar.querySelectorAll('button, [role="button"], [aria-haspopup="true"]')])];
      const visible = nodes.filter((node) => {
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const overlaps = [];
      for (let i = 0; i < visible.length; i++) {
        for (let j = i + 1; j < visible.length; j++) {
          const a = visible[i];
          const b = visible[j];
          if (a.contains(b) || b.contains(a)) continue;
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          if (Math.min(ar.right, br.right) - Math.max(ar.left, br.left) > 0.5 &&
              Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top) > 0.5) {
            overlaps.push([a.textContent.trim(), b.textContent.trim()]);
          }
        }
      }
      const controls = visible.map((node) => {
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { name: node.getAttribute("aria-label") || node.textContent.trim(), left: r.left, right: r.right, top: r.top, width: r.width, height: r.height, reachable: Boolean(hit && node.contains(hit)) };
      });
      const carets = visible.filter((node) => node.matches('[role="button"][aria-haspopup="true"]') && node.closest('[class*="ToolbarSectionMain"]')).map((node) => {
        const rect = node.getBoundingClientRect();
        const arrow = getComputedStyle(node, "::after");
        const border = getComputedStyle(node).borderRightWidth;
        const arrowWidth = parseFloat(arrow.width) + (arrow.boxSizing === "border-box" ? 0 :
          parseFloat(arrow.paddingLeft) + parseFloat(arrow.paddingRight) + parseFloat(arrow.borderLeftWidth) + parseFloat(arrow.borderRightWidth));
        const caretRight = rect.right - parseFloat(border) - parseFloat(arrow.right);
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const rights = [];
        let text;
        while ((text = walker.nextNode())) {
          if (!text.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          rights.push(range.getBoundingClientRect().right);
        }
        return { name: node.textContent.trim(), textRight: Math.max(...rights), caretLeft: caretRight - arrowWidth, caretRight, triggerRight: rect.right };
      });
      const metaStyle = getComputedStyle(metadata);
      const status = toolbar.querySelector('[class*="StatusButton"]:not([data-one-door-hidden="1"])');
      const workflow = Boolean(status && getComputedStyle(status).display !== "none");
      return { height: rect.height, top: rect.top, controls, overlaps, carets, workflow, viewport: innerWidth, metadata: { width: metaStyle.width, height: metaStyle.height, clipPath: metaStyle.clipPath, position: metaStyle.position, display: metaStyle.display } };
    });
    expect(layout.workflow, "only a saved rehearsal workflow draft may use the extra rows").toBe(workflow);
    expect(layout.height, "native controls need one row; rehearsal workflow controls may wrap").toBeLessThanOrEqual(workflow ? (chip ? 164 : 136) : (chip ? 76 : 48));
    expect(layout.controls.length, "native Back, primary action, and account controls must be present").toBeGreaterThanOrEqual(3);
    expect(layout.overlaps, "native controls must not paint over each other").toEqual([]);
    for (const caret of layout.carets) {
      expect(caret.textRight, `${caret.name} label must stay clear of its dropdown caret`).toBeLessThanOrEqual(caret.caretLeft - 2);
      expect(caret.caretRight, `${caret.name} caret must stay inside its trigger`).toBeLessThanOrEqual(caret.triggerRight);
    }
    expect(layout.metadata).toEqual({ width: "1px", height: "1px", clipPath: "inset(50%)", position: "absolute", display: expect.not.stringMatching(/^none$/) });
    const firstTop = layout.controls[0].top;
    for (const control of layout.controls) {
      if (!workflow) expect(control.top, `${control.name} needs the same native row`).toBeCloseTo(firstTop, 0);
      expect(control.width, `${control.name} target width`).toBeGreaterThanOrEqual(43.5);
      expect(control.height, `${control.name} target height`).toBeGreaterThanOrEqual(43.5);
      expect(control.left, `${control.name} left edge`).toBeGreaterThanOrEqual(0);
      expect(control.right, `${control.name} right edge`).toBeLessThanOrEqual(layout.viewport);
      expect(control.reachable, `${control.name} is covered`).toBe(true);
    }
    if (scrolled) expect(layout.top, "native toolbar must stay pinned").toBeCloseTo(0, 0);
  }).toPass({ timeout: 15_000 });
}

const SEED_POST_SLUG = "2026-04-25-replacement-test-post-1";
// Decap's "+ New" button on a collection list (absent from the entry editor).
const NEW_BUTTON = '[class*="CollectionTopNewButton"]';

async function login(page, { collectionLabel = "Posts", publishMode = "editorial_workflow" } = {}) {
  if (collectionLabel !== "Posts" || publishMode !== "editorial_workflow") {
    // Rename the seeded collection in the served config, so the editor reads
    // "Writing in <label> collection" (jodidaniel.com's longest is "Media
    // Items"). Only the collection's own 4-space `label:` line matches.
    await page.route("**/admin/config-test.yml", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /^( {4}label: )Posts$/m,
        `$1${collectionLabel}`,
      ).replace(/^publish_mode: editorial_workflow$/m, `publish_mode: ${publishMode}`);
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
  await waitForNativeViewLiveHidden(page);
}

test.describe("CMS admin — production Publish bar (#731)", { tag: ["@admin-read"] }, () => {
  for (const width of [320, 390]) {
    test(`${width}px: production Publish and confirmation stay below the scrolling toolbar`, async ({ page }) => {
      await page.setViewportSize({ width, height: PHONE_390.height });
      await login(page, { collectionLabel: "Media Items" });
      await openEditor(page);
      await waitForNativeViewLiveHidden(page);
      const githubRequests = await installProductionPublish(page);
      const bar = page.locator("#cms-publish-state");
      await expect(bar).toHaveCSS("background-color", "rgb(253, 243, 216)");
      expect(githubRequests, "layout must never read or publish through GitHub").toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 700));
      await expectPinnedPublish(page);

      // The pinned bar must stay below the toolbar's stacking layer too:
      // native entry and account menus extend into its rectangle.
      for (const trigger of [
        page.getByRole("button", { name: "Published", exact: true }),
        page.getByRole("button", { name: "Account options dropdown", exact: true }),
      ]) {
        await trigger.click();
        const items = page.locator('[role="menuitem"]:visible');
        await expect(items.first()).toBeVisible();
        await expect(async () => {
          const hits = await items.evaluateAll((nodes) => nodes.map((node) => {
            const r = node.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { name: node.textContent.trim(), reachable: Boolean(hit && node.contains(hit)) };
          }));
          expect(hits.length, "a native toolbar menu must be open").toBeGreaterThan(0);
          for (const item of hits) expect(item.reachable, `${item.name} is covered by the Publish bar`).toBe(true);
        }).toPass({ timeout: 15_000 });
        await trigger.click();
        await expect(items).toHaveCount(0);
      }

      // Open only the inline confirmation. Never click Yes: no request to
      // publish, GitHub read, or real credential is needed to test layout.
      await page.locator("#cms-publish-button").click();
      await expect(bar.getByRole("button", { name: "Yes, publish", exact: true })).toBeVisible();
      await expectPinnedPublish(page);
      await bar.getByRole("button", { name: "Cancel", exact: true }).click();

      // index-local.html adds a chip after mounting the toolbar. Its real
      // shim changes the row count, so the offset must update without a
      // route change. Resizing keeps the measured offset aligned while the
      // native controls retain one row.
      const toolbar = page.locator('[class*="EditorContainer"] > [class*="ToolbarContainer"]');
      const initialHeight = (await toolbar.boundingBox()).height;
      await page.addScriptTag({ url: "/admin/local-save-indicator.js" });
      await expect(page.locator("#cms-local-save-indicator")).toBeVisible();
      await expect.poll(async () => (await toolbar.boundingBox()).height).toBeGreaterThan(initialHeight);
      await expectPinnedPublish(page);
      if (width === 390) {
        await page.setViewportSize({ width: 320, height: PHONE_390.height });
        await expectPinnedPublish(page);
      }

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expectPinnedPublish(page);

      // A state-model transition can leave a control in an otherwise idle
      // row. Exercise that CSS path with the real button still in its slot:
      // idle has an inline transparent background, but fields cannot show
      // through a sticky action row. Restore the actual model afterward.
      await page.evaluate(() => {
        window.__mobileLayoutDerive = window.CMSEntryStatus.derive;
        window.CMSEntryStatus.derive = () => window.__mobileLayoutDerive({});
        window.dispatchEvent(new Event("resize"));
      });
      await expect(bar).toHaveAttribute("data-state", "idle");
      expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(
        await bar.evaluate((el) => el.style.backgroundColor),
      );
      await expect(bar).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expectPinnedPublish(page);
      await page.evaluate(() => {
        window.CMSEntryStatus.derive = window.__mobileLayoutDerive;
        delete window.__mobileLayoutDerive;
        window.dispatchEvent(new Event("resize"));
      });
      await expect(bar).toHaveAttribute("data-state", "draft");
      await expect(bar).toHaveCSS("background-color", "rgb(253, 243, 216)");
      expect(githubRequests, "layout must never read or publish through GitHub").toEqual([]);
    });
  }

  for (const width of [601, 1400]) {
    test(`${width}px: production Publish bar keeps its ordinary desktop flow`, async ({ page }) => {
      await page.setViewportSize({ width, height: DESKTOP.height });
      await login(page);
      await openEditor(page);
      const githubRequests = await installProductionPublish(page);
      const bar = page.locator("#cms-publish-state");
      await expect(bar).toHaveCSS("position", "static");
      await expect(bar).toHaveCSS("top", "auto");
      await expect(bar).toHaveCSS("background-color", "rgb(253, 243, 216)");
      await expectReachable(page, page.locator("#cms-publish-button"), "desktop Publish");
      expect(githubRequests, "layout must never read or publish through GitHub").toEqual([]);
    });
  }
});

// Decap's native "View Live" toolbar anchor is hidden by
// admin/native-preview-href.js, a deferred shim that re-hides it from a
// MutationObserver + requestAnimationFrame after each toolbar render. Until
// that pass runs, the visible anchor adds a native action, so measuring the
// toolbar immediately after the editor mounts
// races the shim on a slow WebKit run. The shim's own signal is the
// `data-native-view-live-hidden` marker plus a computed display:none; wait for
// every native anchor to show both before measuring. A toolbar with no
// native anchor has nothing to wait for. The height assertions stay strict:
// a toolbar that genuinely exceeds its allowed rows still fails after the wait.
async function waitForNativeViewLiveHidden(page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const excluded = new Set([
            "cms-live-url-banner-link",
            "live-preview-link",
            "cms-commit-pill",
            "cms-prod-status-pill",
            "cms-preview-build-pill",
          ]);
          const pending = [];
          for (const tb of document.querySelectorAll('[class*="oolbar"]')) {
            for (const a of tb.querySelectorAll('a[target="_blank"][rel*="noopener"][href]')) {
              if (excluded.has(a.id)) continue;
              const hidden =
                a.getAttribute("data-native-view-live-hidden") === "1" &&
                getComputedStyle(a).display === "none";
              if (!hidden) pending.push(a.textContent.trim() || a.getAttribute("href"));
            }
          }
          return pending;
        }),
      {
        message: "native View Live anchor was never hidden by native-preview-href.js",
        timeout: 30_000,
      },
    )
    .toEqual([]);
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

    test("Save and Delete toolbar controls are on-screen with full accessible names", async ({ page }) => {
      await page.setViewportSize(IPHONE_16);
      await login(page);
      await openEditor(page);

      // The Save button and the "Delete published entry" control must be
      // visible AND inside the viewport (the desktop toolbar pushed them
      // off the right edge). Delete's phone icon keeps its full accessible
      // name, while Save keeps its visible label.
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

      // Leave the editor by hash, not page.goto: a reload with the list route
      // in the URL starts single-entry-collection-shortcut.js's 700 ms timer at
      // first paint (see the Reviews nav test below), and on a slow runner it
      // jumps back into the one seeded entry. An arrival from the collection's
      // own entry is the exit that shim leaves alone.
      await page.evaluate(() => {
        location.hash = "#/collections/posts";
      });
      await expect(page.locator(NEW_BUTTON)).toBeVisible({ timeout: 60_000 });
      // The two bottom-right pills + Live Preview stack reach ~ 8.5rem; the list's
      // own clearance must at least cover the 2-line pill stack (~3rem).
      const padding = await page.evaluate(() => {
        const main = document.querySelector('[class*="CollectionMain"]');
        return parseFloat(getComputedStyle(main).paddingBottom);
      });
      expect(padding, "CollectionMain bottom clearance (px)").toBeGreaterThanOrEqual(64);
    });

    // #645 — the eye ("Toggle preview") used to toggle a pane rule 4 hides, so
    // it did nothing on a phone. It now switches to a full-width preview, and
    // the eye or "Back to editing" returns to the form.
    async function expectPreviewView(page) {
      const frame = page.locator('[class*="PreviewPaneFrame"]').first();
      await expect(frame).toBeVisible();
      const box = await frame.boundingBox();
      const vw = page.viewportSize().width;
      expect(box.width, "preview fills the phone width").toBeGreaterThan(vw - 8);
      expect(box.height, "preview has a usable height").toBeGreaterThan(300);
      await expect(page.getByLabel(/^Title$/)).toBeHidden();
      await expect(
        page.frameLocator('[class*="PreviewPaneFrame"]').getByText("Replacement test post 1").first(),
      ).toBeVisible();
      const back = page.getByRole("button", { name: "Back to editing" });
      await expectReachable(page, back, "Back to editing");
      await expectReachable(page, page.getByRole("button", { name: "Toggle preview" }), "eye toggle");
      return back;
    }

    async function expectFormView(page) {
      await expect(page.getByLabel(/^Title$/)).toBeVisible();
      await expect(page.locator('[class*="PreviewPaneFrame"]').first()).toBeHidden();
      await expect(page.getByRole("button", { name: "Back to editing" })).toBeHidden();
    }

    test("#645: the eye shows a full-width preview; the eye or Back returns to the form", async ({
      page,
    }) => {
      await page.setViewportSize(IPHONE_16);
      await login(page);
      await openEditor(page);
      await expectFormView(page);

      const eye = page.getByRole("button", { name: "Toggle preview" });
      await eye.click();
      const back = await expectPreviewView(page);

      await back.click();
      await expectFormView(page);

      await eye.click();
      await expectPreviewView(page);
      await eye.click();
      await expectFormView(page);
    });

    test("#645: one tap previews even when Decap's preview was switched off", async ({ page }) => {
      // A stored `cms.preview-visible=false` (the eye turned off on a desktop)
      // means Decap renders no preview pane at all until the eye is tapped.
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("cms.preview-visible", "false");
        } catch (e) {
          /* storage blocked: the default (on) path is covered above */
        }
      });
      await page.setViewportSize(IPHONE_16);
      await login(page);
      await openEditor(page);
      await expectFormView(page);

      await page.getByRole("button", { name: "Toggle preview" }).click();
      const back = await expectPreviewView(page);
      await back.click();
      await expectFormView(page);
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

// #731 — native Back, Save, Published/Delete, and account controls share
// one 44px phone row. Long collection names remain in the Back link's
// accessible name; local-mode details get their own line underneath.
test.describe("CMS admin — phone toolbar (#731)", { tag: ["@admin-read"] }, () => {
  test.describe.configure({ timeout: 180_000 });
  for (const { collectionLabel, width } of [
    { collectionLabel: "Posts", width: 390 },
    { collectionLabel: "Media Items", width: 390 },
    { collectionLabel: "Media Items", width: 320 },
  ]) {
    test(`${width}px: one native row, full accessible names, 44px controls ("${collectionLabel}")`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: PHONE_390.height });
      await login(page, { collectionLabel });
      await openEditor(page);
      await expectCompactNativeToolbar(page);
      if (width === 390 && collectionLabel === "Media Items") {
        await page.screenshot({ path: testInfo.outputPath("phone-toolbar-published.png") });
      }
      await expect(page.getByRole("link", { name: new RegExp(`Writing in ${collectionLabel} collection`) })).toBeVisible();
      const remove = page.getByRole("button", { name: "Delete published entry", exact: true });
      await expect(remove).toBeVisible();
      const icon = await remove.evaluate((button) => {
        const style = getComputedStyle(button, "::after");
        return { content: style.content, width: style.width, height: style.height, mask: style.maskImage || style.webkitMaskImage };
      });
      expect(icon.content).toBe('""');
      expect(icon.width).toBe("18px");
      expect(icon.height).toBe("18px");
      expect(icon.mask).toContain("data:image/svg+xml,");

      // Native Delete still opens its confirmation, and dismissing it leaves
      // the fixture intact. No deletion, publish, or GitHub operation occurs.
      const dialogPromise = page.waitForEvent("dialog");
      const click = remove.click();
      const dialog = await dialogPromise;
      expect(dialog.type()).toBe("confirm");
      await dialog.dismiss();
      await click;
      await expect(page.getByLabel(/^Title$/)).toHaveValue("Replacement test post 1");

      await page.addScriptTag({ url: "/admin/local-save-indicator.js" });
      await expect(page.locator("#cms-local-save-indicator")).toBeVisible();
      await expectCompactNativeToolbar(page, { chip: true });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
      await expectCompactNativeToolbar(page, { chip: true, scrolled: true });
    });
  }
});

test.describe("CMS admin — compact phone Save states (#731)", { tag: ["@admin-read"] }, () => {
  test.describe.configure({ timeout: 180_000 });
  for (const publishMode of ["simple", "editorial_workflow"]) {
    for (const width of [320, 390]) {
      test(`${width}px ${publishMode}: native ${publishMode === "simple" ? "Publish" : "Save"} works for edits and new entries`, async ({ page }, testInfo) => {
        await page.clock.setFixedTime(new Date("2026-04-25T20:33:00Z"));
        await page.setViewportSize({ width, height: PHONE_390.height });
        const githubRequests = [];
        await page.route("https://api.github.com/**", async (route) => {
          githubRequests.push(route.request().method());
          await route.abort();
        });
        await login(page, { collectionLabel: "Media Items", publishMode });
        await openEditor(page);
        await expectCompactNativeToolbar(page);
        const title = page.getByLabel(/^Title$/);
        const save = page.getByRole("button", { name: publishMode === "simple" ? "Publish" : "Save", exact: true });
        await title.fill("Edited phone fixture");
        await title.blur();
        await expect(save).toBeEnabled();
        await expect(page.locator('[class*="BackStatus"]')).toHaveText(/unsaved/i);
        await expectCompactNativeToolbar(page);
        await save.click();
        if (publishMode === "simple") {
          await page.getByRole("menuitem", { name: "Publish now", exact: true }).click();
          await expect(page.locator('[class*="BackStatus"]')).toHaveText(/saved/i);
        } else {
          await expect(save).toBeDisabled();
        }
        await expect(title).toHaveValue("Edited phone fixture");
        await expect.poll(() => page.evaluate(() => JSON.stringify([window.repoFiles, Object.values(window.repoFilesUnpublished || {})]).includes("Edited phone fixture"))).toBe(true);
        await expectCompactNativeToolbar(page, { workflow: publishMode === "editorial_workflow" });
        if (publishMode === "editorial_workflow") {
          // Production removes its Status control through the served shim.
          // The hidden marker must disable the rehearsal-only wrap rule.
          await page.addScriptTag({ url: "/admin/one-door-publish.js" });
          await expect(page.locator('[class*="StatusButton"]')).toHaveAttribute("data-one-door-hidden", "1");
          const productionGitHubRequests = await installProductionPublish(page);
          await expectCompactNativeToolbar(page);
          expect(productionGitHubRequests, "production layout must not poll or publish").toEqual([]);
        }

        await page.goto("/admin/index-test.html#/collections/posts/new");
        await expect(title).toBeVisible({ timeout: 60_000 });
        await expect(title).toHaveValue("");
        await page.getByLabel(/^Date$/).fill("2026-04-25T16:33");
        await waitForNativeViewLiveHidden(page);
        await expectCompactNativeToolbar(page);
        if (width === 320) {
          await page.screenshot({ path: testInfo.outputPath("phone-toolbar-new-entry.png") });
        }
        await title.fill("New phone fixture");
        await page.getByRole("textbox", { name: "Body", exact: true }).fill("A deterministic fixture body.");
        await title.blur();
        await expect(save).toBeEnabled();
        await expectCompactNativeToolbar(page);
        await save.click();
        if (publishMode === "simple") {
          await page.getByRole("menuitem", { name: "Publish now", exact: true }).click();
          await expect(page.locator('[class*="BackStatus"]')).toHaveText(/saved/i);
        } else {
          await expect(save).toBeDisabled();
        }
        await expect.poll(() => page.evaluate(() => JSON.stringify([window.repoFiles, Object.values(window.repoFilesUnpublished || {})]).includes("New phone fixture"))).toBe(true);
        // The new-entry route keeps its compact controls after the first save;
        // workflow Status belongs to the existing draft editor checked above.
        await expectCompactNativeToolbar(page);
        expect(githubRequests, "the test backend must never reach GitHub").toEqual([]);
      });
    }
  }
});

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

// Owner request (approving visual-regression changes from a phone): rule 9
// hides the floating Reviews button at <= 768px (#625.9/.10), which left the
// phone admin with no way into /admin/reviews/. reviews-nav-link.js puts
// "Reviews" in Decap's top app bar there, between Contents and Media.
//
// The item exists only on the PRODUCTION shell (admin/index.html), which
// needs GitHub sign-in, so the shell's own pieces are lifted into the
// test-repo shell over HTTP, the #757.1 idiom above: the floating links, their
// styles and the inline script that keeps their hrefs (Reviews' ?return=),
// then the deferred shims the shell loads that shape the header
// (one-door-publish.js hides Workflow there, so the production order is
// Contents, Reviews, Media). Everything is
// read from the SERVED admin, so this runs unchanged on a consumer.
async function liftProductionReviews(page) {
  const lifted = await page.evaluate(async () => {
    const html = await (await fetch("/admin/index.html")).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    // The inline script syncs Live Preview first and needs its anchor too.
    const links = ["live-preview-link", "reviews-link"].map((id) => doc.getElementById(id));
    const sync = [...doc.querySelectorAll("script:not([src])")].find((s) =>
      s.textContent.includes("syncReviewsReturn"),
    );
    const srcs = [...doc.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"));
    if (links.includes(null) || !sync) return { ok: false, srcs };
    for (const style of doc.querySelectorAll("style")) {
      if (style.textContent.includes(".floating-link")) {
        document.head.appendChild(document.importNode(style, true));
      }
    }
    for (const link of links) document.body.appendChild(document.importNode(link, true));
    const run = document.createElement("script");
    run.textContent = sync.textContent;
    document.body.appendChild(run);
    return { ok: true, srcs };
  });
  expect(lifted.ok, "admin/index.html must carry #reviews-link and its ?return= sync").toBe(true);
  for (const shim of ["one-door-publish.js", "reviews-nav-link.js"]) {
    expect(lifted.srcs, `admin/index.html must load ${shim}`).toContain(shim);
    await page.addScriptTag({ url: `/admin/${shim}` });
  }
}

test.describe(
  "CMS admin — Reviews in the header nav at phone widths",
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 180_000 });

    const headerState = (page) =>
      page.evaluate(() => {
        const header = document.querySelector('header[class*="AppHeader"]');
        const item = document.getElementById("cms-reviews-nav-item");
        const shown = (el) => !!el && el.getClientRects().length > 0;
        const navItems = [...header.querySelectorAll('[class*="AppHeaderNavList"] > li')]
          .map((li) => li.querySelector("a, button"))
          .filter(shown);
        const style = (el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            fontFamily: cs.fontFamily,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            color: cs.color,
            top: Math.round(r.top),
            height: Math.round(r.height),
            right: r.right,
          };
        };
        const reviews = document.getElementById("cms-reviews-nav");
        const media = navItems.find((el) => el.textContent.trim() === "Media");
        // Header height with and without the item: it must not add a row.
        const withItem = header.getBoundingClientRect().height;
        let without = withItem;
        if (item) {
          item.style.setProperty("display", "none", "important");
          without = header.getBoundingClientRect().height;
          item.style.removeProperty("display");
        }
        // The free space between neighbors (Decap spaces them space-around).
        const boxes = navItems.map((el) => el.getBoundingClientRect());
        return {
          order: navItems.map((el) => el.textContent.trim()),
          gaps: boxes.slice(1).map((r, i) => Math.round(r.left - boxes[i].right)),
          itemShown: shown(item),
          inRoot: !!reviews && !!reviews.closest("#nc-root"),
          href: reviews ? reviews.getAttribute("href") : null,
          hash: location.hash,
          reviews: shown(reviews) ? style(reviews) : null,
          media: media ? style(media) : null,
          headerWith: Math.round(withItem),
          headerWithout: Math.round(without),
          viewport: window.innerWidth,
        };
      });

    test("phone: Reviews sits between Contents and Media, styled like them; desktop keeps the floating button", async ({
      page,
    }) => {
      await page.setViewportSize(PHONE_390);
      await login(page);
      // Do not page.goto the list URL: login() leaves Decap on the Posts list,
      // and that goto is a full reload whose first paint starts
      // single-entry-collection-shortcut.js's 700 ms settle timer before Decap
      // has rendered. On a slow runner the timer finds the seeded post's one
      // entry link with no "+ New" link beside it, takes the collection for a
      // singleton, and jumps into the entry editor (no AppHeader), so the nav
      // item is never there. Wait for the list Decap rendered itself (its "+ New"
      // button is what the shim checks for), then pin the route; a hash already
      // equal to it is a no-op that starts no timer.
      await expect(page.locator(NEW_BUTTON)).toBeVisible({ timeout: 60_000 });
      await page.evaluate(() => {
        location.hash = "#/collections/posts";
      });
      await expect(page.locator(NEW_BUTTON)).toBeVisible();
      await liftProductionReviews(page);

      const header = page.locator('header[class*="AppHeader"]');
      const navReviews = header.getByRole("link", { name: "Reviews", exact: true });
      const floating = page.locator("#reviews-link");

      for (const width of [390, 320, 768]) {
        await page.setViewportSize({ width, height: PHONE_390.height });
        await expect(navReviews, `${width}px: Reviews in the header nav`).toBeVisible();
        await expect(floating, `${width}px: floating Reviews stays hidden`).toBeHidden();
        const s = await headerState(page);
        expect(s.order, `${width}px: header nav order`).toEqual(["Contents", "Reviews", "Media"]);
        expect(s.inRoot, "inside #nc-root, so rule 0's focus ring applies").toBe(true);
        expect(s.href).toBe(`/admin/reviews/?return=${encodeURIComponent(s.hash)}`);
        for (const prop of ["fontFamily", "fontSize", "fontWeight", "color", "top", "height"]) {
          expect(s.reviews[prop], `${width}px: Reviews ${prop} matches Media`).toBe(s.media[prop]);
        }
        expect(s.reviews.right, `${width}px: Reviews past the right edge`).toBeLessThanOrEqual(s.viewport);
        expect(s.headerWith, `${width}px: Reviews added a header row`).toBe(s.headerWithout);
        // Evenly spaced: the Workflow item one-door-publish.js empties must
        // not keep a share of the row between Reviews and Media.
        expect(
          Math.abs(s.gaps[0] - s.gaps[1]),
          `${width}px: Contents-Reviews vs Reviews-Media spacing ${JSON.stringify(s.gaps)}`,
        ).toBeLessThanOrEqual(2);
      }

      // The ?return= target follows the route, like the floating link's.
      await page.setViewportSize(PHONE_390);
      await page.evaluate(() => {
        location.hash = "#/collections/tags";
      });
      await expect(navReviews).toHaveAttribute(
        "href",
        `/admin/reviews/?return=${encodeURIComponent("#/collections/tags")}`,
      );
      // Decap re-creates the header when the editor (which has none) closes;
      // the item comes back with it.
      await page.evaluate((slug) => {
        location.hash = `#/collections/posts/entries/${slug}`;
      }, SEED_POST_SLUG);
      await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
      await expect(header).toHaveCount(0);
      await page.evaluate(() => {
        location.hash = "#/collections/posts";
      });
      await expect(navReviews).toBeVisible();
      expect((await headerState(page)).order).toEqual(["Contents", "Reviews", "Media"]);

      // Above 768px (the 820px tablet, desktop) the header has no Reviews and
      // the floating button is back.
      for (const width of [820, DESKTOP.width]) {
        await page.setViewportSize({ width, height: DESKTOP.height });
        await expect(navReviews, `${width}px: no Reviews in the header`).toBeHidden();
        await expect(floating, `${width}px: floating Reviews is visible`).toBeVisible();
        expect((await headerState(page)).itemShown).toBe(false);
      }
    });
  },
);
