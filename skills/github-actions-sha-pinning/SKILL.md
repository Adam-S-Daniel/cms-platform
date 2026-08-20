---
name: github-actions-sha-pinning
description: How cms-platform and its consumer sites pin GitHub Actions — third-party actions go to a bare full 40-character commit SHA with NO trailing version comment, and a cross-repo reference to cms-platform's own reusable workflows or composite actions stays on its release tag — plus the 7-day cooling-off before adopting a new release. Trigger when adding, editing, or auditing workflow files in cms-platform, adamdaniel.ai, or jodidaniel.com.
---

# GitHub Actions Security: SHA Pinning and Version Policy

Three rules govern every `uses:` line under `.github/workflows/` and
`.github/actions/` — with one shape carved out of Rule 1, and in a consumer
that shape is the whole population. Read `## Scope` at the end before acting
on any of this in a repo other than cms-platform.

The short version: **SHA, and nothing after it — unless the target is this
account's own platform repo, in which case a release TAG, and nothing after it
either.** No `uses:` line in any of the three repos carries a version comment
any more.

## Rule 1: Pin every action by full commit SHA

Git tags are mutable — a compromised maintainer can move a tag to arbitrary code. Commit SHAs are immutable and tamper-proof.

```yaml
# WRONG — mutable tag
- uses: actions/checkout@v4

# WRONG — trailing version comment (retired 2026-08-20; see Rule 2)
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1 (2026-07-17)

# RIGHT — immutable SHA, nothing after it
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
```

Every **third-party** `uses:` line must be a full 40-character commit SHA. AGENTS.md's "Pinning GitHub Actions" section — synced fleet-wide from `_agent-guidance` — is the source of that universal rule; what this skill adds is the cms-platform-specific mechanics, starting with the one shape the rule does NOT reach.

### The carve-out: a CROSS-REPO reference to cms-platform stays on the release TAG

**`uses: Adam-S-Daniel/cms-platform/.github/workflows/<name>.yml@v0.1.85` is correct exactly as written. Do NOT rewrite it to a SHA.** The same goes for a composite: `uses: Adam-S-Daniel/cms-platform/.github/actions/<name>@v0.1.85`. For those shapes the tag is not a mutable pointer someone forgot to nail down — it IS the version, and two pieces of machinery read it as such:

- **The pin-consistency lint asserts the ref EQUALS `platform.lock`'s `platform_ref`.** `scripts/check-platform-pin-consistency.js`'s `classifyUses()` sorts both `<owner>/<repo>/.github/workflows/<n>.yml@<ref>` and `<owner>/<repo>/.github/actions/<n>@<ref>` into a platform ref and hands the raw `<ref>` straight to `record()`, which files a violation on anything that is not the canonical version string. A 40-character SHA is never equal to `v0.1.85`, so SHA-pinning either shape is a guaranteed non-zero exit — the lint reports your "fix" as the breakage.
- **`platform-bump.yml` can no longer move it, and fails SILENTLY.** Its rewrite matches `…/.github/(?:workflows|actions)/[^@\s]+@` followed by `v[0-9]+(?:\.[0-9]+){0,3}` — a version literal, not a SHA. A SHA-pinned ref simply does not match, so the bump skips it without a word and the next pin-consistency run reds the PR. The caller then keeps executing whatever platform tree it was frozen at: structurally the same failure as #220, where jodidaniel.com's `cms-scheduled-publish-loop` ran a v0.1.59 tree for 14 releases because one value the bumper could not rewrite went unnoticed.

**Composite actions used to be the opposite case; as of 2026-08-20 they are not.** A cross-repo composite was SHA-pinned, with its version gate in a trailing `# vX.Y.Z` comment that the checker read with a deliberate LINE-AWARE pass. That comment went with the fleet-wide retirement described in Rule 2 — the same drift and the same inconsistent Dependabot rewriting applied to it, and it was the last thing in the checker that had to parse a comment at all. A composite now takes the tag, which ties it to `platform.lock`'s `platform_ref` directly and is auditable structurally.

So the checker recognises **two** shapes under **one** discipline: a platform ref (reusable workflow OR composite action) pinned by TAG, and the `platform_ref:` INPUT carrying the same version literal. `docs/PIN-CONSISTENCY.md` is the full account — read it before changing anything in this section, and keep the two in step.

Note what did NOT change: a composite is still a piece of code executing on a runner with the job's token, and a tag is still mutable. The carve-out is safe here for the same reason it is safe for the reusables — the tag points at a repo **this account owns and controls**, and `platform-bump.yml` moves every one of those refs to a single release atomically. Nothing third-party is ever a tag.

## Rule 2: No trailing version comment on ANY pin (reversed 2026-08-20)

**A `uses:` line ends at its ref — `@<sha>` for a third-party action, `@<tag>` for a platform ref. Do not append `# vX.Y.Z`, `# vX.Y.Z (YYYY-MM-DD)`, or any other version label to either.**

This reverses the previous rule, which required a dated comment. The measured reason: the comment goes stale silently and then actively **lies**, and a wrong label is worse than no label because it is read and believed. Dependabot's rewriting of it is **inconsistent and cannot be relied on** — it rewrote a bare `# v5` to `# v7.0.0` in GHA-bench#52 while leaving `# v4` stale on the line above **in the same file**, and left every `# vX.Y.Z (YYYY-MM-DD)` comment untouched in skills-evals #38/#39/#40 while moving their SHAs. The result was `actions/checkout` at v7.0.1 labelled `# v4.3.1` in one file and `# v6.0.0` in two others in the same repo.

