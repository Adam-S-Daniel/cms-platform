# cms-platform

Reusable CMS machinery — **Jekyll + Decap CMS + AWS** (S3 / CloudFront / Lambda OAuth) —
for spinning up new sites like [adamdaniel.ai](https://adamdaniel.ai) and keeping
platform improvements flowing **both ways** after a site is created.

> **Status:** mature and in production. Two live consumer sites (adamdaniel.ai,
> jodidaniel.com) run on this platform, kept in lockstep at the current
> release — see the version history in `AGENTS.md`, which is the thing that
> actually gets updated every release (a version hardcoded here went 20+
> releases stale). Full Playwright e2e
> matrix (publish loops, canary probes, parity, visual regression) validating
> every release against real production deploys. The full design,
> parameterization map, and history live in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and this repo's `AGENTS.md`
> version history.

## The model

Two repos, not one:

- **`cms-platform`** (this repo) — owns all reusable machinery, versioned with semver tags (`vMAJ.MIN.PAT`).
- **per-site repo** — holds only content (`_posts/`, `pages/`, …), identity (`_config.yml`),
  site-only overrides, and *thin consumers* of the platform.

Site content, branding, and domain **never** sync. Platform / infra / CI / tooling
**always** sync; structural scaffolding (new collection types, layout patterns)
is **opt-in** per site. Agent skills are a fourth case — they are authored here but
**not synced into a site at all**; they ship as a marketplace bundle (below).

## How each layer is shared

| Layer | Consumed via | Down-sync (platform → site) | Up-sync (site → platform) |
|---|---|---|---|
| GitHub Actions | reusable `workflow_call` workflows pinned by SHA | `platform-bump` (Dependabot ignores cms-platform refs, #244) | PR to this repo |
| Jekyll theme | theme gem (layouts/includes/assets/plugin) | `platform-bump` (Dependabot ignores this gem, #242) | PR to this repo |
| Decap CMS config | build-time render from the site's `_config.yml` | gem bump (`platform-bump`) | PR to this repo |
| AWS infra | versioned CloudFormation (S3-published templates) | `platform-bump` workflow | PR to this repo |
| Agent skills | the `agentskills` marketplace, which federates the `cms-platform` bundle from `skills/` in this repo | **none** — nothing is copied into a site (see "Agent skills" below) | PR to this repo |

Bidirectional sync in one line: **improvement made anywhere → PR to `cms-platform` →
new tag → `platform-bump` fans the bump out to every site**. Nothing platform-owned
is vendored into a site anymore — the admin machinery ships in the gem and the skills
in a marketplace bundle — so the `platform-drift-guard` check that used to police
vendored copies was removed in v0.1.83.

## Agent skills

`skills/` is the canonical home of the platform's skills and the only place one is
edited. They are **not** synced into a consumer: they are published as a federated
bundle in the [`agentskills`](https://github.com/Adam-S-Daniel/agentskills)
marketplace, which resolves `cms-platform` from this repo's plugin manifest.

Type these two in a Claude Code session (they are slash commands, not shell):

```text
/plugin marketplace add Adam-S-Daniel/agentskills
/plugin install cms-platform@agentskills
```

Skills are bundle-namespaced, so they invoke as `/cms-platform:<skill>` — e.g.
`/cms-platform:admin-config-render`. On an ephemeral surface where that install
does not persist (a cloud session, a CI runner), the delivery channel is instead
the registry's `skills-bootstrap` SessionStart hook — but that hook installs this
bundle into a repo only once **that repo's own `skills.lock`** declares
`cms-platform` as a source, pinned and integrity-checked per skill. The lock is a
per-consuming-repo artifact; the registry's own stays `adam`-only by design, and
no consuming repo has declared the source yet. No consumer vendors a copy, so
there is none to drift.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the complete plan.

## Required GitHub secrets (per consumer site)

Each consumer repo needs two hand-made PATs plus three AWS values. The **canonical,
versioned spec — with the exact fine-grained permissions for each — lives in the
`cms-platform-secrets` skill** (`skills/cms-platform-secrets/SKILL.md`), which reaches
a session through the marketplace bundle above rather than through the consumer repo.
At a glance:

- **`CMS_E2E_PAT`** (CMS automation + canary loops) — fine-grained, this repo: **Contents R/W, Pull requests R/W, Actions Read *and write***. Actions *write* is for `regression-review-reaper` (rejecting superseded review-gate deployments); the PAT user must also be a reviewer of the `regression-review` environment. Must be a PAT, not `GITHUB_TOKEN`, so canary-PR events fire downstream workflows.
- **`CMS_PLATFORM_PAT`** (the `platform-bump` auto-bump) — the same **plus Workflows R/W**, because the bump rewrites `.github/workflows/*` pins. Missing this is issue #13.
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
