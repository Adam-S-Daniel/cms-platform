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

Dependabot's github-actions ecosystem updates the `@<sha>` ref and the version part of the trailing comment, but it does NOT refresh the `(YYYY-MM-DD)` release-date suffix this repo's pinning convention requires — and over a few bumps the `vX.Y.Z` part of the comment can drift behind the SHA. The `dependabot-comment-sync.yml` workflow runs on every Dependabot PR and pushes a follow-up commit that rewrites every drifted `# vX.Y.Z (YYYY-MM-DD)` comment to match the new SHA's actual tag and tag-commit date. Do NOT manually fix Dependabot's comments — the sync workflow handles it before the auto-merge gate fires. The workflow requires the `ADAMDANIELAI_WORKFLOW_SHA_COMMENT_PAT` repo secret (a fine-grained PAT with `workflows: write`) and self-skips with a `::notice::` when the secret is unset.
