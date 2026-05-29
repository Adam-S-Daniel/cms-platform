/*
 * Capture screenshots and step descriptions during e2e runs so that the
 * contributor manual is assembled BY the tests — and therefore stays in
 * sync with the actual contributor flows.
 *
 * Usage in a spec:
 *
 *   const { captureStep } = require("./manual-capture");
 *   await captureStep(page, {
 *     section: "Logging in",
 *     step: "1.1",
 *     title: "Click 'Log in with GitHub'",
 *     body: "Visit /admin/. The Decap login screen shows a single button.",
 *   });
 *
 * Each call writes:
 *   docs/manual-screenshots/<section-slug>/<step>-<title-slug>.png
 *   manual-capture/<spec-basename>__<test-id>.json (one record per step)
 *
 * `scripts/build-contributor-manual.js` reads the JSON records, groups
 * them by section, sorts within each section by `step`, and emits
 * `docs/CONTRIBUTOR_MANUAL.md` with embedded screenshots.
 */
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const CAPTURE_DIR = path.join(REPO_ROOT, "manual-capture");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "docs", "manual-screenshots");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function captureKey(specPath, testTitle) {
  const base = path.basename(specPath, path.extname(specPath));
  return `${base}__${slugify(testTitle)}.json`;
}

function readExisting(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return [];
  }
}

function shouldCapture() {
  // Default: capture only when explicitly enabled. The standard PR run
  // skips this work (it's pure-overhead screenshot churn). The
  // `regenerate-manual.yml` workflow flips MANUAL_CAPTURE=1 when it wants
  // a fresh build of the contributor manual.
  return process.env.MANUAL_CAPTURE === "1";
}

/**
 * Take a screenshot at `page` and append a step record. Safe to no-op
 * when capture isn't enabled — keeps spec code free of `if` guards.
 *
 * Required: section, step, title.
 * Optional: body (markdown), elementSelector (highlight target),
 *           fullPage (default true), mask (array of selectors).
 */
async function captureStep(page, opts) {
  if (!shouldCapture()) return;
  const { section, step, title, body = "", elementSelector, fullPage = true, mask } = opts || {};
  if (!section || !step || !title) {
    throw new Error("captureStep requires { section, step, title }.");
  }
  const testInfo = require("@playwright/test").test.info();
  const sectionSlug = slugify(section);
  const titleSlug = slugify(title);
  const stepSlug = `${slugify(step)}-${titleSlug}`.slice(0, 100);
  const sectionDir = path.join(SCREENSHOT_DIR, sectionSlug);
  ensureDir(sectionDir);
  const screenshotPath = path.join(sectionDir, `${stepSlug}.png`);
  const screenshotRel = path.relative(REPO_ROOT, screenshotPath).split(path.sep).join("/");

  const screenshotOpts = { path: screenshotPath, fullPage };
  if (Array.isArray(mask) && mask.length) {
    screenshotOpts.mask = mask.map((s) => page.locator(s));
  }
  if (elementSelector) {
    await page.locator(elementSelector).screenshot({ path: screenshotPath });
  } else {
    await page.screenshot(screenshotOpts);
  }

  ensureDir(CAPTURE_DIR);
  const file = path.join(CAPTURE_DIR, captureKey(testInfo.file, testInfo.title));
  const records = readExisting(file);
  // Replace any prior record for the same { section, step } so reruns
  // overwrite cleanly.
  const idx = records.findIndex((r) => r.section === section && r.step === step);
  const record = {
    section,
    step,
    title,
    body,
    screenshot: screenshotRel,
    url: page.url(),
    spec: path.relative(REPO_ROOT, testInfo.file).split(path.sep).join("/"),
    test: testInfo.title,
    project: testInfo.project.name,
    capturedAt: new Date().toISOString(),
  };
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  fs.writeFileSync(file, JSON.stringify(records, null, 2));
}

module.exports = {
  CAPTURE_DIR,
  REPO_ROOT,
  SCREENSHOT_DIR,
  captureStep,
  shouldCapture,
  slugify,
};
