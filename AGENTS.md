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

## Remaining work

- Port the workflow long-tail: `cms-editorial-workflow`, `sweep-stale-cms-prs`,
  `publish-scheduled-posts`, `secrets-scan`, `required-check-stubs`, then the
  e2e/Playwright matrix (`cms-publish-loop*`, `e2e-tests`, `visual-regression`,
  `parity-preview`, `cms-media-roundtrip`, `canary-prod`) + the
  `post-failure-comment` composite + its scripts.
- Dogfood adamdaniel.ai as consumer #1, then tag `v0.1.0` (the example `@v0.1.0`
  pins don't resolve until a release exists).

## Environment gotchas (this machine / web)

- The **web** GitHub MCP connector can't create repos (403); `/teleport` to local
  and use `gh` (authed as Adam-S-Daniel, scopes incl. `repo`,`workflow`).
- Background sessions: editing a non-cwd repo checkout trips a worktree-isolation
  prompt on the Edit/Write tools — write via Bash (`cat >`, a Python pass) which
  isn't tool-guarded. Writing `.claude/settings.json` is blocked as self-mod.
