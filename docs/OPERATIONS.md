# Operations: running, diagnosing and approving things by hand

The how-tos AGENTS.md points at. Each one is a procedure with a cost behind
it — a wasted prod-mutating loop run, an approval given on the wrong evidence,
a local lane that cannot be reproduced — so the reasoning travels with the
commands rather than being compressed out of them.

Contents: the verify commands, the machine/session gotchas, approving
`regression-review`, what a validation dispatch actually exercises, reading a
failed loop run, pre-running the required lint lane, installing the e2e
fixture's gems, and what to grep before deleting a consumer file.

## Verify

Before claiming a change is done, run both generators against throwaway inputs
and syntax-check what you touched:

```bash
ruby scripts/render-decap-config.rb <site> <site>/_site   # Decap render
node scaffold/create-site.js /tmp/x --yes --domain d --repo d --owner o   # scaffolder
# workflows: python3 -c 'import yaml,...' parse + bash -n the run: blocks
```

## Environment gotchas (this machine / web)

- **The local checkout can be STALE/detached** — before any analysis or work,
  `git fetch && git checkout main` (or compare against `origin/main`), then branch
  off `origin/main`. An old checkout may not reflect landed migrations (e.g. the
  `admin/` → `theme/admin` move, the gem-delivered admin model) and you'll reason
  about machinery that no longer exists. Verify HEAD == `origin/main` first.
- The **web** GitHub MCP connector can't create repos (403); `/teleport` to local
  and use `gh` (authed as Adam-S-Daniel, scopes incl. `repo`,`workflow`).
- Background sessions: editing a non-cwd repo checkout trips a worktree-isolation
  prompt on the Edit/Write tools — write via Bash (`cat >`, a Python pass) which
  isn't tool-guarded. Writing `.claude/settings.json` is blocked as self-mod.

### A live repo-settings check may be IMPOSSIBLE from the session (v0.1.76)

The egress proxy in a sandboxed authoring session returns **403 for
`/actions/variables` and `/actions/secrets`** on all three repos, so whether a
credential is actually provisioned cannot be verified from there — during
v0.1.76, `CMS_AUTOMATION_APP_ID` / `CMS_AUTOMATION_APP_PRIVATE_KEY` could not be
confirmed. **State the limitation honestly rather than asserting either way**, and
design credential-dependent features to **fail SOFT**: absent credentials must
produce a clear notice that names the EXACT knobs, never a crash and never a
silent no-op. The pattern was set by `dependabot-comment-sync.yml` (deleted
2026-08-20 with the pin-comment convention): no App credential simply meant it
skipped with a notice naming all three knobs (`CMS_PLATFORM_PAT` /
`vars.CMS_AUTOMATION_APP_ID` / `CMS_AUTOMATION_APP_PRIVATE_KEY`), which is what
keeps "never onboarded" distinguishable from "misconfigured". `repo-settings-apply.yml`
carries the same shape today, and so do `platform-bump.yml` and
`dev-hooks-sync.yml`, which since #238 read `CMS_AUTOMATION_APP_ID` /
`CMS_AUTOMATION_APP_PRIVATE_KEY` as the CMS automation App that replaces the
consumer's `CMS_PLATFORM_PAT` (App → PAT → `GITHUB_TOKEN`; lint-locked by
`e2e/app-token-platform-writers.test.js`). Whether a consumer has provisioned
the App is exactly the thing this section says cannot be read from a session:
look for the `::notice::Minted …` line in a bump run's log, not at the
settings page.

## Approving `regression-review` on a render-neutral PR

`visual-regression` screenshots the PR against **production**, and prod lags
`main` — so a version-bump or delete-only PR that changes nothing a visitor sees
routinely reports pre-existing drift as its own diff and parks on the manual
`regression-review` gate.

- Do NOT re-run hoping it flips green, and do NOT widen the salience detector
  (`e2e/detect-changed-pages.js`) or the thin caller's `paths:` content-skip list
  to dodge it — both are lint-locked
  (`e2e/visual-regression-content-skip.test.js`, `-skip-review.test.js`) and
  widening either blinds the gate for every future PR.
- Read the shape first: `Visually different ≥ 1` with `Text changed: 0` is the
  false-positive signature (see `docs/VERSION-HISTORY.md`, v0.1.73).
- Prove the PR is render-neutral BEFORE approving. Both must hold:
  `git diff --stat <old-tag> <new-tag> -- theme/` is EMPTY (the gem's render is
  unchanged), and every deleted asset is unreferenced across `_layouts/`,
  `_includes/`, the index page and `_config.yml`.
