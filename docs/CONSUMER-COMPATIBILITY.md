# Consumer compatibility: base_collections, OAuth, spec context, admin parity

What this is: the guard rails that keep the platform's shared e2e harness
correct for BOTH a full consumer and a `base_collections: []` single-page
consumer (jodidaniel.com's shape) — the `site-capabilities.js` predicates and
the two guard registries in `e2e/base-collections-guards.js`, the org
OAuth-App-restriction trap that blocks Decap saves on an org-owned consumer,
the `PLATFORM_META_SPECS` rule that keeps platform-internal specs out of
consumer e2e runs, and the bump-aware admin-bundle parity check. Read this
before adding a new e2e spec that depends on a base collection existing,
before touching `e2e/site-capabilities.js` / `e2e/base-collections-guards.js`
/ `playwright.config.js`'s `PLATFORM_META_SPECS`, or before changing
`e2e/admin-bundle-parity.js`. See also the `admin-config-render` and
`browser-testing` skills.

### base_collections-aware spec skips for single-page consumers (#33, v0.1.9+)

Many e2e specs assume the generic collections (`posts/tags/projects/pages/e2e`)
+ adamdaniel-shaped content (`_posts/`, `_e2e/canary-*.md`, the rendered
`posts`/`tags`/… admin collections, `/blog/`, `/tags/`, `_site/e2e/canary-*/`).
A `base_collections: []` single-page consumer (jodidaniel.com) has **none** of
those, so those specs used to be **permanently RED** on every branch. The fix:
each generic-collection/content-dependent spec **self-skips PRECISELY** when the
consumer genuinely lacks that collection/content, and **runs fully** where it
exists (the platform `e2e/fixture-site` + adamdaniel.ai).

**The helper: `e2e/site-capabilities.js`** — the single source of truth for
"does THIS consuming site have X?". All predicates take an explicit `siteRoot`
(defaulting to `process.env.SITE_ROOT || <harness>/..`, the same root the rest
of the harness uses). Parses YAML with the real `yaml` lib.

- `keepsBaseCollection(siteRoot, name)` — **SOURCE** signal off `_config.yml`
  `cms.base_collections` (build-INDEPENDENT). Use this for **served-site**
  specs (they also run in the preview/prod `@parity` lanes, where `_site` is
  NOT built — a rendered-config check would wrongly skip a full consumer there).
- `hasAdminCollection(siteRoot, name)` / `adminCollections(siteRoot)` —
  **RENDERED** signal off `_site/admin/config.yml` (the ground truth Decap
  loads). Use this for **fs specs that already only run in the local lane**
  (they read `_site`, so the build is guaranteed present).
- `hasE2ECanaries(siteRoot)` / `hasRenderedCanary(siteRoot, slug)` /
  `hasSourcePosts(siteRoot)` / `isSinglePageConsumer(siteRoot)` — canary +
  posts presence.

**The skip pattern** — a precise `test.skip()` (or `beforeEach` skip) keyed on
the helper, with a message that names the collection + `cms.base_collections` +
`(#33)`:

```js
const cap = require("./site-capabilities");
test.skip(
  !cap.hasAdminCollection(SITE_ROOT, "posts"),  // fs/local-lane spec
  'consumer opts out of the "posts" collection via cms.base_collections — skipping <X> (#33)',
);
// served-site spec (also runs preview/prod @parity) → use keepsBaseCollection:
test.skip(!cap.keepsBaseCollection(SITE_ROOT, "tags"), "…opts out of tags… (#33)");
```

**Never weaken assertions for full consumers** — guard with a skip, don't relax
an `expect`. A full consumer that LOST its posts is a real failure, not a skip.
Specs that assert ABSENCE (e.g. sitemap "no draft / no `_e2e` canary leaks")
stay correct (empty) on an opted-out site and are intentionally NOT guarded.

**Guarded specs — group 1 (read-only / config / served-content):**
`canary-content.test.js`, `canary-ondemand-noindex.test.js`,
`cms-config.spec.js` (per-collection), `cms-post-list-summary.spec.js`,
`cms-permalink-contract.spec.js` (per-collection), `cms-preview-url.spec.js`
(per-collection — the Posts `preview_path` block is stripped on opt-out),
`cms-form-clarity.spec.js` (per-collection — every PROD_HINTS key is a base
collection), `sitemap.spec.js` ("every published `_posts` appears"),
`tags.spec.js` ("Tags index page"), `feeds-and-share.spec.js` (global Atom-feed
shape), `console-clean.spec.js` (`/blog/` + `/tags/` crawl URLs). These read the
RENDERED `_site/admin/config.yml` per base collection and self-skip inline on
`cap.hasAdminCollection(SITE_ROOT, "<name>")` (the rendered ground truth) — NOT
the registry `guard()`; the served-content specs self-skip on
`cap.keepsBaseCollection` (they also run the preview/prod `@parity` lanes where
`_site` isn't built). Several content-reading specs were also made
**SITE_ROOT-aware** (read `_posts/`, `_e2e/`, `_site/` under `SITE_ROOT`, not
`__dirname/..`) so they resolve the CONSUMING site's content; the two are
identical in a real consumer (harness at site root) but differ when the
meta-test points `SITE_ROOT` at a fixture.

> **The `@parity-preview` lane MUST export `SITE_ROOT` (#42, v0.1.15).** The
> served-content specs key their single-page skip on
> `cap.keepsBaseCollection(SITE_ROOT, …)`, which reads the CONSUMER's
> `_config.yml`. In the `parity-preview.yml` reusable the harness is checked out
> into `.cms-platform/`, so `SITE_ROOT || __dirname/..` resolves to the
> **platform** checkout (whose fixture `_config.yml` keeps all five base
> collections) unless the spec-run step sets `SITE_ROOT: ${{ github.workspace }}`
> (the first, default-path SITE checkout). Without it, a single-page consumer's
> parity lane crawls `/blog/` + `/tags/` and 404s (jodidaniel.com #35). The
> `e2e-tests.yml` lane already sets `SITE_ROOT` for `target==local`; the
> parity-preview lane now sets it too. **(Resolved — was a "latent gap to watch":
> `e2e-tests.yml` used to leave `SITE_ROOT=''` for `target` preview/prod; it now
> sets `${{ github.workspace }}` unconditionally, and the WHOLE `.cms-platform/e2e`
> harness family is covered — see the UNIVERSAL RULE note below.)** Locked by
> `e2e/parity-preview-site-root.test.js` (this lane) +
> `e2e/loop-site-root-lint.test.js` (the whole family).

> **THE UNIVERSAL RULE — every `.cms-platform/e2e` harness run MUST export
> `SITE_ROOT: ${{ github.workspace }}` (#1815, v0.1.22) — the realized "latent
> gap" above.** When a reusable checks the platform out into `.cms-platform/` and
> runs `npx playwright test` from `.cms-platform/e2e`, a base_collections /
> single-page guard's `SITE_ROOT || __dirname/..` fallback resolves to the
> **platform** checkout (which keeps all five collections) → the guard never
> fires. On jodidaniel.com (`base_collections:[]`) this made the host loop run
> `cms-delete-published.spec.js` and time out 60s on the `/^Posts$/` sidebar link
> the bio admin never renders. **Why `github.workspace` is always correct:** it is
> the site-under-test (default-path) checkout in EVERY lane — a no-op on the
> platform's own self-CI (where `github.workspace` and `.cms-platform` are the
> same tree) and on a full consumer (which keeps every collection); it only
> changes behaviour on a single-page consumer, where it makes the guards fire
> CORRECTLY. There is never a reason to resolve site config from the
> `.cms-platform` harness checkout, so an empty (`|| ''`) or platform-pointing
> value is always a bug.
>
> The rule is now enforced on the WHOLE family, not just the loops: the five loop
> reusables (`cms-publish-loop-host` / `-prod` / `-preview`, `cms-media-roundtrip`,
> `cms-preview-loops`), plus `canary-prod`, `cms-delete-published-preview`,
> `preview-media`, `visual-regression`, `e2e-tests` (its non-local lane used to
> emit `SITE_ROOT=''` — the realized latent gap, now `${{ github.workspace }}`
> unconditionally), and `parity-preview`. **Locked AS EARLY AS POSSIBLE by
> `e2e/loop-site-root-lint.test.js`** — a pure-fs lint in self-CI's
> `node-unit-lints` lane (no build / no browser, hard-fail), so a missing
> SITE_ROOT is caught at PR static-analysis time, *before* any loop ever runs
> against a live site. The lint scans every workflow and auto-covers ANY new
> reusable that grows a `.cms-platform/e2e` harness run — add the reusable, the
> lint demands its SITE_ROOT. (`preview-media` / `visual-regression` specs don't
> read SITE_ROOT today, but the rule is uniform and future-proofs a later guard.)

> **The closed blind spot (#34):** `cms-preview-url.spec.js` +
> `cms-form-clarity.spec.js` READ the rendered admin config per base collection
> but DON'T navigate index-local, so the original guard-registry detector (which
> only matched index-local route-hashes + sidebar-link waits) MISSED them — they
> red-failed a built single-page consumer despite the registry being green. The
> detector is now **comprehensive** (CLASS A/B/C below) so this whole class can't
> be missed again.

**Guarded specs — group 2 (CONSUMER-RUNNING admin-write/read/screenshots that
drive `/admin/index-local.html`):** these navigate
`#/collections/{posts,projects,pages,tags}/...` or wait for a base-collection
sidebar link, so on a `base_collections: []` consumer they would time out (the
local admin shows NO collections — see the config-local nuance below). They are
guarded via the **registry** `e2e/base-collections-guards.js` (single source of
truth, build-INDEPENDENT `keepsBaseCollection`), applied inline as
`test.skip(...guard(SITE_ROOT, "<basename>"))` at the top of each describe:

| spec | guarded on |
| --- | --- |
| `cms-smoke.spec.js` | **all** of posts/tags/projects/pages (hard-asserts the full sidebar) |
| `manual-walkthrough-contributor.spec.js` | **all** of posts/tags/projects/pages (asserts the full sidebar) |
| `cms-page-crud.spec.js` | `pages` |
| `cms-project-crud.spec.js`, `cms-project-gallery.spec.js` | `projects` |
| `cms-featured-image-lifecycle.spec.js`, `cms-html-embed.spec.js`, `cms-image-upload.spec.js`, `cms-inline-image.spec.js`, `cms-link-crawler.spec.js`, `cms-publish-flow.spec.js`, `cms-posts-list-runtime.spec.js`, `manual-walkthrough-content-guide.spec.js`, `manual-walkthrough-first-post.spec.js` | `posts` |

Specs that drive `/admin/index-test.html` (`config-test.yml` is FIXED, NOT
opted-out — `admin-no-occlusion`, `cms-mobile-layout`, `cms-editorial-workflow`,
`cms-field-targeting`, `cms-native-view-live`, …) must **NOT** be guarded. The
drift lint distinguishes them by the index-local route / sidebar-wait signal.

**Single-page consumers and `config-local.yml` (fixed 2026-08):** the gem's
`decap_config_hook.rb` applies the `base_collections` keep-list deletion to BOTH
`config.yml` AND `config-local.yml`. `config-local.base.yml` used to carry **no
`__SITE_COLLECTIONS__` marker**, so a single-page consumer's **LOCAL-dev**
`/admin` (decap-server) showed **NO collections at all** — the keep-list
stripped every built-in and the (marker-less) splice put nothing in to survive
it. Both templates now carry the marker, so a site's own collections reach
local dev exactly as they reach the prod `config.yml`;
`theme/spec/decap_config_hook_render_test.rb` locks the splice+strip end to end
plus a one-marker-per-template assertion. The #33 skips are unaffected — they
guard specs that assume BASE collections exist, and hiding those on a
`base_collections: []` consumer is still the intended behavior.

**The two fixtures (the platform's own both-paths proof):**
`e2e/fixture-site` keeps every base collection + the 3 canonical canaries (the
FULL consumer); `e2e/fixture-site-singlepage` sets `cms.base_collections: []` +
one custom `notes` collection, NO `_posts`/`_e2e` (the OPTED-OUT consumer,
jodidaniel's shape). **Spec-locked** by THREE tests:

1. `e2e/site-capabilities.test.js` — the predicates against both fixture shapes.
2. `e2e/base-collections-skip-meta.test.js` — **build-and-run** proof: builds
   BOTH fixtures, subprocess-runs the **fs-guarded** specs against each, asserts
   opted-out → SKIPS, full → RUNS. Build-dependent → in `node-unit-lints`' DENY
   list (self-ci.yml) + `PLATFORM_META_SPECS`, so **no platform PR lane runs it**.
3. `e2e/base-collections-guard-registry.test.js` — the **pure-fs PR GATE**
   (CONCERN B). Runs in `node-unit-lints` (it's a hermetic `*.test.js`). It is
   the real protection on the admin-write + rendered-config guards: (a)
   **predicate proof** — for every registered spec, `shouldSkip(singlepage)===
   true` & `shouldSkip(full)===false` against the fixtures' `_config.yml` (no
   build); (b) **guard presence** — each registered spec actually imports the
   registry + calls `guard()/shouldSkip()` with its own basename; (c) **no silent
   drift (COMPREHENSIVE)** — its detector flags EVERY consumer-running spec that
   depends on a base collection existing, by ANY of three classes, and each
   flagged spec must be guarded (registry guard OR a direct inline
   `cap.hasAdminCollection`/`cap.keepsBaseCollection` self-skip) or in the
   `NON_GUARDED` allowlist, else RED:

   | class | signal | breaks on opt-out because |
   | --- | --- | --- |
   | **A** index-local route | `page.goto(…index-local.html#/collections/<base>)` | route never renders (collection stripped from `config-local.yml`) |
   | **B** index-local sidebar | `getByRole("link",{name:/^<base>$/i})` in a file that loads `index-local` but NOT `index-test` | sidebar link never appears |
   | **C** rendered-config per-collection | reads the rendered `_site/admin/config.yml` (`RENDERED_CONFIG`/`hasAdminCollection`/`adminCollections`) AND a per-base assertion: `preview_path`, a hint snapshot (`hintFor`/`PROD_HINTS`), `findCollection(cfg,'<base>')`, or `hasAdminCollection(…, '<base>')` | the `posts/tags/projects/pages/e2e` block is stripped → null/absent |
   | **D** single-page SURFACE (#21) | **D1** `page.goto(/admin/reviews…)` + a review-DATA read (`.health-card`/`.stat-grid`/`WORKFLOW_FILES`/`regression.json`); **D2** `page.goto(/preview/?collection=pages\|projects)` or a `data-preview-layout="pages\|projects"` expect; **D3** the `@canary-readonly` tag or `canary-content` import + `.publicPath`; **D4** writes a `_posts/*.md` draft + asserts `/blog/` | the consumer ships none of: a CMS review subject (reviews), preview.md + per-collection content (preview shell), `_e2e/canary-*` (canary probe), or a posts/`/blog/` surface (draft isolation) |

   It also has **detector-stays-comprehensive** tests anchored on
   `cms-preview-url` + `cms-form-clarity` (CLASS C) and the CLASS D set
   (`admin-reviews-{health,stats}`, `preview-shell`, `cms-publish-loop{,-preview}`,
   `cms-preview-pr-self-contained`, `draft-isolation`): if the detector regresses
   so it stops flagging any of these, that goes RED. A **precision-boundary** test
   asserts the detector does NOT flag the single-page-COMPATIBLE lookalikes —
   `glow-banding` (samples the THEME background on `/`; runs fine on a single-page
   bio), `admin-reviews-auth` (drives `/admin/reviews/` but only the site-AGNOSTIC
   OAuth handshake, no review data), `preview-bridge` (only regex-matches the URL
   its builder helper returns, never navigates a variant). A spec whose admin
   shell is `index-test.html` (`config-test.yml` is FIXED — not opt-out-deleted)
   is NOT flagged by A/B and must NOT be guarded. Because (2) never runs on a
   platform PR, (3) is what actually keeps the guard set from regressing.
   `NON_GUARDED` is **empty by design** (every flagged spec is guarded) and the
   stale-entry test requires any future entry to be genuinely
   flagged-but-unguarded.

#### The two guard registries in `e2e/base-collections-guards.js` (#33 + #21)

`shouldSkip(siteRoot, basename)` dispatches on the entry shape:

- **`ADMIN_WRITE_GUARDS`** (#33) — per-collection keep-list guards keyed on
  `keepsBaseCollection(siteRoot, name)` with `mode: "all"|"any"`. The CLASS A/B
  index-local navigators + **`draft-isolation.spec.js`** (posts: it writes a
  `_posts/*.md` draft + asserts `/blog/`, machinery a `base_collections:[]`
  consumer ships none of).
- **`CAPABILITY_GUARDS`** (#21) — coarse single-page guards keyed on a named
  capability predicate (`CAPABILITY_PREDICATES`): `isSinglePage` (→
  `isSinglePageConsumer`) or `hasE2ECanaries` (→ `!hasE2ECanaries`). Members:
  **`preview-shell`** + **`admin-reviews-health`** + **`admin-reviews-stats`**
  (`isSinglePage` — a static bio ships no preview.md / has no review subject),
  **`cms-publish-loop`** (its `@canary-readonly` probe) + **`cms-publish-loop-preview`**
  + **`cms-preview-pr-self-contained`** (`hasE2ECanaries` — no `_e2e/canary-*` to
  drive). Apply inline as `test.skip(...guard(SITE_ROOT, "<basename>"))`.

The two registries are **disjoint** (a spec is guarded by exactly one). The
guard-registry lint proves the both-directions predicate (`shouldSkip(single)===
true & shouldSkip(full)===false`) + guard presence for BOTH. **The reviews
dashboards were also de-identified**: they read `window.CMS_REPO`/`CMS_APEX`, so
the mocked GitHub-API + `regression.json` routes match ANY owner/repo/apex (not a
hardcoded `adamdaniel.ai`); `preview-shell` reads the expected `.site-logo` from
`_config.yml` `title`, not a literal "Adam Daniel". This is what lets the FULL
fixture (and every consumer) RUN+PASS them, while the single-page fixture SKIPS.
**glow-banding is intentionally NOT guarded** — investigation showed it samples
only the theme background gradient on `/`, which renders identically on a
single-page bio (it passes on both fixtures); guarding it would skip a real
glow/theme regression on a single-page consumer.

**Adding a NEW generic-content spec:**
- **Read-only / served / fs spec** (reads a base collection / canary / posts /
  `/blog/` / `/tags/`): guard on the matching `site-capabilities` predicate
  (rendered for local-only fs specs, `keepsBaseCollection` for served specs that
  also run `@parity`), and add `/^e2e\/site-capabilities\.js$/` to its
  `SPEC_RULES` entry in `select-specs.js`. **If it reads the rendered
  `_site/admin/config.yml` per base collection** (CLASS C — `preview_path`, a
  hint snapshot, `findCollection(cfg,'<base>')`, …), the guard-registry detector
  will flag it; you MUST apply a direct inline `cap.hasAdminCollection(SITE_ROOT,
  "<name>")` self-skip (mirror `cms-config.spec.js` — gate the per-collection
  assertion, not the whole file, where a spec mixes collection-specific +
  agnostic checks) or the drift gate goes RED. No registry entry is needed for
  CLASS C — the inline `hasAdminCollection`/`keepsBaseCollection` self-skip is
  what the detector recognizes as coverage.
- **CONSUMER-RUNNING spec that drives `/admin/index-local.html`** and navigates a
  base collection (route `#/collections/<base>` OR a base-sidebar-link wait):
  you MUST (1) add an entry to `ADMIN_WRITE_GUARDS` in
  `e2e/base-collections-guards.js` (its collection(s) + `mode: "all"|"any"` +
  a `(#33)` reason), (2) apply the inline guard
  `test.skip(...guard(SITE_ROOT, "<basename>"))` at the top of the describe
  (`const { guard } = require("./base-collections-guards")`,
  `const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..")`),
  and (3) add `/^e2e\/site-capabilities\.js$/` + `/^e2e\/base-collections-guards\.js$/`
  to its `SPEC_RULES` entry. If you DON'T want a guard (the spec drives
  `index-test.html`, or does no collection nav), the drift lint will go RED until
  you either register it or add it to the lint's `NON_GUARDED` allowlist with a
  reason. **`base-collections-guard-registry.test.js` enforces all of this** — you
  can't merge an unguarded generic index-local spec.

> **Guard EVERY `test()` in a multi-test guarded spec, not just one (v0.1.23).**
> The guard-presence check is satisfied by the inline guard appearing ANYWHERE in
> the file — which let `cms-publish-loop.spec.js` ship its `@canary-readonly` test
> guarded while the MAIN `@admin-write` host-loop `test()` (it drives the canary
> through the live admin) carried NO guard. On jodidaniel.com (no `_e2e/canary-*`
> → `hasE2ECanaries` false) the unguarded test RAN and timed out 60s on "Confirm
> baseline is live" waiting for `/e2e/canary-post/` (404 on a bio) — red even
> AFTER the SITE_ROOT fix (#58), because that test's canary nav uses a VARIABLE
> collection (`#/collections/${CANARY.cmsCollection}`) the per-file detector
> never pattern-matched. **Rule:** every top-level (column-0) `test()` block in a
> guarded spec MUST carry its own `test.skip(...guard(SITE_ROOT, "<basename>"))`.
> Locked by the per-block assertion in `base-collections-guard-registry.test.js`
> ("every top-level test() block in a guarded spec carries the inline guard").

### Org OAuth App approval — the "can log in but can't save" trap (#26)

On an **org-owned** consumer, if the org has **OAuth App access restrictions**
enabled and the CMS OAuth App isn't approved for the org, Decap authenticates +
reads but every **persist fails** with `OAuth App access restrictions`. An org
owner approving the app fixes it (jodidaniel#27, resolved). **Spike result —
trust it:** there is **no public GitHub API** to ask "is OAuth App `<client_id>`
approved for org `<org>`?" (org OAuth-App authorizations aren't exposed like
GitHub App installations), and a **PAT write-probe FALSE-GREENS** (the
restriction targets the OAuth App's user-token flow, not a PAT). So **do NOT add
an API approval-check or a PAT probe.** The shipped, practicable subset:

- `theme/admin/oauth-app-restriction-detector.js` — admin shim that **observes
  Decap's notification DOM** (MutationObserver) for the restriction text and
  shows a **dismissible** banner pointing the org owner at *Settings →
  Third-party access → OAuth App policy*. It **must not** wrap `window.fetch`
  (publish-via-auto-merge.js already does — a second wrap risks the Safari
  loadEntries hang). It exposes pure helpers on
  `window.OAuthAppRestrictionDetector` (`isOAuthAppRestrictionError`,
  `orgFromRepo`, `orgOAuthPolicyUrl`) and is **requireable in Node** (DOM
  wiring guarded by `typeof window/document`). **Loaded PROD-ONLY** (in
  `theme/admin/index.html`, after `posts-list-enhance.js`) — only the real
  github backend can produce the error; it's inert elsewhere. It's
  **order-independent** of the `live-url-derive → banner → native-preview-href →
  posts-list-enhance` chain the load-order spec locks (`cms-posts-list-enhance.spec.js`).
- `scripts/preflight-oauth.js --repo OWNER/REPO` — org-owner go-live CLI;
  detects owner type via `gh`, prints org-approval guidance (org) or "no
  approval needed" (user); resilient when gh is absent. Pure helpers
  (`parseRepo`, `messageFor`) exported for tests.
- `scaffold/create-site.js` nextSteps carries a conditional org-OAuth reminder.

Tests: `e2e/oauth-app-restriction-detector.test.js` (pure helpers, Node) +
`e2e/oauth-app-restriction-detector.spec.js` (`@admin-read` runtime banner,
simulates the Decap error toast — no backend needed) +
`e2e/preflight-oauth.test.js`.

## Consumer-context spec rule (v0.1.5)

The e2e harness is **reused by consumers**. `e2e/playwright.config.js` runs in
CONSUMER mode when `process.env.SITE_ROOT` is set (the consuming site is built +
served from `SITE_ROOT`); the `PLATFORM_META_SPECS` list is then `testIgnore`'d
(those specs assert the platform's OWN source tree).

**A spec that RUNS in consumer mode MUST NOT read admin from the platform
SOURCE tree (`theme/admin`)** — consumers have no `theme/admin`, only the
gem-RENDERED `_site/admin`. Read the **served bytes** instead:
`await (await page.request.get('/admin/<file>')).text()`, or read
`path.join(SITE_ROOT, '_site', 'admin', '<file>')` (pattern in
`cms-config.spec.js`). `preview-bridge.spec.js` regressed exactly this in v0.1.5
(it `readFileSync`'d `theme/admin/preview-bridge.js`, passing platform self-CI
but ENOENT'ing in every consumer run). **Guarded** by
`e2e/admin-spec-source-read-lint.test.js`: a non-meta `.spec.js` that reads
`theme/admin` or legacy `../admin` fails the lint; a genuinely platform-only
spec goes into `PLATFORM_META_SPECS` in `playwright.config.js` (the lint parses
that list out of the config so the two stay in lockstep).

### PLATFORM_META_SPECS registration is MANDATORY for platform-internal specs (#16)

A **platform-internal** spec validates the platform's OWN machinery, not a
consuming SITE's content/admin behavior. Concretely, its code (comments
stripped) reads at least one of: the platform `scripts/**` tree, `scaffold/**`,
the platform's OWN reusable **workflow DEFINITIONS** (via `workflow-yaml-utils` /
`readWorkflow()`, or an fs path into `../.github/workflows` or the
`examples/site/.github` templates), the `theme/**` SOURCE tree, or the platform
**fixtures** as a literal path (`fixture-site` / `fixture-site-singlepage`, not
via `SITE_ROOT`). **Every** such spec MUST be in `PLATFORM_META_SPECS` —
otherwise it RUNS on a `CONSUMER=true` e2e lane (where that source doesn't
exist) and red-fails. This bit the adamdaniel.ai v0.1.10 reconciliation: five
unregistered meta-specs (`workflow-loop-branch-cleanup`, `preflight-oauth`,
`check-platform-pin-consistency`, the two `scaffold-*`) ran+failed on the
consumer. The platform's own self-CI runs e2e with `TARGET=prod` (never the
`CONSUMER=true` lane), so an unregistered meta-spec ships GREEN on the platform
and only detonates on the next consumer.

Keep genuine **SITE** specs OUT of the list (sitemap/tags/feeds/console-clean/
cms-config/permalink/post-summary, the canary content invariants, the manual
walkthroughs, the real publish-loop round-trips). Those resolve their root
through `SITE_ROOT` and read the consumer's own built `_site/**` / content tree
(or self-gate on `site-capabilities`), so they MUST run on a consumer.

**Recurrence guard — `e2e/platform-meta-spec-registry.test.js`** (runs in
self-CI `node-unit-lints`). It statically classifies every spec by the
platform-internal signals above and FAILS if any platform-internal spec is NOT
in `PLATFORM_META_SPECS`. The detector is **path-name-agnostic** — it keys off
the `scripts/` / `scaffold/` / `theme/` / `.github/workflows` SUBPATH literal no
matter how the prefix var is spelled (`REPO_ROOT`, `__dirname`, …), because
`cms-config-preview-delta.spec.js` execs `path.join(REPO_ROOT, "scripts/…")`
which a naive `../scripts`-only matcher missed. This makes "I forgot to register
a meta-spec" impossible to ship — mirrors the `base_collections` guard registry.
When you add a platform-internal spec, register it; when the guard goes RED, add
the named spec to `PLATFORM_META_SPECS` (or, if it only LOOKED internal because
it read `${SITE_ROOT}/_site/**`, make it read via `SITE_ROOT` — not a `../scripts`
/ `../scaffold` / `../theme` / `../.github/workflows` source path).

## Admin-bundle parity is bump-aware (#14)

`e2e/admin-bundle-parity.spec.js` byte-compares the SERVED admin bundle (prod +
the open PR's preview) against the local/source `theme/admin` tree. A **gem
bump** that changes the admin bundle (e.g. v0.1.x adds a `<script>` to
`theme/admin/index.html` — the #26 oauth-detector, confirmed on adamdaniel
#1913) makes PROD legitimately LAG: it keeps serving the OLD bundle until the
bump PR merges + deploys. A naive REQUIRED prod-vs-source check then fails
pre-merge (chicken-and-egg: prod can't match until the very PR that updates it
merges). The spec is therefore split into two gates:

- **REQUIRED (hard gate)** — the PR's OWN **preview** bundle byte-matches the
  local/source tree. Catches the real per-PR risk: a **broken preview build**
  (preview deployed bytes ≠ the PR). No bump excuse — it's the PR's own output.
- **PROD (bump-aware)** — compare prod's served bundle **VERSION** to the PR's
  source version. **Version marker = the served `index.html` manifest sha**:
  `index.html` lists every admin module as a `<script src>`, so any bundle
  add/remove/rename changes its bytes (and a `decap-cms@X.Y.Z` pin bump shows up
  too). If versions **DIFFER** (bump in progress, prod lags) → any prod-vs-source
  byte mismatch is **INFORMATIONAL** (logged `prod lags vX -> vY; reconciles on
  deploy`, not failed). If versions **MATCH** yet bytes differ → **REAL prod
  drift** (hand-edited prod / partial deploy at the same version) → **HARD
  FAIL** (preserves the original probe intent). When the marker is indeterminate
  (prod `index.html` 404/unreadable, or local missing) it fails SAFE to
  informational on the prod side; prod-drift at an unknown version is then caught
  by the scheduled `canary-prod` lane.

> **The walk EXCLUDES files the deploy never serves (#41, v0.1.14).** The
> version marker (`index.html` `<script>` manifest) is BLIND to non-script
> sidecar files. v0.1.13 added `collections.site.yml.example` (#5) + `README.md`
> to `theme/admin/` — SOURCE/DOC files the deploy COPY hook
> (`theme/lib/cms-platform-theme/decap_config_hook.rb`) and its deploy-time mirror
> (`scripts/render-decap-config.rb`) **explicitly SKIP** from `_site/admin`
> (`next if bn.end_with?('.base.yml') || skip.include?(bn)`). They 404 on prod
> AND preview, but the marker stayed byte-identical → the gate misread prod's
> legitimate 404 as same-version **drift** and red-failed every consumer bump.
> Fix: the walk filter is the testable `isExcludedAdminPath()` in
> `admin-bundle-parity.js`, mirroring the hook skip list (`*.base.yml`,
> `collections.site.yml[.example]`, `README.md`) on top of the per-deploy
> (`commit.json`) / preview-mutated (`config*.yml`) / dev-only
> (`index-{local,test}.html`) exclusions. A drift-guard test parses the Ruby
> `skip = […]` arrays so the JS predicate can never diverge from what the deploy
> actually serves. The same-version CONTENT-drift HARD FAIL is unchanged.

The decision logic is the pure, network-free `e2e/admin-bundle-parity.js`
(unit-tested by `e2e/admin-bundle-parity.test.js` with fixture bundles — the
spec only does the fetches). Outcome contract: on a gem-bump PR (prod older
version) parity PASSES via preview-vs-local; on a same-version prod byte-drift it
FAILS.

### The injected shells are identity-NORMALIZED before the byte compare (#17)

The parity byte-compare must NOT trip over the **per-environment `window.CMS_*`
injection** the render hook (and its deploy mirror) splices into the admin
shells. Three shells carry it — `admin/index.html` + `admin/reviews/index.html`
+ `admin/reviews/health.html` (the hook's `index*.html` + `reviews/*.html`
globs). The SERVED shell has an injected identity `<script>` block
(`window.CMS_REPO/CMS_SITE_ORIGIN/CMS_APEX/CMS_OAUTH_BASE_URL/CMS_SITE_TITLE`)
keyed to the *served* origin; the LOCAL source has **no such block at all** (it
only READS those globals at runtime). So a raw-byte compare of an injected shell
ALWAYS mismatched — the served block is present + per-env while source has none.
That false-failed the REQUIRED preview-vs-local gate (`PREVIEW BUNDLE != PR
SOURCE`) on **every** admin PR (regression from #14; confirmed adamdaniel #1913,
where the preview served valid complete pages and ONLY those 3 injected shells
mismatched).

The fix (`parityShaForFile` / `normalizeInjectedIdentity` in
`admin-bundle-parity.js`): an injected shell — classified by `isInjectedShell()`
mirroring the hook's globs **exactly** — is normalized in BOTH the served bytes
AND the local bytes before hashing: (1) the injected identity `<script>` block
(a `<script>` whose body is ONLY `window.CMS_<KEY>=…;` assignments) is STRIPPED
wholesale; (2) any inline `window.CMS_<KEY>=value` / `{{CMS_<KEY>}}` token is
collapsed to a per-key placeholder. The compare then runs on the MACHINERY (real
`<script src>` tags, structure) — preview-injected, prod-injected, and block-less
source all normalize-equal. A genuine machinery diff (added/removed/renamed
`<script src>`, structural edit) survives normalization and STILL hard-fails;
non-injected files (enhancer `.js`, CSS) are NEVER normalized (strict). The
injected key SET stays owned by `decap-config-render-parity.test.js` — the parity
probe deliberately does not assert on the block's internal composition. **If you
add another window.CMS_* identity shell, or change the hook's inject globs,
update `isInjectedShell()` in lockstep.**
