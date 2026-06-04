const { defineConfig } = require("@playwright/test");
const path = require("node:path");

// SITE_ROOT — the consuming SITE's repo root, which the local lane builds
// + serves. When the harness lives AT the site root (adamdaniel.ai@main,
// where `e2e/` sits at the repo root) `path.resolve(__dirname, "..")` IS
// the site, so the env var is unset and this default holds. When the
// platform is consumed (checked out into `<site>/.cms-platform/` and the
// harness copied to `<site>/e2e/`, or run in place) the reusable workflow
// exports `SITE_ROOT=$GITHUB_WORKSPACE` so the local `webServer` builds the
// SITE, not the platform. This is the SAME invariant `e2e/base.js`'s
// `REPO_ROOT` (and ~20 specs' own `path.resolve(__dirname, "..")`) rely on
// for their site-file reads — keep the harness placed so that resolves to
// the site, and SITE_ROOT here agrees with it.
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

// CONSUMER mode — true when this harness runs against a consuming SITE
// (SITE_ROOT is set, the harness placed at the site root, the site built +
// served). When SITE_ROOT is UNSET we're in the platform's OWN self-CI
// (cwd == platform repo, `e2e/` at the platform root), and the full suite —
// including the meta-lints — runs.
//
// PLATFORM_META_SPECS are the "meta" specs: they assert the PLATFORM'S OWN
// source — its GitHub workflows, scripts, infra, harness internals, lint
// rules, and fixture machinery (workflow-graph, *-lint, select-lane,
// spec-load-smoke, run-cms-loop, the platform's *.test.js harness unit
// tests, etc.). They read files that exist only in the platform tree
// (`.github/workflows/*`, `scripts/*`, the harness's own `e2e/*.js`
// helpers) and make sense ONLY when run against the platform checkout. A
// CONSUMER ships the rendered SITE (the harness placed at site root, the
// gem-rendered admin under `_site/admin/`) and has none of that source, so
// these specs would ENOENT-fail or assert against the wrong tree. In
// CONSUMER mode they are testIgnore'd; the consumer runs only SITE specs
// (the real CMS round-trips + public-page contracts). The names are kept as
// basenames; the regex below matches them anywhere under the testDir.
const CONSUMER = !!process.env.SITE_ROOT;
const PLATFORM_META_SPECS = [
  // Platform-internal: admin-JS augmentation + the deploy-preview workflow-shape
  // assertion; and the exclude-plugin's synthetic-build test. Validated in the
  // platform's own self-CI (against the platform tree), not a consumer site.
  "cms-posts-list-enhance.spec.js",
  "e2e-posts-public-exclusion.test.js",
  "admin-bundle-parity.spec.js",
  "admin-css-banned-patterns.test.js",
  "admin-pin-invariant.test.js",
  "admin-theme-removed.test.js",
  "analytics-cloudwatch-rum.test.js",
  "auto-merge-uses-queue.test.js",
  // #33 — platform-internal: the base_collections capability helper's unit
  // test (drives the platform's TWO fixtures) + the build-and-run meta proof
  // (builds both fixtures, subprocess-runs the guarded specs against each).
  // Both read the platform's own fixture trees / harness internals — they make
  // sense only in the platform self-CI, never in a consumer.
  "site-capabilities.test.js",
  "base-collections-skip-meta.test.js",
  // #33 CONCERN B — the pure-fs guard-registry lint: reads the platform's TWO
  // fixtures' _config.yml + the harness spec sources + playwright.config.js's
  // own PLATFORM_META_SPECS. Platform-internal; runs in self-ci node-unit-lints.
  "base-collections-guard-registry.test.js",
  "blog-slug-literal-lint.test.js",
  "cms-automerge-nudge.test.js",
  "cms-editor-ui.test.js",
  "cms-host.test.js",
  "cms-label-contract.spec.js",
  "cms-recursion-churn.test.js",
  "cms-scheduled-post.spec.js",
  "cloudfront-preview-location-fixer.spec.js",
  "cloudfront-preview-router.spec.js",
  "compute-visual-diffs.test.js",
  "decap-config-render-parity.test.js",
  "dependabot-skip.test.js",
  "deploy-commit-metadata.test.js",
  "deploy-pill.test.js",
  "deploy-preview-cms-slug.test.js",
  "deploy-status-pill-robustness.test.js",
  "detect-changed-pages.test.js",
  "fixture-baseline.test.js",
  "generate-test-videos.test.js",
  "github-actions-poll.test.js",
  "live-failures-reporter.test.js",
  "matchmedia-skip-lint.test.js",
  "oauth-app-restriction-detector.spec.js",
  "oauth-app-restriction-detector.test.js",
  "parity-tag-lint.test.js",
  "playwright-image-drift.test.js",
  "posts-list-enhance-reorder.test.js",
  "preview-bot-comment.test.js",
  "preview-config-patch.spec.js",
  "preview-deploy-superset.test.js",
  "prod-mutate-fixture.test.js",
  "public-content.test.js",
  "publish-via-auto-merge.test.js",
  "publish-via-auto-merge-browser.spec.js",
  "regression-video.spec.js",
  "run-cms-loop.test.js",
  "select-lane.test.js",
  "select-specs.test.js",
  "silent-catch-lint.test.js",
  "sitemap-prune.test.js",
  "slugify-parity.test.js",
  "spec-load-smoke.test.js",
  "visual-change-guard.spec.js",
  "visual-regression-content-skip.test.js",
  "visual-regression-skip-review.test.js",
  "workflow-github-sha-lint.test.js",
  "workflow-graph.test.js",
  "workflow-prod-loop-serialized.test.js",
  "workflow-run-name.test.js",
  "workflow-shell-glob-lint.test.js",
  "workflow-triggers.test.js",
];

