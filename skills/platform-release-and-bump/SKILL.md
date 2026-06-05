---
name: platform-release-and-bump
description: Cut a new cms-platform release (vX.Y.Z) and reconcile BOTH consumer repos (adamdaniel.ai, jodidaniel.com) to it in single-version lockstep. Use when you've merged a platform fix and need it to flow to consumers, when bumping platform_ref, or when the pin-consistency guard fails after a partial bump. Covers the release dispatch, the exact set of references to bump (platform_ref, gem tag+revision, workflow @ref pins, composite-action SHA, the trailing # vX.Y.Z comments), the pin-consistency check, and the lockstep invariant. Trigger on "cut a release", "release vX.Y.Z", "bump platform_ref", "reconcile consumers", "platform-pin-consistency", or "flow the fix to consumers".
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

- **adamdaniel.ai** — pins reusable workflows by **`@<40-hex-SHA>`** with a
  trailing `# vX.Y.Z (date)` comment, PLUS a composite-action SHA pin
  (`post-failure-comment@<SHA>`). So a bump replaces BOTH the old `vX.Y.Z`
  string AND the old 40-hex SHA → the new ones.
- **jodidaniel.com** — pins reusable workflows by **`@vX.Y.Z`** tag (no SHA),
  so only the version string changes — EXCEPT `Gemfile.lock`'s git `revision:`
  is the resolved commit SHA and must move to the new release commit too.

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
`.github/workflows/*` (`uses:@` pins + `platform_ref:` with-inputs + the
composite `@<SHA> # vX.Y.Z` pins).

## 3. Verify, then commit + PR + merge

```bash
node ~/repos/cms-platform/scripts/check-platform-pin-consistency.js --root .
# → MUST print "OK — all N reference(s) ... agree on platform_ref vX.Y.Z"
```

If it reports a mismatch, a reference was missed (commonly `Gemfile.lock`'s
`revision:` on jodidaniel, or a stale `# vX.Y.Z` trailing comment). Fix, re-run.
Then commit, push, open the PR, and merge once CI is green. adamdaniel's `e2e`
gate is REQUIRED (wait for the real run, not just the docs-stub); jodidaniel's
parity/e2e are non-required.

## The lockstep invariant + gotchas

- **Keep BOTH consumers on the same version.** A platform-infra-only release
  (e.g. a test-harness fix) is still worth bumping both, so they never skew —
  the pin-consistency guard is per-repo, but lockstep across repos is the design.
- **`platform-bump.yml`** automates step 2 on a schedule/dispatch and is now an
  **atomic single-version bump** (issue #13 **resolved**, v0.1.23): it rewrites
  EVERY version ref in one PR — `platform_ref:` + `platform.lock`, the `uses:@`
  pins, the gem `tag:`, `Gemfile.lock` `tag:` + `revision:` (it resolves the
  release commit sha itself), and any composite `@<sha>` pin — so its PR passes
  `pin-consistency` alone. It checks out with the caller PAT (`secrets.gh_token`
  = `CMS_PLATFORM_PAT`, which MUST carry **Workflows: write** / `workflow` scope)
  so the workflow-file push is authorised — otherwise GitHub rejects it
  (`refusing to allow ... to update workflow ... without 'workflows' permission`).
  Locked by `e2e/platform-bump-atomic.test.js`. **Caveat:** a consumer only gets
  the atomic bump once its `platform-bump` thin caller pins a release that
  CONTAINS this fix (≥ v0.1.23); to bump a consumer still on an older caller,
  do step 2 manually (above). Dependabot remains wired as an independent net.
- **Co-arrival cancels loops:** a push touching `.github/workflows/**` is
  salient to every prod-mutating loop and cancels in-flight ones (shared
  `prod-mutating-loop` concurrency lane). Do consumer bumps, THEN let the loops
  settle before dispatching a validation loop.
- **Release cadence example (this is normal):** one session shipped
  v0.1.13→v0.1.17, bumping both consumers after each — that's five cascades.

## Definition of done — do NOT stop at "merged + bumped"

A release + consumer bump is not complete until you've also (this is Adam's
explicit bar — green unit lints routinely ship a live regression):

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
