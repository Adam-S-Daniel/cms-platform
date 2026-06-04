// @lane: local — builds BOTH fixture shapes + runs the base_collections-guarded
// specs against each as a subprocess; no network, no browser (the guarded specs
// it drives are pure-fs rendered-config / built-_site reads).
//
// THE #33 PROOF. The platform ships ~a dozen e2e specs that assume the generic
// collections (posts/tags/projects/pages/e2e) + canary content exist. A
// single-page consumer that opts out via `cms.base_collections: []` (v0.1.7,
// e.g. jodidaniel.com) used to red-fail every one of them. This meta-test is
// the platform's own regression lock that the fix HOLDS in BOTH directions:
//
//   (i)  on the OPTED-OUT fixture (fixture-site-singlepage) the guarded specs
//        SKIP — they do NOT fail; and
//   (ii) on the FULL fixture (fixture-site) the SAME specs still RUN (pass) —
//        the skip is precise and never masks a real failure on a full consumer.
//
// HOW. It builds each fixture (the theme gem's decap_config_hook renders
// `_site/admin/config.yml`; jekyll renders `_site/sitemap.xml`, `_site/e2e/`),
// then runs the FS-BASED guarded specs against each via a child `playwright
// test --reporter=json`, keyed on SITE_ROOT. It parses the JSON to count
// skipped-vs-passed-vs-failed per fixture. The served-site guards
// (tags/feeds/console-clean) are proven by the same `site-capabilities`
// predicates this drives + their own runtime self-skips; only the FS specs are
// driven here so the meta-test needs no Jekyll server / browser.
//
// Recursion guard: the child invocation runs ONLY the explicitly-named spec
// files (never this meta-test), and this file self-skips when CMS_META_CHILD=1
// so a stray discovery of it inside the child can't recurse.
//
// Toolchain guard: builds need bundler + jekyll; in the Ruby-less
// node-unit-lints self-CI lane this test SKIPS (mirrors
// scaffold-preview-and-404.test.js's "(c) built fixture" gate). It runs fully
// in any environment that can build (dogfood / local dev / the e2e reusable).
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

const HARNESS = __dirname;
const FULL = path.join(HARNESS, "fixture-site");
const SINGLEPAGE = path.join(HARNESS, "fixture-site-singlepage");
const PW_BIN = path.join(HARNESS, "node_modules", ".bin", "playwright");

// FS-based guarded specs: each reads the rendered `_site/admin/config.yml`,
// `_site/sitemap.xml`, or the `_e2e`/`_site/e2e` canary content — NO page.goto.
// These are the ones this meta-test drives directly. (The served-content
// guards — tags.spec, feeds-and-share, console-clean — share the same
// site-capabilities predicates, locked by site-capabilities.test.js.)
const FS_GUARDED_SPECS = [
  "cms-config.spec.js",
  "cms-post-list-summary.spec.js",
  "cms-permalink-contract.spec.js",
  "canary-content.test.js",
  "canary-ondemand-noindex.test.js",
  "sitemap.spec.js",
];

function hasJekyllToolchain(siteRoot) {
  try {
    execFileSync("bundle", ["--version"], { stdio: "pipe" });
  } catch (_) {
    return false;
  }
  // The fixture must have resolved gems (Gemfile.lock) so `bundle exec` works
  // without a network install mid-test.
  return fs.existsSync(path.join(siteRoot, "Gemfile.lock"));
}

function buildFixture(siteRoot) {
  // The theme gem's Jekyll generator (decap_config_hook.rb) renders
  // `_site/admin/config.yml` as part of the build, honoring this fixture's
  // `cms.base_collections`. Production env mirrors the real deploy.
  execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
    cwd: siteRoot,
    stdio: "pipe",
    env: { ...process.env, JEKYLL_ENV: "production" },
  });
}

