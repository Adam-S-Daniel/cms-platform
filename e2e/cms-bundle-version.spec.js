// @lane: local — fs reads of the admin bundle + local /admin shell smoke check
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Audit finding #10: catch CDN drift between the version pinned in
// admin/index.html and the version unpkg actually serves at runtime.
//
// admin/index.html pins `decap-cms@X.Y.Z`; unpkg should redirect that
// to the same X.Y.Z bundle. If the pin ever uses a range operator
// again (or unpkg's resolution semantics shift), the runtime bundle
// could drift from the version we test against. Decap exposes the
// shipped version on the `CMS` global as `CMS.VERSION`.

// SITE_ROOT-aware resolution. The pinned decap-cms version is read from the
// BUILT/served admin shell `<site>/_site/admin/index.html` (the shell the
// `page.goto("/admin/index.html")` half below actually loads), not the
// source `admin/index.html`. The render hook copies the shell into
// `_site/admin/` during the local-lane build; reading the served bytes keeps
// the static pin and the runtime version probe in lockstep.
const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || REPO_ROOT;
const INDEX_HTML = path.join(SITE_ROOT, "_site", "admin", "index.html");

function readPinnedVersion() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const m = html.match(/decap-cms@(\d+\.\d+\.\d+)\/dist\//);
  expect(m, "_site/admin/index.html must pin decap-cms@X.Y.Z").not.toBeNull();
  return m[1];
}

function majorMinor(v) {
  const m = v.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : v;
}

test.describe(
  "Decap bundle version matches the pinned tag",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 120_000 });

    test.beforeEach(async ({ page }) => {
      // The served shell only exists after the local Jekyll build + render
      // hook run; skip (rather than ENOENT-fail) when `_site` isn't built —
      // mirrors the sitemap.spec self-skip for the preview/prod lanes.
      test.skip(
        !fs.existsSync(INDEX_HTML),
        `${INDEX_HTML} not built (run the local Jekyll build + render-decap-config.rb) — bundle-version pin check only runs in the local lane`,
      );
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("runtime decap-cms version major.minor matches admin/index.html pin", async ({ page }) => {
      const pinned = readPinnedVersion();

      // Decap announces its version via `console.log("decap-cms X.Y.Z")`
      // when the bundle bootstraps. There's no stable `CMS.VERSION`
      // property on the global as of 3.12.x, so the console message
      // is the most reliable runtime probe. Capture it before navigating
      // so we don't race the script's first log call.
      const versionMessages = [];
      page.on("console", (msg) => {
        const text = msg.text();
        if (/^decap-cms\s+\d+\.\d+\.\d+/.test(text)) versionMessages.push(text);
      });

      await page.goto("/admin/index.html", { waitUntil: "domcontentloaded" });
      // Wait for the announce log to land. The bundle pushes it shortly
      // after the script tag parses, well before any backend call.
      await page.waitForFunction(() => !!(window.CMS || window.decapCms || window.DecapCms), null, {
        timeout: 60_000,
      });
      // Console events flush asynchronously — give the announce line a
      // beat to arrive before reading.
      await page.waitForTimeout(2000);

      const announce = versionMessages.find((m) => /^decap-cms\s+\d+\.\d+\.\d+/.test(m));
      expect(
        announce,
        `Decap should announce its version on the console at startup; got: ${JSON.stringify(versionMessages)}`,
      ).toBeDefined();
      const runtime = announce.match(/^decap-cms\s+(\d+\.\d+\.\d+)/)[1];

      expect(runtime, "Decap should expose a runtime VERSION on the CMS global").toMatch(
        /^\d+\.\d+\.\d+/,
      );

      // Loose comparison: the pinned tag and the resolved bundle must
      // agree on major.minor. Patch releases are intentionally allowed
      // to land via unpkg cache rotation without breaking this check —
      // the static-pin spec (admin-pin-invariant.test.js) handles the
      // exact-version requirement at the source.
      expect(
        majorMinor(runtime),
        `Runtime Decap VERSION ${runtime} should match the pinned ${pinned} on major.minor`,
      ).toBe(majorMinor(pinned));
    });
  },
);
