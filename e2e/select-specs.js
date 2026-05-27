#!/usr/bin/env node
//
// Decide which e2e spec files actually need to run for a given diff.
//
// Why: the full matrix is 8 projects × ~20 specs. A typo fix in a
// single blog post shouldn't pay for cross-browser admin-CMS specs,
// preview-bridge specs, or CloudFront router specs — those tests
// can't possibly be affected. Visual regression already does this on
// a per-page basis; this script extends the same idea to the rest of
// the e2e suite.
//
// CLI:
//   node e2e/select-specs.js [--base <ref>]
//
// Output (stdout): JSON envelope
//   {
//     "scope": "all" | "skip" | "subset",
//     "files": ["e2e/foo.spec.js", ...],     // only when scope=subset
//     "reason": "human-readable explanation"
//   }
//
// Exit code: 0 for success in all scopes (including "skip" — that's
// not an error). Non-zero only if git diff fails outright.
//
// Always-run baseline (cheap, no browser): compute-visual-diffs.test.js,
// cms-config.spec.js, visual-change-guard.spec.js, canary-content.test.js.
// If only those run, CI is essentially a no-op smoke check.
//
// Rules are intentionally over-eager on the "include" side: when in
// doubt, run the spec. Missing a relevant test is far more costly
// than running an irrelevant one.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ALWAYS_RUN = [
  "e2e/compute-visual-diffs.test.js",
  "e2e/cms-config.spec.js",
  "e2e/visual-change-guard.spec.js",
  "e2e/canary-content.test.js",
  // Pure ms-level fixture/helper invariant (#1053). Always-run so a
  // PR that flips a prod-loop canary back to `published: true`, or
  // breaks the shared force-baseline helper, fails visibly here — the
  // whole point of #1053 is that this regression was silent for ~10
  // days. @lane: local, no browser; mirrors canary-content.test.js.
  "e2e/fixture-baseline.test.js",
];

// Publish-loop browser specs that self-skip on PR runs because they're
// gated to RUN_HOST_REPO_PUBLISH_LOOP / RUN_PROD_MUTATE_PLAYGROUND. They
// do show up in the selector's `files` list (so the dedicated host-repo
// workflow can pick them up), but for shard-budget purposes they're
// effectively no-ops on a normal PR — we don't want to spin up a 4-way
// matrix because the selector returned three publish-loop specs that
// won't actually do any browser work.
const HEAVY = new Set([
  "e2e/cms-publish-loop.spec.js",
  "e2e/cms-publish-loop-preview.spec.js",
  "e2e/cms-publish-loop-prod-mutate.spec.js",
  "e2e/cms-delete-published.spec.js",
  "e2e/cms-delete-published-preview.spec.js",
  // Issue #999 preview-parity loops — heavy, self-skip on PR runs
  // (no PR_NUMBER), exercised by the dedicated cms-preview-loops
  // workflow. In HEAVY so a SPEC_RULES match doesn't inflate the
  // PR shard matrix for a spec that just no-ops.
  "e2e/cms-publish-loop-prod-mutate-preview.spec.js",
  "e2e/cms-unpublish-republish-preview.spec.js",
  "e2e/cms-tags-lifecycle-preview.spec.js",
]);

// Files that fan out to "every spec is potentially affected". Includes
// shared infrastructure (layouts/css/plugins), test infrastructure
// (helpers, base, configs), and dependency manifests.
// Fanout files that change the DEPLOYED / RENDERED output — a change
// here can alter what any page looks like, so the full local matrix
// runs AND the parity-preview specs (which probe the deployed
// preview-pr<N> surface) apply. Every one of these also triggers
// deploy-preview (none are in deploy-preview.yml's paths-ignore), so a
// preview is guaranteed to exist when parity-preview needs it.
const RENDER_FANOUT_PATTERNS = [
  /^_layouts\//,
  /^_includes\//,
  /^_config\.yml$/,
  /^assets\/css\//,
  /^_plugins\//,
  /^Gemfile/,
];

// Additional fanout files that change how the TEST SUITE runs but NOT
// the deployed site (npm/test tooling, Playwright config, the e2e base
// fixture, the e2e workflow itself). The local e2e matrix must still
// re-run broadly on these — but the parity-preview selector must NOT
// fan out on them: parity-preview probes the DEPLOYED preview, which
// these files don't change, and deploy-preview path-ignores every one
// of them (e2e/**, package*.json, playwright config), so it never
// produces a preview for a test/CI-only PR. Fanning parity-preview out
// on them therefore demanded a preview that can't exist → a spurious
// `parity` hard-fail on PRs that legitimately have no preview
// (#1723 follow-up: it blocked the Cat-2 PR, which only edited
// e2e-tests.yml + e2e/fixture-baseline*).
const TEST_INFRA_FANOUT_PATTERNS = [
  /^package(-lock)?\.json$/,
  /^playwright(\.regression)?\.config\.js$/,
  /^e2e\/base\.js$/,
  /^\.github\/workflows\/e2e-tests\.yml$/,
];

