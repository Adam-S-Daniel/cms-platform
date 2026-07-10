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

// Visible-text capture for the text-regression check: the screenshot is
// viewport-only, so a text change below the fold — or one too small to
// clear the pixel threshold (a nav link, a typo fix) — never trips the
// pixel diff. compute-visual-diffs.js compares these dumps (whitespace-
// normalized) and escalates any real page whose text changed. innerText
// deliberately excludes iframe content (separate documents), so embedded
// tools don't re-review their own synced content here.
// A goto that resolved at domcontentloaded can still be settling a
// redirect chain when we get here, destroying the execution context
// mid-evaluate — one settle-and-retry absorbs that. Persistent failure
// skips the dump: compute-visual-diffs tolerates a missing side (the
// text check just doesn't run for that page), the same fail-open shape
// as its no-baseline handling.
async function writeVisibleText(page, side, safeName) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await page.evaluate(() => (document.body && document.body.innerText) || "");
      fs.writeFileSync(path.join(OUTPUT_DIR, side, `${safeName}.txt`), text);
      return;
    } catch (e) {
      if (attempt === 1) {
        console.warn(`[visreg] text capture skipped for ${side} ${safeName}: ${e.message}`);
        return;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
}

// Pages whose PRODUCTION fetch came back 404/410 — CONFIRMED absent from
// prod (vs. a transient capture gap, which stays tolerated). compute-
// visual-diffs.js treats these as "new", which counts toward the manual
// review gate. This is what catches brand-new pages with ZERO per-
// collection mapping knowledge: prod's HTTP status is ground truth.
const PROD_MISSING_PATH = path.join(OUTPUT_DIR, "prod-missing.json");
function recordProdMissing(pagePath) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(PROD_MISSING_PATH, "utf-8"));
  } catch {
    list = [];
  }
  if (!list.includes(pagePath)) list.push(pagePath);
  fs.writeFileSync(PROD_MISSING_PATH, JSON.stringify(list, null, 2));
}

const NEW_PAGE_PLACEHOLDER = (pagePath) => `
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
`;

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
      await writeVisibleText(page, "pr", safeName);
    });

    if (isNew) {
      test(`placeholder PROD: ${pagePath}`, async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.setContent(NEW_PAGE_PLACEHOLDER(pagePath));
        await page.screenshot({
          path: path.join(OUTPUT_DIR, "prod", `${safeName}.png`),
          fullPage: false,
        });
      });
    } else {
      test(`screenshot PROD: ${pagePath}`, async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        try {
          const resp = await page.goto(`${PROD_BASE}${pagePath}`, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          // 404/410 is prod CONFIRMING the page doesn't exist (yet) — a
          // brand-new page the changed-file mapper didn't know about.
          // Record it (compute scores it "new" → review gate) and shoot
          // the New Page placeholder instead of prod's 404 page, so the
          // video shows the same affordance as mapper-detected new pages.
          // Other non-OK statuses (5xx etc.) fall through and screenshot
          // whatever prod rendered, as before — transient prod trouble
          // must not classify pages.
          if (resp && [404, 410].includes(resp.status())) {
            recordProdMissing(pagePath);
            await page.setContent(NEW_PAGE_PLACEHOLDER(pagePath));
            await page.screenshot({
              path: path.join(OUTPUT_DIR, "prod", `${safeName}.png`),
              fullPage: false,
            });
            return;
          }
          await page.waitForTimeout(500);
          await waitForAdminBootIfApplicable(page, pagePath);
          await writeVisibleText(page, "prod", safeName);
        } catch {
          // The page can still be (re)navigating when we land here — e.g.
          // Chromium's net-error page auto-retrying — and setContent
          // throws "context destroyed" mid-flight. about:blank cancels
          // any pending navigation deterministically.
          await page.goto("about:blank").catch(() => {});
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
