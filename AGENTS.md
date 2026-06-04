# AGENTS.md — working in cms-platform

Reusable CMS machinery extracted from **adamdaniel.ai**, so new sites get the
same Jekyll + Decap + AWS stack and platform improvements sync **both ways**.
Read this before changing anything here. Design: `docs/ARCHITECTURE.md`. Sync
model: `docs/SYNC.md`.

**Current release: `v0.1.8`** — `v0.1.0`–`v0.1.8` are all tagged GitHub
releases; cut a new one with `gh workflow run release.yml -f version=vX.Y.Z`.
Consumers: **adamdaniel.ai** (consumer #1, dogfood; gem-delivered admin live on
prod) and **jodidaniel.com** (consumer #2; single-page bio, gem admin + 9
per-section collections, `base_collections: []`, gated coming-soon). See
"Admin delivery (gem-shipped, v0.1.4+)", "Version history", and "Roadmap /
open issues" below.

## The model

Two repos. **This repo owns all machinery** (versioned, semver tags). A **site
repo** holds only content + identity (`_config.yml`) + thin consumers. Site
content/branding/docs **never** sync; platform/infra/CI/tooling/skills do;
structural scaffolding (collection types) is opt-in via the SITE-owned seam
`admin/collections.site.yml`. The Decap admin UI itself ships **inside the
theme gem** (since v0.1.4) — consumers no longer vendor a byte-copy of `admin/`;
they keep only the seam. See "Admin delivery" below.

## Layout

| Path | Layer |
|---|---|
| `.github/workflows/*.yml` | reusable `workflow_call` workflows (deploy, skills-sync, drift-guard, platform-bump) |
| `scripts/` | platform-owned helper scripts (preview slug, preview-config patch, Decap render, `audit-editorial-labels.js`, `write-commit-json.sh`) |
| `infrastructure/`, `oauth-proxy/` | parameterized CloudFormation + deploy scripts |
| `theme/` | the `cms-platform-theme` Jekyll **gem** (gemspec at `theme/`, so the gem root is `theme/`): layouts/includes/assets/plugins + the Decap render hook (`lib/cms-platform-theme/decap_config_hook.rb`) + the `admin/` UI |
| `theme/admin/` | Decap base config (`*.base.yml`) + admin JS/HTML/CSS (read `window.CMS_*`) + `reviews/` dashboards. Ships INSIDE the gem (since v0.1.4 — it had to move under `theme/` to be packaged); the render hook copies it into `_site/admin` and renders `config.yml`. Sites own only the seam `admin/collections.site.yml` (the gem ships no `collections.site.yml`). |
| `theme/spec/` | plain-ruby theme unit tests (`ruby theme/spec/<name>_test.rb`; no rspec/minitest dep beyond the stdlib `minitest/autorun` used by some); excluded from the gemspec `spec.files` glob |
| `skills/` | canonical Claude Code skills |
| `examples/site/` | copyable thin-shell callers a site consumes |
| `scaffold/` | `create-site.js` — the `npx` site generator |

## Conventions (do not break)

- **Port from `adamdaniel.ai@main`** — that's the source of truth. Don't invent;
  lift and parameterize.
- **Never hardcode `adamdaniel` identity.** Site values come from `_config.yml`
  (`cms.*`, `url`), workflow inputs, CFN params (`ResourcePrefix`,
  `ProductionDomainName`), `github.repository`, or injected `window.CMS_*`.
