# CMS Platform — Architecture & Roadmap

## Context

`adamdaniel.ai` is a Jekyll + Decap CMS site with a sophisticated machinery layer:
~22 GitHub Actions workflows, a Jekyll theme + custom plugin, a ~400-line
invariant-heavy Decap config, parameterized CloudFormation (bootstrap / RUM /
oauth-proxy), Playwright e2e, and a set of `.claude/skills`. The goal is to spin up
**new single-owner sites** that get this same machinery, and to let
platform / infra / CMS / CI / tooling / skills improvements flow **both ways** after
creation — while each site's content, branding, and domain stay independent.

Decided constraints:

- **Owner:** all sites are single-owner; one GitHub owner, one shared AWS account.
- **Sync scope:** platform always syncs; structural scaffolding (new collection
  types, layout patterns) is opt-in; site content/branding/domain never sync.
- **AWS:** one account, many domains — shared bootstrap, per-site buckets / CloudFront /
  cert / OAuth-proxy via parameterized templates.
- **Investment:** invest up front in a clean, versioned platform.

The machinery is not one artifact but ~5 layers, each with its own idiomatic reuse
mechanism — so the answer is a **per-layer combination**, not "package *vs* template
*vs* fork". A plain template repo gives no post-creation sync; a fork drags content
history and conflicts on every site-specific file. This two-repo platform model is the
only option delivering low-conflict bidirectional sync with clean identity isolation.

## Repos

- **`cms-platform`** (this repo) — owns all machinery, semver-tagged.
- **per-site repo** — content (`_posts/ _tags/ projects/ pages/`), `_config.yml` (the
  single source of truth for identity), the SITE-owned admin seam
  `admin/collections.site.yml` (the only `admin/` file a site keeps since v0.1.4 —
  the admin UI ships in the gem), a `Gemfile` pinning the theme gem, thin workflow
  callers, `infrastructure/site-params.json`, and a `platform.lock`.

## Per-layer reuse + sync mechanism

