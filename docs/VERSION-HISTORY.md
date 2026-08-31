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

## Version history (v0.1.0 → v0.1.94)

All are tagged GitHub releases (release via `gh workflow run release.yml -f version=vX.Y.Z`).

**SHIPPED IN v0.1.89 (landed 2026-08-20, unreleased at the time) — the action
pin comment is retired fleet-wide, and a cross-repo composite is now
TAG-pinned.** Deliberately not released *when it landed*: skills
reach consumers through their own `skills.lock`, not the release tag, so no
version bump is needed and cutting one would force the whole atomic edit set
`e2e/examples-site-pins-current.test.js` enforces.

- **Every `uses:` line ends at its ref.** 128 trailing `# vX.Y.Z (date)`
  comments were stripped from this repo's 32 workflows and the
  `post-failure-comment` composite. WHY: the comment goes stale silently and
  then actively lies, and Dependabot's rewriting of it is INCONSISTENT — it
  rewrote a bare `# v5` to `# v7.0.0` in GHA-bench#52 while leaving `# v4` stale
  on the line above in the same file, and left every `# vX.Y.Z (YYYY-MM-DD)`
  untouched in skills-evals #38/#39/#40 while moving their SHAs, so
  `actions/checkout` at v7.0.1 read `# v4.3.1` in one file and `# v6.0.0` in two
  others in one repo. A wrong label is worse than no label, because it is read
  and believed. The SHA is the truth; resolve the version when you need it.
- **The composite version gate was REPLACED, not deleted.** A cms-platform
  composite referenced from another repo was the one shape whose comment was
  machine-checked (it was the pin-consistency gate), which is exactly why it
  could not simply be stripped. It now takes the same TAG form the reusables
  already use — `…/.github/actions/<n>@v0.1.88` — which ties it to
  `platform.lock`'s `platform_ref` directly and is auditable without parsing a
  comment. `check-platform-pin-consistency.js` and `e2e/template-pin-rules.js`
  moved together (they MUST NOT diverge, or the template lint and the consumer
  gate disagree about what a valid pin is), and the checker now reads no
  comments at all — retiring the "one justified regex exception" to the
  parse-don't-scan rule rather than documenting it.
- **The gate was DORMANT when this landed**, which is what made it safe to
  change: no consumer SHA-pins a platform composite today, and this repo's own
  composite refs are local `./…` paths. It is shipped and would re-arm.
- The comment-WRITING machinery (`dependabot-comment-sync.yml`, its self-caller,
  the consumer template, `scripts/sync-action-pin-comments.sh`) was deleted in
  the preceding commit — its matcher treated the comment as OPTIONAL, so one run
  would have rewritten comment-less lines to GROW one and undone the change.

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
  rejected as it forks the workflow set + the parity check). Workflow-only; no
  theme/gem change.

  **Correction (v0.1.83).** This entry used to claim the gate was "unit-tested
  across absent / real-dir / symlink->dir / dangling-symlink / empty-dir (skips
  ONLY on fully-absent)." **No such test ever existed.**
  `e2e/skills-sync.test.js` contained exactly four assertions, every one of them
  about the `.repo-local` carve-out or the drift gate: that the reusable keeps
  `rsync --delete`; that it discovers `.repo-local` markers, builds anchored
  `--exclude=/${name}/` arguments, and never passes `--delete-excluded`; that
  the "already in sync" early-exit tests untracked-aware `git status
  --porcelain` rather than untracked-blind `git diff --quiet`; and that
  `skills/README.md` documents the opt-out. None of them read the `[ ! -e
  "$DEST" ] && [ ! -L "$DEST" ]` line, and no spec anywhere in `e2e/` ever
  mentioned a symlink, an `lstat`, or a dangling link in connection with it —
  the five-case matrix was fabricated. The gate shipped with zero coverage and
  was deleted in v0.1.83; see that entry for why it could not have worked even
  if it had been tested.

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
  committing `.claude/skills/<name>/.repo-local` (the mechanism and its
  `skills/README.md` section were deleted in v0.1.83 — see that entry).
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
  (SUPERSEDED 2026-08-20: comment-sync and the pin-comment convention it served
  were deleted fleet-wide — Dependabot's refresh proved not just incomplete but
  INCONSISTENT, so the label was removed rather than synced. The drift analysis
  below is still the evidence for that decision.)
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

- **v0.1.77** (2026-08-10) — **a verifier that could silently verify LESS than it
  claimed, plus four record corrections.** `check-platform-pin-consistency.js`
  dropped from **96 checks to 61** when it found no canonical `examples/site` set,
  and still printed `Pins are consistent` and exited 0. The 35 it skipped are the
  workflow-SET and workflow-CONTENT parity checks — the ones that police a
  consumer's `secrets:` map, the facet whose absence startup-failed jodidaniel's
  sweep for weeks. That mattered concretely: the v0.1.76 consumer bump was
  delegated to subagents, and even one that HAD run the checker would have been
  falsely reassured. `--require-canonical` makes a missing canonical set a hard
  failure (the `platform-pin-consistency` reusable now passes it), the summary is
  QUALIFIED when parity can't run, and **`scripts/verify-consumer-pins.sh`** is the
  one-command consumer gate whose exit code IS the definition of done.

  Also: the `prod-mutating-loop` lane's REPOSITORY scope written down (it
  serialises the three loops within ONE consumer and cannot serialise two
  consumers — Actions has no cross-repo concurrency, and the group is evaluated in
  the CALLER's repo; adamdaniel.ai run 31179432081 and jodidaniel.com run
  31181497216 overlapped 2026-08-07 and both succeeded, 1 of 4 such overlaps in 4
  days — so do NOT add `${{ github.repository }}`, a no-op that only makes the
  byte-identity lint harder); the graduated cooldown documented (GitHub's own
  default minimum package age is **3 days**, so `default-days: 7` is a raise, not
  a floor from zero; `semver-major-days: 30`; minor/patch left undefined because
  GitHub falls them back to `default-days`; version-updates-only, so an advisory
  still ships immediately); the consumer-cooldown rationale CORRECTED (it claimed
  a cooldown would delay release adoption — adoption is landed by
  `platform-bump.yml`, not Dependabot; the real reason is that neither consumer
  pins a single third-party action); and "delegated mechanical work is done when a
  VERIFIER exits 0" recorded as a standing rule.