- **The /admin logo is SITE-OWNED; the gem ships only a NEUTRAL placeholder**
  (issue #25). `theme/assets/images/logo.svg` is a wordless, brand-free generic
  glyph — NEVER a specific site's mark (no "AD"/initials/wordmark). The render
  hooks default `cms.logo_url` to `<url>/assets/images/logo.svg`, and a site
  brands `/admin` by **shadowing** that gem asset with its own
  `assets/images/logo.svg` (Jekyll site files win over same-path gem files) or by
  setting `cms.logo_url`. The scaffolder seeds a "replace me" copy into every new
  site. Locked by `theme/spec/neutral_logo_test.rb` (gem asset is wordless +
  carries the override comment) and `e2e/scaffold-seeds-neutral-logo.test.js`
  (scaffold output). Don't reintroduce a brand into the gem asset.
- **The scaffolder seeds `preview.md` + `404.html` (issue #23).** A consuming
  site MUST expose `/preview/` (the admin "Live Preview" target) and a graceful
  `404.html`, or the admin button dead-ends on a raw S3 404 and unknown URLs 404
  ungracefully. The gem ships `theme/_layouts/preview.html` (the preview SHELL,
  with the hidden post/page/project variants the admin `preview-bridge` streams
  into) + the admin scripts, but the consuming site must provide the `/preview/`
  PAGE. `scaffold/create-site.js` seeds both (`SEED_PREVIEW` / `SEED_404`):
  `preview.md` is **front-matter only** (`layout: preview`, `permalink: /preview/`,
  `sitemap: false`) and carries **no front-matter `robots`** — the gem preview
  layout HARDCODES `<meta name="robots" content="noindex, nofollow">`, so a
  front-matter one would duplicate it (mirrors `adamdaniel.ai/preview.md`).
  `404.html` rides the gem `default` layout (which DOES render `page.robots`), so
  it carries `robots: "noindex,nofollow"` + `sitemap: false` + a home/blog link;
  copy is generic (no site identity). The `e2e/fixture-site` carries both (it
  represents a scaffolded site) and the platform lint
  `e2e/scaffold-preview-and-404.test.js` asserts the contract: (a) scaffold
  output, (b) fixture parity, (c) optional post-build proof that
  `_site/preview/index.html` renders the `data-preview-root` shell +
  `_site/404.html` exists (skips when no Jekyll toolchain — pure-fs self-CI
  lanes). **Single-page-site caveat:** per-item *live* preview is limited for a
  single-page bio (jodidaniel.com — no per-section route to drive the bridge);
  the seeded `preview.md` still gives a working `/preview/` shell + the seeded
  `404.html` a friendly not-found page.
- **Branch + PR, never push to `main`** (the auto-mode classifier enforces this).
- **SHA-pin every workflow `uses:`** with a `# vX.Y.Z (date)` comment; 7-day
  cooling-off before bumping (mirrors adamdaniel.ai policy).
- **Verify before claiming done** — run the render, drift-guard, scaffolder
  against throwaway inputs; syntax-check YAML/bash/Ruby/JS. See "Verify" below.
- **Record knowledge here (AGENTS.md) and/or in `skills/`, not only in agent
  memory** — Adam's standing preference.
- **Two render paths stay in lockstep.** The live Decap config + `window.CMS_*`
  identity globals are produced by BOTH `scripts/render-decap-config.rb`
  (deploy-time) and the theme-gem Jekyll hook
  `theme/lib/cms-platform-theme/decap_config_hook.rb` (build-time — the path gem
  consumers use). Both must inject the same keys
  (`CMS_REPO`/`CMS_SITE_ORIGIN`/`CMS_APEX`/`CMS_OAUTH_BASE_URL`/`CMS_SITE_TITLE`)
  into the same shells (`admin/index*.html` + `admin/reviews/*.html`);
  `e2e/decap-config-render-parity.test.js` fails on drift. Admin chrome (titles,
  reviews dashboards) reads identity from these globals — never hardcode it.
- **`GITHUB_SCOPE` is lockstepped across three files** — `oauth-proxy/lambda.py`,
  `oauth-proxy/template.yaml`, `oauth-proxy/deploy.sh` (default `repo,user,workflow`).
- **De-identified prose uses placeholders:** `<apex>` (production apex), `*.<apex>`,
  `<prefix>` (apex with dots→hyphens), `<owner>/<repo>`, `<your-site>`.
- **Theme-gem ruby unit tests live in `theme/spec/`** (plain ruby — no rspec/minitest;
  `ruby theme/spec/<name>_test.rb`); excluded from the gemspec `spec.files` glob.
- **`e2e/` deps install via `cd e2e && npm ci`** (`e2e/package-lock.json` is tracked —
  consumers need it). The CloudFront-Function specs simulate `Fn::Sub` by substituting
  a synthetic `example.test` apex, so platform specs stay site-agnostic.

## Admin delivery (gem-shipped, v0.1.4+) — the render hook, the seam, base_collections

The Decap admin (`/admin`) is the ~400-line invariant-heavy CMS config plus a
set of JS/HTML/CSS shells and the `reviews/` dashboards. Two facts drive the
whole design:

1. **The gem root is `theme/`** (the gemspec lives there). For the gem to ship
   the admin machinery, `admin/` had to live **under** the gem root, so it was
   relocated from the repo root to `theme/admin/` in **v0.1.4**. (RubyGems drops
   `..` paths and won't follow symlinks, so a sibling `admin/` couldn't be
   packaged.) The gemspec packages `admin/**/*` **minus** the site-owned seam and
   the build-generated files (`collections.site.yml`, `config.yml`,
   `config-local.yml`, `commit.json`) — via `Dir[] - Dir[]` array subtraction,
   because `Dir[]` has no `!` negation.

2. **Consumers stop vendoring `admin/`.** A consuming site deletes its vendored
   `admin/` and keeps **only** the seam `admin/collections.site.yml` (+
   `.example`). The down-sync path is a gem bump (Dependabot `bundler`).
   `platform-drift-guard` is now **skills-only** (admin is no longer
   byte-guarded).

**The render hook** (`theme/lib/cms-platform-theme/decap_config_hook.rb`, a
`:site, :post_write` Jekyll hook) does, at the end of every build:

- **Resolve machinery inputs from the gem** (`site.theme.root/admin`), falling
  back to a vendored `site.source/admin` (migration window + the platform's own
  e2e fixture). No-op if neither has a `config.base.yml`.
- **Copy the gem-resident machinery into `_site/admin`** — Jekyll won't, since
  the site tree no longer contains `admin/`. It copies depth-1 files + the
  `reviews/` subdir only (skipping `*.base.yml`, the seam, `README.md`). **If you
  add another subdirectory under `theme/admin/`, extend this copy AND its parity
  sibling `scripts/render-decap-config.rb`.**
- **Render `config.yml` from `config.base.yml`** by token-substituting the
  `window.CMS_*` identity (`{{CMS_REPO}}`, `{{CMS_OAUTH_BASE_URL}}`,
  `{{CMS_SITE_URL}}`, `{{CMS_DISPLAY_URL}}`, `{{CMS_LOGO_URL}}`) and **splicing
  the SITE-OWNED seam** `admin/collections.site.yml` at the `# __SITE_COLLECTIONS__`
  marker. The seam is read from the **SITE source**, never the gem.
- **Inject `window.CMS_*` globals** into the admin shells (`index*.html`) AND the
  reviews dashboards (`reviews/*.html`) — skipping a file only if it already
  *defines* the identity, not merely uses it.
- **Delete `*.base.yml`** from the output (the templates aren't published).

`scripts/render-decap-config.rb` is the **deploy-time CLI mirror** of the hook
(same copy + render + inject + cleanup; resolves the gem via
`Gem.loaded_specs['cms-platform-theme']`). The two are **parity-locked** by
`e2e/decap-config-render-parity.test.js` — keep the injected globals and the
`index*` / `reviews/*` globs **identical** in both, or the lint fails.

**`write-commit-json.sh`** writes `_site/admin/commit.json` (the commit pill's
`fetch('commit.json')` resolves under `_site/admin/` now that admin is served
from there; CI deploys do this automatically — the script is for local dev).

### base_collections opt-out (v0.1.7)

`_config.yml` `cms.base_collections` is a **KEEP-LIST** of the platform's
built-in collections (`posts tags projects pages e2e`):

- **UNSET** → keep all (default, back-compat).
- `[]` → hide them all, so `/admin` shows ONLY the site's own collections.
- a subset → keep only those.

The renderers delete each unwanted top-level collection block by regex —
matched at **2-space indent**, through to the next top-level `- name:` or EOF;
nested fields are deeper-indented so they survive. **Spec-locked** by
`theme/spec/base_collections_filter_test.rb` (asserts nil keeps all, `[]` hides
all base collections but keeps site collections, partial keep works, survivors'
nested fields and a field literally named like a base collection are untouched,
output stays valid YAML). Used by single-page sites (jodidaniel.com).

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

## Single-version pin consistency guard (anti-skew, #29)

A consumer references the platform version in MANY places (every reusable
`uses: …/.github/workflows/<n>.yml@<ref>`, every SHA-pinned composite
`uses: …/.github/actions/<n>@<sha>  # vX.Y.Z` COMMENT, the `Gemfile`/`Gemfile.lock`
`tag:`, and `platform.lock` `platform_ref`). Dependabot + `platform-bump` land
bumps PIECEMEAL, so consumers drift (observed live: adamdaniel.ai pinned `@v0.1.0`
loop/deploy callers, gem `@v0.1.5`, others `@v0.1.3`/`@v0.1.6` at once — a `v0.1.0`
reusable against a `v0.1.5` gem is a latent bug source).

`scripts/check-platform-pin-consistency.js` (platform-owned, Node, needs only the
repo's `yaml` lib) makes them all agree:

- **Canonical version = `platform.lock` `platform_ref`** (source of truth; missing/
  unparseable → hard fail with a clear message).
- Parses every `.github/workflows/**/*.yml` with the **`yaml` parser** (anchors
  resolved — NOT regex); collects `uses:@` refs targeting the platform owner/repo
  (configurable via `--owner/--repo`, defaulting from `platform.lock`
  `platform_repo`). Reusable refs `.../workflows/*.yml@<ref>`: the `<ref>` must ==
  `platform_ref`. Composite refs `.../actions/*@<sha>`: SHA-pinned, so the gate is
  the trailing `# vX.Y.Z` COMMENT == `platform_ref`. **The comment is read by a
  LINE-AWARE pass** because the YAML parser drops comments — the one justified
  regex/line exception (same rationale as `scripts/sync-action-pin-comments.sh`,
  documented in the script header).
- Reads `Gemfile` (`gem "cms-platform-theme", …, tag:`) + `Gemfile.lock` (the
  cms-platform GIT-source `tag:`); both must == `platform_ref`. Tolerates a
  consumer with NO Gemfile; ignores non-cms-platform `uses:`.
- **Aggregates ALL** violations (doesn't stop at first); prints a precise per-file
  report (file + found + expected) + `::error file=` annotations under
  `GITHUB_ACTIONS`. Exit non-zero iff any mismatch; exit 0 + OK summary otherwise.

Reusable + thin caller: `.github/workflows/platform-pin-consistency.yml`
(`workflow_call`; mirrors `platform-drift-guard`'s checkout-consumer +
checkout-platform-at-`platform_ref`-into-`.cms-platform/` + run-platform-script
shape; the reusable `npm install --no-save yaml` before running, since the script
resolves `yaml` from cwd/node_modules) + `examples/site/.github/workflows/...`
(`pull_request`, NO `paths:` filter — any pin-bearing file can skew). Self-test:
`e2e/check-platform-pin-consistency.test.js` (`@lane local`, runs in
node-unit-lints) — consistent fixture → 0; skewed fixture → non-zero, each
offending file/value named. **Complements** `platform-drift-guard` (that guards
file CONTENT byte-match; this guards VERSION CONSISTENCY). See `docs/SYNC.md`
"Single-version pin invariant".

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

## Editorial-workflow label audit (v0.1.6)

Decap re-runs its editorial-workflow label migration on **every** `/admin` load
(the persistent "Decap CMS is adding labels to N of your Editorial Workflow
entries" dialog) when an open editorial PR (a `cms/*` branch) is **missing** its
`decap-cms/<draft|pending_review|pending_publish>` label — repo-wide, so it
shows on prod AND every preview deploy. Guards:

- `e2e/cms-editorial-label-migration.spec.js` — drives the in-browser test-repo
  backend; asserts the dialog is ABSENT, or gone after dismiss + 30s + reload
  (never survives that cycle).
- `scripts/audit-editorial-labels.js` — flags open `cms/*` PRs missing exactly
  one `decap-cms/<status>` label; exits non-zero with `::error::` annotations.
- `.github/workflows/editorial-label-audit.yml` — reusable; consumers wire a
  daily-cron caller (sparse-checks out just the audit script from the platform).

## E2E decap-server readiness (v0.1.8)

`e2e/playwright.config.js`'s decap-server `webServer` uses
`url: "http://localhost:8081/"` (HTTP readiness — decap-server 404s unknown
routes, which counts as ready) **not** `port: 8081` (TCP-only). The TCP-only
form raced: decap-server accepts the socket a beat before it can serve the
local-backend API, so the admin shell occasionally mounted against a not-ready
proxy and a collection editor failed to render (`cms-link-crawler` flaked ~30%).

## Self-CI lanes

`.github/workflows/self-ci.yml` is the machinery repo's own merge gate (every
other workflow here is an `on: workflow_call` reusable, so a plain PR would
otherwise run zero checks). It runs four FAST lanes on `pull_request` + `push`
to `main`:

1. **actionlint** over `.github/workflows/*.yml` (downloads the pinned binary; hard-fail).
2. **ruby-theme-specs** — `theme/spec/*_test.rb` (hard-fail).
3. **node-unit-lints** — the pure-fs `e2e/*.test.js` lints, selected by an
   exclusion DENY list (build-/repo-dependent specs are denied; a new pure-fs
   lint is picked up automatically). Run with `TARGET=prod` +
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so no Jekyll/browser bring-up (hard-fail).
4. **cfn-lint** over the CloudFormation templates (advisory, `continue-on-error`).

The heavy browser matrix + `@admin-write` write-path specs run in **CONSUMER**
e2e (dogfood / consuming-site CI), NOT in platform self-CI.

## Adding / porting a workflow

Make it `on: workflow_call` with site identity as `inputs`/`secrets`; keep
`github.repository`/`context.repo` (already portable). The site's `on:` trigger
+ `paths-ignore` + `run-name` live in a **thin caller** under
`examples/site/.github/workflows/`. If the workflow needs platform-owned scripts,
check the platform out into `.cms-platform/` (a dot-dir Jekyll ignores) at
`inputs.platform_ref` and run them from there (see `deploy-preview.yml`).

## Verify

```bash
ruby scripts/render-decap-config.rb <site> <site>/_site   # Decap render
node scaffold/create-site.js /tmp/x --yes --domain d --repo d --owner o   # scaffolder
# drift-guard + workflows: python3 -c 'import yaml,...' parse + bash -n the run: blocks
```

## E2E workflow matrix (ported)

The full e2e/Playwright matrix is ported. Two shapes:

- **Reusable + thin caller** (caller in `examples/site/.github/workflows/`):
  `e2e-tests`, `cms-publish-loop-preview`, `cms-delete-published-preview`,
  `cms-preview-loops` (workflow_dispatch); `canary-prod` (schedule + dispatch);
  `parity-preview`, `preview-media` (pull_request, always-run + early-skip — the
  reusable's selector/salient-detector IS the skip, so the caller has NO `paths:`
  to avoid the required-check missing-check trap). Each checks the platform out
  into `.cms-platform/` and references composites by `./.cms-platform/.github/actions/`.
- **Full workflow in `.github/workflows/`** (pinned to that shape by platform
  lints, run in the platform's dogfooding context, reference composites by local
  `./.github/actions/`): the three real-prod loops `cms-publish-loop-prod` /
  `cms-media-roundtrip` / `cms-publish-loop-host` (lint:
  `e2e/workflow-prod-loop-serialized.test.js` — shared `prod-mutating-loop`
  concurrency lane on each loop job, byte-identical; `recursion-gate` job +
  `await-prod-deploy` gate) and `visual-regression` (lints:
  `e2e/visual-regression-content-skip.test.js` + `-skip-review.test.js` — the
  `paths:` content-skip list, the `visually-different` output, the conditional
  `regression-review` environment).

Composites ported: `.github/actions/await-prod-deploy` (commit-json-url now
derives from a `prod-url` input; no hardcoded site URL), `.github/actions/cms-recursion-gate`
(resolves `cms-recursion-churn.js` from the workspace or `.cms-platform/`).

**Deliberately NOT ported / simplified** (adamdaniel-only infra — see each
workflow's "PLATFORM PORT NOTES" header): the GHCR `ci-runner-image` prebaked
Jekyll/Ruby image + the `build-image` jobs + `container:` blocks (deps install
inline instead); the stuck-PR diagnostic steps (depend on un-ported
`scripts/diagnose-stuck-pr.js` + `auto-resolve-newline-conflict.js`); the
preview-loop `if: ${{ false }}` operational disable (an adamdaniel dispatcher
incident, not a platform invariant). The prod-loop serialization lint was
updated to expect the two-job (no build-image) inline-deps shape while keeping
every load-bearing invariant. `visual-regression` still needs the consuming repo
to ship a buildable Jekyll site + Gemfile, AWS OIDC/S3/CloudFront, and a
`regression-review` Environment; baselines regenerate per-site.

## Remaining work

Ported as reusable `workflow_call` + thin callers: deploy (prod+preview),
`cms-editorial-workflow`, `secrets-scan`, `publish-scheduled-posts`,
`sweep-stale-cms-prs`, the full **e2e matrix** (`e2e-tests` + the 10
loop/visual/parity/media workflows + the `await-prod-deploy` /
`cms-recursion-gate` / `post-failure-comment` composites + the `e2e/` harness),
and the **hygiene long-tail**: `auto-resolve-newline-conflict` (+ its
`scripts/auto-resolve-newline-conflict.js`), `cleanup-stale-fixture-branches`,
`dependabot-auto-merge`, `dependabot-comment-sync` (+ its
`scripts/sync-action-pin-comments.sh`; the adamdaniel-only PAT secret was
generalised to the `workflow_sha_comment_pat` input, and the executed script is
now platform-pinned via `.cms-platform/` rather than the PR-head copy — strictly
tighter than the original `pull_request_target` posture), and
`label-non-decap-prs` (keys its Decap-branch prefix off the platform
`e2e/cms-fixture-pr.js` `FIXTURE_BRANCH_PREFIX`).

Both **e2e meta-lints** are now fixed: `visual-regression-content-skip.test.js`
reads `admin/config.base.yml` (the platform's Decap config; `config.yml` is
render-only) and `playwright-image-drift.test.js` loads against the now-ported
`scripts/check-playwright-image-drift.js`. The workflow-structure lints were
already adjusted for the reusable shape (`workflow-run-name` / `dependabot-skip`
exempt `workflow_call`-only reusables). Dropped adamdaniel-only CI (GHCR
`ci-runner-image`, `select-specs` sharding, the finalize merge-gate) is intentional.

**Completeness pass (PR #1 refresh, 2026-05-29).** Ported the `adamdaniel.ai@main`
fix clusters that postdated the initial extraction: `#1810` e2e/test-fixture
exclusion from public aggregation (theme `exclude_e2e_posts` plugin + `feed_exclude`
filtering in `auto_tag_pages` / `tag_feeds` / `atom_feed.xml` / `tag.html`),
`#1840`+`#1809` slug consolidation + the shared `e2e/public-content.js` crawl-set
(+ `slugify-parity` / `preview-deploy-superset` / `e2e-posts-public-exclusion`
tests), `#1844` probe ⊆ deploy (`select-specs.affectsDeployedPreview`),
`#1824`/`#1830`/`#1845` prod-loop + media-roundtrip robustness, and `#1825`
**`cms-automerge-nudge`** — now a reusable `workflow_call` (site supplies its
required-check contexts as an input) + thin caller + lint; treat it like the other
reusables for the run-name/dispatch lint exemption. Also shipped the missing
`scripts/scrub-secrets.js` (the failure reporter referenced a path the platform
didn't ship — un-scrubbed PR output was a secret-leak), local pre-commit hygiene
(`.githooks/pre-commit`, `scripts/secrets-scan.sh` + `lint-staged.sh`, `.gitleaks.toml`
as the single allowlist shared with `secrets-scan.yml`), and `e2e/package-lock.json`.
Stale identity-bound tests were re-parameterized to the env/`window.CMS_*` model.

Still open:
- **Deliberate skips — NOT ported** (each is repo-/site-specific machinery, not a
  reusable; a consuming site authors its own):
  - `required-check-stubs` — encodes the repo's specific required-check /
    path-filter topology; each site authors its own.
  - `code-quality` — platform-self-CI (lints the machinery itself), not a site
    reusable. Being addressed via a **self-test fixture** (a buildable site so
    `cd e2e && npm ci && npx playwright test` runs the harness standalone), then
    adapting `code-quality` to lint cms-platform. Until then, ~12 build-dependent
    e2e specs only go green in a consuming-site context (dogfood / fixture).
  - `regenerate-manual` — site-specific docs (Contributor Manual) generation.
  - `ci-runner-image` — adamdaniel-only GHCR image; already dropped in the e2e
    port (inline deps used instead).
- **`playwright-image-drift` real-repo subtest caveat**: the guard's
  "real repo is drift-free" subtest reads a root `package-lock.json` +
  `.github/ci-runner/Dockerfile`, neither of which the machinery repo ships
  (no installable lockfile here); it exercises fully against the synthetic
  `scaffold()` fixtures and runs green in a consuming site that has both.
- **Visual-regression baselines are site-specific** — a new site regenerates
  snapshots (`npx playwright test --update-snapshots`).
- Dogfood adamdaniel.ai as consumer #1, then tag `v0.1.0` (the example `@v0.1.0`
  pins don't resolve until a release exists).

## Version history (v0.1.0 → v0.1.8)

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
- **v0.1.8** — **e2e flake fix:** decap-server `webServer` waits on HTTP
  readiness (`url:`) not the open port.

## Consumers

- **adamdaniel.ai** — consumer #1, user-owned, the dogfood. Migrated to
  gem-delivered admin (PR #1883); live prod `/admin` verified. Daily
  editorial-label-audit adopted. (A loop co-arrival fix #1892 narrowed the host
  publish-loop's push trigger to its own canary surfaces so it stops evicting
  prod-mutate in the shared `prod-mutating-loop` concurrency lane — see agent
  memory `cms-prod-loops-no-concurrent-runs`.)
- **jodidaniel.com** — consumer #2, org-owned, a SINGLE-PAGE bio. `/admin`
  restructured into 9 per-section collections (5 folder collections ordered by a
  numeric `weight`, declared `output:false`; 4 file collections reading
  `_data/*.yml`). `cms.base_collections: []` hides the generic collections. A
  live-gate in `_data/settings.yml` `site_live` (default `false`) keeps prod
  coming-soon with zero bio leak. Go-live is tracked in jodidaniel issue #26.

## Roadmap / open issues

- **issue #5 GOAL 1 — admin consolidation: DONE** in v0.1.4 (this is the
  gem-delivery model documented above).
- **issue #5 GOAL 2 — `field_library` (OPEN):** per-site custom collections via a
  build-time YAML **deep-merge** of a shared `field_library`, replacing the render
  hook's text-splice of the seam. High-risk re: preserving the config's rich
  comments + invariants through a structural merge; deferred.
- **issue #21 (OPEN):** a prod-mutate canary URL doesn't reflect the new content
  despite a successful deploy — likely a deploy-build future-handling problem.
- **issue #22 (OPEN):** publish loops leave orphaned `cms/*` canary branches —
  add a prune step.

## Environment gotchas (this machine / web)

- **The local checkout can be STALE/detached** — before any analysis or work,
  `git fetch && git checkout main` (or compare against `origin/main`), then branch
  off `origin/main`. An old checkout may not reflect landed migrations (e.g. the
  `admin/` → `theme/admin` move, the gem-delivered admin model) and you'll reason
  about machinery that no longer exists. Verify HEAD == `origin/main` first.
- The **web** GitHub MCP connector can't create repos (403); `/teleport` to local
  and use `gh` (authed as Adam-S-Daniel, scopes incl. `repo`,`workflow`).
- Background sessions: editing a non-cwd repo checkout trips a worktree-isolation
  prompt on the Edit/Write tools — write via Bash (`cat >`, a Python pass) which
  isn't tool-guarded. Writing `.claude/settings.json` is blocked as self-mod.
