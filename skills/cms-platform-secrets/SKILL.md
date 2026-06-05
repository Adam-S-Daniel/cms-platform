---
name: cms-platform-secrets
description: The exact GitHub Actions repository secrets AND variables a cms-platform consumer site must set — the precise fine-grained PAT permissions for each secret, plus the repo variables the reusable workflows read via vars.* and the scripts/set-repo-variables.sh setter that derives them. Use when setting up a new consumer, when a workflow fails with "GH_TOKEN env var is required" / "Input required and not supplied: github-token" / a startup_failure on a required secret, when auto-merge/nudge/sweep/auto-resolve don't run, when a loop probes the wrong URL/bucket, or when platform-bump fails "refusing to allow ... to update workflow ... without 'workflows' permission". Canonical, platform-versioned, synced to every consumer via skills-sync. Trigger on "CMS_E2E_PAT", "CMS_PLATFORM_PAT", "WORKFLOW_SHA_COMMENT_PAT", "dependabot-comment-sync", "required secrets", "PAT permissions", "platform-bump workflow scope", "AWS_ROLE_ARN", "repo variables", "CMS_APEX", "CMS_PROD_URL", "PREVIEW_BUCKET", or "PROD_PLAYGROUND_MODE".
---

# Required GitHub secrets and variables for a cms-platform consumer

Set these as **Actions repository secrets** on the consumer repo
(Settings → Secrets and variables → Actions → New repository secret). Two are
Personal Access Tokens you create by hand; the three AWS values are emitted by
the bootstrap stack (see the `aws-bootstrap` skill). This file is the single
source of truth — it ships from cms-platform and syncs into every consumer's
`.claude/skills/` via `skills-sync`.