// A single regex matching any PLATFORM_META_SPEC basename. Each name is
// escaped (the `.` in `.spec.js` / `.test.js` is a literal) and anchored to
// a path separator (or string start) on the left + end-of-string on the
// right, so `cms-host.test.js` matches `e2e/cms-host.test.js` but never a
// hypothetical `xcms-host.test.js`.
const META_SPECS_RE = new RegExp(
  "(?:^|[\\\\/])(?:" +
    PLATFORM_META_SPECS.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")$",
);

// regression-video.spec.js is ALWAYS ignored (it's a video-fixture
// generator, not a test — and it's also in the meta list above). In
// CONSUMER mode we additionally ignore every meta spec. Playwright's
// `testIgnore` accepts an array of regexes (OR-combined), so we pass the
// always-on regression ignore plus the meta-specs ignore only when CONSUMER.
const TEST_IGNORE = CONSUMER
  ? [/regression-video\.spec\.js/, META_SPECS_RE]
  : /regression-video\.spec\.js/;

// Absolute path to the harness's own node_modules/.bin. The local webServer
// commands `cd ${SITE_ROOT}` first (so `serve`/`decap-server` resolve site
// files + write into the SITE tree), but the SITE has no node_modules, so
// referencing the binaries by absolute path keeps them resolvable from the
// harness regardless of CWD. (`jekyll` is a Ruby gem run via the site's
// `bundle exec`, so it isn't here.)
const HARNESS_BIN = path.join(__dirname, "node_modules", ".bin");
const SERVE_BIN = path.join(HARNESS_BIN, "serve");
const DECAP_SERVER_BIN = path.join(HARNESS_BIN, "decap-server");

const DESKTOP = { width: 1920, height: 1080 };
const LAPTOP = { width: 1366, height: 768 };
const TABLET = { width: 768, height: 1024 };
const MOBILE = { width: 375, height: 667 };
// 3K-monitor approximation. The admin UI is exercised at this resolution
// (and ONLY this resolution among Chromium projects) so a contributor
// running Chrome on a 3K display sees the same affordances the test
// matrix asserts.
const DESKTOP_3K = { width: 3000, height: 1500 };
// iPhone 16 portrait viewport. The 393×852 logical viewport and 3x DPR
// match Apple's published spec; it's the single WebKit surface the
// admin UI is exercised on (per AGENTS.md "iOS-anything is WebKit",
// this also covers iOS Chrome / Edge / Firefox since iOS bans
// third-party rendering engines).
const IPHONE_16 = { width: 393, height: 852 };

// Tag-based browser-matrix filtering.
//
// Admin specs are tagged via Playwright's `{ tag: ['@admin-write' | ...] }`
// option on `test.describe(...)` or `test(...)`. Three admin tags exist:
//
//   @admin-write       — drives /admin/* AND writes (Decap Save → cms/* PR,
//                        decap-server FS write, etc.). Runs on
//                        chromium-desktop-3k ONLY. Single-browser by
//                        design: writes are heavy and serial.
//   @admin-read        — drives /admin/* but is read-only (DOM contract,
//                        HTTP byte parity, mocked APIs). Runs on
//                        chromium-desktop-3k AND webkit-iphone16 — the
//                        two engines admin UI actually needs to render in.
//   @admin-screenshots — manual-walkthrough-* specs. They write to
//                        docs/manual-screenshots/ (project-INDEPENDENT
//                        paths, so two parallel projects would race and
//                        last-write-wins). Run on chromium-desktop-3k
//                        ONLY for screenshot determinism.
//
// `\b` (word boundary) on the tag name prevents future tag-name prefix
// collisions: `/@admin-read\b/` matches `@admin-read` but NOT a
// hypothetical `@admin-readonly`.
const ADMIN_TAGS_ALL = /@admin-write\b|@admin-read\b|@admin-screenshots\b/;
const ADMIN_TAGS_READ = /@admin-read\b/;

