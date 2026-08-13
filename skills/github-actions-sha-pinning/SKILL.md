---
name: github-actions-sha-pinning
description: Project-local rules for pinning every GitHub Actions `uses:` reference in this repo's `.github/workflows/` to a full 40-character commit SHA with a version comment, plus the 7-day cooling-off period before adopting new releases. Trigger when adding, editing, or auditing workflow files.
---

# GitHub Actions Security: SHA Pinning and Version Policy

All GitHub Actions in `.github/workflows/` must follow these three rules.

## Rule 1: Pin every action by full commit SHA

Git tags are mutable — a compromised maintainer can move a tag to arbitrary code. Commit SHAs are immutable and tamper-proof.

```yaml
# WRONG — mutable tag
- uses: actions/checkout@v4

# RIGHT — immutable SHA with version comment
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
```

Every `uses:` line must reference a full 40-character commit SHA followed by a comment containing the exact version number (`# vX.Y.Z`).

## Rule 2: Always include a version comment

Append `  # vX.Y.Z` (two spaces before `#`) to the right of the SHA on the same line. This is required so humans can tell at a glance which version is pinned and agents know when to check for updates.

## Rule 3: 7-day cooling-off period

When a new version of an action is released, **do not adopt it until at least 7 days after its release date**. This guards against supply-chain attacks where a compromised version is published and quickly revoked.

Before upgrading, check the release date:

```bash
gh api repos/{owner}/{repo}/releases --jq \
  '[.[] | select(.tag_name | startswith("vMAJOR."))] | .[0] | {tag: .tag_name, date: .published_at}'
```

If `published_at` is less than 7 days ago, do not upgrade yet.

## How to resolve a tag to a commit SHA

### Step 1 — Find the latest patch release under the major version

```bash
gh api repos/{owner}/{repo}/releases --jq \
  '[.[] | select(.tag_name | startswith("v4."))] | .[0] | {tag: .tag_name, date: .published_at}'
```

### Step 2 — Resolve the tag to a SHA

```bash
gh api repos/{owner}/{repo}/git/ref/tags/{tag} --jq '.object'
```

If `object.type` is `"tag"` (annotated tag), dereference to the commit:

```bash
gh api repos/{owner}/{repo}/git/tags/{tag_object_sha} --jq '.object.sha'
```

If `object.type` is `"commit"`, the `object.sha` is already the commit SHA.

## Scope

These rules apply to every `uses:` line in every file under `.github/workflows/`.

## Dependabot interaction

Dependabot's github-actions ecosystem updates the `@<sha>` ref and the version part of the trailing comment, but it does NOT refresh the `(YYYY-MM-DD)` release-date suffix this repo's pinning convention requires — and over a few bumps the `vX.Y.Z` part of the comment can drift behind the SHA. The `dependabot-comment-sync.yml` workflow runs on every Dependabot PR and pushes a follow-up commit that rewrites every drifted `# vX.Y.Z (YYYY-MM-DD)` comment to match the new SHA's actual tag and tag-commit date. Do NOT manually fix Dependabot's comments — the sync workflow handles it before the auto-merge gate fires.

**The workflow needs a `workflows`-scoped credential, and there are TWO accepted shapes.** The PAT is preferred: `CMS_PLATFORM_PAT` (a fine-grained PAT with Contents + `workflows: write` — the same token platform-bump uses), passed as the `workflow_sha_comment_pat` secret. The fallback is a **GitHub App** (Contents R/W + Pull requests R/W + Workflows R/W) from which the reusable mints a short-lived installation token: its ID is read from the caller repo's `vars.CMS_AUTOMATION_APP_ID` **variable** and only its private key is a secret (`app_private_key` ← `CMS_AUTOMATION_APP_PRIVATE_KEY`). The App exists for a repo with no PAT of its own — cms-platform itself, since that PAT lives in the consumers. The PAT wins when both are present, so a consumer's existing path is unchanged; with NEITHER configured the job logs a `::notice::` naming all three knobs and exits cleanly, never reddening a Dependabot PR. Full setup: the `cms-platform-secrets` skill.

### Why a drifted comment can never self-repair

