---
name: cms-platform-secrets
description: The exact GitHub Actions repository secrets AND variables a cms-platform consumer site must set — the precise fine-grained PAT permissions for each secret, plus the repo variables the reusable workflows read via vars.* and the scripts/set-repo-variables.sh setter that derives them. Use when setting up a new consumer, when a workflow fails with "GH_TOKEN env var is required" / "Input required and not supplied: github-token" / a startup_failure on a required secret, when auto-merge/nudge/sweep/auto-resolve don't run, when a loop probes the wrong URL/bucket, or when platform-bump fails "refusing to allow ... to update workflow ... without 'workflows' permission". Canonical, platform-versioned, synced to every consumer via skills-sync. Trigger on "CMS_E2E_PAT", "CMS_PLATFORM_PAT", "WORKFLOW_SHA_COMMENT_PAT", "CMS_AUTOMATION_APP_ID", "CMS_AUTOMATION_APP_PRIVATE_KEY", "dependabot-comment-sync", "required secrets", "PAT permissions", "platform-bump workflow scope", "AWS_ROLE_ARN", "repo variables", "CMS_APEX", "CMS_PROD_URL", "PREVIEW_BUCKET", or "PROD_PLAYGROUND_MODE".
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
  Currently **dormant in both consumers**: adamdaniel.ai and jodidaniel.com each
  pin zero third-party actions and zero
  `Adam-S-Daniel/cms-platform/.github/actions/<x>@<sha>` composites — every
  `uses:` in both repos is a cms-platform reusable workflow, and since #244
  Dependabot `ignore`s all of those. The workflow (and its `Workflows: write`
  credential requirement below) stays wired and will fire the moment a site
  adds a genuine third-party SHA-pinned action; it just has nothing to sync
  today.

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
> `dependabot-comment-sync` reusable falls back to the App credential pair
> below, and if THAT is unset too it **skips cleanly with a notice** — the
> workflow stays green, Dependabot's pin comments just aren't auto-refreshed.
> (`platform-bump`, by contrast, hard-needs the PAT — issue cms-platform#13.)

## `CMS_AUTOMATION_APP_ID` + `CMS_AUTOMATION_APP_PRIVATE_KEY` — the workflows-scoped App (comment-sync fallback)

A **GitHub App** credential pair that carries the same `workflows` permission
`CMS_PLATFORM_PAT` does, for a repo that has **no PAT of its own**. That is
exactly **cms-platform itself**: `CMS_PLATFORM_PAT` lives in the *consumers*
(whose `platform-bump` / `dependabot-comment-sync` callers pass it), so the
platform repo could ship comment-sync to consumers and never run it on its own
Dependabot PRs. `dependabot-comment-sync.yml` therefore mints a short-lived
**installation token** from the App when no PAT is configured — in pure node +
the stdlib `crypto` module, deliberately not a new marketplace action (repo
policy prefers built-ins, and a new action would itself owe the 7-day
cooling-off).

**The ID is a repository VARIABLE, not a secret** — deliberately, so it can be
read while troubleshooting. Only the private key is a secret:

| Knob | Kind | Where the workflow reads it |
|---|---|---|
| `CMS_AUTOMATION_APP_ID` | Actions repository **variable** (Variables tab) | directly as `vars.CMS_AUTOMATION_APP_ID` — a `workflow_call`'d reusable reads `vars.*` from the **CALLER's** repo, so there is no input to plumb |
| `CMS_AUTOMATION_APP_PRIVATE_KEY` | Actions repository **secret** | passed to the reusable as the `app_private_key` secret input |

**App permissions** (Repository permissions on the App itself, installed on both
resource owners): **Contents: Read and write**, **Pull requests: Read and
write**, **Workflows: Read and write**.

**The PAT still WINS when present.** The reusable resolves ONE effective push
credential — PAT first, minted App token second — so a consumer that already
has `CMS_PLATFORM_PAT` behaves exactly as before and needs neither knob.

**Deliberately NOT used for the `dependabot-rearm-sweep` merge path.** That
sweep keeps the built-in `github.token`, and the reason is a
trigger-consequence, not a permissions one: a `GITHUB_TOKEN`-attributed merge
fires **no** downstream push workflows (verified — neither PR #182's nor #193's
merge commit produced a self-ci push run, and 0 of the last 40 self-ci push runs
carry a `build(deps)` head commit), whereas an App- or PAT-attributed merge
WOULD. A Dependabot bump touching `cms-publish-loop-prod.yml` +
`cms-publish-loop-host.yml` + `cms-media-roundtrip.yml` in one PR would then
fire all three prod loops onto the shared `prod-mutating-loop` concurrency
group, which **drops a co-arriving sibling** — a cancelled loop as the price of
a pin bump. So the App is for the **push-back** credential only.

> Related, and worth stating because the opposite claim was recorded here for a
> while: **`GITHUB_TOKEN` CAN merge a workflow-file PR.** PR #182 (31 changed
> files, all under `.github/workflows/`) merged as `github-actions[bot]` 3 s
> after its last required check went green. What GitHub refuses is *writing*
> workflow files without the `workflows` permission (hence this App), and
> `enablePullRequestAutoMerge` **from the schedule context** — the discriminator
> there is the EVENT CONTEXT, not the token class.

