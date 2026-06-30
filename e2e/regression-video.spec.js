// @lane: local — pulls visual-diff frames from disk to assemble a regression video
const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const changesPath = process.env.PAGE_CHANGES_PATH || "/tmp/page-changes.json";

let changes;
try {
  changes = JSON.parse(fs.readFileSync(changesPath, "utf-8"));
} catch {
  changes = { changed: [], new: [], unchanged: [] };
}

const allPages = [...(changes.changed || []), ...(changes.new || []), ...(changes.unchanged || [])];
// Production baseline origin for the per-page diff. Derived from the CONSUMING
// site's apex (CMS_APEX, exported as APEX_DOMAIN by visual-regression.yml's
// job-level env) so every consumer compares its PR against ITS OWN production.
// A hardcoded "https://adamdaniel.ai" here made every non-adamdaniel consumer
// diff against Adam's site → always "visually different" (issue #123). The
// adamdaniel.ai literal remains only as a last-resort fallback.
const PROD_BASE =
  process.env.PROD_BASE_URL ||
  (process.env.APEX_DOMAIN ? `https://${process.env.APEX_DOMAIN}` : "https://adamdaniel.ai");
const OUTPUT_DIR = path.join(__dirname, "..", "screenshots", "regression");

fs.mkdirSync(path.join(OUTPUT_DIR, "pr"), { recursive: true });
fs.mkdirSync(path.join(OUTPUT_DIR, "prod"), { recursive: true });

function safeFileName(pagePath) {
  const name = pagePath.replace(/\//g, "_").replace(/^_/, "").replace(/_$/, "");
  return name || "index";
}

// Admin shells need a brief settle window after navigation so the
// Decap CMS bundle finishes mounting before we screenshot.
// The custom #cms-loading splash that this used to wait for was
// retired with the cobalt theme; Decap's own first paint is fast,
// but a small fixed delay keeps screenshots deterministic.
async function waitForAdminBootIfApplicable(page, pagePath) {
  if (!pagePath.startsWith("/admin/")) return;
  await page.waitForTimeout(1500);
}

test.describe("Regression video screenshots", () => {
  test.describe.configure({ mode: "serial" });

  for (const pagePath of allPages) {
    const safeName = safeFileName(pagePath);
    const isNew = (changes.new || []).includes(pagePath);

    test(`screenshot PR: ${pagePath}`, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      const resp = await page.goto(pagePath, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      if (resp && resp.ok()) {
        await page.waitForTimeout(500);
      }
      await waitForAdminBootIfApplicable(page, pagePath);
      await page.screenshot({
        path: path.join(OUTPUT_DIR, "pr", `${safeName}.png`),
        fullPage: false,
      });
    });

    if (isNew) {
      test(`placeholder PROD: ${pagePath}`, async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.setContent(`
          <html><body style="margin:0;background:#1a1a2e;color:#8ab0e8;
            display:flex;align-items:center;justify-content:center;
            min-height:100vh;font-family:'Helvetica Neue',Arial,sans-serif;
            text-align:center;">
            <div>
              <div style="font-size:3rem;margin-bottom:1.5rem;opacity:0.3;">+</div>
              <h1 style="font-weight:200;font-size:1.8rem;color:#d8e4ff;
                margin:0 0 1rem;">New Page</h1>
              <p style="margin:0 0 0.5rem;font-size:1rem;">
                No previous version of this page exists.</p>
              <p style="margin:0;font-family:'SF Mono','Fira Code',monospace;
                font-size:0.8rem;opacity:0.6;">${pagePath}</p>
            </div>
          </body></html>
        `);
        await page.screenshot({
          path: path.join(OUTPUT_DIR, "prod", `${safeName}.png`),
          fullPage: false,
        });
      });
    } else {
      test(`screenshot PROD: ${pagePath}`, async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        try {
          await page.goto(`${PROD_BASE}${pagePath}`, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          await page.waitForTimeout(500);
          await waitForAdminBootIfApplicable(page, pagePath);
        } catch {
          await page.setContent(`
            <html><body style="margin:0;background:#1a1a2e;color:#8ab0e8;
              display:flex;align-items:center;justify-content:center;
              min-height:100vh;font-family:'Helvetica Neue',Arial,sans-serif;
              text-align:center;">
              <div>
                <h1 style="font-weight:200;font-size:1.8rem;color:#d8e4ff;
                  margin:0 0 1rem;">Production Unavailable</h1>
                <p style="margin:0;font-size:0.9rem;">
                  Could not load this page from production.</p>
                <p style="margin:0.5rem 0 0;font-family:'SF Mono','Fira Code',monospace;
                  font-size:0.8rem;opacity:0.6;">${pagePath}</p>
              </div>
            </body></html>
          `);
        }
        await page.screenshot({
          path: path.join(OUTPUT_DIR, "prod", `${safeName}.png`),
          fullPage: false,
        });
      });
    }
  }
});