> **Policy: fine-grained PATs only — never classic PATs.** Every token below is
> a [fine-grained personal access token](https://github.com/settings/personal-access-tokens)
> scoped to the single consumer repo with the minimal permissions in its table.
> Classic PATs (org-wide `repo`/`workflow` scopes) are not used here.

## Why a PAT and not the built-in `GITHUB_TOKEN`

GitHub deliberately **does not fire downstream workflows for events created with
the default `GITHUB_TOKEN`** (anti-recursion). The CMS automation creates,
labels, and closes canary PRs and expects their required checks (and the
`auto-merge-when-ready` job) to fire — so those actions must run under a
**user-scoped PAT**. That is the whole reason `CMS_E2E_PAT` exists.

## `CMS_E2E_PAT` — CMS automation + canary loops

Consumed by: `cms-automerge-nudge`, `auto-resolve-newline-conflict`,
`sweep-stale-cms-prs`, and the canary loops (`cms-publish-loop-prod` /
`-host` / `-preview`, `cms-media-roundtrip`, `cms-preview-loops`,
`cms-delete-published-preview`).

**Fine-grained PAT** → *Resource owner* = the repo's owner; *Repository access*
= **Only select repositories → this one consumer repo**; **Repository
permissions**:

| Permission | Access | Why it's needed |
|---|---|---|
| **Contents** | **Read and write** | create/delete branch refs — the publish-via-auto-merge **delete-recovery** branch, loop canary branches — and `sweep-stale-cms-prs --delete-branch` |
| **Pull requests** | **Read and write** | open / label `cms/ready` / comment / close PRs and **enable auto-merge** (nudge, sweep, auto-resolve, the loops, the delete shim) |
| **Actions** | **Read and write** | **read:** the loops poll `deploy-production` run status (`GET /repos/…/actions/workflows/…/runs`). **write:** `regression-review-reaper` rejects superseded review gates via `POST /repos/…/actions/runs/{id}/pending_deployments` (`state=rejected`) |
| **Metadata** | **Read** | mandatory — auto-selected for every fine-grained PAT |

**Not needed:** *Workflows* — `CMS_E2E_PAT` never edits `.github/workflows/*`.
**Also required (settings / role, not token permissions):**
- Settings → General → **Allow auto-merge** = ON (else the nudge can't enable auto-merge).
- The PAT's user must be a **configured reviewer of the `regression-review` environment**
  (Settings → Environments → required reviewers), or `regression-review-reaper` can't
  reject its pending deployments even with `Actions: write`.

## `CMS_PLATFORM_PAT` — anything that edits `.github/workflows/*` (bump + comment-sync)

Consumed by:
- `platform-bump` — opens the single-version bump PR that moves `platform_ref` +
  the gem tag + every reusable `uses: …@<ref>` pin to a new release in one PR.
- `dependabot-comment-sync` — after Dependabot bumps a pinned `uses: …@<sha>`,
  pushes the refreshed `# vX.Y.Z (date)` pin comment back into the workflow file.

**Both edit `.github/workflows/*`, so both need `Workflows: write`** — the one
permission `CMS_E2E_PAT` deliberately lacks. That shared requirement is why they
**consolidate onto this single `repo`+`workflow` PAT** rather than a third
secret. (comment-sync exercises only Contents + Workflows of it; the wider scope
below is platform-bump's.)

It needs **Workflows** but — unlike `CMS_E2E_PAT` — does **not** need **Actions**
(it neither polls runs nor reviews deployments). **Repository permissions**:

| Permission | Access | Why it's needed |
|---|---|---|
| **Contents** | **Read and write** | push the `platform/bump-*` branch |
| **Pull requests** | **Read and write** | open the bump PR |
| **Workflows** | **Read and write** | the bump edits `.github/workflows/*` — GitHub **rejects** the push without this (`refusing to allow … to update workflow … without 'workflows' permission`) |
| **Metadata** | **Read** | mandatory |

Without the **Workflows** permission, `platform-bump` fails and version bumps
must be done manually (issue cms-platform#13). This is the single most-missed
permission.

> A fine-grained PAT can't span two owners; if cms-platform and the consumer
> have different owners, `CMS_PLATFORM_PAT` must be authorized for the consumer
> repo's owner (where it pushes). It does not need access to cms-platform.

> **Comment-sync is optional but loud:** if `CMS_PLATFORM_PAT` is absent the
> `dependabot-comment-sync` reusable **skips cleanly with a notice** — the
> workflow stays green, Dependabot's pin comments just aren't auto-refreshed.
> (`platform-bump`, by contrast, hard-needs the PAT — issue cms-platform#13.)

## AWS deploy secrets (from the bootstrap stack outputs)

`AWS_ROLE_ARN` (OIDC deploy role), `PRODUCTION_CLOUDFRONT_ID`,
`PREVIEW_CLOUDFRONT_ID` — consumed by `deploy-production` / `deploy-preview`.
These are CloudFormation **stack outputs** from `infrastructure/bootstrap/deploy.sh`;
see the `aws-bootstrap` skill for how to read them.

## Repository **variables** (not secrets) — site identity the workflows read via `vars.*`

Separate from the secrets above, the reusable workflows read non-secret config
from the consumer's **Actions repository _variables_** (Settings → Secrets and
variables → Actions → **Variables** tab). Don't set these by hand — run the
platform setter, which derives every value from `APEX_DOMAIN` in
`infrastructure/site-params.env` so nothing is typed twice:

```bash
set -a; source infrastructure/site-params.env; set +a
bash <cms-platform>/scripts/set-repo-variables.sh        # add --dry-run to preview
```

| Variable | Derived from | Read by (reusable) |
|---|---|---|
| `CMS_APEX` | `APEX_DOMAIN` | `cms-publish-loop-prod` / `-host`, `cms-media-roundtrip`, `visual-regression` |
| `CMS_PROD_URL` | `https://$APEX_DOMAIN` | `cms-publish-loop-prod` / `-host`, `cms-media-roundtrip` |
| `PREVIEW_BUCKET` | `<prefix>-previews` (apex, dots→hyphens) | `visual-regression` (S3 steps no-op if unset) |
| `AWS_REGION` | `${AWS_REGION:-us-east-1}` | `visual-regression` |
| `PROD_PLAYGROUND_MODE` | **opt-in** (`site-params.env`) | `cms-publish-loop-prod`, `cms-media-roundtrip` |

**`PROD_PLAYGROUND_MODE` is the one policy call:** it gates whether the
prod-mutate loop actually creates+deletes a live canary. Leave it **unset** on a
real production site (the loop then runs green in report-only mode without
touching prod); set `PROD_PLAYGROUND_MODE=true` in `site-params.env` only for a
throwaway sandbox you want the loop to mutate. The setter only pushes it when
it's explicitly set.

> A fine-grained PAT can't write repo variables for you — the setter uses your
> `gh` auth, which needs admin/maintain on the consumer repo.

## Quick checklist for a new consumer

- [ ] `CMS_E2E_PAT` — fine-grained, this repo: Contents R/W + Pull requests R/W + **Actions R/W** (+ be a reviewer of the `regression-review` environment)
- [ ] `CMS_PLATFORM_PAT` — same **plus Workflows R/W**; powers **both** platform-bump and dependabot-comment-sync
- [ ] `AWS_ROLE_ARN`, `PRODUCTION_CLOUDFRONT_ID`, `PREVIEW_CLOUDFRONT_ID` — from the bootstrap outputs
- [ ] Repo **variables** — `bash <cms-platform>/scripts/set-repo-variables.sh` (sets `CMS_APEX`/`CMS_PROD_URL`/`PREVIEW_BUCKET`/`AWS_REGION` from `site-params.env`; `PROD_PLAYGROUND_MODE` opt-in)
- [ ] Settings → General → **Allow auto-merge** = ON