**Failure mode — soft, and self-describing.** With neither a PAT nor the App
pair, comment-sync logs a `::notice::` naming **all three** knobs
(`workflow_sha_comment_pat`, the `CMS_AUTOMATION_APP_ID` variable, the
`CMS_AUTOMATION_APP_PRIVATE_KEY` secret) and exits cleanly, so "never onboarded"
is distinguishable from "misconfigured". It never reds a Dependabot PR. A failed
*mint* is likewise a `::warning::` plus an empty token, which falls through to
the same clean skip.

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
| `CMS_AUTOMATION_APP_ID` | **opt-in** (`site-params.env`) | `dependabot-comment-sync` (read as `vars.*` from the caller repo; see its section above) |

The last two are the only **non-derived** entries — everything else comes from
`APEX_DOMAIN`, so the setter pushes these two only when `site-params.env`
explicitly sets them. The App's **private key is a SECRET** and is therefore not
settable by the variable setter at all; and cms-platform's own
`CMS_AUTOMATION_APP_ID` is set **by hand** (the setter targets consumers).

**`PROD_PLAYGROUND_MODE` is the one policy call:** it gates whether the
prod-mutate loop actually creates+deletes a live canary. Leave it **unset** on a
real production site (the loop then runs green in report-only mode without
touching prod); set `PROD_PLAYGROUND_MODE=true` in `site-params.env` only for a
throwaway sandbox you want the loop to mutate. The setter only pushes it when
it's explicitly set.

> A fine-grained PAT can't write repo variables for you — the setter uses your
> `gh` auth, which needs admin/maintain on the consumer repo.

## Platform-repo secrets (set on `Adam-S-Daniel/cms-platform`, NOT on consumers)

The platform repo itself holds a few Actions secrets for its own workflows —
they are not part of a consumer's setup checklist.

### `REPO_SETTINGS_READ_ADAM_S_DANIEL` / `REPO_SETTINGS_READ_JODIDANIEL` — repo-settings drift audit (#109)

Consumed by `.github/workflows/repo-settings-audit.yml`, the daily READ-ONLY
drift audit of `repo-settings.yml` (the settings-as-code manifest at the
platform root — see `docs/SYNC.md` "Repo settings as code") against the live
repo settings/rulesets. A fine-grained PAT can't span two owners, so there is
one secret per resource owner:

| Secret | Resource owner | Repository access | Repository permissions |
|---|---|---|---|
| `REPO_SETTINGS_READ_ADAM_S_DANIEL` | `Adam-S-Daniel` | `cms-platform` + `adamdaniel.ai` | **Administration: Read-only** (+ implied Metadata: Read) |
| `REPO_SETTINGS_READ_JODIDANIEL` | org **`jodidaniel`** | `jodidaniel.com` | **Administration: Read-only** (+ implied Metadata: Read) |

