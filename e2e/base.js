const { test: base, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Custom fixture that adds a rootFontSize option.
// Projects can set rootFontSize (e.g. "20px") to simulate users who configure
// a larger default font in their browser — the root <html> element's font-size
// is applied via an init script before any navigation.
//
// G3 — `TARGET=` env switch.
//
// Specs tagged `@parity` (and any other read-only spec) need to be runnable
// against:
//   - `local`   — http://localhost:4000 (default; matches playwright.config.js)
//   - `preview` — https://preview-pr<N>.adamdaniel.ai for the latest open PR
//   - `prod`    — https://adamdaniel.ai
//
// We override Playwright's built-in `baseURL` test option so every
// `page.goto(path)` AND `page.request.get(path)` call routes against the
// resolved target. Existing specs that call `page.goto("/")` or
// `page.goto("/admin/index-local.html")` become parity-aware without any
// spec-level changes — though specs that hit local-only paths
// (e.g. `index-local.html` or `localhost`-bound endpoints) will surface
// remote 404s on TARGET=prod, which is the point.
//
// The static lint at `e2e/parity-tag-lint.test.js` enforces that any spec
// tagged `@parity` is read-only (no fs writes / shell execs / decap-server
// usage), so a `TARGET=prod` run cannot mutate prod.

const TARGET = (process.env.TARGET || "local").toLowerCase();
const PROD_URL = process.env.CMS_PROD_URL || "";
const LOCAL_URL = "http://localhost:4000";
const CMS_APEX = process.env.CMS_APEX || "";

function resolveTargetBaseURL() {
  if (TARGET === "local") return LOCAL_URL;
  if (TARGET === "prod") return PROD_URL;
  if (TARGET === "preview") return resolvePreviewBaseURL();
  throw new Error(`Unknown TARGET="${process.env.TARGET}". Use local | preview | prod.`);
}

function resolvePreviewBaseURL() {
  // Fast path: when the workflow already knows the PR number (CI sets
  // PR_NUMBER / GITHUB_PR_NUMBER from `github.event.pull_request.number`),
  // skip the `gh` round-trip. Used by .github/workflows/parity-preview.yml
  // and any other workflow that runs TARGET=preview against the PR it
  // already has the number for.
  const explicit = process.env.PR_NUMBER || process.env.GITHUB_PR_NUMBER;
  if (explicit) {
    if (!/^\d+$/.test(String(explicit))) {
      throw new Error(`TARGET=preview: PR_NUMBER="${explicit}" is not a positive integer.`);
    }
    return `https://preview-pr${explicit}.${CMS_APEX}`;
  }
  // Otherwise discover the latest open PR via the GitHub API and construct
  // its preview subdomain. Throws with a clear message if no open PR exists.
  let raw;
  try {
    raw = execFileSync(
      "gh",
      [
        "api",
        `repos/${process.env.CMS_REPO || process.env.GITHUB_REPOSITORY}/pulls?state=open&sort=created&direction=desc&per_page=1`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    throw new Error(
      `TARGET=preview: failed to query GitHub for the latest open PR (${err.message}). ` +
        `Ensure 'gh' is on PATH and authenticated, or run with TARGET=local.`,
      { cause: err },
    );
  }
  let pulls;
  try {
    pulls = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TARGET=preview: GitHub API returned non-JSON: ${raw.slice(0, 200)}`, {
      cause: err,
    });
  }
  if (!Array.isArray(pulls) || pulls.length === 0) {
    throw new Error(
      "TARGET=preview: no open PR exists — preview targets cannot be resolved. " +
        "Open a PR or run with TARGET=local|prod.",
    );
  }
  const number = pulls[0].number;
  return `https://preview-pr${number}.${CMS_APEX}`;
}

// ── Per-test screenshot capture ───────────────────────────────────────
//
// Every browser test takes one screenshot per main-frame navigation
// (committed top-level URL change). Frames land at:
//
//   test-results/per-test-frames/<safe-test-id>/NNNN.png
//
// alongside a sidecar `meta.json` describing the run. Each frame
// record carries:
//   - `path`     — relative to repo root
//   - `url`      — committed URL of the navigation that fired the capture
//   - `stepTitle`— title of the innermost active `test.step()` at the
//                  moment of the navigation, or `null` when the
//                  navigation happened outside any `test.step()`. The
//                  assembly script (`e2e/generate-test-videos.js`)
//                  reads this to render the banner's per-frame "Step
//                  <x> of <y>: <step name / URL fallback>" line.
//   - `capturedAt` — ISO-8601 wall-clock at capture
//
// `meta.json` also records `endTime` (ISO-8601) so the assembly
// script can render each test's own end-time on the banner, formatted
// in America/New_York with TZ abbreviation.
//
// The assembly script in the `finalize` job assembles these into
// per-test videos with a metadata banner and concatenates them into a
// master video for the CI run.
//
// This fixture only triggers for tests that request the `page` fixture.
// Pure-node tests (e2e/*.test.js) never instantiate `page`, so they
// stay fully unaffected.
//
// V1 scope: only the test fixture's primary `page` is captured.
// Secondary pages opened via `browserContext.newPage()` are not
// instrumented — extending coverage is a follow-up.

const REPO_ROOT = path.resolve(__dirname, "..");
const PER_TEST_FRAMES_ROOT = path.join(REPO_ROOT, "test-results", "per-test-frames");
const PER_TEST_MAX_FRAMES = 50;

function safeTestId(testInfo) {
  // Build a filesystem-safe id incorporating project, file, title, and
  // repeatEachIndex so retries / cross-project runs of the same test
  // don't collide. Slugify aggressively, cap to a sane length so the
  // total path stays well under typical filesystem limits (<255).
  const file = path.basename(testInfo.file || "unknown");
  const parts = [
    testInfo.project.name || "unknown-project",
    file,
    testInfo.title || "untitled",
    `r${testInfo.repeatEachIndex || 0}`,
  ];
  const raw = parts.join("__");
  const safe = raw
    .replace(/[\s/:\\?*"<>|]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe.slice(0, 180);
}

function ensureFrameDir(testInfo) {
  const dir = path.join(PER_TEST_FRAMES_ROOT, safeTestId(testInfo));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Per-worker stack of currently-active `test.step()` titles. The
// banner spec asks line 2 to read "Step <x> of <y>: <step name / URL
// fallback>", so we record the title of the innermost step that's
// active at the moment a `framenavigated` capture fires. Playwright
// runs tests serially within a worker, so a single module-level stack
// is safe — a fresh test in this worker only starts after the prior
// test's afterEach has drained.
const _stepTitleStack = [];

function _currentStepTitle() {
  return _stepTitleStack.length === 0 ? null : _stepTitleStack[_stepTitleStack.length - 1];
}

// Build a patched `step` method that pushes the active title onto the
// per-worker stack before running the body and pops it after — even
// if the body throws. The wrapper preserves the original (title,
// body, options) contract so specs don't need any change: existing
// `await test.step("…", async () => { … })` calls just work.
function _wrapStep(originalStep, owner) {
  const patched = function patchedStep(title, body, options) {
    const wrappedBody = async (stepInfo) => {
      _stepTitleStack.push(String(title || ""));
      try {
        return await body(stepInfo);
      } finally {
        // Remove the matching title; falling back to a plain pop()
        // protects against re-entrancy weirdness if a name collides
        // (rare — step titles are usually unique within a test).
        const last = _stepTitleStack.lastIndexOf(String(title || ""));
        if (last !== -1) _stepTitleStack.splice(last, 1);
        else _stepTitleStack.pop();
      }
    };
    return originalStep.call(owner, title, wrappedBody, options);
  };
  // Pass through any aux properties (e.g. `step.skip`) untouched —
  // we only intercept the main call form, which is the only one
  // emitting events salient for the banner.
  for (const key of Object.keys(originalStep)) {
    try {
      patched[key] = originalStep[key];
    } catch (_) {
      /* read-only property — skip */
    }
  }
  return patched;
}

async function attachPerTestCapture(page, testInfo) {
  const frameDir = ensureFrameDir(testInfo);
  const captured = [];
  let counter = 0;
  let inFlight = Promise.resolve();

  const meta = {
    safeTestId: safeTestId(testInfo),
    projectName: testInfo.project.name,
    file: path.basename(testInfo.file || "unknown"),
    title: testInfo.title,
    repeatEachIndex: testInfo.repeatEachIndex || 0,
    startTime: new Date().toISOString(),
    endTime: null,
    status: "running",
    frames: [],
  };

  // Persist a starting meta.json immediately so even crashing tests
  // leave a partial record on disk that `generate-test-videos.js` can
  // pick up.
  const metaPath = path.join(frameDir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  const onNavigated = async (frame) => {
    if (frame !== page.mainFrame()) return; // skip subframes
    if (counter >= PER_TEST_MAX_FRAMES) return; // bound runaway loops
    const url = frame.url();
    if (!url || url === "about:blank") return;
    const seq = String(counter).padStart(4, "0");
    counter += 1;
    const file = path.join(frameDir, `${seq}.png`);
    // Snapshot the active step title at the moment the navigation
    // event fires. By the time the (deferred) screenshot completes,
    // the test may have already moved on to a sibling step — but the
    // captured frame visually reflects the URL transition that
    // happened *during* this step, so the step title sampled at event
    // time is the right label for the banner.
    const stepTitle = _currentStepTitle();
    // Serialize captures so we don't fire concurrent screenshots on a
    // page that's still loading the next nav. Failures are swallowed:
    // a torn-down page (post-test) shouldn't fail the run.
    inFlight = inFlight.then(async () => {
      try {
        await page.screenshot({ path: file, fullPage: true, timeout: 5000 });
        captured.push({
          path: file,
          url,
          stepTitle,
          capturedAt: new Date().toISOString(),
        });
      } catch (_err) {
        // Most common: page was closed / navigated again before the
        // screenshot could complete. Silently drop — banner stays in
        // sequence with whatever frames did land.
      }
    });
  };

  page.on("framenavigated", onNavigated);

  return {
    async finalize() {
      page.off("framenavigated", onNavigated);
      // Drain pending screenshots before writing meta.json so the file
      // list matches the disk state.
      try {
        await inFlight;
      } catch (_) {
        /* swallow */
      }
      meta.endTime = new Date().toISOString();
      meta.frames = captured.map((c) => ({
        path: path.relative(REPO_ROOT, c.path),
        url: c.url,
        stepTitle: c.stepTitle || null,
        capturedAt: c.capturedAt,
      }));
      meta.status = (() => {
        // testInfo.status is only finalised in afterEach hooks; we read
        // whatever Playwright has populated.
        const s = testInfo.status || "unknown";
        // "expected" → "passed" semantics: testInfo.status is "passed"
        // for ok runs, "failed" / "timedOut" for failures, "skipped"
        // for skips.
        return s;
      })();
      try {
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch (_) {
        /* swallow */
      }
    },
  };
}

exports.test = base.extend({
  rootFontSize: [null, { option: true }],

  // Override the built-in `baseURL` test option. `undefined` falls
  // through to playwright.config.js's default (localhost:4000) for the
  // local case; preview/prod resolve at fixture-init time.
  baseURL: TARGET === "local" ? undefined : resolveTargetBaseURL(),

  page: async ({ page, rootFontSize }, use, testInfo) => {
    if (rootFontSize) {
      await page.addInitScript((size) => {
        document.documentElement.style.fontSize = size;
      }, rootFontSize);
    }

    // Per-test screenshot capture. Disabled when DISABLE_PER_TEST_VIDEOS=1
    // so an emergency escape hatch is available without a code change.
    let capture = null;
    if (process.env.DISABLE_PER_TEST_VIDEOS !== "1") {
      try {
        capture = await attachPerTestCapture(page, testInfo);
      } catch (_err) {
        // Capture setup must never break a test. Fall through.
        capture = null;
      }
    }

    try {
      await use(page);
    } finally {
      if (capture) {
        try {
          await capture.finalize();
        } catch (_) {
          /* swallow */
        }
      }
    }
  },
});

// Patch `test.step` on the exported (extended) test object so every
// `await test.step("name", async () => { ... })` call records its
// title on the active-step stack while running. Doing this *after*
// `base.extend({...})` is important — `extend()` returns a new test
// object whose `step` property is independent of `base.test.step`.
exports.test.step = _wrapStep(exports.test.step, exports.test);

exports.expect = expect;
exports.TARGET = TARGET;
exports.resolveTargetBaseURL = resolveTargetBaseURL;
exports.safeTestId = safeTestId;
exports.PER_TEST_FRAMES_ROOT = PER_TEST_FRAMES_ROOT;
exports.PER_TEST_MAX_FRAMES = PER_TEST_MAX_FRAMES;
