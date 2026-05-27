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