- **Read-only by design** — there is NO write credential in CI anywhere in
  this mechanism; applying the manifest is a human running
  `node scripts/audit-repo-settings.js --fix --yes` with their own `gh` auth
  (admin on the target repo). An accidental mutation attempt with these
  tokens 403s — a designed tripwire.
- Store: `gh secret set REPO_SETTINGS_READ_ADAM_S_DANIEL -R Adam-S-Daniel/cms-platform`
  (and the same for `REPO_SETTINGS_READ_JODIDANIEL`).
- **Verify each PAT after minting/rotation** — the negative proof matters as
  much as the positives:

  ```bash
  GH_TOKEN=<pat> gh api repos/<owner>/<repo>/actions/permissions --jq .enabled  # true/false = Administration:Read OK
  GH_TOKEN=<pat> gh api repos/<owner>/<repo>/rulesets --jq length                # a number
  GH_TOKEN=<pat> gh api -X PATCH repos/<owner>/<repo> -f has_wiki=false          # MUST fail 403
  ```

  > **Do NOT probe `delete_branch_on_merge` (or any `allow_*_merge` /
  > `*_commit_*` merge-setting) as the positive check.** GitHub gates those
  > merge-setting keys behind the **Contents** permission (read+write), so they
  > are **entirely absent** from the repo object these correctly read-only
  > **Administration: Read** PATs return — the field is missing, not `false`, and
  > a `--jq .delete_branch_on_merge` probe would read empty even on a healthy
  > token. `actions/permissions` needs Administration: Read with no public
  > exemption, so its `.enabled` boolean is the reliable positive proof. Leave
  > these PATs at **Administration: Read only** — do NOT add Contents (the audit
  > skips the merge flags as informational; `--fix` reconciles them under the
  > operator's own admin `gh` auth, which already has Contents).

- **Expiry / rotation:** fine-grained PATs expire (a year at most). An
  expired or missing token turns the daily audit run RED with a distinct
  "read path is broken" error naming the env var — that red run is the
  rotation reminder (the audit never mistakes an auth failure for drift).
  Re-mint with the same permissions and `gh secret set` again.

### `BUMP_DISPATCH_ADAMDANIEL_AI` / `BUMP_DISPATCH_JODIDANIEL_COM` — release fan-out (back-documented)

Consumed by `release.yml`'s "Fan out bump dispatches to consumers" step:
right after `gh release create`, it dispatches each consumer's
`platform-bump.yml` (`gh workflow run platform-bump.yml -R <consumer>`) so
bumps don't wait for the weekly Monday cron. Fine-grained PATs are minted per
RESOURCE OWNER, so each consumer owner supplies its own secret: **Actions:
Read and write** on that ONE consumer repo, nothing else. FAIL-OPEN: a
missing/expired token only degrades that consumer to its weekly
platform-bump cron (a `::warning`, never a job failure).

## Quick checklist for a new consumer

- [ ] `CMS_E2E_PAT` — fine-grained, this repo: Contents R/W + Pull requests R/W + **Actions R/W** (+ be a reviewer of the `regression-review` environment)
- [ ] `CMS_PLATFORM_PAT` — same **plus Workflows R/W**; powers **both** platform-bump and dependabot-comment-sync
- [ ] `CMS_AUTOMATION_APP_PRIVATE_KEY` — **only if the repo has no `CMS_PLATFORM_PAT`**; the App (Contents R/W + Pull requests R/W + Workflows R/W) comment-sync falls back to. Pairs with the `CMS_AUTOMATION_APP_ID` **variable** below; the PAT wins when present, and both-unset skips cleanly
- [ ] `AWS_ROLE_ARN`, `PRODUCTION_CLOUDFRONT_ID`, `PREVIEW_CLOUDFRONT_ID` — from the bootstrap outputs
- [ ] Repo **variables** — `bash <cms-platform>/scripts/set-repo-variables.sh` (sets `CMS_APEX`/`CMS_PROD_URL`/`PREVIEW_BUCKET`/`AWS_REGION` from `site-params.env`; `PROD_PLAYGROUND_MODE` + `CMS_AUTOMATION_APP_ID` opt-in)
- [ ] Settings → General → **Allow auto-merge** = ON
