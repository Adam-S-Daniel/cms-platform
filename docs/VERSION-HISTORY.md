# Version history

What this is: the full release-by-release changelog for cms-platform,
`v0.1.0` through the current release — every fix cluster, incident,
root-cause writeup, and the exact issue/run/PR numbers behind each. Read this
when you need to know whether something was already fixed, when a fix
shipped, or the full story behind a fact stated tersely elsewhere in
AGENTS.md (most "see version history" pointers resolve here). This is the
single biggest section moved out of AGENTS.md — read it when investigating
regressions, before re-deriving a root cause AGENTS.md warns not to
re-derive, or when reconciling a consumer to the latest release.

## Version history (v0.1.0 → v0.1.76)

All are tagged GitHub releases (release via `gh workflow run release.yml -f version=vX.Y.Z`).

- **v0.1.0** — initial extraction; dogfooded on adamdaniel.ai (prod green, pixel-identical).
- **v0.1.1** — org-portability hardening (de-identified secrets-scan / identity).
- **v0.1.2** — fixes pass.
- **v0.1.3** — interim.
- **v0.1.4** — **admin consolidation (Option 1A, issue #5 GOAL 1):** `admin/`
  relocated to `theme/admin/` so the gem ships it; the render hook copies the
  gem-resident machinery into `_site/admin` + renders `config.yml`; consumers
  delete their vendored `admin/` and keep only the seam; drift-guard becomes
  skills-only. (See "Admin delivery".)
- **v0.1.5** — **consumer-context spec rule:** specs that run in CONSUMER mode
  must read the SERVED admin bytes, not `theme/admin`. Fixed `preview-bridge.spec.js`;
  added `e2e/admin-spec-source-read-lint.test.js`.
- **v0.1.6** — **editorial-label audit:** dialog regression guard +
  `audit-editorial-labels.js` + reusable `editorial-label-audit.yml`.
- **v0.1.7** — **base_collections opt-out** (`cms.base_collections` keep-list;
  `theme/spec/base_collections_filter_test.rb`).
- **v0.1.8** — **e2e flake fix:** decap-server `webServer` waits on the open TCP
  `port: 8081`, not a `url:` HTTP probe (decap 404s every GET route, which
  Playwright's readiness rejects — the `url:` form timed out the whole local
  lane). See "E2E local webServer".
- **v0.1.9–v0.1.12** — **issue sweep** (2026-06-04): #25 neutral gem logo, #23
  scaffold seeds `preview.md` + `404.html`, #26 OAuth-restriction admin banner,
  #29 single-version pin-consistency guard (`scripts/check-platform-pin-consistency.js`),
  #21 self-diagnosing deploy-lane diagnostic, #22 ephemeral canary-branch
  cleanup, #5 GOAL 2 `field_library` + `$ref`, #33 base_collections single-page
  e2e skips; plus #14 bump-aware admin parity + #17 injected-shell identity
  normalization + #16 PLATFORM_META_SPECS recurrence guard. Both consumers
  reconciled to single-version lockstep.
- **v0.1.13** (2026-06-05) — **#39 CloudFront `ErrorCachingMinTTL 300→0`** in the
  bootstrap template (root cause of the #21/#1815 canary-URL non-reflection:
  CloudFront negative-cached the pre-create 404) + `deploy.sh`
  `CreateApexDnsRecords` env passthrough; **#40** broader single-page e2e skips
  (reviews/preview-shell/draft-isolation/canary-prod) + media-roundtrip budget
  alignment.
- **v0.1.14** (2026-06-05) — **#41 admin-parity walk excludes deploy-skipped
  source/doc files** (`isExcludedAdminPath()` mirrors the copy-hook skip list +
  a Ruby-skip-list drift guard); fixes false same-version "drift" on
  `README.md`/`collections.site.yml.example` during a bump.
- **v0.1.15** (2026-06-05) — **#42 parity-preview exports `SITE_ROOT`** so a
  single-page consumer's `@parity` crawl reads the CONSUMER `_config.yml`
  (base_collections opt-out) instead of the platform fixture — stops the lane
  crawling `/blog//tags` on jodidaniel.com.
- **v0.1.16** (2026-06-05) — **#44 editorial-label-audit passes `--repo`** so the
  daily audit stops failing `fatal: not a git repository` (the reusable
  sparse-checks-out only the script, so `gh pr list` had no repo context;
  script also falls back to `GITHUB_REPOSITORY`).
- **v0.1.17** (2026-06-05) — **#45 delete-leg dispatch proof**: the prod-mutate /
  media loops' `confirmEditorDelete` now arms `waitForRequest(POST …/git/trees)`
  BEFORE the editor Delete click and awaits it, so a silent delete no-op throws
  at the real fault site instead of timing out 900s later in the URL-404 wait
  (#1815 delete-phase). See the `browser-testing` skill.
- **v0.1.18** (2026-06-05) — **#47 delete helper must not register a 2nd dialog
  handler** (the double-`dialog.accept()` regression invisible to unit lints);
  + the "Definition of done" section captured here.
- **v0.1.19** (2026-06-05) — **#48 recover a Decap published-delete into an
  auto-merged PR on protected `main`** (the `admin/publish-via-auto-merge.js`
  shim path; #1815 delete-phase).
- **v0.1.20** (2026-06-05) — **workflow-SET parity + PAT consolidation epic**:
  #54 pin-consistency now asserts the consumer's `.github/workflows/` basename
  set == the platform-dictated canonical set; #53 comment-sync PAT consolidated
  onto `CMS_PLATFORM_PAT` (fine-grained only); #52 repo-variable setter
  centralization; the contributor manual eliminated.
- **v0.1.21** (2026-06-05) — **#57 recursion-gate skips the prod-mutating loops
  on a platform-version-bump push** (the bump touches the loop's own workflow
  file, which would otherwise re-fire it and race the bump deploy); + #55
  doc-fix sweep, #56 prod/preview host-loop guards for `base_collections:[]`.
- **v0.1.22** (2026-06-05) — **#58 export `SITE_ROOT` on EVERY `.cms-platform/e2e`
  harness invocation** (5 loop reusables + canary-prod + delete-preview +
  preview-media + visual-regression + e2e-tests), enforced by
  `e2e/loop-site-root-lint.test.js` (#1815 host-loop gap).
- **v0.1.23** (2026-06-05) — **#59 (#13) `platform-bump.yml` is atomic** (bumps
  every pinned ref in one pin-consistent PR + checks out with the caller PAT for
  workflow-file push auth); + #60 the MAIN host-loop `test()` guard + a
  per-test-block guard-registry lint.
- **v0.1.24** (2026-06-05) — **#61 full regex→AST rewrite of the guard-registry
  detectors** (`e2e/spec-ast.js`, acorn 8.16.0 + acorn-walk 8.3.5, exact-pinned
  past the 7-day cooling-off). "AST always, never regex for code structure."
- **v0.1.25** (2026-06-05) — **#63 pin-consistency catches thin-caller CONTENT
  drift**, not just version refs (a consumer caller whose body diverged from the
  platform template at the pinned ref).
- **v0.1.26** (2026-06-06) — **#64 crash-resilient :4000 webServer + recover
  stuck-green canaries** (#1815). `e2e/static-serve.js` replaces bare `serve`
  (which crashed the shared :4000 process on a racy ReadStream ENOENT, an
  85-failure `@admin` cascade); `cms-automerge-nudge.yml` now recovers
  UNKNOWN-state stuck-green canaries via a fresh-re-queried, stub-safe explicit
  `pulls.merge`. See "E2E local webServer".
- **v0.1.27** (2026-06-06) — **#66 `validate-content` cancel-in-progress:false**
  (#1815). The editorial workflow fired several runs on the same canary head sha
  (an opened+synchronize+labeled burst), and a cancelled `validate-content`
  check-run shadowed the success → GitHub blocked the merge non-deterministically
  (live 405). This set cancel-in-progress:false — but that was an INCOMPLETE fix
  (see v0.1.28). Nudge `headIsTrulyGreen` also made cancelled-aware. See "A
  cancelled required check blocks the merge".
- **v0.1.28** (2026-06-06) — **#68 remove `validate-content`'s `concurrency`
  block entirely** (#1815, the REAL fix). `cancel-in-progress:false` (v0.1.27)
  was not enough: GitHub keeps the running + latest-pending run and CANCELS the
  other pending dups in a same-sha burst, so cancelled check-runs persisted and
  the loops still merged only via the success-wins coin-flip (#1990/#1993 merged
  with 2 cancelled + 2 success; #1996 blocked with the same). With NO concurrency
  every same-sha run completes success → no cancelled shadow → deterministic
  merge. Lint updated to assert no concurrency block.
- **v0.1.29** (2026-06-06) — **loop reliability + OAuth delivery + a spec migration**:
  - **#70 co-arrival eviction → disjoint push triggers (#73).** Keep the shared
    `prod-mutating-loop` group (HARD mutual exclusion) but make the three loops'
    PUSH triggers PAIRWISE-DISJOINT — prod OWNS the shared infra paths on push,
    media/host cover them via their daily cron — so a single push can't fire two
    loops and co-arrival-evict one. (Superseded an initial run-id lane-gate that
    an adversarial review showed downgraded hard exclusion to fail-open
    best-effort — re-run queue-jumping + media's 150min run >> a 45min gate
    timeout.) New lint asserts disjoint push paths + prod-owns-infra.
  - **#1815 host leg — byte-lock tolerates one in-flight marker (#73).** The host
    publish-loop's create PR appends an `e2e-publish-loop:` marker to the
    persistent `_e2e/canary-post.md`; the strict byte-lock had rejected the
    loop's OWN PR (its heavy job had been red 40+ runs — only the ephemeral-post
    prod/media loops were ever green). `stripInFlightMarker` (self-contained; ONE
    marker pattern shared across the byte-lock, the spec afterAll, and
    reset-orphaned-canary.sh; LF-enforced via .gitattributes) tolerates exactly
    one marker while real drift + the multi-marker orphan (#1861) still fail loud.
  - **#69 deliver OAuth-proxy + bootstrap as delegating wrappers (#72).** The
    scaffolder emits committed thin `oauth-proxy/deploy.sh` +
    `infrastructure/bootstrap/deploy.sh` that read platform.lock, check the
    platform out at `platform_ref`, and `exec` the platform's real deploy.sh
    (default OAuth scope `repo,user,workflow`) — consumers vendor no
    `lambda.py`/`template.yaml`/bootstrap template. A scope-widening redeploy
    needs a MANUAL OAuth-App re-consent. Locked by scaffold-deploy-delegators.test.js.
  - **adamdaniel#2007-P3 — migrate `normalize_empty_slug_test.rb` to the gem
    theme/spec (#74)** (the consumer test required a now-absent `_plugins/` path).
- **v0.1.30** (2026-06-06) — **#76 kill the admin link-crawler TOCTOU flake
  (#1815).** `_site/admin/*` are gem assets copied by the `:post_write` render
  hook, NOT generated by Jekyll, so Jekyll's `cleanup` phase deleted them at the
  start of every build (incl. the in-test `jekyll build`s @admin-write specs run
  against the live `_site`); the @admin-read link-crawler HEADed into the
  delete→recopy window → a ~6% transient 404 that intermittently red-ed
  canary-PR e2e and the loops. Fix: `keep_files: [admin]` (fixture + scaffolder)
  so cleanup never deletes `_site/admin`, + atomic gem-asset copy (temp+rename)
  in both parity-locked render paths. Locked by `e2e/admin-keep-files.test.js`.
  Consumers add `keep_files: [admin]` to `_config.yml` on bump.
- **v0.1.31** (2026-06-06) — **#78 host-loop SITE_ROOT read fix (#1815 host
  leg, next layer).** The v0.1.29 byte-lock fix let the host loop get PAST its
  create leg, exposing the next layer: `cms-unpublish-republish.spec.js` read
  its `_posts/` canary via `path.join(__dirname, "..", FIXTURE_PATH)` = the
  `.cms-platform/` harness checkout on a consumer → ENOENT → the host loop died
  on spec #4 (live run 27069585769). Both reads now use `SITE_ROOT` (the #1815
  v0.1.22 universal rule, applied to these two content reads the workflow-level
  lint couldn't see). New AST lint `e2e/spec-site-root-reads.test.js` flags any
  @lane:real spec reading SITE content (_posts/_e2e/_tags/_drafts/assets) via
  the platform checkout (platform SOURCE reads like theme/admin are allowed).
- **v0.1.32** (2026-06-06) — **#81 host-loop layer #4 (#1815 host leg, tracked in
  #80).** `cms-unpublish-republish.spec.js` reset its canary via a DIRECT PUT to
  `main` (`writeFixtureOnMain`) — which 409s on a consumer whose `main` ruleset
  has `bypass_actors:[]` ("Changes must be made through a pull request"). A failed
  run therefore couldn't restore baseline and left the canary `published:true`,
  SERVING the test fixture publicly at `/blog/e2e-unpublish-canary/`. Switched to
  `seedFixtureViaPr` (a `cms/ready`-labelled auto-merge PR, fire-and-forget) —
  the same path `cms-publish-loop.spec.js`'s afterAll already uses (its helper's
  comment literally explains a direct PUT 409s). The host loop now passes specs
  1–3 live (byte-lock v0.1.29 + keep_files v0.1.30 + SITE_ROOT v0.1.31); the
  remaining spec-#4 failure (a `locator.click` timeout in the unpublish Save/
  Publish leg) is tracked in #80 ("keep peeling to 4/4").
- **v0.1.33** (2026-06-25) — **#96 host-loop layer #5 (#1815 host leg, #80).**
  The v0.1.32 host-loop verification run passed specs 1-3 live but spec #4
  (`cms-unpublish-republish`) still failed: the *second* (unpublish) `saveEntry`
  timed out clicking Save, which the on-prod log resolved to a `<button
  disabled ...SaveButton...>` — the form was never dirtied. After the re-publish
  leg's "Publish now" merges the editorial-workflow PR, Decap reloads the entry
  in place and the Published switch transiently reads its default (OFF) before
  re-hydrating the persisted `published: true`; the idempotent
  `setPublished(false)` raced into that window, saw OFF, skipped the click, and
  left Save disabled. Fix: a symmetric pre-toggle gate (mirroring the step-1
  "reads OFF (baseline)" wait) that re-opens the entry fresh and waits for the
  switch to read ON before toggling OFF, plus an `ENTRY_EDIT_URL` SSOT for the
  canary edit hash-route. Real-prod 4/4 confirmation = a host-loop re-dispatch
  after the consumer bumps land.
- **v0.1.34** (2026-06-25) — **#86 retire the dead committed-PNG visual suite.**
  `e2e/visual-regression.spec.js`'s `toHaveScreenshot` tests had no baselines
  (all 32 committed PNGs were deleted 2026-05-06 and never regenerated), so the
  suite only stayed green by skipping — until the first curated prod tag
  ("quotes", adamdaniel #2057) un-skipped the tag tests and hard-failed
  "snapshot doesn't exist", blocking a content PR. Replaced the 4 pixel tests
  with structural "renders" smoke checks (non-error status + visible heading)
  that KEEP the original content-discovery skip-guards (so they still skip on a
  `base_collections:[]` bio — the #33 contract) and run on a full site; deleted
  `e2e/visual-change-guard.spec.js` (it only bounded the now-gone PNGs) + its 5
  refs. Pixel visual-regression is owned by the prod-diffing video pipeline
  (`visual-regression.yml` + `compute-visual-diffs.js`), which machine-classifies
  PR-vs-production diffs and gates merges via the required `regression-review`
  environment; the structural checks are net-additive (all public projects,
  content-only PRs). Adversarially reviewed (4 lenses): 0 confirmed blockers.
- **v0.1.35** (2026-06-25) — **#100 reaper chokes on Decap smart-quote branch
  names.** `regression-review-reaper.yml` interpolated the PR head branch
  straight into the runs-list URL (`?branch=${HEAD_REF}`). A Decap content-PR
  branch carries the post title verbatim (spaces + smart-quotes), so
  adamdaniel #2057 (`…safety-“somewhat-less-robust”`) produced an UN-encoded
  URL → GitHub returned an HTML error page → `--jq` failed ("invalid character
  '<'") → the job went red under `set -euo pipefail` on every branch sync.
  Fix: build the query with `gh api -X GET -f branch=… -f status=… -f
  per_page=…` (URL-encodes the fields; `-X GET` is required because gh defaults
  to POST once any `-f` is present), and fail OPEN (`|| true`) on the runs-list
  + pending-deployments lookups. Verified live against #2057's exact branch:
  old call → "invalid character '<'", new call → clean total_count.
- **v0.1.36** (2026-06-26) — **#80 host-loop layers 6 & 7 — `saveEntry` vs the
  editorial auto-save.** The v0.1.33 layer-5 fix worked (the unpublish toggle
  now flips ON→OFF), exposing layer 6: after the re-publish leg's Publish-Now
  the entry is in the editorial `Status: Ready` state, where toggling Published
  AUTO-PERSISTS into the open PR — Save goes `disabled` and the transient
  "Changes saved" toast fires/fades in the toggle step. The old `Save.click()`
  30s-timed-out on the disabled button → publishViaUi never ran → unpublish
  never merged. An adversarial review caught layer 7 pre-flight: tolerating the
  disabled Save but still gating on the toast would ALSO fail (toast already
  faded). Fix: `saveEntry` clicks Save only while actionable (4s window) and
  confirms the write via EITHER the toast OR the PERSISTENT saved state (Save
  `disabled` == no unsaved changes). Safe across all 5 callers (each makes a
  guaranteed-real edit; consecutive saves are page.goto-separated → no
  false-pass). Diagnosed from the downloaded test-failed screenshot.
- **v0.1.37** (2026-06-26) — **#85 / #80 layer 8 — Publish-Now 405 dead-end.**
  Multi-agent investigation root-caused the "Publish-Now silently doesn't take
  effect" defect (#85) = the host-loop unpublish leg's "chain never fired": an
  editorial PR auto-merges only on a fresh `decap-cms/pending_publish`/`cms/ready`
  `labeled` event. On an unpublish/re-edit, Decap's "Publish Now" `PUT /merge`
  returns **405** "not mergeable" (checks not recomputed; base just moved), but
  the admin shim `theme/admin/publish-via-auto-merge.js` only recovered on **422**
  "rule violations" → the 405 dead-ended (no `cms/ready`, no auto-merge, no
  deploy). A fresh post works because it opens as a Draft (the Draft→Ready click
  arms auto-merge regardless of the 405). Fix: broaden the **merge** matcher to
  recover on 405/409 too (arm `cms/ready` — correct/idempotent; PR merges via
  auto-merge-when-ready once checks pass); **delete-ref** stays on 422; +3 unit
  tests + a `console.info` to confirm the recovery on the next run. Since the
  host-loop test drives the REAL prod `/admin` shim, this fixes #85 for editors
  AND host-loop spec-4. Evidence: run 28211841171 trace `PUT /pulls/2283/merge
  → 405`, zero `cms/ready` POSTs, deploy queue empty.
- **v0.1.38** (2026-06-28) — **#80 host-loop layer 9 + #85 — the armed PR was
  CLOSED before auto-merge could run.** The v0.1.37 arm-on-405 fix worked (live
  run 28240375064: `PUT /pulls/2295/merge → 405` then `POST /issues/2295/labels`
  arming `cms/ready`), but the freshly-armed, MERGEABLE editorial PR was CLOSED
  ~2s later, before `auto-merge-when-ready` ran, so `enablePullRequestAutoMerge`
  errored "Pull request is closed" → never merged, never deployed. Root cause
  (multi-agent audit + adversarial verification of the Decap 3.12.2 source): the
  shim handed Decap a **synthetic HTTP 200 `{merged:true}`** on its 405/422
  recovery. Decap's `publishUnpublishedEntry` is `await mergePR(pr); await
  deleteBranch(branch)` — `deleteBranch` is UNCONDITIONAL and the merge body's
  `merged` flag is DISCARDED, so any 2xx makes Decap DELETE the editorial head
  ref, which auto-closes the still-open, unmerged PR (PR #2295 timeline:
  `head_ref_deleted` + `closed`, mergedAt:null, by the Decap OAuth user — NOT a
  workflow). Fix (theme/admin/publish-via-auto-merge.js): the **merge** matcher
  still arms `cms/ready` but now returns a **synthetic 422** (deliberately NOT a
  2xx, and NOT 405 — Decap routes exactly 405 to `forceMergePR`, a direct
  default-branch commit), so Decap's `mergePR` re-throws and SKIPS `deleteBranch`
  → the PR stays open + armed → auto-merge-when-ready lands it when the checks
  pass. The **delete-ref** matcher keeps its synthetic `merged:true` (its branch
  is shim-created, not Decap-managed). Also: `console.info`→`console.warn` (the
  host-loop trace only captures error/warn); and `cms-editorial-workflow.yml`'s
  `auto-merge-when-ready` now falls back to a conditional direct squash
  `pulls.merge` when `enablePullRequestAutoMerge` reports "clean status" (every
  required check already green → nothing to enqueue → it would otherwise throw),
  swallowing already-merged/closed idempotently (branch protection still
  enforces the checks at merge time). Updated the shim unit + browser specs and
  added a `clean-status` fallback regression lint.
- **v0.1.39** (2026-06-28) — **#80 host-loop layer 10 — editorial-limbo delete
  leg.** The v0.1.38 422 shim fixed layer 9 (live-verified: editorial PR #2309
  stayed open + armed + auto-merged), but the 422 makes Decap's "Publish Now"
  report an error, so Decap leaves the entry in editorial `Status: Ready` limbo
  (UNPUBLISHED_ENTRY_PUBLISH_FAILURE keeps the entity; the editor shows "Delete
  **un**published entry"). The host-loop delete specs hand-rolled a "Delete
  published entry" click that 30s-timed-out on the wrong affordance
  (cms-delete-published.spec.js:368; run 28340095169). Fix: bring the delete
  specs up to the **proven-green** `cms-publish-loop-prod-mutate.spec.js`
  pattern — after Publish-Now, capture the create PR + `waitForMerge`, then
  `reopenForPublishedDelete` (poll-reloads until Decap drops the now-merged
  editorial entry and shows the PUBLISHED file — a full reload is required;
  Decap's PR-based editorial list only re-derives on CONFIG_SUCCESS), then
  `confirmEditorDelete(() => clickEditorDelete())` (arms a POST /git/trees
  watcher as positive proof the delete dispatched), then label the recovered
  delete PR `cms/ready`. Applied to `cms-delete-published.spec.js` +
  `cms-tags-lifecycle.spec.js` (titleName `/^Name$/i`; canaryMarker = the runId,
  which lands in the file CONTENT — the hyphenated slug is only the filename);
  `cms-publish-loop.spec.js` cleanup leg now uses the limbo-tolerant
  `saveEntry`+`publishViaUi` helpers. `cms-publish-loop-host.yml`
  `timeout-minutes` 105→150 (the delete legs now waitForMerge+reopen). Shim and
  `cms-unpublish-republish.spec.js` unchanged. Decided via multi-agent audit of
  the Decap 3.12.2 editorial-state lifecycle (Option A kept; Option B — 2xx +
  no-op Decap's branch-delete — rejected: re-introduces layer 9 and the no-op is
  indistinguishable from a legit discard).

- **v0.1.40** (2026-06-29) — **#80 host-loop layer 11 — unpublish leg's stale
  editorial draft + reused branch.** v0.1.39 took the loop to 3/4 (both delete
  specs green); cms-unpublish-republish still failed at the UNPUBLISH leg's
  URL-404 wait ("chain never fired", run 28342322662). Root cause: the spec
  reuses a FIXED slug (`2024-01-02-e2e-unpublish-canary`), and (a) the re-open
  step did a hash-route `goto` WITHOUT a full reload, so Decap re-read its
  in-memory editorial draft from the re-publish leg's 422 (Decap re-derives
  editorial state only on a fresh boot / CONFIG_SUCCESS) — the screenshot showed
  Status:Ready + "Not yet published" with Published OFF; and (b) the re-publish
  leg's merged `cms/posts/<slug>` branch LINGERED (`delete_branch_on_merge=false`
  on the consumers), so even a fresh edit couldn't open a new editorial PR
  (createBranch 422s on the existing ref). Fix: (1) the unpublish re-open now does
  an explicit `page.reload()` so Decap re-fetches the entry as the now-published
  file; (2) **enabled `delete_branch_on_merge=true` on both consumers** so a
  merged editorial branch is removed and the next leg/edit opens a fresh PR.
  NOTE: the consumers had drifted to `delete_branch_on_merge=false` (no recorded
  reason; possibly an old fix) — the platform was DESIGNED for it ON
  (cleanup-stale-fixture-branches header). Re-enabled per owner direction with a
  regression watch; revert to false + an in-spec branch-delete is the fallback if
  it regresses elsewhere. cms-delete-published / cms-tags-lifecycle / cms-publish-loop
  unchanged from v0.1.39; the 3-of-4 that passed at `delete_branch_on_merge=false`
  must be re-confirmed green at `true`. **Second-order consequence, recorded in
  v0.1.76:** with the flag ON, GitHub AUTO-RETARGETS dependent PRs, which raises
  the likelihood of the base-retarget case — and a base retarget changes the
  effective diff WITHOUT emitting `synchronize`. That is the residual risk of
  v0.1.76's `pull_request: edited` removal (#222 part 2); the full argument, and
  why it was accepted anyway, is in that entry.

- **v0.1.41** (2026-06-29) — **#80 host-loop layer 11b — unpublish Save no-op on a
  deep-route-reloaded entry.** v0.1.40 (layer 11a) took the loop to 3/4 but
  cms-unpublish-republish leg-2 still failed: a bare `goto(ENTRY_EDIT_URL)+page.reload()`
  on the deep hash route re-derived the post-422 editorial-limbo draft (run
  28372038163 showed status "Published" + "UNSAVED CHANGES" but the toggle-OFF
  Save NO-OP'd — no toast, no branch, no PR, "UNSAVED CHANGES" persisted). Root
  cause (Decap 3.12.2 source audit): the Editor's Save → `actions/entries.ts
  persistEntry`; if `fieldsErrors` is non-empty at click time it `return
  Promise.reject()` with NO toast (only a presence-error shows one), and a bare
  deep-route reload re-boots the app so the toggle+Save can race async field
  re-validation (and the entries route never hydrates the editorialWorkflow
  slice). NOT a boolean-vs-body issue — leg-1 and the green *preview* variant both
  Save a boolean-only toggle fine. Fix: replace the bare reload with the
  PROVEN-green `reopenForPublishedDelete` remount (used by 4 green specs) — it
  bounces through the admin ROOT (fresh CONFIG_SUCCESS / re-login / editorial
  re-hydrate) and poll-reloads until Decap shows a CLEAN PUBLISHED FILE
  (editorial chip absent + "Delete published entry" present), whose settle
  windows let field re-validation finish before Save. From that clean state the
  unpublish Save takes Decap's `!unpublished` createBranchAndPullRequest path →
  a FRESH cms PR opens (layer-11a benefit preserved) → merges → URL 4xxs.
  `saveEntry` unchanged (it correctly fails on a real no-op); `TEST_TIMEOUT_MS`
  40→50 min for the remount budget. Spec-only; shim + delete_branch_on_merge
  unchanged. Also filed #109 (manage repo settings as code).

- **v0.1.42** (2026-06-29) — **#80 host-loop — `saveEntry` re-validation-race no-op
  (shared-helper hardening).** With the layer-11b remount in place, the loop's
  Save-no-op symptom proved to be a GENERAL intermittent flake, not unique to the
  unpublish leg: on run 28380065742 it hit **cms-publish-loop's cleanup** Save
  (byte-identical to the v0.1.40 run that passed → a flake, not a regression).
  Root (Decap 3.12.2 `actions/entries.ts persistEntry`): if `fieldsErrors` is
  non-empty at click time the Save `Promise.reject()`s SILENTLY (only a presence
  error toasts), and field widgets re-validate ASYNC right after a (re)mount, so a
  single Save click can land in the transient-invalid window and no-op — the form
  stays "UNSAVED CHANGES" with Save enabled until the 60s confirm times out. Fix:
  `saveEntry` (shared helper, all 6 callers) now RE-CLICKS Save inside its
  toast-or-disabled `toPass` loop whenever Save is still actionable + unconfirmed;
  once re-validation settles the click persists. Idempotent (a successful save sets
  hasChanged=false → Decap disables Save + the onClick guard no-ops, so it never
  double-persists), and a genuinely-invalid form still fails at `timeout` rather
  than masking a real error. Stacks on the v0.1.41 reopenForPublishedDelete remount.
  Spec-helper only.

- **v0.1.43** (2026-06-29) — **#82 preview-loop in-spec stale-snapshot recovery +
  cms-unpublish-republish setup self-heal.**
  - **#82:** the preview CMS loops timed out at the deploy-chain wait because the
    canary sub-PR (head `cms/*`, BASE = the parent preview-PR HEAD branch, NOT
    main) goes all-required-green + auto-merge-armed but `mergeStateStatus=BLOCKED`
    (the #1812 stale-snapshot), and the cron `cms-automerge-nudge` can't cover it
    (5-min cadence > the ~720s loop budget; it targets main.json checks + merges
    into main) (since superseded in part — see v0.1.52, which extended
    `cms-automerge-nudge.yml`'s own cron backstop to cover base!=main PRs
    directly). ROOT GAP found by audit: **none of the 5 preview specs passed
    `onBudgetExhausted`** (every prod spec does) — so their `waitForChangeReflected`
    wait had NO recovery. Fix: new shared `makePreviewCanaryRecoverer`
    (github-actions-poll.js, sibling of `makeDeployQueueExtender`) + `headChecksTrulyGreen`
    (port of the nudge's fresh-requery: stub-hazard pending-guard, ignore CANCELLED) —
    wired into every preview loop's `onBudgetExhausted`; on a green-but-BLOCKED OWN
    canary (triple guard: `cms/` head + base===preview branch + `automated-test`
    label) it forces a synchronous SQUASH `pulls.merge` into the preview branch to
    dislodge the stale snapshot. Suffix-tolerant context match (`validate-content`
    ruleset context ↔ `editorial / validate-content` check-run name). Only the legs
    with a real canary sub-PR are wired (the tags-delete leg + delete-preview DELETE
    commit directly via the shim — no sub-PR to recover).
  - **Self-heal:** a prior FAILED cms-unpublish-republish run (or the afterAll's
    fire-and-forget reset that never landed) could leave the canary `published:true`
    on main / a lingering branch / the URL serving — and the old setup THREW,
    bricking the next run (hit twice this session). Replaced the throw with
    detect-then-heal: `computeBaselineHeal` (new pure module) drives close-stale-PR +
    reset-published:false-**waiting-for-merge** + URL-404 wait, then a post-heal
    assertion that only throws if un-healable. Reuses existing helpers; logs loudly;
    only ever touches the known throw-away canary fixture.
  Spec/helper-only (no theme change). +unit tests (github-actions-poll.test.js,
  canary-baseline-heal.test.js).

- **v0.1.44** (2026-06-29) — **cms-delete-published-preview delete-leg
  editorial-limbo migration (surfaced verifying #82).** While verifying #82 on a
  PROTECTED preview branch, the delete-preview DELETE leg timed out at
  `getByRole('menuitem', /delete (published )?entry/i)` — the SAME hand-rolled
  editorial-limbo delete-click bug fixed for the prod delete specs in v0.1.39
  (layer 10), never migrated to the preview variant. Fix (PART 1, spec-only):
  migrate the delete leg to the proven `reopenForPublishedDelete` (reopen in the
  PUBLISHED state on the preview admin) + `confirmEditorDelete(() =>
  clickEditorDelete())` (dispatch-proof via a POST /git/trees watcher), after a
  `waitForMerge` on the captured seed PR; delete-leg budget via
  `makeDeployQueueExtender`; TEST_TIMEOUT 30->70 min + the workflow timeout
  35->75. The delete then LANDS on the protected multi-segment preview branch
  via the EXISTING shim delete-ref recovery — Decap PATCHes
  `git/refs/heads/${encodeURIComponent(backend.branch)}`, so a multi-segment
  preview branch arrives percent-encoded (`heads/cms%2F...`) as one raw segment
  that the shim's single-segment regex already matches (verified). DEFERRED
  (PART 2, follow-up issue): scope the shim delete-ref recovery to the configured
  backend branch (read from commit.json) so it never over-recovers a stray
  multi-segment PATCH — a safety hardening that touches the proven prod shim, so
  it is tracked separately rather than bundled here. #82's deploy-chain
  stale-snapshot recovery (cms-preview-loops, the publish/unpublish/tags legs)
  was verified green at v0.1.43; this closes the delete-preview gap.

- **v0.1.45** (2026-06-29) — **`skills-sync.yml` is now a no-op for a no-skills
  consumer (issue #83; the precondition for adamdaniel#2007-P7).** The reusable
  unconditionally `mkdir -p "$DEST"` + `rsync -a --delete`'d the platform skills
  into the consumer and opened a "Sync skills" PR — so a consumer that keeps NO
  local skills mirror (jodidaniel ships `skills-sync.yml` with no `.claude/skills`)
  got one force-created + weekly PR noise, and adamdaniel#2007-P7 could not drop
  its mirror durably (the next sync would re-create it). Fix: gate the sync on
  destination presence — `if [ ! -e "$DEST" ] && [ ! -L "$DEST" ]` (nothing at
  DEST: not a dir, file, or even a symlink) → echo + clean `exit 0`. Opt-IN by
  DEST presence; the platform never forces a mirror into existence. Preserves
  workflow-set parity (the canonical workflow stays present on EVERY consumer —
  only its behavior is data-driven; option (b) "drop it from the canonical set"
  rejected as it forks the workflow set + the parity check). Gate unit-tested
  across absent / real-dir / symlink->dir / dangling-symlink / empty-dir (skips
  ONLY on fully-absent). Workflow-only; no theme/gem change.

- **v0.1.46** (2026-06-29) — **centralize the secrets-scan + lint-staged
  pre-commit guards (dev-hooks-sync, issue #116; also unblocks adamdaniel#2007-P7).**
  The local pre-commit guards were vendored only on adamdaniel (tangled into the
  skills-mirror `bootstrap.sh`); jodidaniel had none (CI-only). The platform
  already owned canonical copies. New reusable **`dev-hooks-sync.yml`** (a
  `skills-sync` twin) down-syncs the canonical guard files —
  `scripts/{secrets-scan,lint-staged,setup-hooks}.sh`, `.githooks/pre-commit`,
  `.gitconfig-fragment` — to a consumer (PR on drift). New
  **`scripts/setup-hooks.sh`** is the slim, idempotent git-config wiring
  (`include.path`/`core.hooksPath`, NO skills) — the section-3 logic extracted
  from the old consumer bootstrap — run from a consumer `.claude/settings.json`
  SessionStart so guards are active locally. The **`dev-hooks-sync` caller** is
  added to `examples/site/.github/workflows/` → carried by the canonical-set
  parity check (auto-required on every consumer) AND seeded by the scaffolder;
  `scaffold/create-site.js` now seeds the guard files + the SessionStart wiring
  on new sites. New `e2e/dev-hooks-sync.test.js` locks the reusable FILES list ⟷
  scaffolder seed list ⟷ canonical files in lockstep (+ asserts the chain no
  longer carries the P7-removed skills-mirror guard). No theme/gem change.

- **v0.1.47** (2026-06-29) — **visual-regression PROD baseline was hardcoded to
  adamdaniel.ai (issue #123).** `e2e/regression-video.spec.js` set
  `const PROD_BASE = "https://adamdaniel.ai"`, so the regression video pipeline
  captured every changed page's PRODUCTION screenshot from Adam's site — meaning
  EVERY non-adamdaniel consumer (jodidaniel + all future sites) diffed its PR
  against a different site and always scored "visually different" (long
  misattributed to "no committed baselines"); adamdaniel worked only by
  coincidence. Fix: derive `PROD_BASE` from the consumer apex —
  `process.env.PROD_BASE_URL || (APEX_DOMAIN ? https://$APEX_DOMAIN : adamdaniel.ai)`.
  `visual-regression.yml` already exports `APEX_DOMAIN: vars.CMS_APEX` at JOB
  level, so the regression-spec step already inherits it — no workflow change.
  New `e2e/regression-prod-base.test.js` locks PROD_BASE to the apex env (never a
  bare hardcoded site). Harness-only; no theme/gem change.

- **v0.1.48** (2026-07-03) — **kill the persistent Decap "adding labels to N of
  your Editorial Workflow entries" dialog at the source.** Root cause: every
  NON-Decap writer that opens a `cms/*` PR (publish-via-auto-merge shim
  delete-recovery, `cms-fixture-pr.js` seed/remove, `sweep-stale-cms-prs.yml`
  cleanup PRs) labelled it `cms/ready` only — no `decap-cms/<status>` — so
  Decap's github backend ran its label migration on every `/admin` load for as
  long as the PR was open, and for these PRs the migration always no-ops
  ("Skipped migrating": no legacy `refs/meta/_decap_cms` metadata), so the
  dialog never cleared. Bit hard when adamdaniel #2387 (a delete-recovery PR
  with a flaky-red `e2e` check) sat open for 3 days: dialog on every prod
  `/admin` load while the flag-only daily audit went red, unnoticed, all week.
  Fix, two layers: (1) all four non-Decap `cms/*` PR writers now apply
  `decap-cms/pending_publish` at creation; (2) `audit-editorial-labels.js`
  gains `--fix` (reusable default `fix: true`, needs caller
  `pull-requests: write`) — the daily audit HEALS stragglers instead of only
  flagging them, and red now means "fix didn't stick", not "needs a label".
  Lint-locked by `e2e/editorial-label-audit-repo.test.js`; shim behaviour by
  `e2e/publish-via-auto-merge{.test.js,-browser.spec.js}`.

- **v0.1.49** (2026-07-05) — **sweep robustness + fixture-pr exports + preview-env
  concurrency + self-secrets-scan, bundled.** #127: `sweep-stale-cms-prs.yml`
  tolerates a consumer missing `_e2e/`/`_posts/`/`assets/images/uploads`
  directories (GitHub's Contents API 404s a missing-directory listing, which
  `set -euo pipefail` turned into a hard crash — jodidaniel.com's daily sweep
  had failed 30/30 times since 2026-06-06); also renamed to "... (reusable)".
  #128: `e2e/cms-fixture-pr.js` now exports `openPr`/`addReadyLabel` (their
  absence crashed `cms-tags-lifecycle.spec.js`'s cleanup safety-net with
  "openPr is not a function"). #129: job-level `concurrency` on each preview-env
  reusable's mutating job (`cms-publish-loop-preview`, `cms-preview-loops`,
  `cms-delete-published-preview`) so simultaneous dispatches against the same
  PR's preview environment stop queuing deploys N-deep past the URL-reflect
  budget; + a bounded retry on the "Delete published entry" click. #126: new
  `self-secrets-scan.yml` — the platform repo now runs `secrets-scan.yml` on
  itself (mirroring the consumer caller's PR/push/weekly-schedule triggers);
  + a consistent `(reusable)` suffix on every `workflow_call` workflow's
  display name.
- **v0.1.50** (2026-07-05) — **#130 discard `gh api` error-body stdout on
  failed listings.** Follow-up to #127 (insufficient): `gh api ... 2>/dev/null
  || true` swallows the exit code, but `gh api` still relays the HTTP error
  body to STDOUT, so a 404 captured `{"message":"Not Found",...}` into the
  variable — on jodidaniel.com (no `_e2e/`) the sweep then tried to delete a
  "file" literally named `{"message":"Not`. Fixed in `sweep-stale-cms-prs.yml`
  (the three directory listings + the Tier-3 branch-json fetch) and the
  same-class bug in `regression-review-reaper.yml`'s run/deployment listings,
  by moving the fallback OUTSIDE the command substitution
  (`files=$(gh api … 2>/dev/null) || files=""`).
- **v0.1.51** (2026-07-05) — **#131 `cms-publish-loop-preview` merge-aware wait
  + queue-aware 90-min budget** (port of #1723 Cat 1 hardening from the
  prod-mutate spec). The spec's `TEST_TIMEOUT_MS` (12min) was structurally too
  small for the real Decap → PR → nudge → merge → deploy-preview → CloudFront
  chain (confirmed-healthy real runs took 10.5-13 min and the spec still died
  at "Test timeout of 720000ms exceeded"); raised to 90min with per-leg budget
  math, mirroring the prod/delete-preview pattern.
- **v0.1.52** (2026-07-05) — **#132 preview-only PR merge fallback + nudge
  carve-out.** `cms-editorial-workflow.yml`'s `auto-merge-when-ready` now
  recovers the "Pull request is in unstable status" GraphQL error the same way
  it already handles "clean status" (a bounded ~10-min poll of the PR's own
  computed mergeable state, falling back to an explicit squash merge) — a
  `cms/preview-only` PR (base != `main`) has no required-status-check
  protection on its base branch, so `enablePullRequestAutoMerge` can never
  succeed and nothing else re-triggers this event-driven job once checks
  finish (PR #2466 sat unmerged 26+ min). `cms-automerge-nudge.yml` gains a
  `basePreviewOnly` (`baseRefName !== 'main'`) carve-out so its cron backstop
  also evaluates these PRs, whose `autoMergeRequest` can never populate in the
  first place.

- **v0.1.53–v0.1.56** (2026-07-05/06) — shipped without history entries here:
  #133 stale-docs sweep, #134 scaffolder latest-release pins, #135 preview-only
  merge unwedging, #136 dependabot re-arm sweep (see its section), #137
  platform-bump seeds newly-dictated callers, #138 base-aware nudge readiness.

- **v0.1.57** (2026-07-06) — **scheduled-run failure alerting (the silent-red
  problem).** New `scheduled-run-health.yml` reusable +
  `self-scheduled-run-health.yml` dogfood caller + `examples/site` thin caller:
  daily scan of the caller repo's last 48h of `event=schedule` runs for
  `failure`/`startup_failure`/`timed_out`, filed on a single `ci`-labelled
  tracking issue (open on first failure, run-id-deduped comments for new ones,
  auto-close after a clean window). Motivated by the 2026-07 audit: adamdaniel's
  editorial-label-audit red 24/30 days and jodidaniel's sweep-stale-cms-prs red
  30/30 for a month, all unnoticed. See "Scheduled-run health audit" section.

- **v0.1.58** (2026-07-06) — **the health-audit alert names the workflow FILE,
  not the run title.** The runs API's `name` is the run's DISPLAY TITLE — for
  this repo family the evaluated dynamic `run-name:` — so grouping by it
  produced alert headers like "scheduled — 0 12 * * *" that never said WHICH
  workflow failed (observed in the v0.1.57 dry-run against adamdaniel's real
  30-day history). `audit-scheduled-runs.js` now groups findings by
  `workflowKey()` = the workflow file's basename from `run.path`
  (`cms-publish-loop-host.yml`, …), with `name` only as a fallback when the
  API omits `path`. Lock: the groupByWorkflow unit test feeds run-name-shaped
  `name` values and asserts basename grouping.
- **v0.1.63** (2026-07-13) — **`skills-sync` no longer clobbers repo-local
  skills.** The down-sync `rsync -a --delete .cms-platform/skills/ <dest>/` made
  the site match the platform EXACTLY, so any skill a site owned but the platform
  didn't ship — adamdaniel.ai's `embeddable-tool-pages` — was deleted on every
  sync (observed as adamdaniel.ai#2593, which deleted it). The reusable now
  scans `<dest>` for skill dirs carrying a `.repo-local` marker file and
  `--exclude`s each from the rsync, protecting them from BOTH overwrite and
  `--delete` (no `--delete-excluded`). Deliberately NOT a plain "merge": unmarked
  skills stay platform-authoritative, so a skill REMOVED from the platform is
  still removed from the site — the marker is what distinguishes "site owns this"
  from "platform dropped this." The up-sync drift-guard already ignored site-only
  skills, so no guard change was needed. Lock: `e2e/skills-sync.test.js` asserts
  the reusable keeps `--delete`, discovers `.repo-local`, builds anchored
  excludes, and never passes `--delete-excluded`. Consumers opt a skill in by
  committing `.claude/skills/<name>/.repo-local` (see `skills/README.md`).
- **v0.1.64** (2026-07-13) — **`skills-sync` additive drift is no longer
  silently dropped.** The "did anything change?" gate used `git diff --quiet`,
  which is BLIND to untracked files. rsync brings NEW platform skills in as
  untracked dirs, so a purely-additive sync reported "already in sync" and
  exited without ever committing them — a latent bug the v0.1.63 repo-local fix
  unmasked (before it, `rsync --delete` always removed the *tracked* repo-local
  skill, forcing a diff that swept the additions along; adamdaniel.ai#2593 was
  exactly that). Discovered when a post-v0.1.63 sync of adamdaniel.ai correctly
  preserved `embeddable-tool-pages` but then added ZERO of the platform's 16
  canonical skills. The gate now tests `git status --porcelain -- "$DEST"`
  (untracked-aware). Lock: `e2e/skills-sync.test.js` asserts the drift gate uses
  `git status --porcelain` and never `git diff --quiet`.

- **v0.1.65–v0.1.67** (2026-07-13/22) — shipped without history entries here.
- **v0.1.68** (2026-08-07) — **the e2e suite runs as one CI job per Playwright
  project: ~680 s → ~200 s of wall clock, measured (#197).** `e2e-tests.yml` ran
  the whole suite in ONE job at Playwright's default 2 workers; it now fans out a
  `project` matrix (10 jobs, one project each, only that project's browser engine
  installed, `150%` workers) behind an aggregating `e2e` gate job — so
  `e2e / e2e` remains the single required context and NO consumer ruleset
  changed. `e2e/ci-matrix.js` derives the matrix list, each job's engine, and the
  worker count from `playwright.config.js`; `e2e/ci-matrix.test.js` fails self-CI
  if the workflow's static `matrix.project` drifts from the real project list
  (the one way the design can silently stop running a project). `--shard` was
  measured and rejected (it balances by test COUNT; a 4-way shard put 71% of the
  work in one shard), as were hand-grouped lanes and browser caching. Four
  PRE-EXISTING test-isolation bugs surfaced and were fixed — a shared upload
  basename (`e2e/upload-fixture.js`), an unbounded crawl on a fixed 30 s budget
  (`image-alt-text`), nine specs racing one `jekyll build` (`e2e/jekyll-build.js`
  + its lock test), and five `existsSync`-then-read waits on files decap-server
  was still writing (`e2e/fs-poll.js`). The reusable also stops paying for the
  per-navigation frame capture whose only consumer no reusable invokes
  (`DISABLE_PER_TEST_VIDEOS=1`). Full measurements, both job shapes, the rejected
  alternatives, and how to re-measure: **`docs/E2E-PARALLELISM.md`**.

- **v0.1.69** (2026-08-07) — **v0.1.68 follow-ups.** (1) The build lock now
  CREDITS its waiting back to the caller's test timeout: the nine build-calling
  specs run on Playwright's 30 s default with a ~4 s build, so a queue three deep
  would have traded the build race for a timeout race (not observed failing — the
  final config was green with zero flaky tests — but now structurally impossible).
  (2) `docs/E2E-PARALLELISM.md` records the CONSUMER-VERIFIED numbers from both
  v0.1.68 bump PRs (adamdaniel.ai 222 s, jodidaniel.com 148 s) plus what the
  design costs: ~1.5x the runner-minutes for ~3x less wall clock, and the wall
  clock includes GitHub allocating ten runners (3-10 s typical, once 59 s).

- **v0.1.70** (2026-08-07) — **the engine scoping reached only ONE lane, and its
  fallback was costing every other one — permanently (#202).** v0.1.68 taught
  `install-browsers-on-miss`'s globalSetup to check only `PW_PROJECT`'s engine,
  but only `e2e-tests.yml` sets that variable. Every OTHER harness-running lane
  left it unset and hit the "check all three" fallback — so a lane that installs
  **chromium only** (all ten sibling reusables) reported firefox + webkit as
  "missing", downloaded them for browsers it never launches, and printed the
  ci-runner-image-drift warning on EVERY run, making a real drift
  indistinguishable from the permanent false one. Self-CI's `node-unit-lints`
  lane, which installs NO browsers to run pure-fs lints, downloaded all three
  (~16 s/run). Both REQUIRED per-PR checks (`parity`, `preview-media`) were
  paying it. Fix: every harness step declares its project(s) via `PW_PROJECT`
  (`neededEngines()` takes a comma-separated list), locked by
  **`e2e/engine-scope-lint.test.js`** — a step whose `PW_PROJECT` is missing or
  disagrees with its `--project` flags fails self-CI, so a new lane can't
  regress it. Steps running a different config (visual-regression, whose config
  declares no globalSetup) are explicitly exempt. Also: **tag routing is opt-IN, so
  an untagged admin spec matches every public project's `grepInvert`** —
  `cms-html-embed.spec.js` drove Decap untagged, held to one project only by a
  hand-rolled `beforeEach` gate (so the harm was mis-stated at the time as "it ran
  on all eight"; see the third paragraph, where leaving that gate in place turned
  out to be the real bug). Now `@admin-write`, with
  **`e2e/admin-tag-lint.test.js`** (AST) failing any spec that navigates the admin
  shell untagged. Plus four documentation corrections
  from v0.1.68's per-project → uniform-`150%`-workers pivot (the
  `playwright.config.js` `workers:` comment, an AGENTS.md self-contradiction,
  `docs/E2E-PARALLELISM.md` naming two symbols that don't exist, and
  `jekyll-build.js` mislabelling its nine callers).

  Also in v0.1.70, from an adversarial review of the parallelism work's own
  fixes: **the build lock's stale break was unreachable** (`STALE_MS` 300 s >
  `WAIT_TIMEOUT_MS` 180 s, so a fresh waiter always timed out before it could
  break an orphaned lock — a killed worker wedged the next build, the opposite of
  the documented guarantee) and **breaking/releasing it was not ownership-checked**
  (a merely-slow holder could have its lock broken, and its `finally` would then
  delete the NEW holder's lock); **six more specs still polled a file's EXISTENCE
  and then read it**, and in `cms-html-embed`/`cms-inline-image` that read feeds a
  `writeFileSync` back to the same path, so an empty read overwrote the entry with
  front-matter-less content instead of merely failing an assertion; and
  **`cms-page-crud` left an orphaned `<loc>` in the shared `_site/sitemap.xml`**
  that `image-alt-text`'s hard 200 assertion crawls (its `/blog/e2e-…` fixture
  exemption does not cover a `/pages/…` path). Each is now lint- or test-locked:
  `jekyll-build.test.js` asserts the constants' inequality and the ownership
  refusal, `fs-poll-lint.test.js` (AST) fails the build on the read-race shape,
  and the sitemap prune mirrors `cms-publish-flow`'s.

  Also **the browser install is now BOUNDED and RETRIED (#204).** Measured on
  adamdaniel.ai job 92862768030: `npx playwright install --with-deps webkit` took
  **39 minutes** while the tests it installed for took 41.6 s — the Ubuntu mirror
  served that runner at ~35 KB/s for its whole run and the install had no upper
  bound. Fanning out to ten lanes means ten INDEPENDENT apt exposures per run, and
  the aggregating `e2e` gate waits for the slowest, so that one lane held a
  delete-recovery PR open 40 min and blew the media-roundtrip loop's 30-minute
  delete-leg budget — the loop failed on a green test suite. All 13 call sites now
  go through `.github/actions/install-playwright-browsers` (`timeout 420` per
  attempt, 3 attempts), locked by **`e2e/playwright-install-bounded.test.js`**. A
  bare `timeout-minutes:` would be WORSE — it turns a slow mirror into a RED
  required check, blocking a `cms/*` canary PR permanently instead of merging it
  late; only a retry recovers, because a fresh attempt gets fresh connections.
  (A later release removed the bound from the apt half specifically: bounding it
  orphaned a root-owned `apt-get` that then starved every retry on the dpkg lock
  — job 92989057569. See the "NEVER shell out" bullet above for the current
  two-phase design.)

  One more, and it was a REGRESSION from #202's own tagging: `cms-html-embed`
  carried a hand-rolled `beforeEach` gate skipping unless the project was
  `chromium-desktop-1080`, so the new `@admin-write` tag (which routes to
  `chromium-desktop-3k`) made the two conditions mutually exclusive and **the
  whole file skipped everywhere** — the kramdown render contract silently
  untested, with nothing red. The gate is gone (the tag expresses that routing),
  and `admin-tag-lint.test.js` now derives each spec's routed projects from the
  config's own `grep`/`grepInvert` and fails on an unsatisfiable gate. **A tag is
  routing: never leave a hand-rolled `project.name !== "…"` skip beside one.**
  (That gate also means #202's "it ran on all EIGHT public projects" overstated
  the harm — the gate had held it to one; the tag was still the right fix.)

- **v0.1.71** (2026-08-07) — **one doc file on a bump PR was cancelling a prod
  loop (#208).** The bump-skip (#57) required EVERY changed path in a push to be a
  version pin, so the `AGENTS.md` corrections landed on the v0.1.70 bump PR — the
  natural place for a doc fix that goes with a bump — made `every(isBumpArtifact)`
  false. The gate said RUN, **all three prod loops fired on the same push**, and
  because they share the `prod-mutating-loop` group (which holds an in-flight run
  but DROPS a co-arriving sibling), `cms-media-roundtrip`'s heavy job was
  **cancelled outright** (adamdaniel.ai run 31185014802) — as was
  `cms-publish-loop-prod`'s (run 31185015141) — while `cms-publish-loop-host`'s
  survived. **#70's disjoint-push-triggers fix cannot prevent this**: a bump
  rewrites the `uses:@<ref>` pin in EVERY loop's own workflow file, which IS each
  loop's own trigger path, so a bump inherently fires all three and the skip is
  the only thing between a bump and a cancelled loop. `isBumpOnlyPush` now also
  tolerates paths that cannot change the built site (`AGENTS.md`, `CLAUDE.md`,
  `README.md`, `LICENSE`, `docs/**` — exactly the deploy workflows'
  `paths-ignore` set); a bump carrying `_posts/`, a script, a config or CSS still
  RUNS. Both directions locked by `e2e/cms-recursion-churn.test.js`. Also: the
  measured per-lane ceiling analysis in `docs/E2E-PARALLELISM.md` (the long pole
  is WebKit's TEST speed, and sharding within a project buys ~45 s for double the
  job count — priced, and declined), the apt-stall frequency (~1 run in 10, two
  occurrences in one afternoon), and both consumers' AGENTS.md corrected where
  they still claimed per-project worker counts.

- **v0.1.72** (2026-08-08) — **the apt bound orphaned a root-owned `apt-get`
  (#216), plus the locale-dependent renderer (#213).** v0.1.70's install bound
  wrapped the WHOLE `install --with-deps`, and that did not abandon a slow apt —
  it ORPHANED one. Playwright logs "Switching to root user to install
  dependencies..." before shelling out, so the `apt-get` doing the work is a
  **root-owned grandchild**; an unprivileged `timeout`'s signal cannot reach it
  (EPERM) however the process group is arranged, which means `setsid` plus a
  group kill does not help either and **no signal-based kill can**. Measured on
  adamdaniel.ai job 92989057569: attempt 1 fetched for 7 minutes with ZERO
  lock-wait lines (it owned the dpkg lock), was killed mid-transaction at the
  420 s bound, and 19 s later attempt 2 died on "Could not get lock
  /var/lib/dpkg/lock-frontend. It is held by process 2857 (apt-get)" — attempt
  1's own survivor, not the runner's `apt-daily`. That failed the webkit lane,
  failed the `e2e` gate, BLOCKED canary PR #2978 and timed out the prod loop; a
  re-run with zero code change went green. Fix: the install splits into two
  phases — `install-deps` (apt) retried but **never** wrapped in `timeout`, and
  `install` (the download, no `--with-deps`) keeping the escalating bound. The
  trade is deliberate: apt IS the slow phase, so a lane can finish late, and
  late-and-green beats red-and-blocked because a red required check blocks a
  `cms/*` canary PR permanently. Classification now greps the captured output
  for `Could not get lock|lock-frontend|dpkg was interrupted` BEFORE reading the
  exit code, since `npx playwright install` wraps apt's 100 as 1.
  Also: **#213** — `scripts/render-decap-config.rb` inherited
  `Encoding.default_external` from the ambient locale, so with no `LANG` it
  resolved to US-ASCII and the first `sub` over `config.base.yml`'s UTF-8
  em-dashes raised `invalid byte sequence in US-ASCII`. CI masked it
  (`ubuntu-latest` sets `LANG=C.UTF-8`); a deploy-time renderer must not depend
  on that. Pinned in the CLI entry point (covering its reads/writes, both
  `YAML.load_file` calls, and the `require_relative`'d `FieldLibrary`), NOT in
  the Jekyll-hosted twin, which must not mutate its host's globals. Proven
  output-neutral under a UTF-8 locale, so no consumer's admin config shifts.
  Plus **build-lock hardening (#214)**: `release()` refuses unless the owner
  reads back exactly our token (an unreadable owner used to fall through and
  delete a lock it could not prove was ours); the stale branch no longer
  `continue`s past the deadline check (an unbreakable lock used to spin
  `acquire()` forever — a hang is worse than a timeout); and the lock wait is
  credited to the caller's test budget INCREMENTALLY, so acquire's own
  diagnostic can surface before Playwright kills the test. The "every in-test
  jekyll build goes through the helper" lint was a regex matching one call
  shape and is now an AST detector over the whole exec/spawn family.

- **v0.1.73** (2026-08-08) — **the regression capture scored a page as changed
  before it finished rendering (#219).** `regression-video.spec.js` screenshotted
  each page without waiting for render to settle, so a page whose paint had not
  converged could be captured mid-render on one side of the PR-vs-prod pair and
  score a pixel delta with **no text delta** — the signature of a false positive.
  Observed on adamdaniel.ai #2994 (v0.1.72 harness): `/blog/introducing-gha-bench/`
  reported visually different, forcing a human `regression-review` approval on a
  pins-only bump. The controlled comparison is #2998 (v0.1.73, same pins-only
  diff, same 13-page universe): 0 different, 13 identical, auto-approved.
  **Read the shape, not just the count:** `Visually different ≥ 1` with
  `Text changed: 0` is the false-positive signature; the v0.1.59–v0.1.62 bump PRs
  also reported 1 different but carried `Text changed: 1` — a real content delta,
  a different thing entirely. Across the 15 bump PRs with a regression comment the
  false-positive shape appears exactly once, so treat any single green run as weak
  evidence and watch the shape over several releases.

- **v0.1.74** (2026-08-08) — **a stale `platform_ref` INPUT silently ran a
  14-release-old platform tree, and the pin guard could not see it (#220).**
  `check-platform-pin-consistency.js` validated every `uses:@` pin, every
  composite `# vX.Y.Z` comment and the Gemfile tags — but not the `platform_ref:`
  input, which is what each reusable's own checkout does `ref:` with, so it (not
  the `uses:@` pin) decides WHICH platform tree runs. The workflow-CONTENT parity
  check could not cover it either: it deliberately masks `with:` VALUES as
  site-specific, and this one is canonical by definition. jodidaniel.com's
  `cms-scheduled-publish-loop` therefore shipped `uses:@v0.1.73` with
  `platform_ref: v0.1.59`, checking out a tree that predated the v0.1.70
  `install-playwright-browsers` composite and failing `Can't find 'action.yml'`
  silently, on a schedule, since v0.1.70 (runs 31242320695, 31266342355).
  **The introduction path is the same blind spot, one level up:**
  `platform-bump`'s newly-dictated-caller SEEDING re-pinned only `uses:@` and the
  composite comment, justified in-comment as "the ref shapes the pin-consistency
  checker recognizes" — so the checker's gap propagated into the seeder, and the
  later generic `CUR->LATEST` replace could never repair the frozen value (`CUR`
  is the consumer's previous ref, which `v0.1.59` never matched again). Both are
  fixed: the guard checks every literal `platform_ref` (skipping input
  DECLARATION maps and `${{ … }}` expressions), and the seeder stamps
  `platform_ref:` in bare / `"double"` / `'single'`-quoted shapes. Keep the two
  shape lists in lockstep, in BOTH directions. The `e2e-tests.yml` skew #220 also
  flagged was an artifact of the grep that found it — a full per-workflow audit of
  both consumers found this caller to be the only real one.

  **Why a stale `platform_ref` cannot be caught by symptoms — only by the guard.**
  A composite is REFERENCED by the reusable (which comes from `uses:@`) but
  RESOLVED from the `.cms-platform/` checkout (which comes from `platform_ref`).
  Those two refs are independent, so a stale input is completely silent until a
  reusable happens to reference a path its pinned tree lacks. Verified against the
  real tag trees: at v0.1.67 and v0.1.69 the reusable shelled out to
  `npx playwright install --with-deps chromium` and the composite did not exist,
  so nothing resolved from the stale checkout and the daily run went green; v0.1.70
  both added the composite AND switched the reusable to it, and the very next
  scheduled run failed. So the *skew* lasted 14 releases while the *failure* lasted
  one day (two runs: 31242320695, then the re-dispatch). Worse, the green month
  before it was hollow — this loop's heavy leg self-skips on jodidaniel
  (`PROD_PLAYGROUND_MODE` disabled), and the reusable itself did not even EXIST at
  v0.1.59, so the `e2e/` harness being checked out was older than the workflow
  driving it and nothing ever exercised it. **Do not reason about pin skew from
  whether runs are passing.**

- **v0.1.75** (2026-08-08) — **two ways an automated PR could wedge itself, and a
  sweep tier that never covered its third loop.**

  **#222 — a second `platform-bump` run retracted its own PR's required checks.**
  Two runs landed 14 s apart on each consumer; the loser force-pushed, found
  `gh pr create` failed because the winner's PR was open, and fell through to
  `|| gh pr edit --body`. That fires `pull_request: edited`, which every
  required-check caller skips on — and **a skipped caller never invokes the
  reusable, so no check-run named `<caller job> / <reusable job>` is produced at
  all.** The newest run therefore WITHDRAWS a required context that was already
  green; GitHub reports "5 of 6 required status checks are expected" and only a
  new SHA restores them, which a finished bump PR never gets. Exactly 5 of the 6
  required contexts are reusable-calling jobs with that guard (`editorial /
  validate-content` is not), matching the error precisely. **`concurrency:`
  alone does NOT fix it** — the existing "already on $LATEST" gate reads
  `platform.lock` on the DEFAULT BRANCH, which only advances when a bump PR
  MERGES, so a serialised second run still redoes the work. The fix is both: a
  job-level `concurrency` group (which is what makes the gate sound — without it
  two runs can both pass the check before either creates a PR) plus an
  idempotency gate keyed on an OPEN `platform/bump-$LATEST` PR, fail-open on a
  gh error. The `edited` guard itself is the amplifier and is tracked
  separately: measured 2 firings in 4 days, self-healing on any PR that gets
  another push, terminal only where none is coming — against **0 base retargets
  in 60 PRs**, which is the only case it exists for.

  **#224 — the sweep never reaped `e2e-scheduled-publish-` orphans.** That loop
  follows the same ephemeral per-run `_posts/` model as prod-mutate and
  media-roundtrip but was absent from the content tier; an orphan from
  2026-07-31 served HTTP 200 on adamdaniel.ai for 8 days with nothing that would
  collect it. Extends the EXISTING tier's jq filter (single source over
  duplication), so it inherits the age gate, the labelled auto-merging cleanup
  PR, and the #130 missing-directory tolerance — which is what makes a consumer
  with no `_posts/` today (jodidaniel.com) benefit the moment it grows one, with
  no per-consumer config. **Deliberately NOT added to the branch safelist**, and
  this is the load-bearing detail: the issue proposed
  `cms/posts/2099-12-31-e2e-scheduled-publish-`, which no code path creates —
  the loop's fixtures ride `cms/e2e-fixture/` (already safelisted), while
  `cms/posts/scheduled-publish-<run_id>` belongs to the REAL scheduler
  (`publish-scheduled-posts.yml` `git checkout -b`) and is shared with genuine
  editor-scheduled posts. Safelisting it would have let the daily sweep close
  real queued content. Three lints added, each proven red-first, including a
  comment-stripped prefix-completeness check (the step's own comment names all
  three prefixes in prose, so an un-stripped assertion would be tautological).

- **v0.1.76** (2026-08-10) — **four separate automations were green and inert at
  the same time.** The re-arm sweep never once reached the branch that works and
  reported `merged=0 re-armed=0 skipped=0` after failing twice; comment-sync was
  shipped to consumers and never run here, so the platform's OWN pin comments
  lie; the repo-settings audit printed "OK — live settings match" for flags its
  read-only PAT had never SEEN; and a month of `skipped=2 / merged=0` read as
  success. A fifth, the health audit, was the inverse — alerting loudly on runs
  that never got a runner. The common shape is a report that cannot distinguish
  *verified* from *never looked*, which is why each fix below changes what gets
  COUNTED and what the exit code means, not only the mechanism.

  **The Dependabot causal story was recorded WRONG, and the wrong version must
  never be re-derived.** "GITHUB_TOKEN cannot merge workflow-file PRs" is FALSE:
  PR #182 merged **31 changed files, all under `.github/workflows/`**, by
  `github-actions[bot]` at 2026-07-21T19:06:16Z — **3 s** after its last required
  check (`node-unit-lints`) completed at 19:06:13. That is native auto-merge armed
  from the `pull_request` event, firing the instant the last check went green;
  PR #193 (6 files, all workflows) is a second instance. The two real causes are
  (1) `enablePullRequestAutoMerge` is refused **from the SCHEDULE context** —
  sweep job 93416787884 passed the mergeable gate, `checks_ok` and the manifest
  re-check for BOTH #194 and #179, then logged "GraphQL: Pull request refusing to
  allow a GitHub App to create or update workflow
  `.github/workflows/deploy-preview.yml` without `workflows` permission"; the
  discriminator is EVENT CONTEXT, not token class — and (2) the CLEAN-gated
  direct-merge branch was UNREACHABLE and had never once executed:
  `mergeStateStatus` read `BLOCKED` on both PRs while all three required contexts
  (`actionlint`, `ruby-theme-specs`, `node-unit-lints`) were SUCCESS, the `main`
  ruleset requires 0 approving reviews, and `bypass_actors` is empty. **A third
  cause was then found, and it corrects (2):** `BLOCKED` was substantively TRUE —
  #194 was 31 commits BEHIND `main` and #179 was 41, while a fresh PR (#228,
  `behind_by=0`) read `clean` under identical protection. A batch strands because
  each merge advances the base and leaves its siblings STALE, and no amount of
  re-arming makes a stale branch mergeable; the sweep now reads `.behind_by` from
  the compare API and runs `gh pr update-branch`, which is what
  `allow_update_branch: true` exists to permit. Fix: the direct merge is **always the
  first attempt** (the checks are already verified green and branch protection
  still enforces every required check at merge time), `--auto` is recovery only,
  `mergeable == UNKNOWN` is RETRIED rather than skipped (job 93223897818 skipped
  both PRs on UNKNOWN on 2026-08-09 and the next day both read MERGEABLE), and a
  PR that can be neither merged nor re-armed counts as **FAILED** and exits
  non-zero — the same "a red run means a human is needed" contract as
  `audit-editorial-labels.js --fix`. **The sweep KEEPS `github.token` on the
  merge path deliberately** — see the re-arm-sweep section for the
  push-trigger/prod-loop-eviction reason.

  **Comment-sync is now dogfooded, and the drift it repairs is structural.**
  Dependabot rewrites a pin comment ONLY when the comment matches the version it
  is bumping FROM, so #194 (6.2.2 → 6.2.3 behind "# v6.1.1 (2026-05-05)") can
  never self-repair and each bump widens the gap; #179 carries setup-node
  v7.0.0's SHA behind "# v6.4.0 (2026-04-20)" across 18 files. That is the SAME
  trap as #220's frozen `platform_ref` — a generic `CUR->LATEST` replace cannot
  match an already-drifted value. (setup-node v7.0.0 was checked for real: v6.4.0
  and v7.0.0 both declare `runs.using: 'node24'` with an IDENTICAL input set, so
  the major is the internal ESM migration; its one behavioural removal, the dummy
  `NODE_AUTH_TOKEN` export, is unused — zero references to `NODE_AUTH_TOKEN` /
  `registry-url` / `mirror-token` in any of the three repos.) Since cms-platform
  has no `CMS_PLATFORM_PAT` of its own, the reusable gains an **App fallback**
  minted in pure node + stdlib `crypto` (no new marketplace action); the PAT still
  wins when present so the consumer path is unchanged. Repairing this removes the
  last human gate on third-party action SHAs entering 18 reusables both
  production sites execute, so both of cms-platform's ecosystems gain a graduated
  `cooldown: {default-days: 7, semver-major-days: 30}` — mechanising the repo's
  existing cooling-off convention, and deliberately NOT applied to a consumer's
  `github-actions` ecosystem (see the re-arm-sweep section for why — and note the
  reason recorded there is a CORRECTION: consumers pin zero third-party actions,
  which is the actual reason, not the release-adoption delay first claimed).

  **#215 — the loop stopped blaming the deploy chain for a PR that has not
  merged, and the scope was wider than the issue.** Before the merge lands the
  deploy lane is idle for a completely innocent reason (nothing can deploy yet),
  so a merely-slow auto-merge was reported as "NO deploy-production run fired for
  your merge — the chain never fired". Observed live: adamdaniel.ai run
  31107474927 (2026-08-06 host-loop) killed `cms-tags-lifecycle` at exactly that
  message after **908 s** with in-flight 0 / queued 0 while the auto-merge was
  merely pending — well inside the documented ~30-min latency; same class in runs
  30915982319 and 30822288078, while the other two host-loop specs passed in that
  run. **13 of the 15 `makeDeployQueueExtender` call sites were BARE**, hence
  unanchored, hence could never reach the conclusive verdict at all — the #21 fix
  only ever applied to 2 legs. Details + the new verdicts: "Prod-loop deploy-lane
  diagnostic" above.

  **The health audit stopped alerting on runner starvation, and the class was
  never jodidaniel-only.** GitHub reports the RUN as `failure` when its jobs were
  cancelled before a runner was ever assigned, and `filterAlertRuns` only tested
  the RUN conclusion. Verified live over a 168h window with the real module:
  jodidaniel.com **5 alertable → 1** (the genuine #220
  `cms-scheduled-publish-loop` failure still alerts) and adamdaniel.ai **6 → 2**
  (both real `cms-publish-loop-host` failures — the ones #215 addresses — still
  alert). The five-clause shape, the `runner_id` asymmetry and the fail-soft
  posture are in "Scheduled-run health audit" above.

  **The repo-settings audit's OK line no longer overstates what it verified.**
  The audit already collected `flag-not-visible` informationals — keys the
  read-only PAT never SAW — but both the per-repo OK line and the final summary
  claimed an unqualified match. Per the owner-chosen approach this SURFACES the
  gap rather than closing it: the per-repo line carries the unverifiable count,
  the per-key notices collapse into one per repo naming the keys, and the
  clean-scan summary says what it could not see. The PATs stay read-only and no
  API call is added, so #172's "Actions variables/secrets in the manifest"
  deferral is untouched, and **the exit code is UNCHANGED and commented as such**
  — unverifiable is not drift, so it never files an issue and never fails the
  run. Locked in BOTH directions, because the half that matters is the quiet one:
  with nothing unverifiable both strings must stay byte-identical to today's
  wording (`toBe` on the literal), which is what stops a later refactor quietly
  restoring the overstating text; an unrelated informational kind must not
  trigger the qualification either.

  **#222 part 2 — dropping the `pull_request: edited` trigger, and its residual
  risk.** A skipped required-context caller never invokes its reusable, so NO
  check-run named `<caller job> / <reusable job>` is produced at all; an `edited`
  run therefore WITHDRAWS a context that was already green, and only a new SHA
  restores it — which a finished automated PR never gets. This deliberately
  REVERTS #145 / PR #166, whose documented case is a PR **retargeted onto a
  different base**: that fires `pull_request: edited` and, with no listener, the
  whole required suite silently never re-runs against the new base. **That
  precondition is now MORE likely**, because `delete_branch_on_merge=true` (see
  v0.1.40) makes GitHub auto-retarget dependent PRs, and a base retarget changes
  the effective diff WITHOUT emitting `synchronize` — so `dependabot-auto-merge`'s
  allowlist re-check will not fire for it either. The justification is #222's own
  measurement: the guard fired **twice in four days**, self-heals on any PR that
  gets another push, against **ZERO base retargets in 60 PRs**. #222's
  alternative — push the guard inside each reusable as always-run + early-skip —
  was rejected: it spreads the workaround into 9 reusables for a case that has
  not occurred, and an always-run job still has to emit the context, which is the
  missing thing. **`deploy-preview.yml` is the ONE exception and KEEPS
  `closed`** — its teardown (S3 `rm --recursive` + CloudFront invalidation + bot
  comment) fires only on that action, so the generic diff there would leak every
  closed PR's `pr-N/` prefix forever with no red check; the replacement lint
  asserts `closed` POSITIVELY. `workflow-retarget-edited.test.js` hard-asserted
  the opposite invariant in the REQUIRED `node-unit-lints` lane and is inverted in
  the same commit, keeping its `hasBaseChangeGate` detector self-tests (folded
  block-scalar gate + a negative case) and adding coverage assertions that the
  candidate scan still sees the real callers. Consumer-side halves land with
  their v0.1.76 bump.

  Every new lint was proven **red-first**. Two design notes worth keeping: the
  dogfood lint keys on the `uses:` TARGET, not a `self-<basename>` filename
  convention (`dependabot-rearm-sweep.yml` is correctly dogfooded by
  `self-dependabot-rearm.yml`, which a name rule would false-fail); and the budget
  lint now reads `maxTotalExtendMs` out of the source rather than hardcoding it,
  asserting each loop's worst case still fits its job `timeout-minutes`.