The SHA is the truth. **When you need the version, resolve it:**

```bash
git ls-remote https://github.com/actions/checkout | grep <sha>
```

or read it off the Dependabot PR title.

The machinery that existed to keep the comments honest — `.github/workflows/dependabot-comment-sync.yml`, its self-caller, the consumer template, and `scripts/sync-action-pin-comments.sh` — is **deleted**. Do not reintroduce a comment-writing job: `sync-action-pin-comments.sh` treated the comment as OPTIONAL in its match, so it rewrote a comment-LESS line to GROW one, and a single manual run would undo the fleet change.

### There are NO surviving version comments — including on a platform ref

An earlier revision of this rule kept ONE exception: a cms-platform **composite** pin stayed `@<sha>  # v0.1.88`, on the argument that there the comment was not a label but the **pin-consistency GATE**, machine-checked on every PR and therefore unable to go quietly stale.

That exception is **retired**. It was true that the comment was checked — and still the wrong design, for two reasons:

- **It kept a comment-parsing pass alive in the checker** for exactly one shape, which is the "one justified regex exception" that AGENTS.md's "AST always, never regex" rule exists to resist. Moving the version into the `@ref` deletes the exception instead of documenting it.
- **A single carve-out is what makes a fleet rule fail to land.** A rule stated as "never a version comment, except here" invites the next agent to decide their case is also the exception, and invites comment-writing machinery back to service that one shape. `sync-action-pin-comments.sh` matched the comment as OPTIONAL, so it rewrote comment-LESS lines to GROW one — a single run against a repo kept "for the composite's sake" would have undone the fleet change everywhere.

So: **a `uses:` line ends at its ref, in all three repos, with no exceptions.** If you find a version comment on one, it is a leftover, and `scripts/verify-consumer-pins.sh`'s stale-token check is what turns a drifted one into a finding rather than an invisible lie.

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

## Scope — WHICH repo you are in changes the answer

This skill ships in the **`cms-platform` bundle** on the `agentskills` marketplace, so it loads wherever that bundle is installed: cms-platform itself, and the two consumer sites that name it as a source in their own `skills.lock` — **adamdaniel.ai** and **jodidaniel.com**. "This repo" is therefore ambiguous, and the three repos have materially different pin populations. Read the rules against the one in front of you.

- **In cms-platform**, every `uses:` is either a third-party action or a local `./` path. It references neither its own reusable workflows nor its own composites across a repo boundary, so the carve-out never fires here and Rule 1 applies without exception: `actions/checkout`, `actions/github-script`, `actions/setup-node`, `actions/upload-artifact`, `ruby/setup-ruby`, `aws-actions/configure-aws-credentials` and the rest are all pinned to a bare SHA with **nothing after it** — in `.github/workflows/` **and** inside the `.github/actions/` composite definitions, which carry `uses:` lines of their own. The `./…` refs have nothing to pin; leave them. (This is also why the tag carve-out is currently DORMANT: it is shipped and would re-arm the moment a consumer referenced a platform composite, but nothing does today.)
- **In a consumer (adamdaniel.ai, jodidaniel.com), the carve-out IS the entire population.** Every `uses:` line in both repos — 32 apiece at v0.1.85 — targets `Adam-S-Daniel/cms-platform/.github/workflows/*.yml@<tag>`. Neither repo pins a single third-party action, and neither calls a composite action directly today; if one ever does, it takes the same `@<tag>` form. **There is nothing in a consumer for Rule 1 to fix.** If this skill has you in a consumer reaching for `gh api …/git/ref/tags/…` to convert those 32 refs to SHAs, stop — you are about to break the release machinery in both of the ways the carve-out describes, and you will have "fixed" a repo that had no violation to begin with.

Within whichever repo you are in, the rules reach every `uses:` line under `.github/workflows/` and `.github/actions/`.

## Dependabot interaction

Dependabot's github-actions ecosystem updates the `@<sha>` ref. It is now the ONLY thing it needs to update, because a third-party pin carries no comment (Rule 2). Nothing about a Dependabot PR needs a follow-up commit any more, and no `workflows`-scoped credential is needed to service one.

### Why a drifted comment could never self-repair — the evidence behind Rule 2's reversal

**Dependabot only rewrites a pin comment that matches the version it is bumping FROM.** Once the comment and the SHA disagree, every subsequent bump leaves the comment alone and the gap WIDENS. Both live instances on cms-platform, found when comment-sync was first dogfooded on this repo (it had been shipped to consumers and never run here): PR #179 carried `actions/setup-node` **v7.0.0**'s SHA behind `# v6.4.0 (2026-04-20)` across 18 files, and PR #194 bumped 6.2.2 → 6.2.3 while its comment still said `v6.1.1` — so the rewrite could never match. This is structurally the SAME trap as #220's frozen `platform_ref`, where a generic `CUR`→`LATEST` literal replace could not match an already-drifted value either.

The account first answered this with an out-of-band sync that read the SHA's ACTUAL tag. The 2026-08-20 measurement retired that answer in favour of removing the field: Dependabot's behaviour is not merely incomplete but **inconsistent** (it refreshed one comment and not its neighbour in the same file — GHA-bench#52), so no amount of syncing makes the label trustworthy, and an untrustworthy label that is nonetheless believed is a net negative. The general lesson survives its instance: **a repair keyed on the old value cannot fix a value that has already drifted past it** — and the cheapest repair is often deleting the derived field rather than keeping it in sync.

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