// G3 — `TARGET=` env switch. Local is the default for every dev run and
// the existing CI matrix; preview/prod skip the local Jekyll + decap-server
// bring-up because they hit deployed surfaces directly via the `baseURL`
// fixture override in `e2e/base.js`.
const TARGET = (process.env.TARGET || "local").toLowerCase();
const IS_LOCAL = TARGET === "local";

module.exports = defineConfig({
  testDir: ".",
  testIgnore: TEST_IGNORE,
  // Install-on-miss browser self-heal (#1723 Cat 4): a sub-ms no-op when
  // the prebaked browsers match this @playwright/test version (the normal
  // path); installs only the missing build(s) on the rare image/cache
  // mismatch so specs don't die at launch with "Executable doesn't exist".
  globalSetup: "./install-browsers-on-miss.js",
  fullyParallel: true,
  // Single auto-retry on CI for the decap-server file-write race (and any
  // similar transient flake). Local runs stay at 0 so a regression caught
  // while iterating fails loudly the first time. A test that fails once
  // and then passes lands in Playwright's report as "flaky" — visible,
  // but doesn't block the merge gate.
  retries: process.env.CI ? 1 : 0,
  // Only spin up the local Jekyll build + decap-server when targeting
  // `local`. Preview/prod runs hit deployed surfaces and don't need
  // either process — running them would be ~30s of wasted bring-up plus
  // a hard fail when bundler/jekyll aren't installed in the remote-only
  // job's container.
  webServer: IS_LOCAL
    ? [
        {
          // Build + serve the SITE (SITE_ROOT), not the harness's parent —
          // see the SITE_ROOT note at the top of this file. `cd ${SITE_ROOT}`
          // makes both `bundle exec jekyll build` (reads the site's Gemfile +
          // _config.yml) and the served `_site` resolve to the consuming site.
          command: `cd ${SITE_ROOT} && bundle exec jekyll build --quiet && "${SERVE_BIN}" ${SITE_ROOT}/_site -l 4000 --no-clipboard`,
          port: 4000,
          reuseExistingServer: !process.env.CI,
        },
        {
          // Decap CMS local-backend proxy: handles file IO for `local_backend: true`
          // in admin/config-local.yml. Without it, the smoke spec's Login →
          // Save / Delete cycle has nowhere to write to. decap-server writes
          // relative to its CWD, so it MUST run from the SITE root (this `cd`
          // was missing — a latent bug that only worked because the harness
          // lived at the site root) or saves land in the wrong tree.
          command: `cd ${SITE_ROOT} && "${DECAP_SERVER_BIN}"`,
          // Readiness = the open TCP port. A prior change used
          // `url: "http://localhost:8081/"` to wait for an HTTP response, but
          // Playwright's webServer readiness only accepts HTTP 200-403, and
          // decap-server returns 404 for EVERY GET route (/, /api/v1, /health —
          // empirically verified) and 422 only for POST /api/v1. So no `url:`
          // probe can ever go ready, and that silently broke the entire
          // `target:local` lane (60s webServer timeout) for every consumer
          // (cms-platform Self CI runs TARGET=prod, so it never caught it).
          // The TCP `port` check is the only mechanism that works here; the
          // original socket-open-before-API-ready flake belongs in a harness
          // readiness poll, which the webServer `url` cannot express.
          port: 8081,
          reuseExistingServer: !process.env.CI,
        },
      ]
    : undefined,
  use: {
    // Default baseURL — picked up by `page.goto("/foo")` and
    // `page.request.get("/foo")` calls in every spec. The `TARGET=` env
    // switch (G3) overrides this fixture at module-init time via
    // `e2e/base.js`: when TARGET=preview or TARGET=prod, the custom
    // `test` extends `baseURL` to resolve at fixture creation
    // (https://preview-pr<latest>.adamdaniel.ai or https://adamdaniel.ai),
    // so every path-relative request routes there instead. The CI matrix
    // drives `TARGET=prod` against the `@parity` subset on every PR; see
    // `.github/workflows/e2e-tests.yml` and the
    // `e2e/parity-tag-lint.test.js` read-only guard.
    baseURL: process.env.CMS_BASE_URL || "http://localhost:4000",
    screenshot: "on",
    video: "retain-on-failure",
    // Default action timeout — caps every page action (click, fill,
    // press, type, etc.) that doesn't pass an explicit `timeout`.
    // Playwright's library default is 0 (no timeout), which turns any
    // missing-element bug into the worst kind of failure: the runner
    // hangs until the outer test timeout fires. Run #25473784039 was
    // exactly this — `getByRole("button", { name: /^Status:/i }).click()`
    // missed because the canary entry's actual button label was
    // "Published"; the click pegged the runner for ~40 min before
    // the spec timeout finally killed it. 30 s is generous for any
    // real Decap interaction (the slowest in-flight thing is the
    // editor mount, which the specs explicitly wait for via
    // `expect(...).toBeVisible({ timeout: 60_000 })` — that's an
    // expect, not an action) and turns the next "selector drifted"
    // bug into a 30 s fast-fail with a clear diagnostic.
    actionTimeout: 30_000,
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
    },
  },
  reporter: process.env.CI
    ? [
        ["html", { open: "never" }],
        ["list"],
        // Live failure stream — posts a marker-tagged comment per
        // terminal failure (final retry only) so agents watching the
        // PR see signal before the whole job ends. No-ops outside CI
        // and when GITHUB_TOKEN / PR_NUMBER aren't exposed; opt in by
        // adding `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and
        // `PR_NUMBER: ${{ github.event.pull_request.number }}` to a
        // job's env. See e2e/live-failures-reporter.js.
        ["./live-failures-reporter.js"],
      ]
    : [["list"]],
  projects: [
    // ── Public-page lane (7 projects) ─────────────────────────────
    // Browser × viewport diversity for public-facing pages
    // (/, /blog/<slug>/, /tags/, /tags/<slug>/, /tags/<slug>/feed.xml,
    // /sitemap.xml, /404.html, etc.). Each project EXCLUDES admin tags
    // via grepInvert so admin specs only run on the dedicated admin
    // projects below.
    {
      // Public-lane Chromium project (viewport DESKTOP = 1920×1080). The
      // "-1080" suffix mirrors "chromium-desktop-3k" (admin-lane, 3K) so
      // the project name encodes the viewport — historical "chromium-
      // desktop" left the resolution implicit.
      name: "chromium-desktop-1080",
      use: { browserName: "chromium", viewport: DESKTOP },
      grepInvert: ADMIN_TAGS_ALL,
    },
    {
      name: "chromium-laptop",
      use: { browserName: "chromium", viewport: LAPTOP },
      grepInvert: ADMIN_TAGS_ALL,
    },
    {
      name: "chromium-mobile",
      use: { browserName: "chromium", viewport: MOBILE },
      grepInvert: ADMIN_TAGS_ALL,
    },
    {
      name: "firefox-desktop",
      use: { browserName: "firefox", viewport: DESKTOP },
      grepInvert: ADMIN_TAGS_ALL,
    },
    {
      name: "webkit-tablet",
      use: { browserName: "webkit", viewport: TABLET },
      grepInvert: ADMIN_TAGS_ALL,
    },
    {
      name: "chromium-large-text",
      use: { browserName: "chromium", viewport: DESKTOP, rootFontSize: "20px" },
      grepInvert: ADMIN_TAGS_ALL,
    },
    {
      name: "chromium-light",
      use: { browserName: "chromium", viewport: DESKTOP, colorScheme: "light" },
      grepInvert: ADMIN_TAGS_ALL,
    },
    {
      name: "chromium-forced-colors",
      use: {
        browserName: "chromium",
        viewport: DESKTOP,
        forcedColors: "active",
      },
      grepInvert: ADMIN_TAGS_ALL,
    },

    // ── Admin lane (2 projects) ───────────────────────────────────
    // The admin UI only needs to render correctly in the two engines
    // a contributor actually uses: Chromium at 3K-monitor scale and
    // WebKit at iPhone 16. See `ADMIN_TAGS_*` above for the routing
    // contract — tags are added per spec via `{ tag: [...] }` on
    // `test.describe(...)` or `test(...)`.
    {
      name: "chromium-desktop-3k",
      use: { browserName: "chromium", viewport: DESKTOP_3K },
      // Runs every admin tag (write, read, and screenshots).
      grep: ADMIN_TAGS_ALL,
    },
    {
      name: "webkit-iphone16",
      use: {
        browserName: "webkit",
        viewport: IPHONE_16,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
      // Read-only admin specs only — writes (cms/* PR creation, FS
      // mutations) and screenshot-deterministic specs run on
      // chromium-desktop-3k only.
      grep: ADMIN_TAGS_READ,
    },
  ],
});
