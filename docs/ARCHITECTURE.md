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
  single source of truth for identity), site-only `admin/` overrides, a `Gemfile`
  pinning the theme gem, thin workflow callers, `infrastructure/site-params.json`, and
  a `platform.lock`.

## Per-layer reuse + sync mechanism

| Layer | Lives in | Consumed via | Down-sync | Up-sync |
|---|---|---|---|---|
| **GitHub Actions** | `.github/workflows/*.yml` as `workflow_call` reusable workflows + `actions/*` composites | per-site `.github/workflows/*.yml` are ~10-line callers: `uses: Adam-S-Daniel/cms-platform/.github/workflows/deploy-preview.yml@<sha>` | **Dependabot** (`github-actions` ecosystem) bumps the pinned SHA | PR to this repo |
| **Jekyll theme** (`_layouts _includes assets _plugins/auto_tag_pages`) | theme **gem** (gem, not `remote_theme` — `remote_theme` can't run the custom plugin reliably) | site `Gemfile` + `_config.yml: theme:`; branding becomes Liquid reading `site.*` | **Dependabot** (`bundler`) | PR to this repo |
| **Decap CMS** (~400-line `admin/config.yml` + `admin/*.js`) | platform owns `admin/config.base.yml` (machinery + default collections + mandatory e2e canary) | **build-time render** injects the ~4 site values from `_config.yml`; extends the existing `scripts/patch-preview-config.sh` pattern. Site may add `admin/collections.site.yml` (opt-in structure) merged at build | via gem bump | PR to this repo |
| **AWS infra** (bootstrap / rum / oauth-proxy) | `infrastructure/*` templates; CloudFront Function regex templated via `Fn::Sub` over an `ApexDomain` param | templates published to the shared artifact bucket as `cfn/<version>/*.yaml`; site stack references the version + `site-params.json` | thin custom `platform-bump` workflow advances the `cfn/<version>` pointer | PR to this repo |
| **`.claude/skills`** | `skills/` canonical copy | a new `skills-sync.yml` reusable workflow pulls skills at the pinned tag. NOTE: adamdaniel.ai's existing `skills-mirror.yml` is a *local structural verifier*, **not** a transport — do not overload it | via the same SHA pin | PR to this repo |

### How bidirectional sync works

- **Down (platform → every site):** publish a `cms-platform` tag. **Dependabot** opens
  the gem-version and workflow-SHA bump PRs in each consumer; site CI (e2e/preview)
  gates the merge. Only the CFN template-version pointer needs the small custom
  `platform-bump` workflow.
- **Up (site → platform):** a `platform-drift-guard` reusable workflow hashes
  platform-owned paths against the pinned gem/tag. A site PR that edits a platform-owned
  file **fails** the check and emits a ready-to-run command to open the equivalent PR
  here. Merge → new tag → Dependabot fans the fix back out.

This satisfies "opt-in structure": the e2e canary collection + editorial-workflow
invariants stay platform-owned and non-optional (they are *test infra*, not content
structure); `admin/collections.site.yml` is the opt-in seam for a site to add/override
content collection types.

## Parameterization pass (source-of-truth, paths relative to the adamdaniel.ai source)

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

**`npx create-adamdaniel-site` scaffolder** (Node is already present via Playwright).
A bare template repo can't deterministically prompt for and write `_config.yml` /
`site-params.json` / `platform.lock`; cookiecutter adds a Python dependency to a
JS/Ruby stack. The scaffolder prompts for domain / title / repo, writes the thin shell,
pins the current `cms-platform` tag, and prints the AWS bootstrap + DNS steps.

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
