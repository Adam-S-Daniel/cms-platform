// Opt-in native race diagnostic; not a CI pass/fail oracle. Event timing varies,
// so report observations instead of asserting an exact defect rate.
const fs = require("node:fs");
const path = require("node:path");
const { chromium, expect } = require("@playwright/test");
const { BUNDLE_CACHE, PARAGRAPHS, openDiagnostic, caretPoint } = require("./decap-caret-diagnostic");

async function run() {
  if (process.argv.length !== 3) throw new Error("Usage: node decap-caret-native.js <output.json>");
  const output = path.resolve(process.argv[2]);
  const browser = await chromium.launch();
  const results = { browser: browser.version(), viewport: { width: 1440, height: 900 }, attemptsPerCell: 100, cells: [] };
  try {
    for (const platform of [false, true]) {
      for (const raw of [false, true]) {
        for (const hidden of [false, true]) {
          const page = await browser.newPage({ viewport: results.viewport });
          try {
            const { editor, errors, scriptCount, pin } = await openDiagnostic(page, {
              platform, raw, hidden,
              bundlePath: process.env.DECAP_DIAGNOSTIC_BUNDLE || BUNDLE_CACHE,
            });
            expect(await editor.locator('[data-slate-string="true"]').allTextContents()).toEqual(PARAGRAPHS);
            expect(errors).toEqual([]);
            // Issue-shaped first trial: start at the body end, then click
            // within the first paragraph and immediately type XYZ.
            await editor.click();
            await page.keyboard.press("Control+End");
            await expect.poll(() => page.evaluate(() => {
              const { children, selection } = window.caretSlate;
              const last = children.length - 1;
              return selection?.anchor.path[0] === last && selection.anchor.offset === children[last].children[0].text.length;
            })).toBe(true);
            const expected = [...PARAGRAPHS];
            const cell = { platform, mode: raw ? "Markdown" : "Rich Text", preview: hidden ? "hidden" : "visible", scriptCount, pin, mismatches: 0, examples: [] };
            for (let trial = 0; trial < results.attemptsPerCell; trial++) {
              const paragraph = trial % 2;
              const point = await caretPoint(editor, paragraph, 2);
              await page.evaluate(() => { window.caretEvents = []; });
              await page.mouse.click(point.x, point.y);
              await page.keyboard.type("XYZ");
              expected[paragraph] = expected[paragraph].slice(0, 2) + "XYZ" + expected[paragraph].slice(2);
              const actual = await editor.locator('[data-slate-string="true"]').allTextContents();
              expect(actual.length).toBeGreaterThanOrEqual(2);
              if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                cell.mismatches++;
                if (cell.examples.length < 3) cell.examples.push({ trial, expected: [...expected], actual, events: await page.evaluate(() => window.caretEvents) });
                // Each later trial compares insertion against its actual input,
                // so one earlier split does not count every later trial wrong.
                expected.splice(0, expected.length, ...actual);
              }
            }
            expect(errors).toEqual([]);
            results.cells.push(cell);
            fs.writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
            console.log(`${platform ? "platform" : "stock"} ${cell.mode} preview ${cell.preview}: ${cell.mismatches}/100 mismatches`);
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
