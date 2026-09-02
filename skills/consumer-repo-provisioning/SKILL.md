---
name: consumer-repo-provisioning
description: >-
  The exact GitHub Actions repository secrets AND variables a cms-platform
  consumer site must set — the precise fine-grained PAT permissions for each
  secret, plus the repo variables the reusable workflows read via vars.* and
  the scripts/set-repo-variables.sh setter that derives them. Use when setting
  up a new consumer, when a workflow fails with "GH_TOKEN env var is required"
  / "Input required and not supplied: github-token" / a startup_failure on a
  required secret, when auto-merge/nudge/sweep/auto-resolve don't run, when a
  loop probes the wrong URL/bucket, or when platform-bump fails "refusing to
  allow ... to update workflow ... without 'workflows' permission". Trigger on
  "CMS_E2E_PAT", "CMS_PLATFORM_PAT", "WORKFLOW_SHA_COMMENT_PAT",
  "CMS_AUTOMATION_APP_ID", "CMS_AUTOMATION_APP_PRIVATE_KEY",
  "required secrets", "PAT permissions",
  "platform-bump workflow scope", "AWS_ROLE_ARN", "repo variables",
  "CMS_APEX", "CMS_PROD_URL", "PREVIEW_BUCKET", or "PROD_PLAYGROUND_MODE".
---

# Required GitHub secrets and variables for a cms-platform consumer