| Layer | Lives in | Consumed via | Down-sync | Up-sync |
|---|---|---|---|---|
| **GitHub Actions** | `.github/workflows/*.yml` as `workflow_call` reusable workflows + `actions/*` composites | per-site `.github/workflows/*.yml` are ~10-line callers: `uses: Adam-S-Daniel/cms-platform/.github/workflows/deploy-preview.yml@<sha>` | **Dependabot** (`github-actions` ecosystem) bumps the pinned SHA | PR to this repo |
| **Jekyll theme** (`_layouts _includes assets _plugins/auto_tag_pages`) | theme **gem** (gem, not `remote_theme` — `remote_theme` can't run the custom plugin reliably) | site `Gemfile` + `_config.yml: theme:`; branding becomes Liquid reading `site.*` | **Dependabot** (`bundler`) | PR to this repo |
| **Decap CMS** (~400-line config + admin `*.js`/`*.html` + `reviews/` dashboards) | platform owns `theme/admin/` (`config.base.yml` machinery + default collections + mandatory e2e canary) — **shipped inside the theme gem since v0.1.4** (GOAL 1, below); consumers no longer vendor it | **build-time render hook** (`theme/lib/cms-platform-theme/decap_config_hook.rb`, mirrored by `scripts/render-decap-config.rb`) copies the gem-resident machinery into `_site/admin`, injects the site identity from `_config.yml`, and splices the SITE-owned seam `admin/collections.site.yml` (opt-in structure) | via gem bump (Dependabot `bundler`) | PR to this repo |
| **AWS infra** (bootstrap / rum / oauth-proxy) | `infrastructure/*` + `oauth-proxy/*` parameterized templates; CloudFront Function regex templated via `Fn::Sub` over an `ApexDomain` param | a consumer commits ONLY thin **delegating `deploy.sh` wrappers** (scaffolder-emitted from `*.delegating`) that check the platform out at `platform_ref` into `.cms-platform/` and `exec` the platform deploy.sh under the site identity — never the vendored template/lambda (#69) | platform fix flows on the next `platform_ref` bump | PR to this repo |
| **`.claude/skills`** | `skills/` canonical copy | a new `skills-sync.yml` reusable workflow pulls skills at the pinned tag. NOTE: adamdaniel.ai's old `skills-mirror.yml` (a *local structural verifier*, not a transport) has since been REMOVED (P7, v0.1.46), superseded by the platform's centralized `dev-hooks-sync.yml` guard — no risk of confusing it with `skills-sync.yml` anymore | via the same SHA pin | PR to this repo |

### How bidirectional sync works

- **Down (platform → every site):** publish a `cms-platform` tag. **Dependabot** opens
  the gem-version and workflow-SHA bump PRs in each consumer; site CI (e2e/preview)
  gates the merge. Only the CFN template-version pointer needs the small custom
  `platform-bump` workflow.
- **Up (site → platform):** a `platform-drift-guard` reusable workflow hashes
  platform-owned paths that physically live in the site (`.claude/skills/`) against
  the pinned gem/tag. A site PR that edits a platform-owned file **fails** the check
  and emits a ready-to-run command to open the equivalent PR here. Merge → new tag →
  Dependabot fans the fix back out. (Since v0.1.4 the admin machinery ships in the gem,
  so it is no longer byte-copied into sites and the guard is **skills-only** — the gem
  bump is admin's down-sync path.)

This satisfies "opt-in structure": the e2e canary collection + editorial-workflow
invariants stay platform-owned and non-optional (they are *test infra*, not content
structure); the SITE-owned seam `admin/collections.site.yml` is the opt-in seam for a
site to add/override content collection types, spliced into the rendered config at the
`# __SITE_COLLECTIONS__` marker. A site may additionally trim the platform's built-in
collections via `_config.yml: cms.base_collections` (a keep-list; v0.1.7).

## Parameterization pass (source-of-truth, paths relative to the adamdaniel.ai source)

> The `admin/*` paths below are the **original adamdaniel.ai source locations**
> from the extraction plan; in this repo the admin machinery now lives under
> `theme/admin/` and is rendered by the hook (see GOAL 1 status at the bottom).

| File:line | Hardcoded today | → Source of truth |
|---|---|---|
| `_config.yml` | (becomes the canonical identity file) | add `cms:` (`repository`, `oauth_base_url`) and `aws:` (`apex_domain`, `prod_bucket`, `preview_bucket`, `stack_name`) blocks |
| `admin/config.yml:7` | `repo: Adam-S-Daniel/adamdaniel.ai` | rendered from `_config.yml: cms.repository` |
| `admin/config.yml:10` | OAuth API-GW URL | `_config.yml: cms.oauth_base_url` (from oauth-proxy stack output) |
| `admin/config.yml:22-24` | site/display/logo url | derived from `_config.yml: url` |
| `admin/deploy-status-pill.js:93`, `admin/publish-via-auto-merge.js:46` | `const REPO` | injected `<meta name="cms-repo">` (build emits it from `_config.yml`) |
| `.github/workflows/deploy-preview.yml:82-83`, `:457` | `adamdaniel-ai-previews`, `adamdaniel.ai` | reusable-workflow `inputs.preview_bucket` / `inputs.apex_domain` |
| `deploy-preview.yml:394,513` | `<!-- adamdaniel-preview-bot -->` | `inputs.bot_marker` (default generic) |
| `.github/workflows/deploy-production.yml:80` | `adamdaniel-ai-production` | `inputs.prod_bucket` |
| `.github/workflows/sweep-stale-cms-prs.yml` (10+) | `Adam-S-Daniel/adamdaniel.ai` | `${{ github.repository }}` |
| `infrastructure/bootstrap/template.yaml` (~233-249, ~301-342) | CloudFront Function regex `…adamdaniel\.ai$` | add `ApexDomain` param + `Fn::Sub` the function code |
| `infrastructure/*/deploy.sh` | `STACK_NAME`, region | `infrastructure/site-params.json` |
| `oauth-proxy/template.yaml:66` | Lambda name | `FunctionName` param |
| `e2e/base.js:30`, `e2e/cms-host.js:11` | `PROD_URL` / `PROD_HOST` | `process.env` fed from `_config.yml` by the thin caller |

`context.repo.owner/repo` is already used throughout `deploy-preview.yml`, so those
references are already portable.

## Creation path

**`npx github:Adam-S-Daniel/cms-platform` scaffolder** (bin name `create-cms-site`;
Node is already present via Playwright). A bare template repo can't deterministically
prompt for and write `_config.yml` / `site-params.json` / `platform.lock`; cookiecutter
adds a Python dependency to a JS/Ruby stack. The scaffolder prompts for domain / title /
repo, writes the thin shell, pins the current `cms-platform` tag, and prints the AWS
bootstrap + DNS steps.

## Sequencing (adamdaniel.ai stays green at every step)

1. **Build parameterized machinery here**, in `cms-platform`, by reading the
   adamdaniel.ai source and producing already-parameterized versions. (adamdaniel.ai is
   untouched at this stage.)
2. **Tag `v0.1.0`.**
3. **Dogfood:** point `adamdaniel.ai` at `cms-platform` as consumer #1 — swap to the
   theme gem + thin workflow callers + `platform.lock`; full e2e/canary/visual-regression
   must stay green.
4. **Add `platform-drift-guard` + the CFN `platform-bump` workflow**; confirm Dependabot
   opens gem/SHA bump PRs.
5. **Build the scaffolder**; create a throwaway site #2.

**Riskiest steps:** (1) the CloudFront Function `Fn::Sub` templating — a bad regex breaks
preview *and* prod routing; stage it on a scratch distribution first. (2) the theme-gem
cutover — diff built `_site` before/after. (3) the OAuth-proxy URL move — keep the old
endpoint valid until build-time config render is proven.

## Verification (end-to-end)

- Scaffold `test-site-throwaway`, run the AWS bootstrap in the shared account with its
  params, deploy via the reusable workflows; confirm prod renders, a PR preview renders,
  and Decap login works.
- **Down-path:** make a visible theme change here, tag `v0.2.0`; assert Dependabot opens
  bump PRs in both `adamdaniel.ai` and the test site and that gated CI passes.
- **Up-path:** make a platform-owned fix *in the test site*; assert `platform-drift-guard`
  fails the PR and the emitted command opens a `cms-platform` PR; merge → new tag → bump
  fans back out.
- Decommission the throwaway site/stack after green.

## Admin-machinery roadmap status (historical — as of v0.1.8; see AGENTS.md for current status)

The Decap admin layer was the one row in the per-layer table whose final reuse
mechanism was still open at extraction time. Issue **#5** split it into two goals:

- **GOAL 1 — ship `admin/` via the theme gem (Option 1A): DONE in v0.1.4.**
  `admin/` was relocated from the repo root to `theme/admin/` (the gem root is
  `theme/`, so it had to move under it to be packaged). The render hook
  (`theme/lib/cms-platform-theme/decap_config_hook.rb`, mirrored by
  `scripts/render-decap-config.rb`, parity-locked by
  `e2e/decap-config-render-parity.test.js`) copies the gem-resident machinery into
  `_site/admin`, token-substitutes the `window.CMS_*` identity, and splices the
  SITE-owned seam `admin/collections.site.yml` at `# __SITE_COLLECTIONS__`.
  Consumers delete their vendored `admin/` and keep only the seam; the gem bump
  (Dependabot `bundler`) is the down-sync path; `platform-drift-guard` became
  skills-only. The `cms.base_collections` keep-list (v0.1.7) lets a site trim the
  built-in collections. See `AGENTS.md` "Admin delivery" for the full mechanics.

- **GOAL 2 — `field_library` + `$ref` reuse: DONE (LOW-RISK increment).** A
  site's seam `collections.site.yml` can `$ref` platform-defined field/widget
  defs from `theme/admin/field_library.yml`, resolved at render time in both
  paths via the shared `CmsPlatformTheme::FieldLibrary` resolver. The base
  config stays TEXT (spliced byte-for-byte; all verbatim-locked lines
  preserved); no-`$ref` seams render byte-identically (backward-compat
  proven). **Still deferred:** the full base-collection-override
  **deep-merge** (override/reorder a base collection's fields) — the seam
  remains append-only; `$ref` delivers shared-field reuse only, not base
  override.

Other platform issues, now resolved: **#21** (a prod-mutate canary URL not
reflecting new content — **DONE**, v0.1.13/#39: CloudFront was
NEGATIVE-CACHING the pre-create 404 via `ErrorCachingMinTTL: 300`, fixed to
`0`) and **#22** (publish loops leaving orphaned `cms/*` canary branches —
**DONE**: loops now prune their own orphaned branches, scoped to branches with
no open PR, locked by `e2e/workflow-loop-branch-cleanup.test.js`). See
AGENTS.md's "Roadmap / open issues" section for the authoritative current
status.