// The local e2e matrix fans out on BOTH sets (a test-infra change can
// shift local test execution). Order preserved so existing behaviour /
// the "first fanout file" reason string is byte-identical.
const FANOUT_PATTERNS = [...RENDER_FANOUT_PATTERNS, ...TEST_INFRA_FANOUT_PATTERNS];

// Per-spec inclusion rules. Each entry says: "if any changed file
// matches one of these patterns, include this spec." A spec NOT named
// here is included only via fanout (or because its own file changed).
const SPEC_RULES = {
  "e2e/admin-reviews-auth.spec.js": [/^admin\/reviews\//, /^oauth-proxy\//],
  // Live byte-parity probe: fetches every admin/ file from prod and
  // from the latest open PR's preview, compares ETag/sha256. Triggers
  // on any admin/ change so a CMS-shaped diff verifies it survives
  // the deploy round-trip without drift.
  "e2e/admin-bundle-parity.spec.js": [/^admin\//],
  "e2e/admin-reviews-stats.spec.js": [
    /^admin\/reviews\//,
    /^e2e\/compute-visual-diffs\.js$/,
    /^e2e\/generate-video\.sh$/,
    /^\.github\/workflows\/visual-regression\.yml$/,
  ],
  // Pure-node invariants on admin/index.html + admin/custom.css. Runs
  // any time admin/ changes — guards the cobalt theme + ?notheme
  // kill-switch contract documented in AGENTS.md.
  "e2e/admin-theme-removed.test.js": [/^admin\/(index\.html|custom\.css)$/],
  // Responsive-layout invariants for admin/admin-mobile.css (iPhone 16).
  // Runs on any admin/ change: the stylesheet, the shells that link it,
  // or a Decap version bump in index*.html could each regress the
  // mobile overlay. Drives the test-repo backend on the admin lane.
  "e2e/cms-mobile-layout.spec.js": [/^admin\//],
  // Cross-resolution occlusion guard for every admin screen (controls
  // not clipped off-screen or covered by another element). Runs on any
  // admin/ change and when the shared visibility helper changes.
  "e2e/admin-no-occlusion.spec.js": [/^admin\//, /^e2e\/ui-visibility\.js$/],
  "e2e/detect-changed-pages.test.js": [/^e2e\/detect-changed-pages\.js$/],
  "e2e/cms-smoke.spec.js": [/^admin\//, /^_posts\//, /^_tags\//, /^_projects\//, /^pages\//],
  "e2e/cms-editorial-workflow.spec.js": [/^admin\//, /^_posts\//],
  // Canary content invariants — fast, no browser. Cross-checks the
  // _e2e/ collection wiring stays consistent across _config.yml,
  // admin/config.yml, and the canary source files.
  "e2e/canary-content.test.js": [
    /^_e2e\//,
    /^admin\//,
    /^_config\.yml$/,
    /^_layouts\/canary\.html$/,
  ],
  // Issue #1042 admin posts-UI invariants — fast, pure-fs, no browser.
  // Locks the restored live-URL banner wiring + posts-list-enhance.js
  // augment/hide contract + the INVALID-DATE / Automated-tests /
  // test_fixture config and canary-marker invariants, PLUS the
  // preview/PR link relabel + "Check for Preview" commit-status fix
  // (deploy-preview.yml ↔ admin/config*.yml preview_context contract).
  // Runs on any admin/ change, canary _posts marker edits, and the
  // deploy-preview workflow whose commit status it locks.
  "e2e/cms-posts-list-enhance.spec.js": [
    /^admin\//,
    /^_posts\//,
    /^\.github\/workflows\/deploy-preview\.yml$/,
  ],
  // Behavioural unit test (pure-node, no browser) for posts-list-enhance.js's
  // reorderFixturesLast fixed point — guards the ≥2-fixture infinite reorder
  // loop that wedged the admin main thread (worst at the 3K viewport). Selects
  // on any change to the script it exercises.
  "e2e/posts-list-enhance-reorder.test.js": [/^admin\/posts-list-enhance\.js$/],
  // Real-network publish-loop specs. Heavy and slow; run only when
  // something contributor-relevant changed.
  "e2e/cms-publish-loop.spec.js": [
    /^admin\//,
    /^_layouts\/(post|page|project|canary|default)\.html$/,
    /^_layouts\/preview\.html$/,
    /^_e2e\//,
    /^scripts\/patch-preview-config\.sh$/,
    /^\.github\/workflows\/cms-editorial-workflow\.yml$/,
    /^\.github\/workflows\/deploy-production\.yml$/,
    /^\.github\/workflows\/deploy-preview\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|canary-content|cms-fixture-pr|cms-host)\.js$/,
  ],
  // Delete-published-entry flow. Same shape as the publish-loop spec
  // — both opt into RUN_HOST_REPO_PUBLISH_LOOP and run exclusively
  // under the dedicated cms-publish-loop-host workflow, but we still
  // want PR-time selection so changes to admin/, the canary fixtures,
  // or the editorial-workflow / deploy infra trigger a coverage
  // refresh.
  "e2e/cms-delete-published.spec.js": [
    /^admin\//,
    /^_e2e\//,
    /^_layouts\/canary\.html$/,
    /^\.github\/workflows\/(cms-editorial-workflow|deploy-production|cms-publish-loop-host)\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|canary-content|cms-fixture-pr|cms-host)\.js$/,
  ],
  "e2e/cms-publish-loop-preview.spec.js": [
    /^admin\//,
    /^_layouts\/(post|page|project|canary|default)\.html$/,
    /^_e2e\//,
    /^scripts\/patch-preview-config\.sh$/,
    /^\.github\/workflows\/cms-editorial-workflow\.yml$/,
    /^\.github\/workflows\/deploy-preview\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|canary-content|cms-host)\.js$/,
  ],
  // Preview-side delete-published-entry flow. Same opt-in shape as the
  // prod delete spec but targets a per-PR preview env (head ref,
  // cms-feature-branches ruleset, deploy-preview) — runs exclusively
  // under the dedicated cms-delete-published-preview workflow. PR-time
  // selection still fires so changes to admin/, the canary layout/
  // collection, the editorial-workflow / deploy-preview infra, the
  // shared run-cms-loop spine, or its imported helpers trigger a
  // coverage refresh.
  "e2e/cms-delete-published-preview.spec.js": [
    /^admin\//,
    /^_layouts\/canary\.html$/,
    /^_e2e\//,
    /^scripts\/patch-preview-config\.sh$/,
    /^\.github\/workflows\/(cms-editorial-workflow|deploy-preview|cms-delete-published-preview)\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|cms-host|run-cms-loop)\.js$/,
  ],
  // Unit test for the shared run-cms-loop spine. Pure-node; selects
  // when the spine impl or the test itself changes (the latter via
  // the direct-change rule, but listing the impl path keeps the
  // mapping explicit and survives a future rename of the test).
  "e2e/run-cms-loop.test.js": [/^e2e\/run-cms-loop\.js$/],
  // Structural + slug-derivation invariants for the per-CMS-slug preview
  // alias. Pure-node; selects when the shared slug script or the
  // deploy-preview workflow it asserts against changes.
  "e2e/deploy-preview-cms-slug.test.js": [
    /^scripts\/cms-preview-slug\.sh$/,
    /^\.github\/workflows\/deploy-preview\.yml$/,
  ],
  // Prod-mutation playground (G4). Skips itself unless CMS_E2E_PAT is
  // set, so PR runs are safe — the spec just emits a skip and exits.
  // Selecting it on its own infra changes here keeps the PR matrix
  // exercising the skip path so a regression in the gating doesn't
  // ride to prod silently.
  "e2e/cms-publish-loop-prod-mutate.spec.js": [
    /^admin\//,
    /^_layouts\/(post|default)\.html$/,
    // #1771 step 4: the persistent `_posts/2099-01-01-e2e-mutation-canary.md`
    // fixture was retired for an EPHEMERAL born-published per-run post; the
    // spec now builds its fixture from this module, so a change to it
    // refreshes PR-time coverage of the gating/skip path.
    /^e2e\/prod-mutate-fixture\.js$/,
    /^\.github\/workflows\/cms-editorial-workflow\.yml$/,
    /^\.github\/workflows\/deploy-production\.yml$/,
    /^\.github\/workflows\/cms-publish-loop-prod\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|cms-fixture-pr|cms-host)\.js$/,
  ],
  // Issue #999 preview-parity loops. Each is the preview-env
  // counterpart of a prod-only real-backend loop, driving the same
  // Decap mutation through `preview-pr<N>.adamdaniel.ai` against the
  // PR head branch (deploy-preview path) instead of main. Heavy +
  // self-skipping on PR runs (gated on PR_NUMBER); selected here so a
  // change to admin/, the fixtures, the editorial/deploy-preview
  // infra, the shared helpers, or the dedicated workflow refreshes
  // PR-time coverage of the gating/skip path. Run end-to-end only by
  // .github/workflows/cms-preview-loops.yml.
  "e2e/cms-publish-loop-prod-mutate-preview.spec.js": [
    /^admin\//,
    /^_layouts\/(post|default)\.html$/,
    // #1771 step 4 retired the persistent `_posts/2099-01-01-e2e-mutation-canary.md`
    // fixture this preview twin mirrored; with no committed fixture the spec
    // self-`fixme`s (dispatch-only, non-required). It stays selected by its
    // admin/helper/workflow rules below so the gating/skip path keeps coverage.
    /^scripts\/patch-preview-config\.sh$/,
    /^\.github\/workflows\/cms-editorial-workflow\.yml$/,
    /^\.github\/workflows\/deploy-preview\.yml$/,
    /^\.github\/workflows\/cms-preview-loops\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|cms-fixture-pr|cms-host)\.js$/,
  ],
  "e2e/cms-unpublish-republish-preview.spec.js": [
    /^admin\//,
    /^_layouts\/(post|default)\.html$/,
    /^_posts\/2024-01-02-e2e-unpublish-canary\.md$/,
    /^scripts\/patch-preview-config\.sh$/,
    /^\.github\/workflows\/cms-editorial-workflow\.yml$/,
    /^\.github\/workflows\/deploy-preview\.yml$/,
    /^\.github\/workflows\/cms-preview-loops\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|cms-fixture-pr|cms-host)\.js$/,
  ],
  "e2e/cms-tags-lifecycle-preview.spec.js": [
    /^admin\//,
    /^_tags\//,
    /^_layouts\/tag\.html$/,
    /^_plugins\/auto_tag_pages\.rb$/,
    /^scripts\/patch-preview-config\.sh$/,
    /^\.github\/workflows\/cms-editorial-workflow\.yml$/,
    /^\.github\/workflows\/deploy-preview\.yml$/,
    /^\.github\/workflows\/cms-preview-loops\.yml$/,
    /^e2e\/(decap-pat|github-actions-poll|cms-fixture-pr|cms-host)\.js$/,
  ],
  // Lightweight read-only preview-surface media gate. Selected when
  // anything that could regress the flat media_folder path on the
  // deployed build changes. @lane:real, single HTTP GET — NOT in the
  // HEAVY set (no Decap/PAT/mutation). The dedicated preview-media.yml
  // workflow is what makes it a required check.
  "e2e/preview-media-resolves.spec.js": [
    /^assets\/images\/uploads\//,
    /^admin\/config(-local)?\.yml$/,
    /^_config\.yml$/,
    /^_layouts\/(post|canary)\.html$/,
    /^scripts\/patch-preview-config\.sh$/,
    /^e2e\/cms-host\.js$/,
  ],
  "e2e/cms-publish-flow.spec.js": [
    /^admin\//,
    /^_posts\//,
    /^_layouts\/(post|default)\.html$/,
    /^_includes\//,
    // Cleanup helper that prunes the smoke post's orphaned sitemap URLs.
    /^e2e\/sitemap-prune\.js$/,
  ],
  // Pure-node unit test for the sitemap-prune cleanup helper.
  "e2e/sitemap-prune.test.js": [/^e2e\/sitemap-prune\.js$/],
  "e2e/cms-preview-url.spec.js": [/^admin\//, /^_posts\//],
  "e2e/blog-post.spec.js": [/^_posts\//, /^blog\//],
  "e2e/tags.spec.js": [/^_tags\//, /^tags\//],
  "e2e/not-found.spec.js": [/^404\.html$/],
  // @parity specs that hit Jekyll output through the deployed preview
  // surface. Path-rules cover the inputs that can shift what's served.
  // The sitemap/feed/console-clean/image-alt specs ALSO read `_site/`
  // locally — Jekyll's input set is wider than just _posts (layouts,
  // config, plugins), so anything that can change the rendered tree
  // selects them. Picked up by parity-preview.yml's spec selector
  // (see PARITY_PREVIEW_SPECS / selectParityPreviewSpecs below).
  "e2e/sitemap.spec.js": [
    /^_posts\//,
    /^_projects\//,
    /^_tags\//,
    /^pages\//,
    /^_config\.yml$/,
    /^_layouts\//,
    /^_plugins\//,
  ],
  "e2e/console-clean.spec.js": [
    /^_posts\//,
    /^_projects\//,
    /^pages\//,
    /^_config\.yml$/,
    /^_layouts\//,
    /^_includes\//,
    /^_plugins\//,
    /^assets\/css\//,
    /^assets\/js\//,
  ],
  "e2e/draft-isolation.spec.js": [
    /^_posts\//,
    /^_drafts\//,
    /^_config\.yml$/,
    /^_layouts\//,
    /^_includes\//,
  ],
  "e2e/image-alt-text.spec.js": [
    /^_posts\//,
    /^_projects\//,
    /^pages\//,
    /^_layouts\//,
    /^_includes\//,
    /^assets\/images\//,
  ],
  "e2e/glow-banding.spec.js": [
    // CSS-only spec; otherwise idle. Picks up via fanout.
  ],
  "e2e/preview-bridge.spec.js": [
    /^admin\/preview-bridge\.js$/,
    /^_layouts\/preview\.html$/,
    /^preview\.md$/,
  ],
  "e2e/preview-shell.spec.js": [
    /^_layouts\/preview\.html$/,
    /^admin\/preview-bridge\.js$/,
    /^preview\.md$/,
  ],
  "e2e/preview-config-patch.spec.js": [
    /^scripts\/patch-preview-config\.sh$/,
    /^admin\/(config\.yml|config-local\.yml)$/,
  ],
  "e2e/cloudfront-preview-router.spec.js": [/^infrastructure\//],
  "e2e/cloudfront-preview-location-fixer.spec.js": [/^infrastructure\//],
  // publish-via-auto-merge shim: pure-node matcher tests + browser-
  // context route-mocked tests. Trigger on any change to the shim
  // itself or the admin shell that loads it.
  "e2e/publish-via-auto-merge.test.js": [/^admin\/publish-via-auto-merge\.js$/],
  "e2e/publish-via-auto-merge-browser.spec.js": [
    /^admin\/publish-via-auto-merge\.js$/,
    /^admin\/index\.html$/,
  ],
  "e2e/visual-regression.spec.js": [
    // Master visual gate — always include when *anything* visual could
    // have shifted. Our fanout patterns cover that.
    /^_posts\//,
    /^_tags\//,
    /^_projects\//,
    /^pages\//,
    /^index\.html$/,
    /^blog\/index\.html$/,
    /^projects\/index\.html$/,
    /^tags\/index\.html$/,
  ],
  // #1101 regression guard. Pure-fs lint (no browser/network), but it
  // MUST run whenever a real-prod loop workflow or the await-prod-deploy
  // gate is edited — that is exactly when the shared-concurrency /
  // deploy-await invariants could silently regress. Without this rule a
  // loop-workflow tweak selects no workflow-*.test.js (they otherwise
  // only run on fanout or their own change).
  "e2e/workflow-prod-loop-serialized.test.js": [
    /^\.github\/workflows\/cms-publish-loop-prod\.yml$/,
    /^\.github\/workflows\/cms-media-roundtrip\.yml$/,
    /^\.github\/workflows\/cms-publish-loop-host\.yml$/,
    /^\.github\/actions\/await-prod-deploy\//,
  ],
};

function getChangedFiles(baseRef) {
  try {
    const out = execSync(`git diff --name-only ${baseRef}...HEAD`, {
      encoding: "utf8",
    }).trim();
    return out.split("\n").filter(Boolean);
  } catch {
    // Fallback: list current uncommitted changes.
    const out = execSync("git status --porcelain", { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }
}

// Parse `// @<key>: <value>` style directives from the head of a spec
// file. Reads ~500 bytes only — directives must live near the top of
// the file (above first import or under the leading comment block).
//
// Currently implements `@select-skip-when-head-ref-prefix:` (returned
// as `skipWhenHeadRefPrefix`). Designed to be extended: add a new case
// to the switch and return the value on the directive record.
//
// Multi-value directives are comma-separated. Whitespace around values
// is trimmed; empty entries are dropped.
//
// Errors swallow to {} so a missing/unreadable file never breaks the
// selector — directives are an additive opt-out, not a contract.
function parseSpecDirectives(absPath) {
  const directives = {};
  let head;
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(500);
      const n = fs.readSync(fd, buf, 0, 500, 0);
      head = buf.slice(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return directives;
  }

  // Match `// @key: value` directives. Allows leading whitespace inside
  // a `/* ... */` block (e.g. ` * @key: value`) so specs whose header
  // is a JSDoc-style block comment can also carry directives.
  const re = /^[\s/*]*@([a-z][a-z0-9-]*):[ \t]*([^\n\r]*)/gim;
  let m;
  while ((m = re.exec(head)) !== null) {
    const key = m[1].toLowerCase();
    const rawValue = m[2].trim();
    switch (key) {
      case "select-skip-when-head-ref-prefix": {
        const values = rawValue
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (values.length > 0) {
          directives.skipWhenHeadRefPrefix = (directives.skipWhenHeadRefPrefix || []).concat(
            values,
          );
        }
        break;
      }
      case "lane": {
        // First `@lane:` wins. Trailing `// — explanation` comments
        // are stripped so reviewers can leave a one-liner beside the
        // directive without breaking the parse. Invalid values are
        // rejected silently and treated as absent → caller defaults
        // to `local`.
        if (directives.lane !== undefined) break;
        const cleaned = rawValue
          .split("//")[0] // drop trailing "// rationale"
          .split(/[\s,;—-]/)[0] // first whitespace/punct token
          .trim()
          .toLowerCase();
        if (cleaned === "local" || cleaned === "real") {
          directives.lane = cleaned;
        }
        break;
      }
      // Future directives slot in here. Unknown keys are ignored
      // silently so old selectors don't fail on newer spec headers.
      default:
        break;
    }
  }
  return directives;
}

// Resolve the `@lane:` directive for a single spec, defaulting to
// `local` when absent or invalid. Local is the safe default — it
// keeps a spec on the hermetic matrix that has no opinions about
// real GitHub state.
function parseLaneDirective(absPath) {
  const d = parseSpecDirectives(absPath);
  return d.lane === "real" ? "real" : "local";
}

// Filter a list of repo-root-relative spec paths down to the ones whose
// `@lane:` directive matches the requested lane. Specs without an
// annotation default to `local` per parseLaneDirective.
//
// The `repoRoot` option lets callers point at a fixture tree; defaults
// to the repo root resolved from this file's location.
function filterByLane(specs, lane, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, "..");
  const wanted = lane === "real" ? "real" : "local";
  return specs.filter((spec) => {
    const abs = path.isAbsolute(spec) ? spec : path.join(repoRoot, spec);
    return parseLaneDirective(abs) === wanted;
  });
}

function selectSpecs(changedFiles, options = {}) {
  if (changedFiles.length === 0) {
    return {
      scope: "skip",
      reason: "No changed files detected — running baseline only.",
    };
  }

  const specs = new Set(ALWAYS_RUN);

  // Resolve lane up-front so the fanout branch can honour it too —
  // `scope: "all"` implies "every spec", and on a `real` lane that
  // means "every @lane: real spec", not "every spec ignoring lane".
  const resolvedLane =
    (options.lane !== undefined ? options.lane : process.env.TEST_LANE || "local").toLowerCase() ===
    "real"
      ? "real"
      : "local";

  // Fanout files include all specs.
  const fanoutHit = changedFiles.find((f) => FANOUT_PATTERNS.some((rx) => rx.test(f)));
  if (fanoutHit) {
    if (resolvedLane === "local") {
      return {
        scope: "all",
        reason: `Fanout file changed: ${fanoutHit} — running full matrix.`,
      };
    }
    // For non-default lanes, we can't return scope="all" — the
    // workflow's "all" path runs `npx playwright test` with no spec
    // list, which would also pick up every local-marked spec. Convert
    // to an explicit subset of every real-lane spec under e2e/.
    const repoRoot = options.repoRoot || path.resolve(__dirname, "..");
    const e2eDir = path.join(repoRoot, "e2e");
    let allSpecs;
    try {
      allSpecs = fs
        .readdirSync(e2eDir)
        .filter((f) => /\.spec\.js$/.test(f) || /\.test\.js$/.test(f))
        .map((f) => `e2e/${f}`);
    } catch {
      allSpecs = [];
    }
    const laneSpecs = allSpecs.filter(
      (s) => parseLaneDirective(path.join(repoRoot, s)) === resolvedLane,
    );
    if (laneSpecs.length === 0) {
      return {
        scope: "skip",
        reason: `Fanout file changed: ${fanoutHit}, but no spec matches lane=${resolvedLane}.`,
      };
    }
    return {
      scope: "subset",
      files: laneSpecs.slice().sort(),
      reason: `Fanout file changed: ${fanoutHit} — running every lane=${resolvedLane} spec.`,
    };
  }

  // Direct: a spec file's own change includes itself.
  for (const f of changedFiles) {
    if (/^e2e\/.*\.spec\.js$/.test(f) || /^e2e\/.*\.test\.js$/.test(f)) {
      specs.add(f);
    }
  }

  // Indirect: rules from SPEC_RULES.
  for (const [spec, patterns] of Object.entries(SPEC_RULES)) {
    for (const f of changedFiles) {
      if (patterns.some((rx) => rx.test(f))) {
        specs.add(spec);
        break;
      }
    }
  }

  // Spec-header directives. After rule matching, give each spec a
  // chance to opt OUT of selection on certain branches via its
  // `// @select-skip-when-head-ref-prefix:` header. Only filters the
  // rule-matched specs; the ALWAYS_RUN baseline is intentionally
  // exempt (those are tiny and self-document the change).
  const headRef =
    options.headRef !== undefined ? options.headRef : process.env.GITHUB_HEAD_REF || "";
  const skippedByDirective = [];
  const repoRoot = options.repoRoot || path.resolve(__dirname, "..");
  if (headRef) {
    const baseline = new Set(ALWAYS_RUN);
    for (const spec of [...specs]) {
      if (baseline.has(spec)) continue;
      const directives = parseSpecDirectives(path.join(repoRoot, spec));
      const prefixes = directives.skipWhenHeadRefPrefix;
      if (Array.isArray(prefixes) && prefixes.some((p) => headRef.startsWith(p))) {
        specs.delete(spec);
        skippedByDirective.push(spec);
      }
    }
  }

  // Lane filtering. After all other selection logic, drop specs whose
  // `@lane:` directive disagrees with the requested lane. Default lane
  // is `local`; specs without an annotation default to `local`.
  // ALWAYS_RUN is filtered too — a `real`-only run shouldn't pay for
  // the local-only baseline (e.g. compute-visual-diffs reads `_site/`).
  // resolvedLane was settled above so the fanout path could honour it.
  const skippedByLane = [];
  for (const spec of [...specs]) {
    if (parseLaneDirective(path.join(repoRoot, spec)) !== resolvedLane) {
      specs.delete(spec);
      skippedByLane.push(spec);
    }
  }

  // Quirk: changes ONLY to docs / READMEs / AGENTS.md don't need any
  // browser specs at all. Detect this by checking if everything outside
  // ALWAYS_RUN stayed unselected after the rule pass.
  const onlyDocs = changedFiles.every((f) =>
    /^(README\.md|AGENTS\.md|docs\/|\.agents\/skills\/)/.test(f),
  );
  if (onlyDocs && !options.disableSkip) {
    return {
      scope: "skip",
      reason: "Only documentation changed — running baseline only.",
    };
  }

  // If lane filtering dropped every spec (e.g. TEST_LANE=real on a
  // change that only affects local-only specs), there's nothing to
  // run — collapse to skip so the workflow doesn't try to launch an
  // empty shard.
  if (specs.size === 0 && !options.disableSkip) {
    return {
      scope: "skip",
      reason: `${changedFiles.length} file(s) changed but no spec matches lane=${resolvedLane}.`,
    };
  }

  // If after all the rules the only specs that survived are the always-
  // run baselines, the payload is identical to scope=skip. Collapse it
  // so the workflow can run a single shard instead of a 4-way matrix —
  // sharding 3 sub-second file-comparison tests is pure overhead.
  const onlyBaseline = specs.size === ALWAYS_RUN.length && ALWAYS_RUN.every((s) => specs.has(s));
  if (onlyBaseline && !options.disableSkip) {
    return {
      scope: "skip",
      reason: `${changedFiles.length} file(s) changed but none affect a non-baseline spec.`,
    };
  }

  const result = {
    scope: "subset",
    files: [...specs].sort(),
    reason: `Matched ${specs.size} spec(s) from ${changedFiles.length} changed file(s).`,
  };
  if (skippedByDirective.length > 0) {
    result.skippedByDirective = skippedByDirective.slice().sort();
  }
  if (skippedByLane.length > 0) {
    result.skippedByLane = skippedByLane.slice().sort();
  }
  return result;
}

// Decide how many parallel matrix shards the e2e job should fan out to,
// given the selector's verdict. The full 4-way matrix exists for the
// scope=all path (every spec, three browsers, four viewports = ~80 test
// minutes); paying that bring-up cost for a 30-test invariant subset is
// pure overhead. Heuristic, not measurement-driven — once we have data
// we can replace this with a duration-based bucket. The required check
// is `e2e (1)`, so this function MUST always include shard 1; the
// downstream workflow turns shard_count=N into the matrix [1..N], which
// guarantees that.
function pickShardCount(scope, files) {
  if (scope === "skip") return 1;
  if (scope === "all") return 4;
  if (scope === "subset") {
    const browser = (files || []).filter((f) => f.endsWith(".spec.js") && !HEAVY.has(f));
    if (browser.length <= 2) return 1;
    if (browser.length <= 6) return 2;
    return 4;
  }
  // Unknown scope — fail safe to the full matrix.
  return 4;
}

// ── @parity-preview selector ─────────────────────────────────────────
// The five @parity specs that hit the live preview-pr<N>.adamdaniel.ai
// surface (not /admin/index-local.html). Driven by .github/workflows/
// parity-preview.yml. The other three @parity-tagged specs
// (cms-link-crawler / manual-walkthrough-{contributor,content-guide})
// drive Decap's local_backend at /admin/index-local.html and self-skip
// on any non-local TARGET — they stay covered by the normal e2e matrix.
const PARITY_PREVIEW_SPECS = [
  "e2e/admin-bundle-parity.spec.js",
  "e2e/console-clean.spec.js",
  "e2e/draft-isolation.spec.js",
  "e2e/image-alt-text.spec.js",
  "e2e/sitemap.spec.js",
];

// "Direct edit to the spec file itself" counts as applicable so that
// renaming/touching a parity-preview spec exercises it once before merge.
function selectParityPreviewSpecs(changedFiles) {
  const selected = [];
  // RENDER fanout only — NOT the test-infra fanout. parity-preview
  // probes the deployed preview; only changes that alter the rendered
  // tree warrant re-checking it, and those are exactly the ones that
  // make deploy-preview produce a preview to check against. Test/CI
  // fanout files (e2e-tests.yml, package-lock.json, playwright config,
  // e2e/base.js) change test execution, not the deployed site, and
  // never produce a preview — so they must not force a parity-preview
  // run that would then hard-fail for want of a preview (#1723 follow-up).
  const fanout = changedFiles.some((f) => RENDER_FANOUT_PATTERNS.some((p) => p.test(f)));
  for (const spec of PARITY_PREVIEW_SPECS) {
    if (fanout || changedFiles.includes(spec)) {
      selected.push(spec);
      continue;
    }
    const rules = SPEC_RULES[spec] || [];
    if (rules.some((p) => changedFiles.some((f) => p.test(f)))) {
      selected.push(spec);
    }
  }
  return selected;
}

module.exports = {
  ALWAYS_RUN,
  FANOUT_PATTERNS,
  RENDER_FANOUT_PATTERNS,
  TEST_INFRA_FANOUT_PATTERNS,
  SPEC_RULES,
  HEAVY,
  PARITY_PREVIEW_SPECS,
  selectSpecs,
  selectParityPreviewSpecs,
  getChangedFiles,
  parseSpecDirectives,
  parseLaneDirective,
  filterByLane,
  pickShardCount,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";
  const changed = getChangedFiles(baseRef);
  // --parity-preview emits the @parity-preview subset for the
  // parity-preview workflow's salient detector. Output shape matches
  // the rest of the script (JSON envelope) so the workflow can
  // ${{ fromJSON(...) }} the file list directly.
  if (args.includes("--parity-preview")) {
    const files = selectParityPreviewSpecs(changed);
    process.stdout.write(
      JSON.stringify(
        {
          scope: files.length ? "subset" : "skip",
          files,
          reason: files.length
            ? `Matched ${files.length} parity-preview spec(s) from ${changed.length} changed file(s).`
            : `${changed.length} file(s) changed; no parity-preview spec applies.`,
          changedFiles: changed,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  }
  // GITHUB_HEAD_REF is set by GHA on `pull_request` events; empty for
  // `schedule` / `workflow_dispatch` / `push` (cron, manual, main-push).
  // An empty headRef disables directive filtering — every annotated
  // spec stays selected, matching pre-Layer-3.A behaviour.
  const result = selectSpecs(changed, {
    headRef: process.env.GITHUB_HEAD_REF || "",
  });
  // Make output stable across CI runs by sorting and including the
  // changed-files list for traceability.
  result.changedFiles = changed;
  // Layer 2: emit a recommended shard count so the workflow can scale
  // the matrix to the subset's actual size. The workflow turns this
  // into a [1..N] array; downstream the required check (`e2e (1)`)
  // continues to fire because shard 1 is always in the array.
  result.shard_count = pickShardCount(result.scope, result.files);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
