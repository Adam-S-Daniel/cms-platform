---
name: browser-testing
description: Write, run, and maintain Playwright e2e tests across the browser/viewport/accessibility matrix. Use when adding new e2e tests, updating the test matrix, debugging cross-browser failures, or understanding how the browser testing infrastructure works.
compatibility: Requires Node.js 20+, Ruby 3.2+ with Jekyll, Playwright browsers installed.
---

# Browser Testing Matrix

All e2e tests run across 8 Playwright projects covering browsers, viewports, text sizes, and color settings. Tests run fully parallel.

## Platform CI shape (read this first)

The platform ships ONE reusable e2e workflow, `.github/workflows/e2e-tests.yml`, called by a thin per-site wrapper. It is deliberately simple, and several details in the older prose below describe a richer setup that the platform does **not** have:

- **Single job, `runs-on: ubuntu-latest`.** There is no `e2e` / `parity` / `finalize` job split and no downstream aggregation job. The `finalize`-job patterns, the per-test-video assembly job, and "post the comment from a downstream job" advice elsewhere in this file are NOT how the platform runs.
- **No container image.** Browsers are installed inline on the runner: `npx playwright install --with-deps <browser>` (the workflow's `browser` input, default `chromium`; `all` installs every engine). The `mcr.microsoft.com/playwright:v<version>-noble` container, the "browsers are baked into the image" claims, and the image-version-drift `select` check are NOT part of the reusable workflow. (A `scripts/check-playwright-image-drift.js` exists, but the reusable e2e workflow doesn't use a container.)
- **No diff-aware spec selection and no dynamic sharding.** The reusable workflow runs `npx playwright test --reporter=list` once — it does not call `select-specs.js`, build a `[1..shard_count]` matrix, or fan out 4 ways. The `select` job, `shard_count` envelope, and 4-way-fanout described later are upstream-only (adamdaniel.ai); they have not been ported to the platform.
- **Parameterized on env, not site identity.** The suite reads `TARGET`, `CMS_PROD_URL`, `CMS_APEX`, `CMS_REPO` (= `${{ github.repository }}`), and `PR_NUMBER` from the workflow inputs/env, so a new site passes its URLs as inputs rather than editing the harness.
- **Failure surfacing via the co-located composite.** On failure (when `pr_number` is set) the job calls `./.cms-platform/.github/actions/post-failure-comment` (`mode: post`, marker `e2e-failure-summary`); on success it resolves the same comment. The platform is checked out into `.cms-platform/`, so the action is referenced by that local path.

Treat the sections below as authoritative for *writing specs and using the Playwright matrix locally*. Where they describe CI orchestration (container, sharding, finalize, image-drift, diff-aware selection), defer to this note — that machinery lives in the upstream site, not the platform's reusable workflow.

## Key files

