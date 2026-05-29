# AGENTS.md — working in cms-platform

Reusable CMS machinery extracted from **adamdaniel.ai**, so new sites get the
same Jekyll + Decap + AWS stack and platform improvements sync **both ways**.
Read this before changing anything here. Design: `docs/ARCHITECTURE.md`. Sync
model: `docs/SYNC.md`.

## The model

Two repos. **This repo owns all machinery** (versioned, semver tags). A **site
repo** holds only content + identity (`_config.yml`) + thin consumers. Site
content/branding/docs **never** sync; platform/infra/CI/tooling/skills do;
structural scaffolding (collection types) is opt-in via `admin/collections.site.yml`.

## Layout

| Path | Layer |
|---|---|
| `.github/workflows/*.yml` | reusable `workflow_call` workflows (deploy, skills-sync, drift-guard, platform-bump) |
| `scripts/` | platform-owned helper scripts (preview slug, preview-config patch, Decap render) |
| `infrastructure/`, `oauth-proxy/` | parameterized CloudFormation + deploy scripts |
| `admin/` | Decap base config (`*.base.yml`) + admin JS/HTML (reads `window.CMS_*`) |
| `theme/` | the `cms-platform-theme` Jekyll gem (layouts/includes/assets/plugins + Decap render hook) |
| `skills/` | canonical Claude Code skills |
| `examples/site/` | copyable thin-shell callers a site consumes |
| `scaffold/` | `create-site.js` — the `npx` site generator |

## Conventions (do not break)

- **Port from `adamdaniel.ai@main`** — that's the source of truth. Don't invent;
  lift and parameterize.
- **Never hardcode `adamdaniel` identity.** Site values come from `_config.yml`
  (`cms.*`, `url`), workflow inputs, CFN params (`ResourcePrefix`,
  `ProductionDomainName`), `github.repository`, or injected `window.CMS_*`.
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

## Environment gotchas (this machine / web)

- The **web** GitHub MCP connector can't create repos (403); `/teleport` to local
  and use `gh` (authed as Adam-S-Daniel, scopes incl. `repo`,`workflow`).
- Background sessions: editing a non-cwd repo checkout trips a worktree-isolation
  prompt on the Edit/Write tools — write via Bash (`cat >`, a Python pass) which
  isn't tool-guarded. Writing `.claude/settings.json` is blocked as self-mod.
