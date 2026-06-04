# Bidirectional sync

How platform changes reach sites, and how site-side improvements get back.

## Down (platform → sites)

| What | Mechanism |
|---|---|
| Reusable workflow `uses:@<tag>` pins | **Dependabot** `github-actions` ecosystem (`examples/site/.github/dependabot.yml`) |
| `cms-platform-theme` gem (layouts/includes/assets/plugins + Decap render hook + **admin UI** `theme/admin`) | **Dependabot** `bundler` ecosystem |
| `platform_ref:` workflow inputs + `platform.lock` | **`platform-bump`** reusable workflow (Dependabot doesn't touch `with:` inputs) |
| Skills (`.claude/skills`) | **`skills-sync`** reusable workflow (rsync + PR, platform-authoritative) |
| AWS infra templates | re-run `infrastructure/*/deploy.sh` with the new templates |

Tag a release on `cms-platform` → the bump PRs fan out to every site; site CI gates the merge.

## Up (site → platform)

**`platform-drift-guard`** runs on site PRs: platform-owned files that live in the
site (`.claude/skills/`) must byte-match the platform at the site's pinned ref. A PR
that edits one **fails** with guidance to make the change in `cms-platform` instead.

The **admin machinery** (`admin/` except the seam) is shipped via the `cms-platform-theme`
gem (`theme/admin`) as of v0.1.4 — sites no longer vendor byte-copies, so it isn't
byte-match-guarded; a gem bump (Dependabot `bundler`) is its down-sync path. Site-owned
seams (`admin/collections.site.yml`) and generated configs (`admin/config.yml`,
`admin/config-local.yml`) are never platform-owned. A site can also opt out of the
platform's built-in collections via `_config.yml: cms.base_collections` (a keep-list;
v0.1.7) without forking any admin file.

So an improvement made while working on any site is routed here as a PR → merge →
tag → it flows back down to all sites. Site **content/branding/docs never sync** — only machinery.