| File | Purpose |
|---|---|
| `playwright.config.js` | Matrix definition, webServer config, parallelism |
| `e2e/base.js` | Custom fixture — extends `test` with `rootFontSize` option, plus the per-test screenshot capture hook (`attachPerTestCapture`) |
| `e2e/*.spec.js` | Test files — import `{ test, expect }` from `./base` |
| `e2e/select-specs.js` | Diff-aware spec selector (upstream-only; the platform's reusable e2e-tests.yml does NOT invoke it — see "Platform CI shape") — maps changed files to relevant specs and emits a `shard_count` envelope |
| `e2e/generate-test-videos.js` | Assembles per-test screenshot frames into `<safe-test-id>.mp4` + `_combined.mp4` with a 96px banner via ImageMagick + ffmpeg (run locally; the platform CI does not assemble videos) |
| `.github/workflows/e2e-tests.yml` | CI — reusable single `ubuntu-latest` job: `npm ci` → `npx playwright install --with-deps <browser>` → `npx playwright test --reporter=list`, then post/resolve the failure comment. No container, no selector, no sharding, no finalize job. See "Platform CI shape". |

## Matrix projects

| Project | Browser | Viewport | Special |
|---|---|---|---|
| `chromium-desktop` | Chromium | 1920×1080 | Baseline |
| `chromium-laptop` | Chromium | 1366×768 | Most common laptop |
| `chromium-mobile` | Chromium | 375×667 | Mobile form factor |
| `firefox-desktop` | Firefox | 1920×1080 | Gecko engine |
| `webkit-tablet` | WebKit | 768×1024 | Safari engine, tablet |
| `chromium-large-text` | Chromium | 1920×1080 | `rootFontSize: "20px"` |
| `chromium-light` | Chromium | 1920×1080 | `colorScheme: "light"` |
| `chromium-forced-colors` | Chromium | 1920×1080 | `forcedColors: "active"` |

## Writing a new test

1. Create `e2e/my-feature.spec.js`
2. Import from the custom fixture, not from `@playwright/test`:
   ```js
   const { test, expect } = require("./base");
   ```
3. The test automatically runs across all 8 projects.

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

For heavy specs that only need single-project coverage (e.g. loading the real CMS), skip by project name:

```js
test.skip(
  testInfo.project.name !== "chromium-desktop",
  "Heavy setup — one project is enough",
);
```

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
# Full matrix (all 8 projects, parallel)
npx playwright test

# Single project
npx playwright test --project chromium-desktop

# Single file, single project
npx playwright test e2e/glow-banding.spec.js --project chromium-mobile

# With visible browser
npx playwright test --headed --project chromium-desktop

# Debug mode
npx playwright test --debug --project chromium-desktop
```

## Parallelism

- `fullyParallel: true` — tests across all projects and within files run concurrently
- Playwright auto-detects worker count from CPU cores
- The `webServer` builds Jekyll once; all workers share port 4000
- The platform's reusable CI installs the single requested browser engine (`browser` input, default `chromium`); pass `all` to install every engine. The full 3-engine cross-browser matrix is for local runs and the upstream site's full-matrix push builds.

## Screenshots and video

Every test captures a screenshot (`screenshot: "on"`) and video is retained on failure (`video: "retain-on-failure"`). Artifacts are in `test-results/` and uploaded as CI artifacts.

## Visual regression

`e2e/visual-regression.spec.js` captures golden-image baselines for key pages (homepage, blog post) using `toHaveScreenshot()`. Baselines are stored per-project in `e2e/visual-regression.spec.js-snapshots/` and committed to the repo.

**How it works:**
1. Animations are frozen for deterministic screenshots
2. `toHaveScreenshot("name.png")` compares against the committed baseline
3. If the diff exceeds 1% pixel ratio, the test fails
4. CI uploads an HTML report with visual diffs as an artifact

**Update baselines after intentional changes:**
```bash
# Regenerate all baselines
npx playwright test e2e/visual-regression.spec.js --update-snapshots

# Single project
npx playwright test e2e/visual-regression.spec.js --update-snapshots --project chromium-desktop
```

**First run for a new browser project:** baselines don't exist yet and the test fails. Run `--update-snapshots` to generate them, then commit.

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

Heavy CMS specs are restricted to `chromium-desktop` — the assertion is about app behaviour, not browser quirks, and booting decap-server + Playwright in webkit/firefox is wasted minutes.

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

## Diff-aware spec selection (upstream-only)

> The platform's reusable `e2e-tests.yml` does NOT use any of this — it runs the whole suite once per call (see "Platform CI shape"). The selector + sharding live in the upstream adamdaniel.ai site and are documented here for context / potential future port. `select-specs.js` and `select-specs.test.js` ship in the harness, but no platform workflow invokes them.

The full matrix is 8 projects × ~25 specs. A content-only edit shouldn't pay for the cross-browser admin-CMS specs, the preview-bridge specs, or the CloudFront router specs — those tests can't possibly be affected. `e2e/select-specs.js` reads the PR's `git diff --name-only origin/main...HEAD` and returns one of three scopes:

- **`all`** — fanout file changed (`_layouts/`, `_includes/`, `_config.yml`, `assets/css/`, `_plugins/`, `package*.json`, `Gemfile*`, `e2e/base.js`, `playwright*.config.js`). Run the full matrix.
- **`subset`** — match each changed file against `SPEC_RULES` and run only the resulting list, plus the always-run baseline.
- **`skip`** — only docs (`README.md`, `AGENTS.md`, `docs/`, `.agents/skills/`) changed. Run the baseline only as a smoke check.

Always-run baseline (cheap, no browser): `compute-visual-diffs.test.js`, `cms-config.spec.js`, `visual-change-guard.spec.js`, plus the spec's own changed file.

Push to main bypasses the selector and runs the full matrix, since "the diff" for a merge commit covers everything anyway.

`e2e/select-specs.test.js` covers each rule.

### Dynamic shard count (upstream-only)

> Same caveat as above — the platform's reusable workflow does not shard. This describes the upstream site's `e2e-tests.yml`.

The selector also returns a `shard_count` field — `1` for tiny baseline-only runs, `2` for mid-sized subsets, `4` for full-matrix and large subsets. The upstream `e2e-tests.yml` reads this and builds a `[1..shard_count]` matrix array, so a baseline-only PR no longer pays the 4× container bring-up cost. The `e2e (1)` required check is always present because the matrix array always starts at 1.

### Spec-header opt-out: `@select-skip-when-head-ref-prefix:`

A spec can declare a top-of-file directive to skip itself when the PR's head ref starts with a given prefix:

```js
// @select-skip-when-head-ref-prefix: cms/
const { test, expect } = require("./base");
```

Comma-separated prefixes are allowed (`cms/, claude/`). The selector reads `GITHUB_HEAD_REF` and drops matching specs from the rule-matched set; the `ALWAYS_RUN` baseline is exempt. Used to shave bring-up time on cms-bot PRs that don't need most browser specs.

## CI: browser install (no container)

The platform's reusable `e2e-tests.yml` runs on plain `ubuntu-latest` and installs the requested browser engine inline:

```yaml
# from e2e-tests.yml — browser input defaults to "chromium"; "all" installs every engine
- name: Install Playwright browser + system deps
  run: npx playwright install --with-deps "$PW_BROWSER"
```

`--with-deps` pulls the OS libraries the engine needs on the runner. There is no `mcr.microsoft.com/playwright:...-noble` container, so the "browsers baked into the image" model and the image-version-drift check do NOT apply to the reusable workflow.

> Note: a `scripts/check-playwright-image-drift.js` exists in the platform for sites that DO containerize their own workflows, but the platform's reusable e2e workflow is not one of them. If you containerize a downstream site's Playwright workflow, then the image tag must match `package-lock.json`'s `@playwright/test` version, and `ruby/setup-ruby` inside a noble container still needs `libyaml-0-2` + `build-essential` apt-installed first.

## Per-test screenshot videos (`per-test-videos` artifact)

Every browser-based test captures one full-page screenshot per `framenavigated` event. Running `node e2e/generate-test-videos.js` composites each frame with a 96px metadata banner above the screenshot via ImageMagick `convert`, concatenates the resulting PNG sequence per test into `<safe-test-id>.mp4`, and stitches them all together as `_combined.mp4`. This is a local/manual step — the platform's reusable e2e workflow uploads `playwright-report` but does NOT have a `finalize` job that assembles per-test videos. (Upstream adamdaniel.ai runs the assembly in its `finalize` job and ships a `per-test-videos` artifact, 7-day retention.)

- Capture fixture: `attachPerTestCapture` in `e2e/base.js`.
- Frame storage: `test-results/per-test-frames/<safe-test-id>/{NNNN.png,meta.json}`.
- Assembly: `e2e/generate-test-videos.js`.
- Banner shape: `PR #<n> · Test X of Y · <file>::<title>` / `Step x of y: <name> · <status>` / `project: <name> · <date> <time US/Eastern>`.
- Frame rate: `2/3` fps, capped at 50 frames per test.
- Disable per-run: `DISABLE_PER_TEST_VIDEOS=1`.

The assembly step is non-blocking — it never fails the build, and it's not a required check. Pure-node tests that don't request the `page` fixture are unaffected (no capture hook fires).

## Visual showcase

**Standing rule:** after any change that could affect visual output (CSS, layouts, templates, images), regenerate the showcase before committing.

`scripts/generate-showcase.js` reads all snapshot PNGs, displays each in a labeled Playwright browser page for 3 seconds, and records the session as `recordings/visual-regression-showcase.webm`.

```bash
# Full workflow: save before, update baselines, generate before/after showcase
cp -r e2e/visual-regression.spec.js-snapshots{,-before}
npx playwright test e2e/visual-regression.spec.js --update-snapshots
node scripts/generate-showcase.js
# Commit updated snapshots + recordings/visual-regression-showcase.webm
```

If no `-before` directory exists (first run, no prior baselines), the showcase shows current snapshots only. The `-before` directory is auto-cleaned after the video is written.
