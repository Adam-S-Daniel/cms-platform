// Platform-only offline diagnostic for #755; Self fixture E2E runs the
// dedicated playwright.caret.config.js after preparing the pinned bundle.
const { test, expect } = require("@playwright/test");
const { BUNDLE_CACHE, PARAGRAPHS, openDiagnostic, caretPoint } = require("./decap-caret-diagnostic");

for (const platform of [false, true]) {
  for (const raw of [false, true]) {
    for (const hidden of [false, true]) {
      test(`${platform ? "platform scripts" : "stock"}, ${raw ? "Markdown" : "Rich Text"}, preview ${hidden ? "hidden" : "visible"}: records the stale-selection split`, async ({ page }, testInfo) => {
        const { editor, errors, scriptCount, pin } = await openDiagnostic(page, {
          platform, raw, hidden,
          bundlePath: process.env.DECAP_DIAGNOSTIC_BUNDLE || BUNDLE_CACHE,
        });
        expect(await editor.locator('[data-slate-string="true"]').allTextContents()).toEqual(PARAGRAPHS);
        expect(await page.evaluate(() => Boolean(window.caretSlate))).toBe(true);
        expect(errors).toEqual([]);
        if (hidden) await expect(page.locator("#preview-pane")).not.toBeVisible();
        else await expect(page.locator("#preview-pane")).toBeVisible();
        const platformPreviewRegistered = await page.evaluate(() => Boolean(window.CMS.getPreviewTemplate("posts")));
        expect(platformPreviewRegistered).toBe(platform);

        // Settle the first caret by observing Slate state, not by sleeping.
        // No synthetic selection or character input is used.
        const initial = await caretPoint(editor, 0, 2);
        await page.mouse.click(initial.x, initial.y);
        await expect.poll(() => page.evaluate(() => window.caretSlate.selection?.anchor)).toEqual({ path: [0, 0], offset: 2 });

        // Event-order reduction: hold back selectionchange processing until
        // the first beforeinput completes. It forces the old Slate selection
        // versus fresh DOM target boundary observed in the native reproduction.
        // This is diagnostic instrumentation, not a runtime mitigation.
        await page.evaluate(() => {
          window.caretEvents = [];
          window.holdCaretSelection = true;
          document.addEventListener("selectionchange", (event) => {
            if (window.holdCaretSelection) event.stopImmediatePropagation();
          }, true);
          document.addEventListener("beforeinput", () => {
            queueMicrotask(() => { window.holdCaretSelection = false; });
          }, { once: true });
        });
        const target = await caretPoint(editor, 1, 2);
        await page.mouse.click(target.x, target.y);
        await page.keyboard.type("XYZ");
        const actual = await editor.locator('[data-slate-string="true"]').allTextContents();
        const events = await page.evaluate(() => window.caretEvents);
        await testInfo.attach("caret-selection-evidence", {
          body: JSON.stringify({ pin, scriptCount, platform, raw, hidden, actual, events }, null, 2),
          contentType: "application/json",
        });
        expect(errors).toEqual([]);
        expect(events.find(({ type, data }) => type === "beforeinput" && data === "X")).toMatchObject({
          anchor: PARAGRAPHS[1], offset: 2,
          slateSelection: { anchor: { path: [0, 0], offset: 2 } },
          targetRanges: [{ start: PARAGRAPHS[1], startOffset: 2, end: PARAGRAPHS[1], endOffset: 2 }],
        });
        expect(events.find(({ type, key }) => type === "keydown" && key === "Y")).toMatchObject({ anchor: PARAGRAPHS[0], offset: 2 });
        // Known upstream defect observation. A fixed bundle changes this result
        // and asks for a review of the diagnostic, rather than silently hiding
        // it with test.fail() or leaving CI permanently red.
        expect(actual).toEqual([
          "AlYZpha paragraph has several words.",
          "BrXavo paragraph also has several words.",
        ]);
      });
    }
  }
}
