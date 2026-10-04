---
name: platform-release-and-bump
description: Cut a new cms-platform release (vX.Y.Z) and reconcile BOTH consumer repos (adamdaniel.ai, jodidaniel.com) to it in single-version lockstep. Use when you've merged a platform fix and need it to flow to consumers, when bumping platform_ref, or when the pin-consistency guard fails after a partial bump. Covers the release dispatch, the exact set of references to bump (platform_ref, gem tag+revision, workflow and composite @ref pins), the pin-consistency check, and the lockstep invariant. Trigger on "cut a release", "release vX.Y.Z", "bump platform_ref", "reconcile consumers", "platform-pin-consistency", or "flow the fix to consumers".
compatibility: Requires gh CLI authed to Adam-S-Daniel (repo + workflow scope) and Node 20. Run from ~/repos/{cms-platform,adamdaniel.ai,jodidaniel.com}.
---

# Cut a platform release + reconcile consumers (lockstep)

A cms-platform fix only reaches a consumer when the consumer's `platform_ref`
(and every co-pinned reference) points at a RELEASE that contains it. The
consumers are kept in **single-version lockstep** — every platform-version
reference in a consumer repo agrees on ONE `vX.Y.Z` (enforced by the
pin-consistency guard, issue #29). So a platform change is a 3-step cascade:
**release → bump each consumer → verify**.

## 1. Cut the release

The release workflow tags `main` HEAD + creates a GitHub Release. Merge your
fix to `main` and confirm `main`'s self-CI is green FIRST, then:

```bash
gh workflow run release.yml -R Adam-S-Daniel/cms-platform -f version=vX.Y.Z --ref main
# the release tag == main HEAD; grab its SHA (you need it for the composite pin):
gh api repos/Adam-S-Daniel/cms-platform/git/refs/tags/vX.Y.Z --jq '.object.sha'
```

## 2. Bump each consumer

A consumer pins the platform in MANY places; they must ALL move together or
the pin-consistency guard fails. The two consumers differ slightly:

- **Both consumers** pin every cross-repo platform ref — reusable workflow and
  composite action alike — by **`@vX.Y.Z`** TAG, so only the version string
  changes. Measured 2026-08-20: 32 `@v0.1.88` refs in adamdaniel.ai, zero SHA
  pins, zero pin comments; jodidaniel.com the same shape.
- **jodidaniel.com additionally** has `Gemfile.lock`'s git `revision:`, which is
  the resolved commit SHA and must move to the new release commit too.
- **Historical, and why a stale doc here bites:** adamdaniel.ai once SHA-pinned
  its reusables with a trailing `# vX.Y.Z (date)` comment, and composites were
  SHA-pinned with the version in that comment. Both forms are gone — the tag
  carve-out took the reusables, and the 2026-08-20 fleet retirement of the pin
  comment took the composites (see the `github-actions-sha-pinning` skill). A
  bump replaces version STRINGS now; if you find yourself hunting 40-hex SHAs in
  a consumer's workflows, you are working from the old model.

The robust, idempotent way (handles the unicode-quoted-filename trap — use
`git ls-files -z`, not plain `ls-files`):

```bash
cd ~/repos/<consumer>
git fetch origin --quiet && git checkout -b chore/bump-platform-vX.Y.Z origin/main
python3 - <<'PY'
import subprocess, pathlib
OLD_VER="vA.B.C"; NEW_VER="vX.Y.Z"
OLD_SHA="<old release SHA>"; NEW_SHA="<new release SHA>"
for fb in subprocess.check_output(["git","ls-files","-z"]).split(b"\0"):
    if not fb: continue
    p = pathlib.Path(fb.decode("utf-8","surrogateescape"))
    try: t = p.read_text()
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError): continue
    if OLD_VER not in t and OLD_SHA not in t: continue
    n = t.replace(OLD_SHA, NEW_SHA).replace(OLD_VER, NEW_VER)
    if n != t: p.write_text(n)
PY
```

References the replace covers: `platform.lock` (`platform_ref:` + `tag:`),
`Gemfile` (`tag: "vX.Y.Z"`), `Gemfile.lock` (`tag:` + `revision:` — the SHA
replace moves the revision for adamdaniel; for jodidaniel set `revision:`
explicitly to the new release SHA since its files carry no SHA strings),
`.github/workflows/*` (`uses:@` pins — reusable and composite alike, both
tag-pinned — plus `platform_ref:` with-inputs).

**This manual path does NOT seed newly-dictated workflow callers** — unlike
`platform-bump.yml` (below), it only rewrites pins in files the consumer
already has. If `check-platform-pin-consistency.js` reports `workflow-set:
MISSING (platform-dictated)` after a manual bump, either copy the missing file
from `examples/site/.github/workflows/<name>.yml` by hand and re-pin it, or
just use the automated `platform-bump.yml` reusable instead.

## 2b. Sequencing: let other `main` merges settle first

`platform-bump` branches off `main` at the moment it runs, so dispatching it
while another PR is mid-merge cuts the bump branch from the PRE-merge tree.
That either conflicts on `update-branch` (`422 merge conflict between base and
head`), or — worse — makes the bump PR run the new release's checks against a
tree that is missing the other PR's fix. Both happened at v0.1.81. If a bump PR
is already open and stale, REGENERATE it from current `main` rather than
merging through the conflict, and re-run the verifier below before
force-pushing. See `docs/PIN-CONSISTENCY.md`, "A bump PR cut in the same minute
as another `main` merge carries a stale tree".

## 3. Verify, then commit + PR + merge

**The bump is done when this exits 0 — nothing else counts as verification.**
Run it from the CONSUMER repo root:

```bash
bash ~/repos/cms-platform/scripts/verify-consumer-pins.sh --platform-dir ~/repos/cms-platform
# → last line MUST be "verify-consumer-pins: PASS"   (exit 0)
```

It asserts `platform.lock`'s `platform_ref`, that NO other platform version ref
survives in `platform.lock` / `Gemfile` / `Gemfile.lock` / `.github/workflows/`,
that every workflow parses as YAML, and then runs
`check-platform-pin-consistency.js --require-canonical`, parity included.
**A green run of this script — not a visual diff review, and not a report that
says the edits look complete — is what makes a consumer bump done.** Never
substitute the bare checker: without `--require-canonical` (and a canonical set)
it skips the workflow-SET and workflow-CONTENT parity that police a consumer's
`secrets:` map, and still exits 0. It does say so — a degraded run prints a
"workflow-set parity skipped" notice and ends "parity is UNVERIFIED" rather than
"Pins are consistent" — but an exit-0 run with a notice is one CI does not fail
on, which is why the flag, not the reader, has to be the thing that enforces it.
Don't look for a fixed check COUNT here — it is
derived from how many pin references the consumer's tree carries and moves with
every workflow added or removed, which is why the numbers this paragraph used to
quote ("96", degrading to "61") were both stale when measured on 2026-08-20 (90
and 57, on both consumers, at `platform_ref` v0.1.86). Read the count off the
script's own summary line, which prints the real one every run.

If it reports a mismatch, a reference was missed (commonly `Gemfile.lock`'s
`revision:` on jodidaniel, or a stale version token in a LEFTOVER `# vX.Y.Z`
trailing comment — house style carries none since 2026-08-20). Fix, re-run.
Then commit, push, open the PR, and merge once CI is green. adamdaniel's `e2e`
gate is REQUIRED (wait for the real run, not just the docs-stub); jodidaniel's
parity/e2e are non-required.

**Delegating the bump?** Put that exact command in the spec as the definition of
done and require its exit code in the report; a subagent that cannot run it must
report BLOCKED rather than describe partial work as progress. See cms-platform
`docs/CONTRIBUTING.md` "Delegated mechanical work is done when a VERIFIER exits
0" for the v0.1.76 incident this rule comes from.

## The lockstep invariant + gotchas

- **Keep BOTH consumers on the same version.** A platform-infra-only release
  (e.g. a test-harness fix) is still worth bumping both, so they never skew —
  the pin-consistency guard is per-repo, but lockstep across repos is the design.
- **`platform-bump.yml`** automates step 2 and is dispatched by `release.yml` the moment a release is cut (no cron; re-dispatch by hand if that failed) and is now an
  **atomic single-version bump** (issue #13 **resolved**, v0.1.23): it rewrites
  EVERY version ref in one PR — `platform_ref:` + `platform.lock`, the `uses:@`
  pins, the gem `tag:`, `Gemfile.lock` `tag:` + `revision:` (it resolves the
  release commit sha itself), and any composite `@<tag>` pin — so its PR passes
  `pin-consistency` alone. It checks out with a **Workflows: write** credential
  so the workflow-file push is authorised — otherwise GitHub rejects it
  (`refusing to allow ... to update workflow ... without 'workflows' permission`).
  Since #238 that credential is the CMS automation App's per-run installation
  token, minted from `vars.CMS_AUTOMATION_APP_ID` + the `app_private_key`
  secret (nothing to rotate). The caller-PAT fallback (the `gh_token` input)
  was REMOVED in v0.1.103, so a consumer without the App fails the bump with
  an `::error::` naming both knobs.
  Locked by `e2e/platform-bump-atomic.test.js` and
  `e2e/app-token-platform-writers.test.js`. It also seeds any workflow
  caller the release newly made platform-dictated (a file
  `examples/site/.github/workflows/` gained since the consumer's last bump),
  so the bump PR passes the workflow-set-parity check too, not just
  pin-consistency. **Caveat:** a consumer only gets the atomic bump once its
  `platform-bump` thin caller pins a release that CONTAINS this fix (≥
  v0.1.23); to bump a consumer still on an older caller, do step 2 manually
  (above). **Neither Dependabot ecosystem is wired as a net for a
  cms-platform reference anymore.** Since #242 the `bundler` ecosystem
  `ignore`s `cms-platform-theme`, and since #244 the `github-actions`
  ecosystem `ignore`s every `Adam-S-Daniel/cms-platform/*` ref (reusable and
  composite `uses:@<tag>` pins alike) — `platform-bump` is
  the sole bumper of everything a consumer pins to the platform. Dependabot
  stays wired only for the site's own non-cms-platform deps (see cms-platform
  `docs/SYNC.md`).
- **Loop triggers are pairwise-disjoint (#70); the shared lane serializes
  time-overlap.** Each real-prod loop's heavy job shares the
  `prod-mutating-loop` concurrency group (HARD mutual exclusion — never two
  loops mutating prod at once), but a push used to fire MULTIPLE loops at once
  (shared salient paths) and GitHub then cancel-EVICTED the co-arriving sibling
  (1 running + only the latest pending kept). Fixed by making the three loops'
  push paths disjoint: prod OWNS the shared infra paths on push; media/host
  cover them via their daily cron. So a consumer bump (a `.github/workflows/**`
  push) now fires at most one loop, and the shared group queues any remaining
  cron/dispatch time-overlap rather than evicting it. Still: do consumer bumps,
  THEN let the loops settle before dispatching a validation loop.
- **A release that changes an `examples/site` caller's `secrets:` map is
  reconciled BY `platform-bump`, in the bump commit.** The pin-consistency
  guard's workflow-CONTENT parity check compares each job's `secrets:` map
  **WHOLE, including VALUES** (`stableStringify(a.secrets) !==
  stableStringify(b.secrets)`) and **symmetrically**, against the template at
  the **CONSUMER's own `platform_ref`** — i.e. the NEW ref the bump PR
  introduces — so a mismatch surfaces first on the bump PR itself, and the fix
  cannot be split into its own PR. `platform-bump` therefore runs
  `scripts/reconcile-caller-secrets.js` (fetched at the new ref, beside the
  checker whose `structuralShape()` it reuses) over every existing caller:
  keys the template gained are added with the template's comments, keys it
  dropped are removed, changed values take the template's; the consumer's own
  comments and formatting are kept, and the result is re-parsed before it is
  saved. The PR body names each reconciled job. **Before this (v0.1.113 →
  v0.1.114) it was a hand edit:** #467 added `app_private_key` to the
  `dependabot-rearm-sweep` template, and both bump PRs (adamdaniel.ai#3891,
  jodidaniel.com#281) failed `workflow-content: DRIFT ... secrets: map` until
  it was added by hand. **When it still needs a hand edit:** the PR body
  carries a `:warning:` naming a `secrets:` map that could NOT be reconciled
  (a flow-style job, an anchored map — the run log's `MANUAL` line says which),
  or the bump targets a release older than the script. Then add or drop the
  `secrets:` lines in the same bump PR, exactly as the template has them.
  The same lesson covers a release that REMOVES a dictated caller: workflow-set
  parity reports EXTRA unless the thin caller is deleted in the same commit as
  the `platform_ref` bump, which `platform-bump` now does too (#315). This is
  the class of drift that let jodidaniel's sweep caller silently lose its
  `CMS_E2E_PAT` map and `startup_failure` for weeks — now caught, and fixed,
  at the bump.
- **v0.1.76 also changes 9 workflow callers' `pull_request` types** (dropping
  `edited` — #222 part 2), so both consumers' bump PRs carry that 9-file edit
  alongside the pin rewrite. **`deploy-preview.yml` is the ONE exception and
  KEEPS `closed`** — it is the only caller declaring it, and the reusable's
  teardown (S3 `rm --recursive` + CloudFront invalidation + bot-comment update)
  fires only on that action; the replacement lint asserts `closed` POSITIVELY,
  so applying the generic diff there fails self-CI. Residual risk to record
  beside `delete_branch_on_merge=true`: dropping `edited` reverts #145 / PR #166,
  whose case is a PR **retargeted onto a different base** — that fires
  `pull_request: edited` and, with no listener, the whole required suite silently
  never re-runs against the new base. `delete_branch_on_merge=true` makes GitHub
  auto-retarget dependent PRs, so the precondition is now MORE likely, and a base
  retarget changes the effective diff **without** emitting `synchronize`. The
  justification is the measurement: the guard fired twice in four days,
  self-heals on any PR that gets another push, and there were **zero** base
  retargets in 60 PRs.
- **Release cadence example (this is normal):** one session shipped
  v0.1.13→v0.1.17, bumping both consumers after each — that's five cascades.

## Definition of done — do NOT stop at "merged + bumped"

A release + consumer bump is not complete until you've also (this is Adam's
explicit bar — green unit lints routinely ship a live regression):

0. **Got `scripts/verify-consumer-pins.sh` to exit 0 on EVERY bumped consumer**
   (step 3 above) — the pin half of the bump is not done on prose, only on that
   exit code.
1. **Driven the prod-mutate validation loop to GREEN** — dispatch
   `cms-publish-loop-prod.yml` (and `cms-media-roundtrip.yml` if relevant) on
   the affected site and iterate until a run succeeds end-to-end
   (create → reflect → delete → 404). The live loop catches what unit lints and
   even an adversarial multi-agent review miss (e.g. the double-`dialog.accept()`
   crash on loop 27013147945).
2. **Audited + driven every workflow green** — each workflow re-ran after the
   last real (non-generated) change and its latest run SUCCEEDED.
3. **Cleared OPTIONAL checks too** — drive `UNSTABLE` → clean, not just
   `BLOCKED` → mergeable; a red non-required check still isn't done (unless it's
   a known user-credential / go-live blocker, which you surface explicitly).

See cms-platform AGENTS.md "Definition of done (non-trivial changes)".