**Dependabot only rewrites a pin comment that matches the version it is bumping FROM.** Once the comment and the SHA disagree, every subsequent bump leaves the comment alone and the gap WIDENS. Both live instances on cms-platform, found when comment-sync was first dogfooded on this repo (it had been shipped to consumers and never run here): PR #179 carried `actions/setup-node` **v7.0.0**'s SHA behind `# v6.4.0 (2026-04-20)` across 18 files, and PR #194 bumped 6.2.2 → 6.2.3 while its comment still said `v6.1.1` — so the rewrite could never match. This is structurally the SAME trap as #220's frozen `platform_ref`, where a generic `CUR`→`LATEST` literal replace could not match an already-drifted value either. The lesson generalises: **a repair keyed on the old value cannot fix a value that has already drifted past it** — which is exactly why the fix is an out-of-band sync that reads the SHA's ACTUAL tag, not a smarter replace.

### The cooling-off is MECHANISED on cms-platform (and only there), and it is GRADUATED

Rule 3 above is a convention a reviewer has to remember. On cms-platform it is now enforced by the bot: `.github/dependabot.yml` gives **both** ecosystems — `github-actions` and the `/e2e` `npm` harness — a graduated minimum package age:

```yaml
cooldown:
  default-days: 7
  semver-major-days: 30
```

The reason is blast radius — repairing the Dependabot pipeline (comment-sync + the re-arm sweep) removed the last human gate on a fresh third-party action SHA landing in the 18 reusables **both** production sites execute, so the wait has to be enforced by the bot rather than by whoever happens to review the PR. The `/e2e` harness gets the same treatment because it is not platform-internal either: both consumers check it out and execute it, so a bad Playwright major reaches production CI the same way a bad action SHA would.

Four facts worth carrying:

- **7 is a RAISE, not a floor from zero.** GitHub's own default minimum package age is **3 days**, so an unset `cooldown` is not "no wait" — writing 7 doubles it and makes the number reviewable.
- **Majors wait 30 days because a major is the class that has actually needed reverting here** — `setup-node` 6→7 (#179) lands in 18 reusables both sites execute, and the Decap bundle bump is kept revertible on purpose (v0.1.66 → v0.1.67). A Playwright major additionally REQUIRES a coupled `.github/ci-runner/Dockerfile` bump (the `playwright-image-drift` guard) that Dependabot cannot make in the same PR, so 30 days is room to do it deliberately rather than in a red-CI scramble.
- **Leave `semver-minor-days` / `semver-patch-days` undefined.** GitHub's documented precedence falls an undefined `semver-*-days` back to `default-days`, so spelling them out only invites the three numbers to drift apart. (`include:` / `exclude:` per-dependency lists exist too; nothing here needs them.)
- **Cooldown is version-updates-only.** A security advisory bypasses it by GitHub's spec, so it still opens — and auto-merges — the moment the matrix is green. Cooldown never delays a fix.

**Do NOT add a cooldown to a CONSUMER's `github-actions` ecosystem — and the reason matters, because the first one recorded was wrong, and the second one is gone too.** The original claim was that a consumer cooldown "would delay every release's adoption"; that mechanism does not hold. Release adoption is landed by `platform-bump.yml`, which opens the bump PR itself (the last five releases all arrived as `platform/bump-vX.Y.Z`), so Dependabot is not on the adoption path. The actual primary reason is verified and simpler: **neither consumer pins a single third-party action** — every `uses:` in both repos targets `Adam-S-Daniel/cms-platform/.github/workflows/*.yml` — so a consumer cooldown has no supply-chain surface to hold and would be inert config that reads as policy. A second reason recorded here used to be that Dependabot was a backstop that bumped a platform pin when `platform-bump` hadn't run, and cooling that off would delay our own release — **that reason is gone as of #244**: the `github-actions` ecosystem now carries an explicit, unscoped `ignore` for `Adam-S-Daniel/cms-platform/*`, so there is no cms-platform Dependabot activity there for a cooldown to gate at all, structurally the same position #242 already put the `bundler` ecosystem in for the `cms-platform-theme` gem — `platform-bump` is the sole bumper of every cms-platform reference either ecosystem could otherwise touch (see cms-platform `docs/SYNC.md`).
