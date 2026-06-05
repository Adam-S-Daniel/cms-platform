---
name: cms-platform-secrets
description: The exact GitHub Actions repository secrets a cms-platform consumer site must set, and the precise fine-grained PAT permissions for each. Use when setting up a new consumer, when a workflow fails with "GH_TOKEN env var is required" / "Input required and not supplied: github-token" / a startup_failure on a required secret, when auto-merge/nudge/sweep/auto-resolve don't run, or when platform-bump fails "refusing to allow ... to update workflow ... without 'workflows' permission". Canonical, platform-versioned, synced to every consumer via skills-sync. Trigger on "CMS_E2E_PAT", "CMS_PLATFORM_PAT", "required secrets", "PAT permissions", "platform-bump workflow scope", or "AWS_ROLE_ARN".
---

# Required GitHub secrets for a cms-platform consumer

Set these as **Actions repository secrets** on the consumer repo
(Settings → Secrets and variables → Actions → New repository secret). Two are
Personal Access Tokens you create by hand; the three AWS values are emitted by
the bootstrap stack (see the `aws-bootstrap` skill). This file is the single
source of truth — it ships from cms-platform and syncs into every consumer's
`.claude/skills/` via `skills-sync`.

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
**Classic-PAT equivalent:** the `repo` scope.
**Also required (settings / role, not token permissions):**
- Settings → General → **Allow auto-merge** = ON (else the nudge can't enable auto-merge).
- The PAT's user must be a **configured reviewer of the `regression-review` environment**
  (Settings → Environments → required reviewers), or `regression-review-reaper` can't
  reject its pending deployments even with `Actions: write`.

## `CMS_PLATFORM_PAT` — platform-version auto-bump

Consumed by: `platform-bump` (opens the single-version bump PR that moves
`platform_ref` + the gem tag + every reusable `uses: …@<ref>` pin to a new
release in one PR).

It needs **Workflows** (the bump PR rewrites the `uses: …@<ref>` pins under
`.github/workflows/*`) but — unlike `CMS_E2E_PAT` — does **not** need **Actions**
(it neither polls runs nor reviews deployments). **Repository permissions**:

| Permission | Access | Why it's needed |
|---|---|---|
| **Contents** | **Read and write** | push the `platform/bump-*` branch |
| **Pull requests** | **Read and write** | open the bump PR |
| **Workflows** | **Read and write** | the bump edits `.github/workflows/*` — GitHub **rejects** the push without this (`refusing to allow … to update workflow … without 'workflows' permission`) |
| **Metadata** | **Read** | mandatory |

**Classic-PAT equivalent:** `repo` + **`workflow`**. Without the Workflows
permission, `platform-bump` fails and version bumps must be done manually
(issue cms-platform#13). This is the single most-missed permission.

> A fine-grained PAT can't span two owners; if cms-platform and the consumer
> have different owners, `CMS_PLATFORM_PAT` must be authorized for the consumer
> repo's owner (where it pushes). It does not need access to cms-platform.

## AWS deploy secrets (from the bootstrap stack outputs)

`AWS_ROLE_ARN` (OIDC deploy role), `PRODUCTION_CLOUDFRONT_ID`,
`PREVIEW_CLOUDFRONT_ID` — consumed by `deploy-production` / `deploy-preview`.
These are CloudFormation **stack outputs** from `infrastructure/bootstrap/deploy.sh`;
see the `aws-bootstrap` skill for how to read them.

## Quick checklist for a new consumer

- [ ] `CMS_E2E_PAT` — fine-grained, this repo: Contents R/W + Pull requests R/W + **Actions R/W** (+ be a reviewer of the `regression-review` environment)
- [ ] `CMS_PLATFORM_PAT` — same **plus Workflows R/W** (or classic `repo` + `workflow`)
- [ ] `AWS_ROLE_ARN`, `PRODUCTION_CLOUDFRONT_ID`, `PREVIEW_CLOUDFRONT_ID` — from the bootstrap outputs
- [ ] Settings → General → **Allow auto-merge** = ON