- Only then approve the environment gate:
  `gh api repos/<owner>/<repo>/actions/runs/<run-id>/pending_deployments` to read
  the environment id and `current_user_can_approve`, then
  `gh api -X POST .../pending_deployments -f state=approved -F "environment_ids[]=<id>"`.
  The approver must be a configured reviewer of the `regression-review`
  environment (see the `consumer-repo-provisioning` skill).
- If either check fails, the gate is doing its job — review the pixels, don't
  approve.

## A validation dispatch tests the code that is REACHABLE, not the code you merged

A host-loop iteration costs over an hour (`cms-publish-loop-host.yml` runs four
`@admin-write` specs at `--workers=1`, `timeout-minutes: 150`), so a dispatch
that exercises the wrong bytes burns a whole cycle. Two ways that happens, both
observed:

- **The CDN is still serving the old admin.** `deploy-production` concluding
  `success` is NOT proof prod `/admin` changed: the admin assets sit behind
  CloudFront and the deploy fires `create-invalidation` WITHOUT waiting for it to
  complete, so the edge can keep serving the previous asset for minutes. A
  re-dispatch once raced it, fetched the old `publish-via-auto-merge.js`, and
  spent a full run failing on a defect that was already fixed and merged.
  **Curl the served asset and grep for the new symbol before dispatching:**
  `curl -s https://<apex>/admin/<file>.js | grep <new-symbol>`.
- **`gh workflow run` against a stale branch.** Dispatching on a dead feature
  branch runs THAT branch's code and resurrects failures the fix already removed.
  Dispatch on current HEAD, and delete feature branches once merged.

So for any change to a gem-shipped `/admin` asset: land the consumer bump, let
its `deploy-production` finish, verify the SERVED asset, then dispatch.

## Diagnose a failed loop run from its ARTIFACTS, not from the logs

`gh run download <run-id>`, then read `test-failed-1.png` and `error-context.md`
BEFORE theorising. A host-loop iteration is over an hour of real prod mutation
(`cms-publish-loop-host.yml` runs four `@admin-write` specs at `--workers=1`,
`timeout-minutes: 150`), so a wrong guess costs a full cycle — and what these
specs catch are Decap UI-state bugs (a Save button gone `disabled`, a confirming
toast that already faded) that a log physically cannot show. The v0.1.36 layer in
`docs/VERSION-HISTORY.md` was cracked by the screenshot alone, after log-reading
had already produced two wrong root causes.

## Pre-run the required lint lane locally

`node-unit-lints` is a REQUIRED check and the cheapest one to reproduce. Mirror
it from `e2e/`:

```bash
TARGET=prod PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npx playwright test --project=chromium-light --reporter=line ./*.test.js
```

Run the WHOLE `*.test.js` set, not just the files you touched — these lints
cross-reference each other, so an edit in one file routinely reds a lint in
another.

Two classes of local red are EXPECTED, not regressions: the build-dependent
specs on `self-ci.yml`'s DENY list, and anything needing a Jekyll toolchain on a
box that has none. Check a red against that list before chasing it.

## Install the e2e fixture's gems into the fixture, not the system gem path

With `GEM_HOME` unset, bundler defaults to an unwritable `/var/lib/gems` and the
`e2e/fixture-site` gem install fails outright — which blocks every lint that
needs the fixture's `bundle exec` (e.g. `e2e/base-collections-skip-meta.test.js`,
which requires the fixture to have resolved gems). Scope the fix to the fixture
rather than fixing it globally:

```bash
cd e2e/fixture-site && bundle config set --local path vendor/bundle && bundle install
```

`vendor/` and `.bundle/` are already gitignored there — and `.bundle/` is
precisely what does NOT travel with a clone, so this is a one-time step on every
fresh checkout, not a fix someone forgot to commit.

## Before deleting anything from a consumer, grep the PLATFORM too

A file with no references anywhere inside a consumer repo can still be
load-bearing: the platform's own e2e specs reach into a consumer's tree by
HARDCODED path, and a consumer-only grep is blind to that.

A thin-ification audit that checked page and site references only listed
`assets/images/uploads/e2e-preview-media-probe.png` as a stray upload safe to
delete. It is the sentinel `e2e/preview-media-resolves.spec.js` fetches to prove
the flat `media_folder` resolves on the preview surface — deleting it 404s the
probe and reds the REQUIRED `preview-media` check.

So: grep **all three repos**, `cms-platform/e2e` and `cms-platform/scripts`
included, before removing a consumer file. "No in-repo references" is a necessary
condition, never a sufficient one. (That specific sentinel is now lint-locked by
`checkMediaProbeSentinel()` in `scripts/check-platform-pin-consistency.js` and by
`e2e/scaffold-seeds-media-probe.test.js` — the class of miss is not.)