// Run the FS-guarded specs against `siteRoot` via a child playwright and parse
// the JSON reporter. TARGET=prod makes playwright.config.js skip the local
// Jekyll/decap webServer bring-up (it's local-only) — the specs read the
// already-built `_site` directly. Returns a flat list of { title, status }.
function runGuardedSpecs(siteRoot) {
  let raw;
  try {
    raw = execFileSync(PW_BIN, ["test", "--reporter=json", "--project=chromium-light", ...FS_GUARDED_SPECS], {
      cwd: HARNESS,
      env: {
        ...process.env,
        SITE_ROOT: siteRoot,
        TARGET: "prod",
        CMS_META_CHILD: "1",
        CI: "", // no auto-retry; deterministic counts
        PW_TEST_HTML_REPORT_OPEN: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // playwright exits non-zero when any test fails; the JSON is still on
    // stdout, which is exactly the case we assert against on the buggy
    // (pre-fix) path. Fall back to its stdout.
    raw = e.stdout || Buffer.from("");
  }
  const report = JSON.parse(raw.toString("utf8") || "{}");
  const out = [];
  const walk = (suite) => {
    for (const s of suite.suites || []) walk(s);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        // Playwright's JSON: t.status is "expected"|"unexpected"|"skipped"|"flaky".
        // Map to passed/failed/skipped using the result outcome.
        const result = (t.results && t.results[0]) || {};
        const status = result.status || t.status; // "passed"|"failed"|"skipped"|"timedOut"
        out.push({ title: `${spec.file} › ${spec.title}`, status });
      }
    }
  };
  for (const s of report.suites || []) walk(s);
  return out;
}

test.describe("#33 base_collections skip contract — opted-out SKIPS, full RUNS", () => {
  test.describe.configure({ mode: "serial", timeout: 600_000 });

  // Self-skip inside the child invocation (belt-and-braces; the child never
  // names this file, but a stray discovery must not recurse).
  test.skip(process.env.CMS_META_CHILD === "1", "child meta invocation — no nested meta run");

  const TOOLCHAIN = hasJekyllToolchain(FULL) && hasJekyllToolchain(SINGLEPAGE);

  test("opted-out fixture: every FS-guarded spec SKIPS (none fail)", () => {
    test.skip(!TOOLCHAIN, "no Jekyll toolchain (bundler + both Gemfile.lock) — pure-fs lanes skip the build-and-run proof");
    buildFixture(SINGLEPAGE);
    const results = runGuardedSpecs(SINGLEPAGE);
    expect(results.length, "child run produced no test results").toBeGreaterThan(0);
    const failed = results.filter((r) => r.status === "failed" || r.status === "timedOut");
    const skipped = results.filter((r) => r.status === "skipped");
    expect(
      failed,
      `on the opted-out fixture these specs FAILED instead of skipping:\n${failed
        .map((f) => `  ✘ ${f.title}`)
        .join("\n")}`,
    ).toEqual([]);
    // At least the per-collection generic specs must have engaged a skip —
    // not silently produced zero tests.
    expect(skipped.length, "expected the guarded specs to SKIP on the opted-out fixture").toBeGreaterThan(0);
  });

  test("full fixture: the SAME FS-guarded specs RUN (pass; skip is precise)", () => {
    test.skip(!TOOLCHAIN, "no Jekyll toolchain (bundler + both Gemfile.lock) — pure-fs lanes skip the build-and-run proof");
    buildFixture(FULL);
    const results = runGuardedSpecs(FULL);
    expect(results.length, "child run produced no test results").toBeGreaterThan(0);
    const failed = results.filter((r) => r.status === "failed" || r.status === "timedOut");
    const passed = results.filter((r) => r.status === "passed");
    expect(
      failed,
      `on the FULL fixture these specs FAILED (the skip must never mask a real failure):\n${failed
        .map((f) => `  ✘ ${f.title}`)
        .join("\n")}`,
    ).toEqual([]);
    // The full fixture has every collection + canary, so the guarded specs
    // must actually RUN (pass), not skip — proving the guards are precise.
    expect(passed.length, "expected the guarded specs to RUN (pass) on the full fixture").toBeGreaterThan(0);
  });
});
