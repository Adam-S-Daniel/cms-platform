---
name: browser-testing
description: Write, run, and maintain Playwright e2e tests across the browser/viewport/accessibility matrix. Use when adding new e2e tests, updating the test matrix, debugging cross-browser failures, or understanding how the browser testing infrastructure works.
compatibility: Requires Node.js 20+, Ruby 3.2+ with Jekyll, Playwright browsers installed.
---

# Browser Testing Matrix

All e2e tests run across 10 Playwright projects in two lanes: 8 public-page projects (browsers, viewports, text sizes, color settings) that run every spec WITHOUT an `@admin-*` tag, and 2 admin-lane projects (`chromium-desktop-3k` for `@admin-write`/`@admin-read`, `webkit-iphone16` for `@admin-read` only) that run only tagged specs. Tag routing is opt-IN — an untagged spec runs on every public-lane project, so any spec that drives `/admin` MUST carry `@admin-write` or `@admin-read` (`e2e/admin-tag-lint.test.js` fails the build otherwise; see "Matrix projects" below). Tests run fully parallel.

## Platform CI shape (read this first)

The platform ships ONE reusable e2e workflow, `.github/workflows/e2e-tests.yml`, called by a thin per-site wrapper. Several details in the older prose below describe an earlier, simpler shape the platform does **not** have anymore:

- **One job per Playwright project, plus an aggregating gate — not a single job.** `e2e-tests.yml` fans a `project` matrix out to 10 jobs (one per project in `playwright.config.js`, derived by `e2e/ci-matrix.js`), each `runs-on: ubuntu-latest`, each installing only its own browser engine, each at `150%` workers. An `e2e` gate job (`needs: project`, `if: always()`) fails if any matrix result is non-success. The single REQUIRED status context stays `e2e / e2e`; the 10 per-project contexts are informational and named by no ruleset. There is still no separate `parity` / `finalize` job on THIS workflow (parity has its own reusable, `parity-preview.yml` — see below) and still no per-test-video assembly job (see "Per-test screenshot videos" further down).
- **No container image; browsers install through a two-phase, retried composite — never a raw `npx playwright install`.** Each project job's install step calls `./.cms-platform/.github/actions/install-playwright-browsers` (both phases retry with backoff, but only the browser-download phase is time-bounded — the apt phase, `install-deps`, deliberately never is; see `docs/E2E-PARALLELISM.md`), not a bare `npx playwright install --with-deps <browser>`. A raw install once took **39 minutes** on a slow Ubuntu mirror while the tests it installed for took 41.6 s — that's why the composite exists; never shell out to the bare command from a workflow. The `mcr.microsoft.com/playwright:v<version>-noble` container, the "browsers are baked into the image" model, and the image-version-drift `select` check still do NOT apply to the reusable workflow — there is no prebaked-browser image anywhere in the platform, so every lane installs inline, on the critical path. (A `scripts/check-playwright-image-drift.js` exists, but the reusable e2e workflow doesn't use a container.)
- **`e2e-tests.yml` itself still has no diff-aware spec selection and no sharding of its own** — it runs the full 10-project matrix on every call, deliberately: the goal is to run the *same* coverage faster, not less of it. `e2e/select-specs.js` genuinely IS wired into CI now, but only into `parity-preview.yml` (its `--parity-preview` flag / `selectParityPreviewSpecs()`, reusing this module's `SPEC_RULES`); `preview-media.yml` runs an analogous inline salient-path check for the same always-run-plus-early-skip purpose, but does not call this module. Neither adamdaniel.ai's own e2e lane nor the platform's `e2e-tests.yml` uses the selector or the `shard_count`/`[1..N]`-matrix machinery described later in this file — see "Diff-aware spec selection" below for what's actually wired up.
- **Parameterized on env, not site identity.** The suite reads `TARGET`, `CMS_PROD_URL`, `CMS_APEX`, `CMS_REPO` (= `${{ github.repository }}`), and `PR_NUMBER` from the workflow inputs/env, so a new site passes its URLs as inputs rather than editing the harness.
- **Failure surfacing via the co-located composite, marker per project.** On failure the job calls `./.cms-platform/.github/actions/post-failure-comment` (`mode: post`, marker `e2e-failure-summary-<project>` — project-scoped so the 10 matrix jobs don't clobber each other's comment); on success it resolves the same comment. The platform is checked out into `.cms-platform/`, so the action is referenced by that local path.

Treat the sections below as authoritative for *writing specs and using the Playwright matrix locally*. Where "8 projects" appears in older prose it means the 8 public-lane projects specifically, not the full 10-project matrix (see "Matrix projects" below). Read `docs/E2E-PARALLELISM.md` before re-tuning anything about parallelism, worker counts, or sharding — it has the measurements and the rejected alternatives.

## Key files

| File | Purpose |
|---|---|
| `playwright.config.js` | Matrix definition, webServer config, parallelism |
| `e2e/base.js` | Custom fixture — extends `test` with `rootFontSize` option, plus the per-test screenshot capture hook (`attachPerTestCapture`) |
| `e2e/*.spec.js` | Test files — import `{ test, expect }` from `./base` |
| `e2e/ci-matrix.js` | Derives the CI project-matrix list, each job's browser engine, and each job's worker count FROM `playwright.config.js` — the single source of truth for `e2e-tests.yml`'s matrix. `e2e/ci-matrix.test.js` fails self-CI if the workflow's static `matrix.project` drifts from the real project list (the one way this design can silently stop running a project) |
| `e2e/select-specs.js` | Diff-aware spec selector — maps changed files to relevant specs (and, for its general `selectSpecs()` entry point, emits a `shard_count` envelope nothing currently reads). Wired into CI only via `parity-preview.yml`'s `--parity-preview` flag (`selectParityPreviewSpecs()`); the platform's reusable `e2e-tests.yml` does NOT invoke it — see "Platform CI shape" and "Diff-aware spec selection" |
| `e2e/generate-test-videos.js` | Assembles per-test screenshot frames into `<safe-test-id>.mp4` + `_combined.mp4` with a 96px banner via ImageMagick + ffmpeg. Local-only: no reusable workflow invokes it, so `e2e-tests.yml` sets `DISABLE_PER_TEST_VIDEOS=1` to stop paying for the frame capture that nothing in CI reads |
| `.github/workflows/e2e-tests.yml` | CI — reusable: a `project` matrix (10 jobs, one per Playwright project, each installing only its own browser engine via the bounded/retried `install-playwright-browsers` composite, `150%` workers) behind an aggregating `e2e` gate job. `e2e / e2e` is the single REQUIRED status context; the 10 per-project contexts are informational. Failure comments are marker-scoped per project (`e2e-failure-summary-<project>`). See "Platform CI shape". |

## Matrix projects

**Public-page lane (8 projects)** — runs every spec that does NOT carry an `@admin-*` tag:

| Project | Browser | Viewport | Special |
|---|---|---|---|
| `chromium-desktop-1080` | Chromium | 1920×1080 | Baseline |
| `chromium-laptop` | Chromium | 1366×768 | Most common laptop |
| `chromium-mobile` | Chromium | 375×667 | Mobile form factor |
| `firefox-desktop` | Firefox | 1920×1080 | Gecko engine |
| `webkit-tablet` | WebKit | 768×1024 | Safari engine, tablet |
| `chromium-large-text` | Chromium | 1920×1080 | `rootFontSize: "20px"` |
| `chromium-light` | Chromium | 1920×1080 | `colorScheme: "light"` |
| `chromium-forced-colors` | Chromium | 1920×1080 | `forcedColors: "active"` |

**Admin lane (2 projects)** — runs only specs tagged `@admin-write` or `@admin-read`; public-page specs do NOT run here:

| Project | Browser | Viewport | Tags accepted |
|---|---|---|---|
| `chromium-desktop-3k` | Chromium | 3000×1500 | `@admin-write` + `@admin-read` |
| `webkit-iphone16` | WebKit | 393×852 (deviceScaleFactor 3, isMobile, hasTouch) | `@admin-read` only |

## Writing a new test

1. Create `e2e/my-feature.spec.js`
2. Import from the custom fixture, not from `@playwright/test`:
   ```js
   const { test, expect } = require("./base");
   ```
3. An UNTAGGED test automatically runs across all 8 public-lane projects. A spec that drives `/admin` runs on the admin lane instead, ONLY if you tag it `@admin-write` or `@admin-read` — tag routing is opt-IN, so an untagged admin spec silently runs on the 8 public-lane projects too (`e2e/admin-tag-lint.test.js` fails the build on this).

## Skipping tests for specific conditions

Some tests don't apply to all projects. Read the project config via `testInfo`:

```js
test("my test", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.use.forcedColors === "active",
    "Gradient rendering differs in forced-colors mode",
  );
  // ...
});
```

Don't use `matchMedia()` for this — it's unreliable under Playwright's media emulation. A viewer-side check can return `false` on a project configured with `forcedColors: "active"`, and the test will run (and flake) where it should have skipped.

For a heavy, non-admin spec that only needs single-project coverage, skip by project name using a real project:

```js
test.skip(
  testInfo.project.name !== "chromium-desktop-1080",
  "Heavy setup — one project is enough",
);
```

For a spec that drives `/admin` (e.g. loading the real CMS), don't hand-roll a project-name skip — tag it `@admin-write` or `@admin-read` instead (see "Matrix projects" above) so it routes to the admin lane automatically. A hand-rolled skip left beside such a tag can make the two conditions mutually exclusive and silently skip the whole file on every project with nothing red; `e2e/admin-tag-lint.test.js` fails the build on this shape.

## Custom fixture: rootFontSize

The `e2e/base.js` fixture adds a `rootFontSize` option that injects `document.documentElement.style.fontSize` before navigation. Projects set this in `playwright.config.js`:

```js
{ name: "chromium-large-text", use: { rootFontSize: "20px" } }
```

Tests don't need to handle this — it happens automatically via the fixture.

## Adding a new matrix dimension

1. Add a new project in `playwright.config.js` → `projects[]`
2. If the dimension needs custom setup (like `rootFontSize`), add it to `e2e/base.js` as a new option
3. Update the CI workflow if a new browser is needed
4. Update `AGENTS.md` E2E testing table

## Running tests

```bash
# Full matrix (all 10 projects, parallel)
npx playwright test

# Single project
npx playwright test --project chromium-desktop-1080

# Single file, single project
npx playwright test e2e/glow-banding.spec.js --project chromium-mobile

# With visible browser
npx playwright test --headed --project chromium-desktop-1080

# Debug mode
npx playwright test --debug --project chromium-desktop-1080
```

## Parallelism

- `fullyParallel: true` — tests across all projects and within files run concurrently
- Playwright auto-detects worker count from CPU cores
- The `webServer` builds Jekyll once; all workers share port 4000
- Every consumer caller passes `browser: all` to the platform's reusable, so each of the 10 project jobs installs only ITS OWN engine (resolved via `e2e/ci-matrix.js --engine <project>`), not one shared engine for the whole run. Every project job runs at the SAME worker count (`150%` — 6 on a 4-vCPU runner); it is not a per-project table. `--shard` is deliberately unused (it balances by test count, and this suite's per-test durations span 5 ms → 49 s). See `docs/E2E-PARALLELISM.md` for the measurements.

## Screenshots and video

Every test captures a screenshot (`screenshot: "on"`) and video is retained on failure (`video: "retain-on-failure"`). Artifacts are in `test-results/` and uploaded as CI artifacts.

## Visual regression

`e2e/visual-regression.spec.js` is a **structural** smoke suite, not pixel snapshots. The `toHaveScreenshot()` golden-image baselines it used to hold were retired (#86): the committed PNGs were deleted 2026-05-06 and never regenerated, so the suite only stayed green by skipping — until the first real curated tag un-skipped the tag pages and hard-failed on a baseline that had never been committed. It now just asserts each representative public surface (homepage, a blog post, `/tags/`, a tag archive) returns a non-error status and renders a visible heading — catching a 500/blank render, nothing pixel-level.

**Pixel (and text) visual regression is a separate, prod-diffing VIDEO pipeline** — there are no committed baselines to `--update-snapshots`:

- `.github/workflows/visual-regression.yml` (reusable) — a `detect` job decides SALIENCE (`e2e/visual-regression-salient.js`: templates/layouts/styling/the admin shell/the pipeline's own tooling are salient; CMS content and media uploads are not). Synced tool-vendor bumps under `assets/tools/` + `_data/tool_sources/` are carved OUT of salience even though `_data/` is otherwise salient — that delta is already reviewed in the tool's own source repo, so the site-side gate auto-passes it by design. Only a salient PR builds Jekyll and screenshots.
- `e2e/detect-changed-pages.js` discovers the page universe from a scan of the just-built `_site` (the `generate` job now builds Jekyll BEFORE detecting; locked by `visual-regression-step-order.test.js`) — this is what makes site-owned collections (e.g. adamdaniel.ai's `/tools/`) visible to the gate with zero per-collection mapping. `*/e2e/*` output is excluded so canary churn can't flake the required check.
- `e2e/regression-video.spec.js` screenshots each page PR-side and prod-side, dumps whitespace-normalized visible text per side (`<safe>.txt`), and records a prod 404/410 in `prod-missing.json` so a brand-new page is caught by HTTP status at capture time, not mapper knowledge.
- `e2e/compute-visual-diffs.js` classifies each page identical/different/new and ESCALATES a pixel-identical page to "different" when its visible text changed (below-the-fold or sub-pixel-threshold edits a viewport screenshot alone would miss). The required `approve-regression` check only opens the manual `regression-review` gate when something actually came back different.

**Pixel-level analysis:** `glow-banding.spec.js` uses a different approach — direct pixel sampling with `pngjs` for quantitative gradient smoothness checks, independent of golden images.

## Non-browser specs that still live in e2e/

Some specs run under Playwright's runner purely for its discovery + parallelism, not because they need a browser:

| Spec | What it exercises |
|---|---|
| `e2e/preview-config-patch.spec.js` | `scripts/patch-preview-config.sh` — copies `admin/config.yml` into a temp dir, runs the script, asserts the patched output |
| `e2e/cloudfront-preview-router.spec.js` | Extracts the inline CloudFront Function from `infrastructure/bootstrap/template.yaml`, evals it in Node, asserts the host → S3-prefix routing table |

They ignore the `page` fixture and don't need Jekyll to be running — treat them as unit tests that happen to share the test harness.

## Driving Decap CMS in an e2e spec

The current CMS is Decap, which talks to GitHub directly via the OAuth Lambda proxy and to `decap-server` locally. Specs don't need a `FileSystemDirectoryHandle` mock — Decap's local backend is just an HTTP server pointed at the on-disk repo, which Playwright's webServer config already starts. The CMS specs in tree:

- `e2e/cms-smoke.spec.js` — boots `decap-server` + a static fileserver and asserts the admin shell loads, sign-in works, and at least one collection's entry list renders.
- `e2e/cms-config.spec.js` — pure YAML invariants on `admin/config*.yml` (editorial workflow on, every folder collection has explicit `create: true` AND `delete: true`, all required fields). Runs as part of the always-run baseline. Pinned because Decap's defaults can drift between major versions.
- `e2e/cms-publish-flow.spec.js` — exercises the editor's status pill (Draft → In Review → Ready) and asserts each transition produces the expected GitHub label-change request via a mocked OAuth proxy.
- `e2e/cms-preview-url.spec.js` — verifies the preview-bridge's `/preview/` URL is opened with the right collection and slug for each entry type.
- `e2e/admin-reviews-auth.spec.js` / `-stats.spec.js` — drive the visual-regression reviews dashboard at `/admin/reviews/`. Mock the GitHub OAuth handshake using `ghp_test_token_abc123` / `ghp_fake_token_for_test` (allowlisted in `.gitleaks.toml`).

Heavy CMS specs are tagged `@admin-write` (mutating) or `@admin-read` (read-only) rather than restricted by project name — the tag routes them to the admin lane (`chromium-desktop-3k` for both tags; `webkit-iphone16` for `@admin-read` only). The assertion is about app behaviour, not browser quirks, so a single desktop-Chromium project is sufficient for `@admin-write` specs; booting decap-server + Playwright on the 8 public-lane projects too would be wasted minutes.

### Decap config gotcha

Folder collections need **explicit** `create: true` AND `delete: true` in `admin/config*.yml`. Decap defaults both to true, but the explicit form keeps editor capabilities visible in the YAML and survives major-version default changes. `files:` collections never expose create/delete in the UI — convert to `folder:` if editors need to add or remove entries. `cms-config.spec.js` locks this in structurally. NOTE (v0.1.4+): the live config is **rendered** from `theme/admin/config.base.yml` by the theme gem (no source `admin/config.yml` in a consumer); edit the `.base.yml` template, and in a consumer-mode spec read the **served** bytes (`/admin/config.yml`) or `_site/admin/config.yml`, never `theme/admin` — see `e2e/admin-spec-source-read-lint.test.js`.

If a UI-driven delete spec on a collection ever stops "doing anything" silently, check the collection's `delete:` flag first — Decap renders the delete menuitem only when `delete: true`. (This bit `cms-delete-published.spec.js` until PR #302 flipped the e2e collection's flag.)

### Native window.confirm() in delete / unpublish flows

Decap CMS 3.x uses native `window.confirm()` for delete confirmations (the bundle has 9+ call sites). Playwright's default behavior is to AUTO-DISMISS native dialogs when no listener is registered — Decap reads the dismiss as "user cancelled" and aborts the chain silently. Symptoms: the click on "Delete published entry" focuses the button but produces NO DELETE call, NO workflow dispatch, NO cms PR.

**Fix:** register a persistent `page.on("dialog", d => d.accept())` BEFORE any user interaction. `page.once(...)` set after the click is too late — the dialog has already fired and been auto-dismissed.

```js
// CORRECT — set up handler BEFORE any clicks
page.on("dialog", (d) => d.accept());
await trigger.click();
```

```js
// WRONG — listener registered AFTER click is too late
await trigger.click();              // dialog fires + auto-dismisses here
page.once("dialog", (d) => d.accept());  // registered too late
```

Other specs that already use the right pattern: `cms-page-crud.spec.js`, `cms-project-crud.spec.js`, `cms-smoke.spec.js`. Use them as the template.

**The dialog handler alone is NOT enough — also AWAIT the delete DISPATCH (v0.1.17 / cms#45).** `await btn.click()` resolves the instant the *synchronous* `window.confirm` returns, but Decap's actual delete is an ASYNC backend chain that fires afterward. If the test marches on (next step, navigation, teardown) the async write can be raced/abandoned, so the click "succeeds" yet onDelete silently no-op'd: no commit, no deploy, and the failure only surfaces ~900s later as "URL never 404s / no deploy fired" (prod runs 26996121665 / 26994473112). A "Delete **published** entry" commits DIRECT to the default branch via the git data API (`API.deleteFiles`: getDefaultBranch → `POST .../git/trees` (sha:null) → commit → patchRef) — so arm a `waitForRequest` on `POST .../git/trees` **before** the click and **await it** as positive proof the delete actually dispatched; throw at that real fault site if it never fires. `/git/trees` is the *distinguishing* signal: the editorial DRAFT delete (`onDeleteUnpublishedChanges`) deletes a ref via `DELETE` and never POSTs `/git/trees`, so the proof fires only on a real delete-from-main. Use the shared helper `confirmEditorDelete(page, () => clickEditorDelete(page))` in `e2e/cms-editor-ui.js` (installs the persistent dialog auto-accept, arms + awaits the dispatch proof, folds in a forward-compat in-app modal-confirm fallback); both prod-loop specs route their delete through it. Locked by three `e2e/cms-editor-ui.test.js` lints.

### Never bypass the UI in a UI test

Codified in AGENTS.md too. The mistake to avoid: when a Decap UI click is reliably broken (e.g., empirically the "Delete published entry" button stopped firing today), the temptation is to swap the UI click for `page.evaluate(fetch(...))` against the GitHub API or call the shim's `__callMerge` directly. Don't. The whole point of `cms-publish-loop*` and `cms-delete-published` specs is to validate that the editor's click does what we expect end-to-end. A bypass test passes while the UI is silently broken — exactly the regression the spec exists to catch.

If the UI looks broken, suspect (in order): `delete:` flag on the collection, missing dialog handler, anchored regex on the confirm-button label not matching the live label, missing `force: true` on a click intercepted by an overlay, Decap version drift. All of these have bit cms-delete-published in the past — see git log e2e/cms-delete-published.spec.js for the genealogy.

The route-mocked unit specs (`publish-via-auto-merge-browser.spec.js`) exercise the shim's internal contract without Decap. Those CAN call `__callMerge` directly because that's their entire reason for existing. The real-network specs must not.

### UI-driven cleanup + `test.afterAll()` harness safety net

Real-network specs that mutate prod state (write to a `_e2e/` canary, flip a `published:` flag, delete a fixture) need cleanup that's both UI-driven AND deterministic. Two failure modes pull in opposite directions:

1. **API cleanup as the primary path** = back door. Violates "Never bypass the UI in a UI test" — if Decap's UI cleanup is silently broken, an API-driven cleanup hides the regression.
2. **UI-only cleanup with no safety net** = next run starts dirty. A test crash mid-mutation leaves the canary in the wrong state; the next run fails its baseline check or, worse, runs against the corrupted state and confuses diagnostics.

The pattern that resolves both: make UI cleanup the primary path (last `test.step` in the body), and add a `test.afterAll()` harness that **only** runs API cleanup when the file on main is still mutated. In the happy path the harness reads the file once and no-ops with a `[cleanup-harness] … no safety net needed` log line.

```js
// Inside the test body, last step — UI-driven restore-to-baseline:
await test.step("Cleanup via UI: remove marker, Save → Status:Ready → Publish Now", async () => {
  // ... drive Decap's editor to undo the mutation, wait for the URL
  // to flip back via waitForChangeReflected ...
});
});

// At the bottom of the file, after the test() block — API safety net:
test.afterAll(async () => {
  if (PROD_CANARY) return; // daily canary probe doesn't mutate
  if (!getPat()) return;   // PAT-less runs can't write anyway
  let current;
  try {
    current = await fetchFixtureFromMain();
  } catch (e) {
    console.warn(`[cleanup-harness] couldn't read ${FIXTURE_PATH}: ${e.message}`);
    return;
  }
  const decoded = Buffer.from(current.content, "base64").toString("utf8");
  // Skip-when-clean check: regex / structural test that distinguishes
  // baseline from mutated. If clean, log and return — the harness is silent.
  if (!/e2e-publish-loop:[a-z]+:\d+/.test(decoded)) {
    console.log("[cleanup-harness] at baseline; UI cleanup succeeded — no safety net needed");
    return;
  }
  console.warn("[cleanup-harness] mutation remained after UI cleanup; restoring via API");
  await writeFixtureOnMain({ fileText: baselineFileText, message: "..." });
});
```

**Why a module-scoped flag for delete-style specs.** When the test creates a per-run fixture (`_e2e/canary-delete-<runId>.md`), the `runId` and `filePath` only exist inside the test closure. A common pattern: hoist a `let pendingFixture = null;` to module scope, set it inside the test once the fixture is committed, and have the harness read from it. The harness skips when `pendingFixture === null` (test never ran) and only acts when `fileExistsOnMain(pendingFixture.filePath)` is true (UI delete failed).

**What the skip-when-clean check should be.**
- Body-marker mutations: regex on file text (`/e2e-publish-loop:[a-z]+:\d+/`).
- Frontmatter flag mutations: parse the field (`readPublishedFlag(decoded) === true`).
- Fixture-delete mutations: file existence (`fileExistsOnMain(filePath)`).
- The check must return *quickly* and *cheaply*. One `gh /contents/` call per spec is fine; anything heavier and the harness becomes its own flake source.

**Reference implementations.** Restore-to-baseline variant (mutated a persistent fixture, safety-net rewrites it): `cms-publish-loop.spec.js` (PR #421), `cms-publish-loop-preview.spec.js` (PR #423), `cms-unpublish-republish.spec.js`. Existence-only-delete variant (created an ephemeral per-run post, safety-net deletes any leftover orphan): `cms-delete-published.spec.js`, plus `cms-publish-loop-prod-mutate.spec.js` and `cms-media-roundtrip.spec.js` since #1771 step 4 made the prod loops ephemeral (they previously mutated a persistent `_posts/` canary in place via PR #426). `cms-preview-pr-self-contained.spec.js`. Search for `test.afterAll` + `[cleanup-harness]` to find them.

**Anti-pattern: try/finally in the test body.** Functionally similar but conflates "test logic" with "harness logic" and forces the cleanup code to live inside the test closure. `test.afterAll()` reads better, runs even when the test was skipped (the harness self-skips on `if (!pendingFixture) return;`), and matches the shape every other spec uses.

### Why not Sveltia

An earlier iteration used Sveltia CMS for its UX improvements, but Sveltia ≤ 0.158 silently ignores `publish_mode: editorial_workflow`. With branch protection on `main`, every Save returned "Repository rule violations found." Decap implements the editorial workflow correctly — each Save lands on a `cms/...` branch and opens a PR — so we swapped back. See PR #48.

## Visual reachability: `toBeVisible()` is not enough

A passing `toBeVisible()` only proves an element has non-zero size and isn't `display:none` / `visibility:hidden` / `opacity:0`. It does **not** prove the element is *usable*. Two regressions have shipped past it in the Decap admin:

- **Clipped off-screen** — a toolbar/modal control rendered past the viewport's right edge on a phone (the editor toolbar's Save/Publish/Delete; the media-library action buttons). "Visible" to Playwright, unreachable to the user.
- **Occluded** — another element paints on top (the media-library "Delete selected" button rendered *behind* the asset grid once the header's fixed-height row overflowed). "Visible", but covered.

Use **`expectReachable(page, locator, label)`** from `e2e/ui-visibility.js` for any control a user must be able to tap. It asserts the element is visible, sits within the viewport horizontally, and is the topmost element at its center point (`document.elementFromPoint`). It polls, so a mid-render / "Loading entry…" transient doesn't flake the check, while a persistent clip or occlusion still fails.

```js
const { expectReachable } = require("./ui-visibility");
await expectReachable(page, page.getByRole("button", { name: /^Save$/ }), "editor Save button");
```

**Run admin reachability checks at BOTH admin resolutions.** The admin UI is exercised on two surfaces — `chromium-desktop-3k` (3000×1500) and `webkit-iphone16` (393×852) — and a control reachable on one can be clipped/occluded on the other (that's exactly the iPhone-only bugs above). Tag the spec `@admin-read` and do **not** pin a viewport with `setViewportSize`, so it runs at each project's native resolution. `e2e/admin-no-occlusion.spec.js` is the worked example: it checks the collection list, entry editor, editorial-workflow board, and media-library modal. **Every new admin screen — or new control on an existing screen — must add its key controls there.**

When a control's region can be occluded only by *content* (e.g. the media grid populated with assets — which the in-browser test-repo backend uploads unreliably), assert the layout *fact* instead of staging the occluder: e.g. the header isn't clipped (`scrollHeight <= clientHeight`) and the controls sit within the header's box. See the media-library test in `admin-no-occlusion.spec.js`.

## Diff-aware spec selection (parity-preview only)

> The platform's reusable `e2e-tests.yml` does NOT use any of this — it runs the whole 10-project matrix on every call (see "Platform CI shape"): the goal there is to run the *same* coverage faster, not less of it. Neither does adamdaniel.ai's own e2e lane. The one lane that genuinely invokes `e2e/select-specs.js` today is `parity-preview.yml`, via its `--parity-preview` flag (`selectParityPreviewSpecs()`), which reuses this module's `SPEC_RULES` mapping to decide which `@parity-preview` specs apply to a PR's already-deployed preview surface. `preview-media.yml` runs an analogous, separately-coded inline salient-path check for the same always-run-plus-early-skip purpose, but does not call this module. `select-specs.js` and `select-specs.test.js` ship in the harness either way.

The full matrix is now 10 projects (8 public-lane + 2 admin-lane) × ~25 specs. A content-only edit shouldn't pay for the cross-browser admin-CMS specs, the preview-bridge specs, or the CloudFront router specs — those tests can't possibly be affected. The module's general-purpose `selectSpecs()` reads a diff via `git diff --name-only origin/main...HEAD` and returns one of three scopes:

- **`all`** — fanout file changed (`_layouts/`, `_includes/`, `_config.yml`, `assets/css/`, `_plugins/`, `package*.json`, `Gemfile*`, `e2e/base.js`, `playwright*.config.js`). Run the full matrix.
- **`subset`** — match each changed file against `SPEC_RULES` and run only the resulting list, plus the always-run baseline.
- **`skip`** — only docs (`README.md`, `AGENTS.md`, `docs/`, `.agents/skills/`) changed. Run the baseline only as a smoke check.

Always-run baseline (cheap, no browser): `compute-visual-diffs.test.js`, `cms-config.spec.js`, plus the spec's own changed file.

Push to main bypasses the selector and runs the full matrix, since "the diff" for a merge commit covers everything anyway.

`e2e/select-specs.test.js` covers each rule. (`parity-preview.yml` calls the separate `selectParityPreviewSpecs()` entry point, not this `all`/`subset`/`skip` path — see the note at the top of this section.)

### Dynamic shard count (used by no lane today)

The selector's general `selectSpecs()` path also returns a `shard_count` field — `1` for tiny baseline-only runs, `2` for mid-sized subsets, `4` for full-matrix and large subsets. **No lane consumes this field today.** `e2e-tests.yml` gets its parallelism from the one-job-per-project design instead (see "Platform CI shape"); nothing builds a `[1..shard_count]` matrix array anywhere in the platform or in adamdaniel.ai's caller. The field is still computed by the CLI and covered by `select-specs.test.js`, but treat it as dead machinery until something wires it up again.

### Spec-header opt-out: `@select-skip-when-head-ref-prefix:`

A spec can declare a top-of-file directive to skip itself when the PR's head ref starts with a given prefix:

```js
// @select-skip-when-head-ref-prefix: cms/
const { test, expect } = require("./base");
```

Comma-separated prefixes are allowed (`cms/, claude/`). The selector reads `GITHUB_HEAD_REF` and drops matching specs from the rule-matched set; the `ALWAYS_RUN` baseline is exempt. Used to shave bring-up time on cms-bot PRs that don't need most browser specs.

## CI: browser install (no container, bounded + retried — never a raw `npx playwright install`)

The platform's reusable `e2e-tests.yml` runs one job per Playwright project on plain `ubuntu-latest`; each job installs only its own project's browser engine, through the shared composite rather than a bare command:

```yaml
# from e2e-tests.yml — one engine per project job, resolved via e2e/ci-matrix.js
- name: Install Playwright browser + system deps
  uses: ./.cms-platform/.github/actions/install-playwright-browsers
  with:
    browser: ${{ steps.engine.outputs.engine }}
```

**Never shell out to a raw `npx playwright install --with-deps <browser>` from a workflow.** `--with-deps` apt-installs ~90 system packages before the browser download, and on a slow mirror that combination has no natural upper bound: `install --with-deps webkit` once took **39 minutes** while the tests it installed for took 41.6 s. `install-playwright-browsers` splits the two halves and retries both with backoff instead of running the bare command; `e2e/playwright-install-bounded.test.js` fails self-CI if any workflow reverts to it. **Never put a `timeout` bound around the apt half (`install-deps`).** Playwright runs that apt as root ("Switching to root user to install dependencies..."), so the real `apt-get` is a root-owned grandchild an unprivileged `timeout` cannot signal (EPERM) — killing the wrapper only orphans that `apt-get` still holding `/var/lib/dpkg/lock-frontend`, and every retry then starves on the same lock (job 92989057569). Only the browser-download half (`install`, no `--with-deps`) is time-bounded; apt is retried on failure but never killed, with the job's own `timeout-minutes` as the sole backstop for a genuine hang. There is no `mcr.microsoft.com/playwright:...-noble` container and no prebaked-browser image anywhere in the platform — every lane installs inline, so both the CDN download and the apt install are on each job's critical path — so the "browsers baked into the image" model and the image-version-drift check still do NOT apply to the reusable workflow.

> Note: a `scripts/check-playwright-image-drift.js` exists in the platform for sites that DO containerize their own workflows, but the platform's reusable e2e workflow is not one of them. If you containerize a downstream site's Playwright workflow, then the image tag must match `package-lock.json`'s `@playwright/test` version, and `ruby/setup-ruby` inside a noble container still needs `libyaml-0-2` + `build-essential` apt-installed first.

## Per-test screenshot videos (local-only; disabled in CI)

Every browser-based test captures one full-page screenshot per `framenavigated` event. Running `node e2e/generate-test-videos.js` composites each frame with a 96px metadata banner above the screenshot via ImageMagick `convert`, concatenates the resulting PNG sequence per test into `<safe-test-id>.mp4`, and stitches them all together as `_combined.mp4`. This is a local/manual step only: no reusable workflow invokes the assembly script — the job that used to assemble these videos was never ported to the platform — so `e2e-tests.yml` sets `DISABLE_PER_TEST_VIDEOS=1` to stop paying for the per-navigation frame capture that nothing in CI reads. `screenshot: "on"` and `video: "retain-on-failure"` still produce the failure artifacts a red run is diagnosed from; unset the env var locally to get the per-test frames back.

- Capture fixture: `attachPerTestCapture` in `e2e/base.js`.
- Frame storage: `test-results/per-test-frames/<safe-test-id>/{NNNN.png,meta.json}`.
- Assembly: `e2e/generate-test-videos.js`.
- Banner shape: `PR #<n> · Test X of Y · <file>::<title>` / `Step x of y: <name> · <status>` / `project: <name> · <date> <time US/Eastern>`.
- Frame rate: `2/3` fps, capped at 50 frames per test.
- Disable per-run: `DISABLE_PER_TEST_VIDEOS=1`.

The assembly step is non-blocking — it never fails the build, and it's not a required check. Pure-node tests that don't request the `page` fixture are unaffected (no capture hook fires).

## Visual showcase — REMOVED, don't go looking for it

This section used to tell you to run `node scripts/generate-showcase.js` after any change affecting visual output, having first copied `e2e/visual-regression.spec.js-snapshots` aside and re-run `--update-snapshots`.

**None of that machinery exists.** `scripts/generate-showcase.js` is not in the repo, and neither is any `visual-regression.spec.js-snapshots` directory — the committed-PNG suite was retired in **v0.1.34** (it had been passing only by skipping, since all 32 baselines were deleted in 2026-05 and never regenerated; the first curated prod tag un-skipped it and hard-failed a content PR). That is stated correctly in the "Visual regression" section above; this section was pre-v0.1.34 leftovers that contradicted it 40 lines later.

What actually guards visual output now:

- **`visual-regression.yml`** — screenshots each changed page on the PR *and on production*, computes the pixel delta (`e2e/compute-visual-diffs.js`) plus a whitespace-normalized visible-text delta, and gates merge through the `regression-review` environment when anything is visually different. It needs **no committed baselines** — production *is* the baseline.
- **The structural "renders" smoke checks** in `e2e/visual-regression.spec.js`, which assert a non-error status and a visible heading rather than a pixel match.

The only committed snapshots left in the repo are the **ARIA-contract YAML** baselines under `e2e/cms-editor-aria-contract.spec.js-snapshots/`. `--update-snapshots` applies to those and only those — and per the standing rule, regenerating them on a Decap bump is a human-review moment, not a formality.
