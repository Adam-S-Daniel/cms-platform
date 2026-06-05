# cms-platform

Reusable CMS machinery — **Jekyll + Decap CMS + AWS** (S3 / CloudFront / Lambda OAuth) —
for spinning up new sites like [adamdaniel.ai](https://adamdaniel.ai) and keeping
platform improvements flowing **both ways** after a site is created.

> **Status:** early scaffolding. The full design, parameterization map, creation
> path, sequencing, and verification plan live in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Machinery is being extracted from
> `adamdaniel.ai` one layer at a time.

## The model

Two repos, not one:

- **`cms-platform`** (this repo) — owns all reusable machinery, versioned with semver tags (`vMAJ.MIN.PAT`).
- **per-site repo** — holds only content (`_posts/`, `pages/`, …), identity (`_config.yml`),
  site-only overrides, and *thin consumers* of the platform.

Site content, branding, and domain **never** sync. Platform / infra / CI / tooling /
skills **always** sync; structural scaffolding (new collection types, layout patterns)
is **opt-in** per site.

## How each layer is shared

| Layer | Consumed via | Down-sync (platform → site) | Up-sync (site → platform) |
|---|---|---|---|
| GitHub Actions | reusable `workflow_call` workflows pinned by SHA | Dependabot bumps the pin | PR to this repo |
| Jekyll theme | theme gem (layouts/includes/assets/plugin) | Dependabot (bundler) | PR to this repo |
| Decap CMS config | build-time render from the site's `_config.yml` | gem bump | PR to this repo |
| AWS infra | versioned CloudFormation (S3-published templates) | `platform-bump` workflow | PR to this repo |
| `.claude` skills | `skills-sync` workflow at the pinned tag | same SHA pin | PR to this repo |

Bidirectional sync in one line: **improvement made anywhere → PR to `cms-platform` →
new tag → Dependabot fans the bump out to every site**; a `platform-drift-guard` check
catches site edits to platform-owned files and routes them back here.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the complete plan.

## Required GitHub secrets (per consumer site)

Each consumer repo needs two hand-made PATs plus three AWS values. The **canonical,
versioned spec — with the exact fine-grained permissions for each — lives in the
`cms-platform-secrets` skill** (`skills/cms-platform-secrets/SKILL.md`), which
`skills-sync` copies into every consumer's `.claude/skills/`, so it travels with the
platform. At a glance:

- **`CMS_E2E_PAT`** (CMS automation + canary loops) — fine-grained, this repo: **Contents R/W, Pull requests R/W, Actions Read *and write*** (classic: `repo`). Actions *write* is for `regression-review-reaper` (rejecting superseded review-gate deployments); the PAT user must also be a reviewer of the `regression-review` environment. Must be a PAT, not `GITHUB_TOKEN`, so canary-PR events fire downstream workflows.
- **`CMS_PLATFORM_PAT`** (the `platform-bump` auto-bump) — the same **plus Workflows R/W** (classic: `repo` + **`workflow`**), because the bump rewrites `.github/workflows/*` pins. Missing this is issue #13.
- **`AWS_ROLE_ARN`, `PRODUCTION_CLOUDFRONT_ID`, `PREVIEW_CLOUDFRONT_ID`** — from the bootstrap stack outputs (see the `aws-bootstrap` skill).

## Organization-owned consumers: OAuth App approval

On an **org-owned** consumer (the repo owner is a GitHub organization), if the
org has **OAuth App access restrictions** enabled and this site's CMS OAuth App
hasn't been approved for the org, Decap CMS **authenticates and reads fine but
every save/publish fails** with an `OAuth App access restrictions` API error —
the "can log in but can't save" trap. An **org owner** approving the app fixes
it. (First/only org-owned consumer to hit this: `jodidaniel.com` —
[jodidaniel#27](https://github.com/jodidaniel/jodidaniel.com/issues/27),
resolved by approval.)

There is **no public GitHub API** to query whether an OAuth App is approved for
an org, and a PAT write-probe gives a **false green** (the restriction targets
the OAuth App's user-token flow, not a PAT). So the platform ships the
practicable, non-probing subset:

- **Runtime admin banner** — `theme/admin/oauth-app-restriction-detector.js`
  (loaded in the prod admin shell). It observes Decap's notification surface
  and, when the `OAuth App access restrictions` persist error appears, shows a
  **dismissible** banner telling the org owner to approve the app at *Settings →
  Third-party access → OAuth App policy*. It never blocks editing and never
  wraps `window.fetch`; it re-shows on the next failed save.
- **Org-owner preflight** — `node scripts/preflight-oauth.js --repo OWNER/REPO`
  detects the owner type via `gh`; for an org it prints the exact approval step
  + the settings deep-link, and for a user it confirms no approval is needed.
  Run it as a go-live step for any org-owned consumer.
- **Scaffold nudge** — `scaffold/create-site.js` adds a conditional reminder to
  its next-steps output pointing at the preflight script.

There is intentionally **no automated approval-check or PAT probe** (both are
infeasible / misleading per the above).