- **v0.1.78** (2026-08-10) — **decap-cms `3.12.2 → 3.15.1`, and the 3.14.1 revert
  finally explained.** Retargets #162 (3.14.1 is no longer `latest`) and ships on
  its own so the pin stays revertible alone — `v0.1.66 → v0.1.67` already needed
  that once. Both blocking regressions were re-probed against the real 3.15.1
  bundle rather than assumed:

  **Regression 2 was OURS.** `cms-smoke`'s "New Tag" click that timed out 30 s
  (twice) was attributed to "the adamdaniel built-site shape × 3.14.1". It was
  neither. Decap's EN `collection.collectionTop.newButton` became
  `"＋ %{collectionLabel}"` and 3.15.x sets `newButtonAriaLabel` — "Create entry of
  type %{collectionLabel}" — as `aria-label`, which **wins over text content for
  the accessible name**. So `getByRole("link",{name:/new tag|new entry/i})`
  resolved nothing: the element never moved, only its NAME did. Now single-sourced
  as **`collectionNewLink()`** in `cms-editor-ui.js` (same convention as
  `publishedSwitch`), matched on the collection label plus either verb, with two
  lint-locks — a lives-ONLY-in-the-helper scan and a browser-free assertion that
  the regex matches BOTH era strings. The workflow BOARD's own "New Post"
  (`workflow.workflow.newPost`) is a different string, verified unchanged, and is
  deliberately not flagged. **Lesson: a role+name locator can break with no DOM
  change at all** — an added `aria-label` is invisible to a DOM-shape diff.

  **Regression 1 was fixed UPSTREAM — do not duplicate it.** The precondition was
  to write `pointer-events: none` onto the decorative `SearchIcon` in
  `admin-mobile.css` §7; 3.15.1 ships exactly that, plus `StyledModal`
  `grid-template-rows: 120px auto → auto 1fr` (that fixed 120 px header IS the bug
  §7 works around) and `flex-wrap: wrap; gap: 8px` on
  `RowContainer`/`ButtonsContainer`. §7 stays as belt-and-braces with a note
  saying so, so nobody adds a duplicate rule or deletes the overrides prematurely.

  Verified byte-identical in 3.15.1 (each re-probed, none find-and-replaced): the
  `confirmLoadBackup` call site incl. its `? :` else-branch (#161 shim),
  `role:"switch"` + `aria-checked`, every pinned `editorToolbar` EN string,
  `view_filters` normalization with still NO `default`/`active` flag,
  `previewContext`, the absent `/media` route, `git/trees`/`deleteFiles`, and
  `ListCard` still being an `<li>`. `react`/`react-dom` are `^19.1.0` across the
  whole range including our 3.12.2, so this is not a React major jump. One thing
  DID change shape — 3.15.x moved to React 19's automatic JSX runtime, so Save
  renders as `jsx(...,{...,children},"save-button")` — but nothing matches on that
  markup, so it is a comment fix only. **The ARIA baselines were deliberately NOT
  pre-regenerated:** every pinned string is verified identical, and letting
  `cms-editor-aria-contract.spec.js` run is STRONGER than regenerating, because a
  real drift then fails by name instead of being blessed by `--update-snapshots`.

- **v0.1.79** (2026-08-10) — **the occlusion probe was resolving a
  visually-hidden label, so it was right about an element no user can tap.** The
  decap 3.15.1 bump (v0.1.78) reddened `admin-no-occlusion.spec.js` on
  `webkit-iphone16`, and #162's standing precondition said the fix belonged in
  `admin-mobile.css` §7 (`pointer-events: none` on the decorative `SearchIcon`).
  Both were wrong about the cause. Measured at 393×852:

  ```
  target: span.visuallyHidden-ResponsiveActionButton   box 46,161   1x1
  hit:    svg < span.IconWrapper-visuallyHidden-…      box 47,152  18x18
  ```

  3.15.x made Copy Path / Download **`ResponsiveActionButton`s** — icon-only
  below a breakpoint, the label parked in a `visuallyHidden` 1×1 span with the
  `<svg>` in a **sibling** `IconWrapper`. The spec's `getByText` resolved that
  invisible span, whose centre falls inside its sibling icon; a sibling is
  neither descendant nor ancestor, so `expectReachable` was CORRECT — it was
  reporting a genuinely untappable 1×1 target. Delete and Upload kept
  text-bearing 36 px boxes, which is exactly why only Copy failed and why it read
  as a real layout regression. Fixed in the SPEC (probe `button, label`, verified
  against both bundles), NOT in CSS — and §7 now records this so the next reader
  does not misfile it a third time.

  Upstream had independently shipped `pointer-events: none` on `SearchIcon` and
  `grid-template-rows: 120px auto → auto 1fr` on `StyledModal`; §7 documents both
  as making our overrides belt-and-braces, so nobody duplicates or deletes them.
  **Lesson worth carrying: a role/name/text locator can break with no DOM change
  at all** — an added `aria-label`, or a label moved into a visually-hidden
  sibling, is invisible to a DOM-shape diff, which is what both earlier
  investigations of this were looking at.

- **v0.1.80** (2026-08-12) — **apply-in-CI behind a verified reviewer gate, the
  gate itself made drift-checkable, and two things that told the operator the
  opposite of what the code did.** The largest single release since v0.1.76, and
  the first to put a WRITE credential for repo administration into CI.

  **Apply-in-CI (#172, the first of #109's four deferrals).**
  `repo-settings-apply.yml` moves convergence from a human running `--fix --yes`
  into CI behind a reviewer gate, additively — the audit is untouched and either
  can be disabled alone. Three properties are load-bearing, each a trap rather
  than a preference: (1) TWO jobs, because an environment gate pauses a job
  BEFORE its first step, so a plan printed inside the gated job is invisible at
  approval time and the reviewer would approve an unseen diff; (2) the ungated
  plan job mints `administration:read` and the gated apply `administration:write`
  — `POST /access_tokens` can only NARROW an installation's grant, so the ungated
  job is INCAPABLE of writing rather than trusted not to; (3) naming an
  environment that does not exist does NOT fail — GitHub creates it implicitly
  with NO protection rules — so the apply job asks the API whether
  `required_reviewers` is really present and refuses if not. A GitHub App rather
  than a PAT because the manifest spans two owners and a fine-grained PAT cannot;
  apply runs as a matrix so each leg holds one owner's credential.
  `scripts/mint-app-token.js` is the single mint implementation (pure node +
  stdlib crypto, no marketplace action in a workflow holding an admin
  credential), failing SOFT when un-onboarded and HARD when a credential is
  present but broken — both verified live, the soft path by a real
  variable-vs-secret mix-up that skipped cleanly with a notice instead of
  crashing.

  **Environments became a fourth managed surface, because the gate's own config
  was unaudited.** Remove the required reviewer and nothing noticed — the gate
  silently became decorative. `repo-settings.yml` modelled repo flags, rulesets
  and Actions permissions; environments were not modelled at all.
  `MANAGED_ENVIRONMENT_KEYS` (reviewers / wait_timer / prevent_self_review) now
  are, with a 404 mapped to `{absent:true}` as DRIFT, live `protection_rules`
  projected to the comparable `{type,id}` reviewer shape and sorted so order is
  never drift, and absent rules normalized to GitHub's own defaults.
  `ENV_FIX_FORBIDDEN` is CREATE-ONLY and the asymmetry IS the security property:
  an ABSENT gating environment may be created (the body comes from the manifest,
  so the only reachable outcome is the declared protected state, and bootstrap
  becomes a command rather than a UI click-through), while an EXISTING drifted
  one is never written — an approved apply holds `administration:write` and could
  otherwise strip its own required reviewer, one approval buying permanent
  unattended access. Verified live: the operator's `--fix --yes` created the
  environment and re-audited clean, idempotent on re-run.

  **Two prose-vs-code mismatches, both caught by running the thing rather than
  reading it.** `fetchEnvironments` shipped `catch (e) { throw e; }` beneath a
  comment describing 404 handling it did not implement. And the drift annotation
  said `--fix will not create or write it` for BOTH forbidden states, then
  created the absent one — telling the operator the opposite of what happened and
  sending them to the UI for nothing. Both fixed; the suffix now distinguishes
  the states, and `(w4)` asserts it against the real `describeFinding` rather
  than a copy of its wording.

  **A cosmetic step could block a merge.** Root-caused from adamdaniel.ai#3064:
  `e2e / project (chromium-large-text)` PASSED its tests, failed only on
  "Resolve failure summary on success" — a step that stamps an EXISTING comment
  as resolved — which reddened the job, reddened `e2e / e2e`, blocked
  scheduled-publish seed PR #3063, timed out `waitForMerge` after 25 min, failed
  the scheduled run and filed the issue. A DIAGNOSTIC became the CAUSE. All TEN
  `mode: resolve` call sites were unprotected (the loops' existing
  `continue-on-error` guards BRANCH cleanup, not this), now fail-open with the
  same rationale; `mode: post` deliberately is NOT, since it runs under
  `failure()` and swallowing its error would hide that the report never landed.

  **The theme gemspec's version is deliberately frozen, and now says so.** `spec.version = "0.1.4"` looks 75 releases stale and
  is LOAD-BEARING: bumping it alone would break BOTH consumers' CI at
  `bundle install`. Three verified facts — (1) each consumer's `Gemfile.lock`
  records the version TWICE, in the GIT block's `specs:` and again under
  `CHECKSUMS`, as `cms-platform-theme (0.1.4)`; (2) consumer CI installs in
  bundler DEPLOYMENT/frozen mode, because `ruby/setup-ruby` sets
  `bundle config deployment true` whenever a lockfile exists and both consumers
  commit one — and frozen bundler materializes a git-source spec by
  `[name, VERSION]` and refuses to rewrite the lock, so a disagreement is a hard
  `GemNotFound`, not a re-resolve; (3) `platform-bump.yml` cannot repair it, since
  it rewrites the lock TEXTUALLY (`CUR`→`LATEST` where `CUR` is the v-prefixed
  `platform_ref`, so it can never match a bare `0.1.4`) and runs bundler zero
  times. The RubyGems angle is real but inert — never published (API 404).

  The reason lives in the gemspec itself, not only in a test, because a bare
  frozen constant invites exactly the tidy-up it guards against.
  `e2e/gemspec-version-frozen.test.js` pins the value, the self-explanation, and
  the freeze's PRECONDITION (that platform-bump still cannot re-resolve the lock)
  so the reasoning fails loud rather than rotting into folklore.

  **Proving that lint red-first caught a vacuous assertion in the lint itself:**
  `runScripts` takes raw workflow TEXT and returns `{script, line}` objects, so
  `runScripts(wf).join()` yielded `"[object Object]"` — 15 characters — and BOTH
  shell assertions were passing against it. Same "cannot distinguish *verified*
  from *never looked*" failure this release train fixed in the re-arm sweep, the
  repo-settings audit and the pin checker — this time in the guard written to
  prevent it. It now asserts the extracted shell is non-trivial before matching.

- **v0.1.81** (2026-08-12) — **the theme gem's version reference gets the same
  single-writer treatment the atomic bump already gave everything else (issue
  #242, PR #245).** `platform-bump.yml` already moved every OTHER cms-platform
  reference in one PR (#13); the `bundler` ecosystem's own Dependabot bumps of
  `cms-platform-theme` were the one exception, and they could only ever move
  the `Gemfile`/`Gemfile.lock` half of the gem's version references — either
  redundant once `platform-bump` had already landed the change, or actively
  skewing the tree. `Adam-S-Daniel/adamdaniel.ai` PR #3076 (2026-08-12)
  demonstrated the skew live: a stale Dependabot bundler PR, rebased forward
  without re-resolving its target, proposed **downgrading** the gem
  `v0.1.80` → `v0.1.75`; `platform-pin-consistency`, `admin-bundle-parity`,
  and `dependabot-auto-merge` all caught it independently and it was closed
  unmerged rather than merged and repaired.

  Both consumers' `dependabot.yml`, and the canonical
  `examples/site/.github/dependabot.yml` template, now carry an explicit,
  UNSCOPED `ignore: dependency-name: cms-platform-theme` under `bundler` — an
  `update-types`/`versions`-scoped ignore would not have stopped a plain
  version bump like #3076. **Note the ignore also suppresses *security*
  updates for that dependency**, not only version ones — nothing is lost
  here: `cms-platform-theme` is a first-party git-sourced gem with no
  RubyGems advisory-database entry, and `platform-bump` adopts every release
  cms-platform cuts, security fixes included. Two lints lock it:
  `e2e/dependabot-theme-gem-ignored.test.js` re-checks a consumer's OWN file
  in CONSUMER mode; `e2e/scaffold-seeds-dependabot-ignore.test.js`
  (platform-internal) asserts both the `examples/site` template and the
  scaffolder's generated output carry it, so no new site is born with the
  defect. `select-specs.js` gained rules so a diff touching
  `.github/dependabot.yml` actually selects both. Docs across
  SYNC/ARCHITECTURE/ADMIN-DELIVERY/PIN-CONSISTENCY/READMEs and two skills
  stopped naming Dependabot as the gem's down-sync path.

  Closes #242.

- **v0.1.82** (2026-08-13) — **the same fix for the other half — no
  Dependabot ecosystem bumps a cms-platform reference anymore (issue #244) —
  plus the bump-race sequencing hazard #242's own rollout surfaced (#246).**

  **The `github-actions` ecosystem gets the #242 treatment (#244).** Unlike
  `bundler`'s single Gemfile, `github-actions` treats each workflow FILE's
  `uses:` as its own independent dependency, so Dependabot could only ever
  move the `uses:@<tag>` pins ONE PR AT A TIME — every such PR necessarily
  left the other ~34 references (`platform.lock`, the gem `tag:`, every
  caller's `platform_ref:` input, and every OTHER `uses:@<tag>`) behind,
  exactly the skew `check-platform-pin-consistency.js --require-canonical`
  exists to fail. Verified, not theoretical: **jodidaniel.com #8–#22**
  (2026-06-03/04) produced fifteen separate bump PRs from a single release,
  one per reusable caller, all `0.1.1 → 0.1.3` (Dependabot itself closed two,
  #9 and #21, as redundant once `platform-bump` had already landed the
  change); **adamdaniel.ai #1895–#1898** (2026-06-04) produced four more with
  DIFFERENT from-versions per file in the same batch; **adamdaniel.ai #1900**
  was closed with reasoning that generalizes verbatim: "a piecemeal bump to
  v0.1.6 would now fail the platform-pin-consistency guard." Both consumers'
  `dependabot.yml` and the `examples/site` template now carry an UNSCOPED
  `ignore: dependency-name: "Adam-S-Daniel/cms-platform/*"` under
  `github-actions`, deliberately scoped narrower than a bare `*` so the
  ecosystem stays wired for a genuine third-party action — verified, neither
  consumer pins one today (34 `uses:` in each, all cms-platform; the
  thin-ification, adamdaniel.ai#2007-P7, removed the last third-party
  action). The pattern relies on Dependabot's wildcard matcher
  (`Dependabot::Config::UpdateConfig.wildcard_match?`, in
  `common/lib/dependabot/config/update_config.rb`; `*` → `.*`, crosses `/`) matching
  every `…/.github/workflows/<n>.yml` dependency name with one entry;
  `e2e/dependabot-config-utils.js`'s `wildcardMatches()` re-implements that
  matcher exactly, because it's the one piece of the fix nothing else in CI
  can prove empirically. The same two lints from #242 now cover both
  ignores: `e2e/dependabot-theme-gem-ignored.test.js` and
  `e2e/scaffold-seeds-dependabot-ignore.test.js`, each asserting non-vacuity
  (the tree actually pins cms-platform refs), full wildcard coverage, that
  every covering entry is UNSCOPED, and that no entry accidentally matches a
  third-party action name (`actions/checkout`, `actions/setup-node`,
  `ruby/setup-ruby`, `aws-actions/configure-aws-credentials`) — the last
  check exists specifically to catch a lazy `dependency-name: "*"` that would
  silently disable the whole ecosystem.

  **Closing the ecosystem also closed a silent-failure blind spot in the
  bumper itself.** A Dependabot actions PR was, incidentally, the only
  INDEPENDENT signal that a release existed if `platform-bump.yml` ever
  silently stopped — `scheduled-run-health.yml` alerts on a FAILING scheduled
  run, not one that succeeds-and-no-ops. The release lookup had exactly that
  hole:

  ```bash
  LATEST=$(gh release view --repo "$PLATFORM" --json tagName -q .tagName 2>/dev/null || echo "")
  [ -n "$LATEST" ] || { echo "no release on $PLATFORM yet"; exit 0; }
  ```

  which folded an expired/insufficiently-granted `CMS_PLATFORM_PAT`, a
  revoked cross-repo grant, and a GitHub API outage into the same green
  `exit 0` as the one genuinely benign case. The lookup now uses
  `gh api repos/<repo>/releases/latest`: a 404 means "no published release"
  and nothing else — cms-platform is a PUBLIC repo, so a 404 can never mean
  "you lack access" — and is the only case treated as the benign `exit 0`;
  every other failure is `::error::` + `exit 1`, surfaced by
  `scheduled-run-health.yml` like any other scheduled failure. Only the HTTP
  status code is echoed on failure, never the response body. Locked by a new
  test in `e2e/platform-bump-atomic.test.js`.

  **A bump PR cut in the same minute as another `main` merge can carry a
  stale tree (#246).** `platform-bump` branches off `main` at the moment it
  runs; dispatching it seconds after a release while another PR is mid-merge
  cuts the bump branch from the PRE-merge tree. Observed live at v0.1.81:
  both consumers' `platform/bump-v0.1.81` branches were cut ~17s after the
  release and moments before the #242 `dependabot.yml` change merged, so they
  would have run v0.1.81's new `dependabot-theme-gem-ignored.test.js` against
  a config that did not yet carry the ignore that lint asserts. Not a
  `platform-bump` bug — a branch cut at time T legitimately contains `main`
  at time T — but a sequencing hazard, recorded where the sequencing decision
  is made: let every other `main` merge settle before dispatching
  `platform-bump`, or, if a bump PR is already open and stale, regenerate it
  (deterministic: reapply the same `CUR`→`LATEST` / `OLD_SHA`→`NEW_SHA`
  replace on top of current `main`, confirm with
  `scripts/verify-consumer-pins.sh`, then force-push the bump branch) rather
  than fighting an `update-branch` conflict. See `docs/PIN-CONSISTENCY.md`'s
  platform-bump section and the `platform-release-and-bump` skill step 2b.

  Closes #244. Refs #242, #246.

- **v0.1.83** (2026-08-14) — **skills stop being a file transport and become a
  published bundle; the sync workflow, its drift guard, and their tests are
  deleted.** `skills/` remains the canonical home of every platform skill and
  authoring is unchanged — what goes away is the machinery that copied that
  directory into a consumer and then policed the copy.

  **Deleted:** `.github/workflows/skills-sync.yml`,
  `.github/workflows/platform-drift-guard.yml`, both of their `examples/site`
  thin callers, and `e2e/skills-sync.test.js`. The issue #83
  destination-presence gate and the v0.1.63 `.repo-local` carve-out go with
  them — both were properties of the transport, and there is no transport left
  to opt out of.

  **Replaced by a federated bundle.** The repo now carries a bundle manifest
  (`.claude-plugin/plugin.json`, plus a root `plugin.json`) so the
  `agentskills` marketplace can resolve `cms-platform` **straight from this
  repo** rather than mirroring a copy of it. A durable machine installs it once
  (`/plugin install cms-platform@agentskills`) and invokes the skills namespaced
  as `/cms-platform:<skill>`. On an ephemeral surface — a cloud session, a CI
  runner — that install does not persist, so the channel is the registry's
  `skills-bootstrap` SessionStart hook, which installs against a pinned,
  per-skill-hashed `skills.lock` because fetching instruction text at session
  start is a supply-chain surface. That lock is a **per-consuming-repo**
  artifact, not a registry-wide one: a repo gets this bundle only once its own
  `skills.lock` declares `cms-platform` as a source, pinned to a commit with
  per-skill digests. The registry's own `skills.lock` deliberately stays
  `adam`-only and will not carry these skills. As of this release the
  marketplace entry is the part that exists — **no consuming repo has declared
  the source yet**, so the hook path is available rather than in use. Nothing is
  rsynced into a consumer and no consumer vendors a copy, so there is no second
  copy to drift.

  **The `skills-sync` transport never reached every consumer anyway.** The
  literal "copies into every consumer's `.claude/skills/`" in the root README
  and "synced to every consumer via skills-sync" in the `cms-platform-secrets`
  skill — and the same universal framing in `docs/SYNC.md`'s and
  `docs/ARCHITECTURE.md`'s per-layer tables — were already false when written:
  jodidaniel.com is a consumer, ships the `skills-sync.yml` caller to this day,
  and has never had a `.claude/skills` directory at all. Those sentences are
  corrected in this release rather than carried forward.

  **What `platform-drift-guard` actually did.** Contemporary prose said it
  *enforced* byte-parity between a consumer's `.claude/skills/` and the
  platform. It did not, on three counts: it was **never a required check** (the
  `consumer-main` ruleset requires `editorial / validate-content`, `scan /
  scan`, `parity / parity`, `preview-media / preview-media`, `e2e / e2e`, and
  `visual-regression / approve-regression` — the guard is not among them), so a
  red run never blocked a merge; it walked `find "$p" -type f` over files
  **present in the site**, so a platform-owned skill *deleted* from a consumer
  was invisible to it; and its per-path loop opened with `[ -d "$p" ] || [ -f
  "$p" ] || continue`, so an absent `.claude/skills` produced "No platform
  drift." and a green exit. No drift was ever observed — but the strongest
  thing the tree supports is a point-in-time observation, not a lifetime
  claim: the one consumer that ever had a mirror (adamdaniel.ai) was
  byte-identical at the time of removal. That is **observed zero, not enforced
  zero**, and the distinction is the reason removing the guard costs nothing.

  **Why the #83 gate is a deletion and not a repair — it could never achieve
  its stated goal.** Its comment says it exists so a consumer "can drop its
  mirror durably," but the gate keys on `.claude/skills` **existing** (`[ ! -e
  "$DEST" ] && [ ! -L "$DEST" ]` → skip), while the `.repo-local` carve-out
  requires a site-owned skill to live at `.claude/skills/<name>/.repo-local` —
  inside that very path. So the state "this site owns skills of its own but
  wants none of the platform's" is **unrepresentable by construction**: owning
  a site-local skill makes `$DEST` exist, which disarms the gate, which
  re-installs the whole platform set on the next run. The two features were
  mutually exclusive on the same directory. That is a design contradiction, not
  an oversight or a bug with a patch, which is why nothing here tries to fix
  the gate. (It was also, per the v0.1.45 correction above, entirely untested —
  the five-case coverage matrix that entry advertised was fabricated.)

  **Skill-content fixes carried in the same release.** `skills/workflow-path-audit`
  is **deleted** — the `adam` bundle ships the same skill, and a consumer with
  both installed would see two `workflow-path-audit` entries competing to
  trigger. `skills/cms-platform-secrets/SKILL.md` carried its whole
  `description:` on one unquoted line — 1079 characters, past the 1024-char
  limit, and **not valid YAML at all**: the embedded `"Input required and not
  supplied: github-token"` puts a colon-space inside a plain scalar, so
  `yaml.safe_load` on that frontmatter raises `mapping values are not allowed
  here`. It is now a `>-` block scalar at 1006 characters, which parses, and
  which no longer closes on the false "synced to every consumer via
  skills-sync". Finally, several skills quoted their payload paths as if the
  scripts sat beside the skill (`ruby scripts/render-decap-config.rb`, `node
  scripts/audit-editorial-labels.js`) — true under the old mirror, where the
  skill and the scripts shared one repo, but false for a bundle-installed
  skill, which lands in `~/.claude/skills` with no platform checkout anywhere
  near it. Those are now repo-relative (`cms-platform/scripts/…`) with a note
  naming what they are relative to.

  **Consumers must delete both callers in the SAME commit as the
  `platform_ref` bump.** `check-platform-pin-consistency.js` compares a
  consumer's `.github/workflows/*.yml` basenames against the canonical set read
  from `examples/site/.github/workflows/` **at the pinned ref**, and reports
  both directions. Split the change across two commits and exactly one side
  goes red: delete the callers first and the still-pinned old ref reports
  `workflow-set: MISSING (platform-dictated)`; bump `platform_ref` first and
  the new canonical set — which no longer contains either file — reports
  `workflow-set: EXTRA (not platform-dictated)`. At the time, the automated
  `platform-bump` PR **could not do this for you**: it seeded a wholly-missing
  dictated caller but never deleted a de-dictated one, so the v0.1.83 bump PR
  arrived carrying both stale callers and failed parity until the two deletions
  were hand-added to it. **That is fixed (#315)** — `platform-bump` now retires a
  caller that left the canonical set in the same commit as the pin, deciding
  "was it ever dictated?" from the canonical set at the OLD ref so a
  site-authored workflow is never touched. The constraint above still holds and
  is the reason the deletion rides the bump commit rather than a follow-up PR.

- **v0.1.84** (2026-08-17) — **three defects a green CI run could not tell
  apart from health: a command injection reachable from a `cms/*` branch ref
  (#259), a gitleaks allowlist that silently left whole files unscanned
  (#260), and an audit that closed its own alert about a dead cron (#258).**
  These are the **first consumer-facing changes since v0.1.83** — both sites
  still pin that tag, so none of it reaches them until this release exists.

  **Command injection from a `cms/*` ref into the preview deploy (#259).**
  `scripts/cms-preview-slug.sh` derived the preview slug from the PR head ref
  with **no charset filter**, and `deploy-preview.yml` embedded that output
  inside single quotes at four `run:` sites. The runner expands `${{ }}` into
  the command TEXT before bash parses it, so single quotes stop `$( )` but not
  a `'`: head ref `cms/a/'$(id)'` produced slug `a-'$(id)'`, which rendered as
  `SLUG='a-'$(id)''` and executed `id` — in the deploy AND the teardown job,
  both of which by then hold the live OIDC deploy role. Reachability was nil
  *today* — the trigger is `pull_request`, not `pull_request_target`, so it
  needs base-repo write, and every current writer is an admin who could already
  run code by editing the workflow — and stops being nil the moment a
  write-but-not-admin collaborator exists, which is the CMS's design intent,
  since Decap editors push exactly these `cms/*` refs. **Both halves are fixed
  so neither stands alone:** the script folds anything outside `[a-z0-9-]` to a
  hyphen, collapses runs and trims the ends — the charset its own header and
  the CloudFront router (`/^[a-z0-9-]+$/`) already declared but never enforced
  — applied BEFORE the 51-char bound so the overflow hash stays deterministic;
  and all six consumers of the slug now bind it through an `env: CMS_SLUG`
  passthrough, matching how this workflow already handles `HEAD_REF`, so the
  runner never rewrites the command text. A ref that folds away entirely yields
  the empty string, which callers already gate on, so it skips the alias rather
  than publishing a bare `cms-/` prefix. Slug output changes **only** for a ref
  carrying an out-of-charset byte, and for those it repairs a **latent silent
  404**: DNS lowercases the Host, so the router rewrote a mixed-case ref to a
  lowercased S3 prefix while the sync had written a case-preserved one, and S3
  keys are case-sensitive — those aliases never resolved at all. New lints in
  `e2e/deploy-preview-cms-slug.test.js` assert that no `run:` body interpolates
  the slug expression and that all six consumers bind it via `env:`, parsed off
  the real YAML so an aliased value cannot hide.

  **A `paths` entry in a gitleaks allowlist is a blind spot, not a filter
  (#260).** gitleaks skips a `paths`-matched file **entirely, before any rule
  runs** — and nothing in CI could tell that apart from a clean scan, which is
  what made it survivable. Two behaviours kept it invisible: unknown TOML keys
  are silently ignored, so an attempt to narrow such an entry (`condition =
  "AND"`) loads cleanly and changes nothing, and `regexTarget = "secret"`
  narrows nothing either because it names the allowlist's *default* target.
  `secrets-scan.yml` gains an **"Allowlist canary"** step: it plants a freshly
  generated, detectable `ghp_`-shaped credential at every path the caller's
  allowlist covers, scans that tree with the caller's own config, and requires
  every plant back as a finding — a plant the config cannot see is a file a
  real secret could hide in. The comparison is **differential** against a bare
  `useDefault` config so gitleaks' own upstream exclusions are not misread as
  the caller's blind spot, and both scans pass `--config` explicitly, because
  gitleaks auto-loads `.gitleaks.toml` from the scan TARGET and a "no config"
  control would silently load the config under test. It fails **soft** for a
  caller with no allowlist or an unparseable one, and a `paths` entry matching
  no tracked file (both consumers today) stays green until a matching file
  appears. This repo's own three `paths` entries are **deleted**, because the
  canary fails on them: measured at gitleaks 8.30.1 they removed 29,326 bytes —
  four files — from every scan of a public repo while suppressing nothing (with
  the default ruleset and no `paths` at all those files produce zero findings;
  the `regexes` block already covers every fixture shape in them). The
  scaffolder copies this config verbatim, so new sites stop inheriting the
  latent entries too. **Correction carried in the same release:** the original
  commit and three comments called `regexTarget = "secret"` *invalid*; measured
  on the pinned 8.30.1 it is **accepted** (gitleaks validates the key — `zzzz`
  is fatal — but special-cases `secret` while its own error text lists only
  `match`/`line`). Only the word "invalid" was wrong; every consequence built on
  it is unchanged and still measured.

  **The scheduled-run audit scored a dead cron as healthy and closed its own
  alert (#258).** `scripts/audit-scheduled-runs.js` sourced its finding set
  entirely from runs that EXIST, so a workflow **GitHub auto-disabled for
  inactivity** was invisible to it: such a workflow emits no runs,
  `filterAlertRuns([])` is `[]`, and that is byte-identical to a repo with no
  schedules at all. The `failures.length === 0` branch then printed "All
  scheduled workflows healthy" and — if a tracking issue was open — posted a
  "clean window" comment and **closed it**. A repo whose crons went dark
  mid-incident had its own alert actively reaped. The fix widens the input set
  rather than the lifecycle: `GET /actions/workflows` exposes `state`, and dead
  cron-bearing workflows now flow through the same open/comment/close tracking
  issue as failing runs, with their own hidden dedupe block so a corpse is
  reported once rather than daily. Three properties keep the bug from
  re-growing: **public repos only** (the 60-day auto-disable rule applies
  there; a private repo's disabled cron is off by intent, and both visibility
  predicates demand a strict boolean so an ambiguous answer is neither); an
  **UNKNOWN probe answer is never "no findings"** — it suppresses the auto-close
  and reds the run, which is the existing "red means the alerting layer needs a
  human" contract; and scoping asks the API "did this ever fire on a cron?"
  rather than parsing the workflow file, since the reusable sparse-checks-out
  only this script and the runtime has no YAML parser. The nine tests that
  landed with the fix all exercised pure helpers — **a mutant reverting the two
  lifecycle conditions shipped green**, reintroducing the bug in #258's own
  title — so `e2e/scheduled-run-health.test.js` now drives the real CLI end to
  end through a `gh` stub on PATH and asserts the one argv that must never
  appear on either path (`-X PATCH -f state=closed`).

  Closes #258, #259, #260.

- **v0.1.85** (2026-08-17) — **five-item follow-up sweep from #261, all adversarially verified.**
  - **Gitleaks canary compared per FILE, so a rule-scoped allowlist hid (#264).** A config blinding
    `github-pat` at the control path still saw the file reported by `generic-api-key`, so the canary
    printed OK and exited 0 over a live blind spot. Now compares `(file, RuleID)` PAIRS. An
    unreachable `elif None in scopes` origin arm was deleted (proven unreachable by fixture, not
    merely untested), and the previously-unasserted `"an entry in .gitleaks.toml"` fallback gained a
    test — poisoning that string had left all 23 cases green. Suite 23 → 24. Two comments claiming
    "four shapes" now say "several … among them": per-rule `stopwords`, per-rule `regexes` +
    `regexTarget = "match"`, and `[extend] disabledRules` were each measured to reach the same
    fallback.
  - **Workflow injection lint matched expression TEXT (#265).** Five adversarial rounds, each
    closing an evasion the previous round's author believed closed — only the cms slug was linted
    and `with.script` was unscanned; then a `${{ }}` split across lines; then index syntax
    `github['event'][…]` plus case-insensitivity; then `}}` inside a quoted literal ending the span
    early; and finally the lint's OWN recommended `env:` remediation read back as an expression
    (`env: BASE: ${{ github.event…base.ref }}` + `run: "${{ env.BASE }}"` passed both gates at exit
    0 with the injection intact, while the header asserted that an `env:` binding "removes the `${{
    }}` from the body entirely" — false whenever the body reads it back). actionlint is no backstop:
    a field on its own untrusted list goes from exit 1 to silent across one `env:` hop. The boundary
    is now general by construction (the reference lexer's token-start charset admits exactly one
    construct that opens a data region; property-tested over 43,054 generated bodies across two
    seeds, 0 under-flags). The root set remains an approximation and now says so — see "WHERE THE
    GUARANTEE ENDS" in `docs/CI-INVARIANTS.md`.
  - **`#258`'s dead-cron detector could be defeated by run-record retention (#263).** The scoping
    probe read RUNS, and an empty runs list is byte-identical to "never had a schedule", so a
    finding silently drops out once records age. `state == disabled_inactivity` is self-evidencing
    and now short-circuits the probe. Two filing premises were refuted and are not repeated: run
    records do NOT age out at 90 days (531 schedule-event records older than that on adamdaniel.ai),
    and "widen the `created:` window" was vacuous (the probe carries no such bound). A collateral
    casualty was fixed too — `scheduled-run-health.test.js:455` had begun passing with zero probe
    calls, silently no longer testing what it names.
  - **Both consumers carried latent `.gitleaks.toml` `paths` entries** (adamdaniel.ai#3161,
    jodidaniel.com#136): whole-file allowlist entries that would blind every rule if those paths
    were ever recreated. Removed; the load-bearing `regexes` blocks kept.
  - **Scaffolded sites were born failing the authoritative pin gate (#266).** The cause was NOT the
    template's stale pins — `create-site.js` rewrites refs on copy, so a new site always got one
    version — but the static `GEMFILE` constant carrying no `tag:`. Fixed at the source; the
    template pinned; `examples/site` added to actionlint, which had never linted those 32 workflows
    at all. The anti-rot guard now RUNS the consumer gate's own rule rather than a lookalike:
    `scripts/stale-platform-refs.js` is `verify-consumer-pins.sh`'s awk extracted verbatim and
    `require`d by both, with a 12-shape agreement table asserting the guard's verdict and the shell
    gate's exit code together. **This makes the 54 template refs and `PLATFORM_VERSION` part of the
    atomic release-PR edit set**, enforced by a required lane; `release.yml`'s error string and
    AGENTS.md's release paragraph — the only two enumerations of that set — now name them.

  Closes #263, #264, #265, #266.

- **v0.1.86** (2026-08-19) — **the scheduled-run health audit widens to
  cover silent default-branch PUSH failures too (#279).** `audit-scheduled-runs.js`
  watched only `event=schedule`; a `push`-to-default-branch failure is exactly
  as silent (no PR to go red on, no notification). Live incident, 2026-08: a
  `.gitleaks.toml` change on adamdaniel.ai passed its PR check (the PR lane
  scans `base..head`) but broke `secrets-scan.yml`'s `push`-to-`main` run (the
  push lane scans full history) for **8 CONSECUTIVE pushes** — each one a
  blocked Decap editorial publish — with no tracking issue ever filed. The
  fix generalizes rather than duplicates: `isAlertRun`/`filterAlertRuns` take
  an `event` parameter (default `"schedule"`, so every existing call site
  stays byte-identical); the runs paginator factors into `listRunsForEvent`,
  with `listPushRuns` calling it as `event=push&branch=<default_branch>`; the
  default branch is read off the SAME `getRepoMeta` call the dead-workflow
  probe already makes (zero new API calls, never hardcoded `main`); and
  `partitionStarvedRuns`/runner-starvation suppression apply unchanged, since
  neither references `run.event`. The two lanes render as **separate**
  sections — `secrets-scan.yml` fires on both events, and a merged list would
  bury exactly the signal the incident needed ("scheduled green, push on
  fire") — but dedupe through the SAME hidden run-ids channel (a push run has
  a real run id, unlike a dead workflow, so no second hidden block is
  needed) and share ONE close-gate: the tracking issue does not close until
  scheduled runs, push runs, AND dead workflows are all clean. A repo-metadata
  probe failure now marks the push lane (not only the dead-workflow lane)
  UNKNOWN rather than clean, per the same #258 principle — an answer the audit
  could not verify must never read as health. The reusable's new `push_scan`
  input defaults to **true**, deliberately: an opt-in-off flag would leave
  exactly the busy, bot-automated repos that need this uncovered until someone
  remembered to flip it. `e2e/scheduled-run-health.test.js` gained pure-helper
  coverage for the `event` parameter and the push endpoint shape, plus — in
  the same style as the #258 regression guards — `main()`-lifecycle tests
  driven through the `gh` stub: a live push-lane failure must not close the
  issue, both lanes clean closes it, a repo-metadata probe failure skips the
  push lane without attempting it, and a push run once reported is never
  re-reported. The close-gate change was verified with a negative control:
  reverting it to the old two-term form reproduces the bug (the stub log
  shows an attempted `-X PATCH -f state=closed` with a live push failure
  still outstanding) before the fix, and shows none after.

  Closes #279.

- **v0.1.87** (2026-08-20) — **a required status context may no longer sit
  inside a `concurrency` group, on the platform or on a consumer (#285).** A
  cancelled required check answers `405 Required status check "<ctx>" is
  cancelled` and nothing overrides it — not native auto-merge, not an explicit
  merge call, not a nudge bot. AGENTS.md states the rule categorically and then
  offers an operative carve-out ("jobs triggered only by `push`/`synchronize`
  are safe to cancel"); v0.1.87 implements the CATEGORICAL form, because the
  carve-out is false in both of its halves.

  ITS PREMISE IS FALSE. `opened` and `synchronize` DO share a head sha.
  Measured on adamdaniel.ai PR #3006, 2026-08-09: opened `01:57:10Z`,
  `head_ref_force_pushed` `01:57:38Z`, and visual-regression runs
  `31289327061` (cancelled) and `31289327099` (skipped) BOTH created
  `01:57:41Z` carrying `head_sha 68d7c777` — webhook latency dispatches the
  `opened` run after the force-push has already moved the head. jodidaniel.com
  has the twin at `01:58:49Z` on `bf49581a`. On that occasion the required
  context concluded `success` and the cancelled check-run was the non-required
  `visual-regression / generate`: a near-miss, not an outage, which is exactly
  the non-determinism the rule exists to remove. Neither type can be dropped —
  without them the required check never reports at all.

  IT COULD NOT TRAVEL. `concurrency` lives in the platform reusable, which a
  `platform_ref` bump carries to both consumers. `pull_request.types` lives in
  the consumer CALLER, which nothing propagates: `platform-bump.yml` seeds only
  a wholly-MISSING caller (its own comment says so) and
  `check-platform-pin-consistency.js`'s `structuralShape()` deliberately
  excludes `on:`. A template-only trigger change reaches neither live site,
  ever, while a lint reading `examples/site/` reports green forever.

  THREE OFFENDERS, not the two first identified: `secrets-scan.yml`
  (`scan / scan`), `visual-regression.yml`
  (`visual-regression / approve-regression`), and `self-ci.yml` — THIS repo's
  own merge gate, whose four jobs are platform-main's four required contexts
  and which carried `cancel-in-progress: true`. `repo-settings-pat-verify.yml`
  keeps its group: its dynamic job name skeletonises to
  `/^verify [\s\S]* PAT$/` and cannot be any required context. `reopened` is
  restored everywhere the previous attempt narrowed it — its only
  justification was the group now gone.

  THE GUARD, and why it is SMALLER than the attempt it replaces. Deleting the
  exemption deleted its machinery and three defects with it: `SHA_REPEATING_EVENTS`
  was ALLOW-by-default (`issue_comment`, `workflow_run`, `merge_group`,
  `check_suite`, `check_run:rerequested`, `status`, `label`,
  `deployment_status` and tag `push` all returned zero offenders);
  `SHA_DISTINCT_PR_TYPES` blessed the wedge shape above; and the run-sentinel
  was substring-matched into the resolved key, so a literal `deploy-<run-id>-lane`
  — static text, always colliding — earned the exemption. Detection now keys on
  PRESENCE of a `concurrency` key: there is no value left to forge.

  IT IS SPLIT IN TWO ON PURPOSE. `required-context-concurrency.test.js`
  (renamed `required-context-cancellable.test.js` in #289, when the guard was
  renamed after the OUTCOME it forbids rather than one cause of it) is
  registered in `PLATFORM_META_SPECS` and gates the required `node-unit-lints`
  lane against the WORKING TREE — a pre-release gate. Registration is precisely
  what `testIgnore`s a spec on consumer lanes, i.e. on the repos where #285
  actually wedges PRs, so `consumer-required-context-concurrency.test.js`
  (likewise `consumer-required-context-cancellable.test.js` since #289) is
  deliberately UNregistered and reads the site's own callers, its pinned
  `.cms-platform/` reusables and that checkout's `repo-settings.yml`. Shared
  matching lives in a plain helper module so neither spec inherits the other's
  platform-internal signal. Run against adamdaniel.ai's live callers paired with
  the pre-fix reusables, the consumer spec exits 1 naming both real offenders.

  TWO BYPASSES adversarial review found in the rewrite, both unit-locked. An
  unresolvable `uses:` passed GREEN via three composing defects — a
  case-sensitive owner regex (lowercasing the owner, which GitHub resolves
  identically, flipped a real offender from `1 failed` to `15 passed`),
  caller-side declarations discarded before they were reported, and a
  per-context resolution counter masked by a sibling publisher (`e2e / e2e` has
  two, so one going unreadable was invisible). And a `concurrency:` arriving
  through a YAML MERGE KEY was invisible: `yaml` v2 leaves `<<` as a literal
  key, so a merged job's own keys are `['<<','uses']`. Fixed at the shared
  `workflow-yaml-utils.js` seam rather than per-spec, because that blind spot
  sat under EVERY workflow lint here; a measured no-op today (no merge key
  exists in this repo or either consumer).

  ALSO IN THIS RELEASE, three silent-detection fixes. `audit-scheduled-runs.js`'s
  `renderFindings()` hardcoded the scheduled-lane noun while serving both lanes,
  so the #279 push lane rendered "N failing SCHEDULED run(s)" under a heading
  saying PUSH — found by running that lane against real data for the first time
  (run `32320712148`). The `cms-automerge-nudge` template passed five of
  `consumer-main`'s six required contexts, short `e2e / e2e`, so a freshly
  scaffolded site inherited the jodidaniel.com#156 defect. And
  `platform-meta-spec-registry.test.js` extracted `PLATFORM_META_SPECS` by
  REGEX over the array body, so a quoted spec name inside a comment counted as a
  registration — now acorn, matching the sibling that always did it correctly.
  Under the old form the new test fails AND the "every platform-internal spec is
  registered" test spuriously PASSES, so it could mask a real gap, not merely
  false-fail.

  SCOPE LIMIT, recorded in both specs: `repo-settings.yml`'s third ruleset
  `cms-feature-branches` (bare `validate-content`, active on both consumers) is
  not scanned. Adding it naively would MISFIRE — no caller job is named
  `validate-content`, since callers publish the two-part
  `editorial / validate-content` — and there is no live exposure: the underlying
  job is covered via `consumer-main` and declares no group.

- **v0.1.88** — **the invariant becomes the OUTCOME: no required
  status context may end `cancelled` (#289).** v0.1.87 removed every `concurrency`
  group from every required-context publisher and closed the route THOSE had. Four
  days later the next route surfaced, and it had already fired: a job also ends
  `cancelled` when it hits `timeout-minutes`, and two required-context reusables
  carried one. Measured on live PRs — adamdaniel.ai#3217
  `preview-media / preview-media` cancelled at 30m20s and `parity / parity` at
  30m26s, adamdaniel.ai#3202 `parity / parity` at 30m16s — all three on the
  30-minute wall with no `concurrency` group anywhere near them, and both PRs still
  unmerged. Scoped honestly: neither PR is "all-green but unmergeable" (both also
  carry a real `e2e / e2e` failure), so what is demonstrated is the MECHANISM, not
  yet a wedge with everything else green.

  A GitHub quirk sharpens it: a job killed by `timeout-minutes` reports `cancelled`,
  NOT `timed_out`. `timed_out` is already in the health audit's `BAD_CONCLUSIONS` —
  had the API used it here, the audit would have caught this.

  WHY ALL THREE DETECTION LAYERS WERE BLIND, and each defensibly. The v0.1.87 lint
  keys on the PRESENCE of a `concurrency` key; there is none here, so it correctly
  reported clean — it enforced what it said, and what it said was one cause.
  `audit-scheduled-runs.js` excludes `cancelled` NECESSARILY, because the
  runner-starvation carve-out is itself a cancelled shape. And the push lane is
  scoped to the default branch on the recorded rationale that "a push to a feature
  branch already has a human watching it via the PR" — the exact assumption that
  fails when the check never goes red.

  THE FIX. `parity` and `preview-media` are split the way `e2e` and
  `visual-regression` ALREADY do it: a WORK job keeps the 30-minute wall under a name
  no ruleset requires (`parity / parity-probe`, `preview-media / media-probe`), plus
  a GATE job that keeps the required name, carries `needs:` + `if: always()` and NO
  `timeout-minutes`, and exits non-zero unless the probe succeeded. A wall-killed
  probe now concludes `cancelled` on a context nobody requires and the required
  context goes RED. The wall is neither raised nor deleted — a bigger number keeps
  the failure mode, and no number makes a runaway job bounded — and both properties
  are locked positively so a later edit cannot quietly drop the probe's timeout. The
  fix lives entirely in the platform reusables, which is what lets it travel: a
  `platform_ref` bump carries it to both consumers, and `structuralShape()` compares
  the caller's `permissions` + `jobs.*`, so there is no consumer-side parity churn.

  THE GUARDS ARE RENAMED `required-context-concurrency*` ->
  `required-context-cancellable*`. Naming a guard after one CAUSE is precisely what
  let the second cause ship underneath it four days after #285 closed the first. The
  shared matcher now reports four structural causes rather than one: a `concurrency`
  declaration at any of the four sites; a `timeout-minutes` on a publisher without
  the translating shape; `strategy.fail-fast` not explicitly false on a matrix
  publisher; and a publisher with `needs:` whose `if:` never says `always()` — that
  last being the TWIN defect a careless version of this very fix would introduce,
  where the gate SKIPS instead of reddening. The third has no live instance and the
  header says so rather than implying coverage. Both registry facts survive the
  rename and are asserted: the platform spec registered in `PLATFORM_META_SPECS`,
  the CONSUMER sibling deliberately not.

  DELIBERATELY NOT DONE, with the reasoning recorded at `BAD_CONCLUSIONS`: no
  `cancelled` detector was added to the health audit. Admitting it at run level would
  void the runner-starvation carve-out, and it is the wrong lane regardless — a
  wedged required context is an `event=pull_request` run that neither the schedule
  nor the push query returns. A precise detector is a THIRD lane over open PRs' check
  rollups, separating a cancelled run superseded by a later push (routine) from one
  still on the PR's CURRENT head sha with no successful sibling for that context (the
  wedge). That has its own evidence and its own false-positive tuning; the split
  above prevents the cause, a detector would report the symptom.

  Also: `verify-consumer-pins.sh` advertised 96 checks while running 90 — the number
  is REMOVED rather than corrected, since a count in prose drifts again — and its
  `--help` range was truncating mid-sentence.

- **v0.1.89** — **a public-site link crawler, and prereleases that a consumer's
  default branch will refuse (#308, #309).** Both halves come out of
  jodidaniel.com PR #176, where every one of the home page's 16 media links 404'd
  on the preview deploy while every CI lane stayed green.

  NOTHING CRAWLED THE PUBLIC PAGES. `e2e/cms-link-crawler.spec.js` walks `/admin`
  only, over the five base collections — so a site could ship a section whose
  every link 404s and CI never noticed. `e2e/site-link-crawler.spec.js` closes
  it: it walks every built HTML page under `_site` (admin excluded, it has its
  own crawler), harvests each `<a href>` pointing back at the site, and asserts
  the target exists in the build. Pure-fs — no browser, no server — and
  `SITE_ROOT`-aware, so it runs on consumers. It reports EVERY broken link rather
  than the first, because one root cause takes out a whole section at once.
  Verified against the real regression: with jodidaniel's media collection back
  at `output: false` it reports 18 broken links; with the fix, 2.

  THOSE REMAINING 2 WERE A PLATFORM BUG the new crawler found on its first run.
  `theme/_includes/header.html` linked `/blog/` unconditionally, so a consumer
  with no blog served a dead "Blog" link on every default-layout page — live at
  the time on jodidaniel.com's 404 page and its `/preview/` shell. The nav entry
  is now conditional on the `/blog/` page actually existing, which is the precise
  signal: an empty-but-real blog index keeps its nav, a site that never had one
  stops advertising it.

  RELEASES CAN NOW BE CUT AS PRERELEASES, so a platform fix is validated on ONE
  consumer PR before it fans out to prod. `release.yml` gains a `prerelease`
  input: it requires a `vX.Y.Z-<suffix>` version, passes `--prerelease`, skips the
  plugin-manifest version guard (which locks the manifests to a RELEASE tag — a
  prerelease precedes that bump by design), and skips the consumer fan-out
  dispatch. GitHub keeps a prerelease off `repos/<repo>/releases/latest`, the only
  thing `platform-bump` resolves, so no consumer can drift onto one; the fan-out
  is skipped anyway rather than leaning on that downstream detail.

  AND THE DEFAULT BRANCH NOW REFUSES ONE. Nothing stopped an RC pin riding into
  the consumer's default branch afterwards — the branch `deploy-production` builds
  from — and a merge was one click. `scripts/assert-release-pin.js` reads the
  consumer's `platform.lock` and exits 1 when `platform_ref` is a prerelease, 0
  when it is not, and 2 when it could not evaluate its input at all: three-valued,
  so a guard that cannot read `platform.lock` never looks like a pass. A sha or
  branch `platform_ref` is deliberately out of scope — also not releases, but not
  what this guards, and failing them would change the failure mode for setups
  nobody audited.

  IT RUNS FROM ITS OWN REUSABLE + `examples/site` CALLER rather than as a job on
  `platform-pin-consistency.yml`, for two reasons that both end in a broken repo.
  (1) That caller carries a site-tuned `paths-ignore` on adamdaniel.ai, and a
  REQUIRED context whose workflow is skipped emits no check run — branch
  protection then hangs forever on "Waiting for status to be reported". (2) The
  standard remedy for (1), a mirroring stub as `e2e-stub.yml` does for
  `e2e / e2e`, is WRONG here: a stub emits a synthetic success, so a content-only
  PR on a branch already pinned to an RC would collect that pass and stay
  mergeable. The pin does not have to change in the PR for the pin to be wrong. So
  this lane carries no path filter and always reports — it can afford to, it reads
  one key out of one file — and `branches: [main]` on the caller is what scopes
  it, leaving an RC pinnable everywhere else, which is the entire point of cutting
  one.

  `repo-settings.yml` adds `prerelease-guard / prerelease-guard` to the
  `consumer-main` ruleset's required checks. Required, not merely red: red does not
  stop a merge, and stopping the merge is the whole ask. That obliged two edits the
  repo's own locks caught and which are correct in their own right —
  `examples/site`'s `cms-automerge-nudge` caller gains the context in
  `required_contexts` (per #284: the nudge's gate and branch protection have to
  agree, or the nudge could recover a PR the guard has not passed), and both
  consumer ruleset fixtures gain it, since manifest + fixtures encode the DESIRED
  converged state.

  SEQUENCING, AND THE WINDOW IT OPENS. `repo-settings-apply.yml` fires on a push to
  `main` touching `repo-settings.yml`, so the required context auto-applies to both
  live consumers — while NO consumer yet carries the caller that publishes it. A
  consumer whose ruleset has converged before its `platform_ref` reaches v0.1.89
  has every open PR into `main` wedged on "Expected — Waiting for status to be
  reported", with `bypass_actors: []` and so no override. The escape is
  self-unblocking and needs no revert: `platform-bump`'s own PR seeds the newly
  dictated caller pinned at v0.1.89 and publishes the context ON ITSELF (a
  `pull_request` workflow runs from the PR head), and passes, because
  `platform.lock` then reads a real release. That is why the release must precede
  the bump — a caller pinned at v0.1.88 references a reusable that does not exist
  at that tag, so the job errors and the context reports FAILURE instead.

  Also fixes `scripts/stale-platform-refs.js`, which tokenized versions with
  `/v\d+\.\d+\.\d+/` and so read `v0.1.89-rc.1` as `v0.1.89`. Compared against the
  canonical `v0.1.89-rc.1` that made EVERY pin look stale — 55 of them, measured on
  jodidaniel.com — so `verify-consumer-pins.sh`, the gate that defines a consumer
  bump as done, could never pass on an RC-pinned tree. The same prefix-normalization
  bug bit the parity checker in #308 (a consumer pinned at `v0.1.89-rc.1` compared as
  `@vREF-rc.1` against the template's `@vREF` and was reported as call-interface
  DRIFT); each was a separate copy, and the #308 fix missed this one. With both
  corrected an RC is usable for the one job it exists to do.

  `e2e/prerelease-guard.test.js` locks the guard, including the two invariants that
  fail as "this PR hangs forever" / "this PR merged an RC" rather than as a red lint:
  the caller may never gain a path filter, and the two job ids must compose exactly
  the context string `repo-settings.yml` requires (a rename orphans the ruleset entry
  and hangs every consumer PR).

- **v0.1.90** — **a tag pill has never linked to a page that exists (#308's
  crawler, first catch).** `theme/_layouts/post.html` built the href as
  `{{ '/tags/' | append: tag | slugify | relative_url }}`. Liquid applies a
  filter chain left-to-right over the whole accumulated value, so `slugify` ran
  on `/tags/quotes`, not on `quotes`; `Jekyll::Utils.slugify` collapses that
  non-alphanumeric run — both slashes included — to a single dash, and
  `relative_url` guarantees a leading slash back. Result: `/tags-quotes`. The
  tags collection's permalink is `/tags/:slug/`, so the page that href names has
  never existed, on any post, on any consumer with a blog.

  MEASURED, NOT INFERRED: 3 of 66 internal links broken on adamdaniel.ai — the
  home page, the blog index, and the post itself — live on production at the
  time of this release.

  WHAT MAKES IT A GOOD STORY FOR #308. `e2e/site-link-crawler.spec.js` shipped
  one release earlier because nothing crawled the PUBLIC pages; the `/admin`
  crawler walks only the five base collections. This is the first defect it
  found against a real consumer, and it found it on the first run of the first
  bump PR that carried it — which is also why v0.1.89's consumer bump could not
  merge on adamdaniel.ai until this release existed.

  THE PAGE WAS THERE ALL ALONG. `auto_tag_pages.rb` generates `/tags/<slug>/`
  for every tag any post references — its own header names "a tag pill that
  404s" as the condition it exists to prevent. It was doing that correctly; the
  layout pointed elsewhere. So no `_tags/<slug>.md` and no content edit fixes
  this, and adding one would have looked like a fix while changing nothing.

  THE FIX is the idiom the two sibling usages already used and this one did not
  — slugify into a variable first, then append (`default.html:16`,
  `atom_feed.xml:5-6`) — plus the trailing slash the permalink requires.

  `theme/spec/post_tag_pill_url_test.rb` locks it BEHAVIOURALLY: it extracts the
  href expression from the layout and EVALUATES the filter chain, rather than
  matching the text, so the regression re-reds in any spelling. One detail there
  is load-bearing and was got wrong once before being got right — modelling
  `relative_url` as an identity function makes the regression assertion pass
  VACUOUSLY against the unfixed layout, because the leading slash in
  `/tags-quotes` is precisely what that filter puts back. Verified red-first
  twice: the unfixed layout fails 4 of 4 assertions with actual
  `/tags-ai-engineering`; the fixed one passes 17 assertions.

- **v0.1.91** — **the 2026-08-29 user-testing remediation: what a real owner
  and real visitors hit on jodidaniel.com's go-live build.** Six issues, all
  found by human-eye testing rather than by CI, and each one invisible to every
  lint that existed at the time.

  **#324 — preview environments served raw S3 errors for every 404**, bucket
  key, `RequestId` and `HostId` included, plus a nested "could not retrieve a
  custom error document". Production was fine; the gap was preview-only, which
  is the surface a non-technical reviewer gets sent. `ProductionDistribution`
  had a `CustomErrorResponses` block and `PreviewDistribution` had none.
  Fixed twice over, deliberately. CloudFront now maps 404/403 to a generic
  preview page at the bucket ROOT — the viewer-request Function's `pr-<N>/`
  rewrite does not re-apply to CloudFront's own error fetch, which is why the
  target cannot live under the prefix. That half needs an operator-run
  `infrastructure/bootstrap/deploy.sh` per consumer, so validating the RC
  against the live preview drove out a second, deploy-free half: the full error
  body names `Key: 404.html`, and the previews bucket's own
  `WebsiteConfiguration` already declares exactly that error document, resolved
  against the bucket root, where the object had simply never existed. Seeding it
  is one `aws s3 cp` and fixes previews on the next deploy with no
  infrastructure change at all. Both are kept: S3's covers 404 immediately,
  CloudFront's also covers 403 and normalises status at the edge.

  **#325 — the theme shipped no favicon mechanism**, so both consumers 404ed
  `/favicon.ico` on every page view and every tab showed the generic globe.
  Fixed with issue #25's established pattern: the gem ships a neutral,
  brand-free, site-shadowable `assets/favicon.svg` and emits the tag from a
  gem-owned partial. The consumer wrinkle is the part worth remembering — a
  site with its OWN layouts never runs the gem's `<head>`, so the include is
  standalone by design and such a layout adopts it in one line. jodidaniel.com
  needed exactly that, and pinning the RC without it left the measured defect
  live: gem asset shipped, pages carrying no icon tag at all.

  **#326 — the seeded 404 rode the gem `default` layout**, so on a
  design-custom consumer a mistyped URL landed on a near-black monospace page
  that read as a different site. Two testers independently made it their top
  finding. It works perfectly on adamdaniel.ai, whose site IS the gem look — it
  breaks precisely on the consumer shape the platform exists to support, and
  every future design-custom consumer would inherit it from the seed. The seed
  is now self-contained and neutral with `--nf-*` custom properties a site can
  shadow, with the required bits (permalink, noindex, sitemap:false, a link
  home, no site identity) lint-locked so a restyle cannot lose them. An
  EXISTING consumer does not pick this up — `404.html` is site-owned and a
  `platform_ref` bump does not touch it.

  **#328 / #329 — the admin actively misled owners on section-collection
  sites.** "VIEW PAGE ON SITE: Set a title or slug to see the URL" showed on
  every entry of every such collection, including entries WITH a title and
  singletons that will never have a page — `compute()` returned `{url: null}`
  for anything it could not route and the banner rendered that as an
  instruction the owner could never satisfy. Live Preview rendered a Media
  entry as a generic dark blog article with "1 MIN READ" chrome, because any
  collection without its own preview variant falls back to the posts one; a
  preview showing the WRONG design is worse than none, because it teaches
  distrust of the real one. Both affordances are now gated on what actually
  works, both maps dual-maintained and lint-locked. Also: `sortable_fields`
  modelled in the example seam so a reorder is verifiable in the admin, and two
  phone-layout fixes.

  **What did NOT ship, and why it is recorded here rather than quietly
  dropped:** #329's blocker — after one publish, reverting a field to its
  pre-session value leaves no way to save, because Decap's dirty-tracking
  compares against the snapshot loaded at editor-open rather than the
  just-published state. On a boolean like `site_live` that strands the whole
  site gated, i.e. stuck not launched. The real fix reaches into Decap's Redux
  internals, which an upgrade would silently break; the public-API alternative
  depends on remount behaviour that could not be tested (no Decap in the
  authoring container, `unpkg.com` 403 at the egress proxy). For a blocker whose
  failure mode is a site stuck unlaunched, an unverified shim is worse than an
  honest proposal, so a concrete patch sketch went on the issue for a session
  with real-backend access. #329.5's null `aria-label` on the list-row chevron
  is deferred for the same reason: every shim here that touches Decap's rendered
  DOM was built against live observation, and guessing a selector is the
  brittleness to avoid.

- **v0.1.94** — **the notice pointing at the Publish button was painted on
  top of it, and two separate guards were structurally unable to see that.**
  `publish-step-hint.js` shipped in v0.1.92 as a `position: fixed`, top-centre,
  `pointer-events: none` banner reading "Not published yet — click Publish,
  then choose 'Publish now'." Measured against a live Decap 3.15.1 admin, it
  covered 68% of the Publish control and 47% of the Status control at
  1280x800 — the two controls its own text names. Reported from a live preview
  session on jodidaniel.com PR #220, with a screenshot.

  **Why every occlusion assertion in the repo stayed green.**
  `e2e/ui-visibility.js`'s `expectReachable` decides "covered" with
  `document.elementFromPoint` at the control's centre. That is the right
  question for *can the user click it* and the wrong one for *can the user read
  it*: a `pointer-events: none` overlay is invisible to a hit test, so the
  button stayed clickable and the guard stayed green for as long as the banner
  was on production. `expectNoInjectedOverlap` now asks the geometric question —
  rectangle intersection between anything the platform injects (`id^="cms-"`
  plus the two floating chrome links) and each named control, containment
  exempt in both directions.

  **And why the browser lane could not have caught it either.** The damage is
  viewport-width dependent, and this spec's two `@admin-read` projects sit
  either side of the band. Overlap of the Publish button, same session, same
  banner: `3000x1500 → 0`, `2000x1100 → 0`, `1440x900 → 2682px2`,
  `1280x800 → 2682px2`, `1024x768 → 2438px2`, `393x852 → 0`. A centred fixed
  overlay clears a 3000px toolbar and sits above a wrapped phone toolbar; it
  lands on the controls at exactly the widths a laptop uses. The new test in
  `e2e/admin-no-occlusion.spec.js` therefore pins its own widths, against that
  file's "deliberately does NOT pin a viewport" rule, and carries a vacuity
  guard so it cannot pass by rendering nothing.

  **The fix.** The bar is a full-width row in normal flow, inserted as the
  toolbar's next sibling inside Decap's `EditorContainer`. Zero overlap at every
  width measured, with no hard-coded offset, because Decap's own layout does the
  work in both modes: on desktop `ToolbarContainer` is `position: absolute` and
  the container carries a matching `padding-top`; on the phone layout the
  toolbar is `position: static` and wraps. It also reports a state that had no
  signal at all — while an entry has unsaved changes Decap renders NO publish
  control (`renderWorkflowControls`: `!hasChanged && …`) and nothing said why.
  The "about 5-15 minutes" clause is gated on the shell's own
  `deploy-status-pill.js` tag, so the local and test shells — which have no
  deploy — never make a timing promise, the honesty constraint
  `local-save-indicator.js` already documents.

  **The knowledge existed, in the wrong file.** `index-test.html`'s diagnostic
  banner carries a comment saying it is bottom-pinned *because* Decap's toolbar
  is `position: fixed; top: 0`. One shell knew; nothing enforced it. Two pure-fs
  lints in `e2e/admin-329-shims.test.js` now do, for both shims.

  **The lint had to PARSE, and finding that out cost one run.** The first draft
  was `/position\s*:\s*fixed/` over the source, and it red-failed the FIXED
  file — whose header comment explains the defect it forbids. A lint that
  forbids a token cannot read comments. It walks acorn's AST now (string
  literals, `style.position = "fixed"`, `setProperty("position","fixed")`),
  which is the house AST rule in its cheapest form. Both new lints and the
  browser guard were proved able to fail against the pre-fix file.

  Also shipped: `docs/PUBLISHING-UX.md`, the wider rethink this came out of —
  the nine overlapping notions of "published" an editor meets across four
  systems, including the two that contradict each other (`WorkflowList`
  hard-gates publishing on `Ready`; the entry editor's Publish dropdown has no
  status gate at all, and setting `Status: Ready` publishes on its own via the
  `decap-cms/pending_publish` label `auto-merge-when-ready` fires on), the
  5-15 minutes of silence a publish spends after a 14-second toast and an
  8-second error message that is wrong, and a staged plan to collapse it to
  four states and two verbs. Phase 1 is what shipped; phases 2-5 are specified
  and unbuilt, and phase 2 needs an operator decision because it removes a
  capability. #351.

- **v0.1.93** — **the archive field name, fixed before it reached a
  consumer's immutable history.** v0.1.92's media-archive publish path (#347)
  read `pdf_archive_key`; jodidaniel.com's consumer half shipped
  `pdf_archive_file`. Nothing connects the two repos, so nothing caught the
  skew — and the consumer's name is the one that had to win, for a reason
  worth stating plainly because it decides every future field name this
  platform dictates.

  gitleaks' `generic-api-key` rule fires on a KEYWORD next to a high-entropy
  value, and `key` is on its list. This repo names the field, but a CONSUMER
  writes it beside a long hyphenated PDF filename, which clears the entropy
  floor. So the name reddens THEIR scan, never ours, where it only ever sits
  next to `fm[...]` — three of jodidaniel.com's eight media entries tripped it
  on the pinned 8.30.1. `secrets-scan.yml` reads FULL history on push and on
  the weekly sweep and history is immutable, so a name reaching a consumer's
  default branch reddens every future push to it, permanently, one repo at a
  time. Renaming at source is the fix; an allowlist is per-repo and a
  `.gitleaksignore` fingerprint is commit-sha-keyed and cannot propagate.

  It was not breaking anything yet, and the reason is worth recording: every
  jodidaniel entry is `pdf_public: false`, so the script skipped them all and
  exited 0. It would have broken the first time an editor ticked the box on a
  bumped consumer — `fm["pdf_archive_key"]` nil, key empty, `exit 1`, a failed
  production deploy from a routine editorial action, citing a field the site
  does not have. Fail-loud working correctly on a defect. Reproduced both
  directions against the real script with fixtures before the fix was trusted.

  The lint is what stops the next one. `media-archive-publish-gate` already
  asserted the step ordering, all four public-access blocks, the read-only IAM
  grant, the masked-exit-code trap and the `== true` gate — thorough, and blind
  to this, because nothing checked the field NAME. It now rejects any
  front-matter field this script dictates that contains a gitleaks keyword, so
  the next one fails in a platform PR rather than in a consumer's history.
  Proven able to fail: reverting the script reds it (1 failed, 12 passed).
  #348.

- **v0.1.92** — **the rest of #329, fixed against a real Decap instance
  instead of deferred for want of one.** v0.1.91 shipped 2 of the 9
  user-testing findings and deferred the blocker for an honest reason: `/admin`
  loads Decap from unpkg, the egress proxy answers that 403, and there was no
  instance in the authoring container to reproduce against, inspect, or test a
  candidate fix on. The unlock was that `registry.npmjs.org` sits in the
  container's `no_proxy` list — so `decap-cms@3.15.1` came from npm, the real
  gem admin shells were served against jodidaniel.com's own seam and content,
  and Playwright drove it. Every claim below was measured with the shims off
  and on.

  **#329.1, the blocker.** Decap's dirty-tracking baseline is the entry
  snapshot taken when the editor OPENED, and publishing never refreshes it.
  Publish a change, retype the original, and the form now equals the STALE
  baseline: Decap reports "Changes saved" and removes the publish control while
  the backend still holds the old value. Reproduced on a string widget and on
  jodidaniel.com's `Site Live` boolean — the catastrophic one, where "flip it
  off to look, flip it back" left the site gated with the admin insisting there
  was nothing to publish. Re-opening the entry refreshes the baseline, so
  `publish-baseline-refresh.js` makes a publish do what a re-open does: on
  `postPublish`, remount the entry editor with a hash round-trip. Public
  `window.CMS` APIs only — no Redux internals, which is what the deferred
  option-1 sketch would have cost. It acts only when the editor is clean, so an
  in-flight edit is never discarded, and only on the entry route, so it is
  inert on the editorial-workflow path.

  **#329.2** shipped as the issue's option (b), not (a), on evidence:
  click-forwarding was implemented and tested, and programmatically activating
  the single menu item — by `.click()` and by a full synthetic pointer sequence
  — does not publish and raises a page error, besides being the branch that
  risks double-publishing. `publish-step-hint.js` shows an unmissable "not
  published yet" state instead.

  **#329.4** was root-caused rather than guessed. The scope is not merely
  "the open collection" — it is sticky and history-dependent. One session, same
  collection, same term: first search routed to
  `#/collections/expertise/search/HIPAA` and returned 0 hits, though "HIPAA" is
  in that collection's own `description`; later the same search routed to
  `#/search/HIPAA` and returned 3. `search-scope-all.js` rewrites the scoped
  route so the box labelled "Search all" searches all.

  **#329.5 / #329.7** — `list-row-affordance.js` (the row's summary text
  expands the row; the chevron gets the `aria-label` it lacked) and
  `single-entry-collection-shortcut.js` (skip the one-item list for file
  collections). The latter is guarded on the absence of a `/new` link, so a
  FOLDER collection that happens to hold one entry is never trapped with no way
  back to its list — the guard earned itself within the day, when
  jodidaniel.com added an `events` folder collection.

  **#329.8** — `local-save-indicator.js`, local shell only: the editor toolbar
  reads `local · saves to your working copy`, then `saved to working copy ·
  HH:MM:SS` after a save, persistently. The persistence IS the fix; a 3-second
  toast was the defect. It is barred from implying a deploy, because on the
  local backend there is none.

  **The finding worth keeping.** That last shim's first draft assigned
  `textContent` unconditionally on every render. Assigning `textContent`
  replaces the child text node even when the string is identical — a
  `childList` mutation inside `document.documentElement`, the exact subtree the
  shim's own `MutationObserver` watched with `subtree: true`. So `render()` fed
  the observer that called it, and because observer callbacks are microtasks
  the loop never yielded: injected into a live admin it killed the page target
  outright ("Target page, context or browser has been closed"). The entire
  pure-fs lint suite was green through it, 1551/0. It is a clean instance of
  this repo's own "green unit lints routinely ship a LIVE regression" rule, and
  it was caught only because the fix was driven against a real instance.
  `render()` now compares before writing; a regression guard is lint-locked and
  was proved able to fail.

  Also filed from this work: **#342**, a pre-existing Decap 3.15.1 defect
  reproduced identically WITHOUT these shims — direct hash navigation between
  two entry routes breaks the next publish with `Cannot read properties of
  undefined (reading 'reduce')`. The admin UI offers no such navigation, so it
  is reachable only from a synthetic harness; it is a live trap for e2e specs
  that publish in two entries in one session.

  Item 9 (contradictory status badges on the test-repo backend) remains open on
  its original terms: it needs real-backend confirmation before badge logic is
  treated as trustworthy.