Set these as **Actions repository secrets** on the consumer repo
(Settings → Secrets and variables → Actions → New repository secret). One is a
Personal Access Token you create by hand, one is a GitHub App's private key
(with the App's ID as a repository variable), and the three AWS values are
emitted by the bootstrap stack (see the `aws-bootstrap` skill). This file is the single
source of truth. It is authored in `cms-platform`'s `skills/` and reaches a
session through the `cms-platform` bundle in the `agentskills` marketplace
(`/plugin install cms-platform@agentskills`) — nothing copies it into a consumer
repo, so a consumer's checkout is never a place to look for or edit it.

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

Consumed by **16** of the dictated callers — the whole set, because an
under-count here is how a permission goes missing (see `Issues` below):

- **CMS automation:** `cms-automerge-nudge`, `cms-editorial-workflow`,
  `auto-resolve-newline-conflict`, `sweep-stale-cms-prs`,
  `regression-review-reaper`, `publish-scheduled-posts`
- **Canary / real-prod loops:** `cms-publish-loop-prod` / `-host` / `-preview`,
  `cms-scheduled-publish-loop`, `cms-media-roundtrip`, `cms-preview-loops`,
  `cms-delete-published-preview`
- **PR-triggered lanes:** `e2e-tests`, `parity-preview`, `visual-regression`

Regenerate the list rather than trusting this one:
`grep -l CMS_E2E_PAT examples/site/.github/workflows/*.yml`.

**Fine-grained PAT** → *Resource owner* = the repo's owner; *Repository access*
= **Only select repositories → this one consumer repo**; **Repository
permissions**:

| Permission | Access | Why it's needed |
|---|---|---|
| **Contents** | **Read and write** | create/delete branch refs — the publish-via-auto-merge **delete-recovery** branch, loop canary branches — and `sweep-stale-cms-prs --delete-branch` |
| **Pull requests** | **Read and write** | open / label `cms/ready` / comment / close PRs and **enable auto-merge** (nudge, sweep, auto-resolve, the loops, the delete shim) |
| **Issues** | **Read and write** | `cms-editorial-workflow` drives the editorial-workflow labels and status comments through the **issues** API — `issues.createLabel`, `issues.listComments`, `issues.createComment`, `issues.updateComment`. A PR is an issue to those endpoints, so `Pull requests: write` does NOT cover them |
| **Actions** | **Read and write** | **read:** the loops poll `deploy-production` run status (`GET /repos/…/actions/workflows/…/runs`). **write:** `regression-review-reaper` rejects superseded review gates via `POST /repos/…/actions/runs/{id}/pending_deployments` (`state=rejected`) |
| **Commit statuses** | **Read** | `cms-automerge-nudge` and `cms-editorial-workflow` call `repos.getCombinedStatusForRef` (`GET /repos/…/commits/{ref}/status`) to decide whether a head sha is green |
| **Metadata** | **Read** | mandatory — auto-selected for every fine-grained PAT |

**Not needed:**

- *Workflows* — `CMS_E2E_PAT` never edits `.github/workflows/*`. That single
  omission is the whole reason it stays separate from `CMS_PLATFORM_PAT`.
- *Deployments* — nothing this token drives touches the deployments API.
  `pending_deployments` looks like it should, but it is an **Actions** endpoint
  (`/actions/runs/{id}/pending_deployments`) and is covered by the row above;
  `repos.createDeployment` / `createDeploymentStatus` live in `deploy-preview`
  and `deploy-production`, which run on `GITHUB_TOKEN`, not this PAT. Verified
  2026-09-02 by grepping every caller that receives `CMS_E2E_PAT`.
- *Checks* — **fine-grained PATs have no Checks permission at all.** The nudge
  does read check-runs (`checks.listForRef`); that read succeeds only because
  all three repos are PUBLIC. The same caveat applies to `Commit statuses`,
  which is granted above so the token does not silently depend on repo
  visibility.
**Also required (settings / role, not token permissions):**
- Settings → General → **Allow auto-merge** = ON (else the nudge can't enable auto-merge).
- The PAT's user must be a **configured reviewer of the `regression-review` environment**
  (Settings → Environments → required reviewers), or `regression-review-reaper` can't
  reject its pending deployments even with `Actions: write`.

## `CMS_PLATFORM_PAT` — anything that edits `.github/workflows/*` (the FALLBACK since #238)

> **Provision the CMS automation App instead** (next section). Both readers
> below resolve their credential App → PAT → `GITHUB_TOKEN`, so on a consumer
> with `CMS_AUTOMATION_APP_ID` + `CMS_AUTOMATION_APP_PRIVATE_KEY` this PAT is
> never read and can be left to expire. It stays documented because it is what
> a consumer runs on until the App is provisioned — and what the FIRST bump to
> an App-capable release runs on, since that bump is opened by the reusable at
> the consumer's OLD pin, which knows only `gh_token`.

Consumed by:
- `platform-bump` — opens the single-version bump PR that moves `platform_ref` +
  the gem tag + every reusable `uses: …@<ref>` pin to a new release in one PR.
- `dev-hooks-sync` — pushes the platform's dev hooks into the consumer.

There used to be a third, `dependabot-comment-sync`, which pushed a refreshed
`# vX.Y.Z (date)` pin comment back into the workflow file after Dependabot
bumped a `uses: …@<sha>`. It was **deleted on 2026-08-20** along with the pin
comment itself: the comment goes stale silently and then actively lies, and
Dependabot refreshes it only sometimes, so a wrong label is worse than no
label. A third-party `uses:` now ends at `@<sha>`.

**These edit `.github/workflows/*`, so they need `Workflows: write`** — the one
permission `CMS_E2E_PAT` deliberately lacks. That shared requirement is why they
**consolidate onto this single `repo`+`workflow` PAT** rather than a third
secret.

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

> `platform-bump` hard-needs this PAT — issue cms-platform#13.

## `CMS_AUTOMATION_APP_ID` + `CMS_AUTOMATION_APP_PRIVATE_KEY` — the CMS automation App (replaces `CMS_PLATFORM_PAT`, #238)

A **GitHub App** whose installation token does `CMS_PLATFORM_PAT`'s job. Since
cms-platform#238 the two reusables that hold that credential — `platform-bump`
and `dev-hooks-sync` — resolve their push-back credential **App → PAT →
`GITHUB_TOKEN`**: when both knobs below are set on the consumer, the reusable
mints a ~1 h installation token per run (`scripts/mint-app-token.js`, pure node
+ stdlib `crypto`, fetched from the platform at the release the bump targets)
and `CMS_PLATFORM_PAT` is never read. When they are not, the PAT carries the
job exactly as before, after one `::notice::` naming both knobs.

Why an App and not another PAT: a fine-grained PAT cannot span owners, so the
PAT was one token per consumer, and each expired on its own calendar — taking
the ONLY platform down-sync path with it, on a schedule, silently
(`scheduled-run-health` reports it a day late by design). An installation token
is minted per run and expires in an hour; **one App installed on both owners
serves every consumer, and nothing is left to rotate.**

**Create it once (account-level, by hand):**

1. https://github.com/settings/apps/new — name it something that says what it
   is FOR and trips no scanner keyword (`cms-platform-automation` is fine;
   never `…-secrets`/`…-token`/`…-key`, see AGENTS.md "A name you choose
   becomes data a scanner reads"). Uncheck *Webhook → Active*. **Repository
   permissions: Contents: Read and write · Pull requests: Read and write ·
   Workflows: Read and write** (Metadata: Read is implied). Nothing else — in
   particular NOT Administration: that is the separate `REPO_SETTINGS_*` App,
   and the two stay separate on purpose so no single key can both rewrite repo
   settings and push to production (#238, question 1).
2. *Install App* on **each owner** — `Adam-S-Daniel` (select `adamdaniel.ai`
   and `cms-platform`) and the `jodidaniel` org (select `jodidaniel.com`). An
   org install needs an org owner; there is no separate approval step of the
   kind the org OAuth App needed (#26/#27) — the installer IS the approver.
3. *Generate a private key* (a `.pem` download). Note the **Client ID** on the
   App's *General* page — the JWT issuer `mint-app-token.js` uses; the numeric
   App ID is honoured too.

**Then per consumer** — the ID is a repository VARIABLE, not a secret,
deliberately, so it can be read while troubleshooting; only the key is a secret:

| Knob | Kind | Set with |
|---|---|---|
| `CMS_AUTOMATION_APP_ID` | Actions repository **variable** | `gh variable set CMS_AUTOMATION_APP_ID --body <client-id> -R <owner>/<repo>` (or `CMS_AUTOMATION_APP_ID=<client-id>` in `site-params.env` + `scripts/set-repo-variables.sh`) |
| `CMS_AUTOMATION_APP_PRIVATE_KEY` | Actions repository **secret** | `gh secret set CMS_AUTOMATION_APP_PRIVATE_KEY -R <owner>/<repo> < app.pem` |

A reusable reads `vars.*` from the **caller's** repo, so the variable needs no
plumbing; the key reaches the reusable as its `app_private_key` secret input,
which the `examples/site` callers pass. **That `secrets:` line has to ride a
platform-bump** — `check-platform-pin-consistency.js`'s `structuralShape()`
compares each caller's `secrets:` map against the template at the consumer's
pinned ref, so a consumer adding the line ahead of its bump reports DRIFT on
`platform-pin-consistency / pin-consistency`. Set the two knobs first (a no-op
until the reusable reads them), let the bump land the caller line, then verify:

```bash
gh workflow run platform-bump.yml -R <owner>/<repo>      # expect "already on vX.Y.Z"
gh run view <run-id> -R <owner>/<repo> --log | grep -E '::notice::(Minted|No CMS automation App)'
```

`Minted a contents:write,pull_requests:write,workflows:write installation token`
means the App path is live and `CMS_PLATFORM_PAT` can be left to expire; the
`No CMS automation App` notice means a knob is missing. A present-but-broken
key is a red run with `::error::Could not mint` — never a silent PAT fallback,
so "misconfigured" stays distinguishable from "never onboarded".

**What the token can and cannot do.** It is scoped DOWN at mint time to the one
repo the job runs in (`--repositories`) and to `contents=write,
pull_requests=write,workflows=write` for the bump, `contents=read,
pull_requests=write` for dev-hooks-sync — the App's own grant is the ceiling,
never the token. Commits keep their explicit `cms-platform-bot@users.noreply.
github.com` identity (both reusables set it); the PR and the auto-merge arm
are attributed to `<app-slug>[bot]`. A PR opened by an App token fires the
site's CI exactly as a PAT-opened one does — that is why `GITHUB_TOKEN` was
never enough here.

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

**Not (yet) a replacement for `CMS_E2E_PAT`.** That token is written verbatim
into Decap's browser session (`e2e/decap-pat.js`), and Decap's GitHub backend
gates login on `GET /repos/{owner}/{repo}` reporting `permissions.push` for the
token's identity — unmeasured for an installation token; `regression-review-
reaper` must act as a configured **reviewer** of the `regression-review`
environment, a role only a person or team can hold; and
`auto-resolve-newline-conflict.js` allowlists PR authors by user login. Each of
those needs a live measurement with a real App key before the swap, so
`CMS_E2E_PAT` stays a PAT and is rotated on its calendar. The analysis is in
cms-platform#238.

> Related, and worth stating because the opposite claim was recorded here for a
> while: **`GITHUB_TOKEN` CAN merge a workflow-file PR.** PR #182 (31 changed
> files, all under `.github/workflows/`) merged as `github-actions[bot]` 3 s
> after its last required check went green. What GitHub refuses is *writing*
> workflow files without the `workflows` permission (hence this App), and
> `enablePullRequestAutoMerge` **from the schedule context** — the discriminator
> there is the EVENT CONTEXT, not the token class.

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
| `CMS_AUTOMATION_APP_ID` | **opt-in** (`site-params.env`) | `platform-bump`, `dev-hooks-sync` — the App's Client ID; with the `CMS_AUTOMATION_APP_PRIVATE_KEY` secret it retires `CMS_PLATFORM_PAT` (see its section above) |

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

- [ ] `CMS_E2E_PAT` — fine-grained, this repo: Contents R/W + Pull requests R/W + **Issues R/W** + **Actions R/W** + **Commit statuses R** (+ be a reviewer of the `regression-review` environment)
- [ ] `CMS_AUTOMATION_APP_PRIVATE_KEY` (secret) + `CMS_AUTOMATION_APP_ID` (variable) — the CMS automation App, installed on this owner; powers platform-bump and dev-hooks-sync with nothing to rotate
- [ ] `CMS_PLATFORM_PAT` — only until the App above is provisioned (and for the first bump to an App-capable release): same as `CMS_E2E_PAT` **plus Workflows R/W**, minus Actions
- [ ] `AWS_ROLE_ARN`, `PRODUCTION_CLOUDFRONT_ID`, `PREVIEW_CLOUDFRONT_ID` — from the bootstrap outputs
- [ ] Repo **variables** — `bash <cms-platform>/scripts/set-repo-variables.sh` (sets `CMS_APEX`/`CMS_PROD_URL`/`PREVIEW_BUCKET`/`AWS_REGION` from `site-params.env`; `PROD_PLAYGROUND_MODE` + `CMS_AUTOMATION_APP_ID` when `site-params.env` sets them)
- [ ] Settings → General → **Allow auto-merge** = ON
