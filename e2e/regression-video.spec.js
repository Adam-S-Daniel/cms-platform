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

// Deployment-metadata exclusion for the text dumps — two layers, both
// load-bearing:
//   - [data-visreg-ignore]: the extensible marker carried by the PAGE
//     markup (#151; the admin commit/deploy pills set it).
//   - The known metadata element IDs, excluded UNCONDITIONALLY: the prod
//     side of the diff serves the PREVIOUS release's markup, so a marker
//     added to a pre-existing element doesn't exist on prod until prod
//     itself ships it. Attribute-only exclusion therefore leaked the
//     commit pill's "<sha> <time>" into prod's dump and flagged /admin/
//     on the very bump PR that shipped the marker (adamdaniel.ai#2560) —
//     and would repeat on every consumer's first bump past that release.
//     This spec runs at the PR's pin on BOTH sides, so an id list here
//     covers both regardless of page version. A brand-NEW metadata
//     element needs only the attribute (element + this spec ship in the
//     same release); only a marker RETROFITTED onto a pre-existing
//     element needs its id added here. Ids drift-locked to the theme
//     sources by e2e/visreg-ignore-lint.test.js.
const VISREG_IGNORE_SELECTOR = [
  "[data-visreg-ignore]",
  "#cms-commit-pill",
  "#cms-prod-status-pill",
  "#cms-preview-build-pill",
].join(", ");

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
      // visibility:hidden excludes a node from innerText; restore afterwards
      // so the (already-taken or later) screenshot and live page are
      // untouched. See VISREG_IGNORE_SELECTOR above for what's excluded and why.
      const text = await page.evaluate((sel) => {
        const ignored = Array.from(document.querySelectorAll(sel));
        const saved = ignored.map((el) => el.style.visibility);
        ignored.forEach((el) => (el.style.visibility = "hidden"));
        const t = (document.body && document.body.innerText) || "";
        ignored.forEach((el, i) => (el.style.visibility = saved[i]));
        return t;
      }, VISREG_IGNORE_SELECTOR);
      fs.writeFileSync(path.join(OUTPUT_DIR, side, `${safeName}.txt`), text);
      return;
    } catch (e) {
      if (attempt === 1) {
        console.warn(`[visreg] text capture skipped for ${side} ${safeName}: ${e.message}`);
        return;
      }
      await page
        .waitForLoadState("domcontentloaded")
        .catch((e) => console.warn(`[visreg] settle wait failed (retrying anyway): ${e.message}`));
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
          await page
            .goto("about:blank")
            .catch((e) => console.warn(`[visreg] about:blank cancel failed: ${e.message}`));
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
