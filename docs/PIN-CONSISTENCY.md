# Platform-pin consistency (anti-skew)

What this is: how `scripts/check-platform-pin-consistency.js` keeps every
place a consumer references the platform version — reusable `uses:@ref`
pins, composite `uses:@ref` pins, `Gemfile`/`Gemfile.lock`
`tag:`, `platform.lock` `platform_ref`, and each caller's `platform_ref:`
input — in lockstep, plus the workflow-content (call-interface) parity check
that catches a thin caller whose body drifted from the canonical template.
Read this before changing the pin-consistency script, `platform-bump.yml`'s
seeding logic, or anything that adds a new "pin shape" a consumer can carry.
See also the `platform-release-and-bump` skill and `docs/SYNC.md`'s
"Single-version pin invariant".

## Single-version pin consistency guard (anti-skew, #29)

A consumer references the platform version in MANY places (every reusable
`uses: …/.github/workflows/<n>.yml@<ref>`, every cross-repo composite
`uses: …/.github/actions/<n>@<ref>`, the `Gemfile`/`Gemfile.lock`
`tag:`, and `platform.lock` `platform_ref`). Historically Dependabot + `platform-bump`
landed bumps PIECEMEAL, so consumers drifted (observed live: adamdaniel.ai pinned
`@v0.1.0` loop/deploy callers, gem `@v0.1.5`, others `@v0.1.3`/`@v0.1.6` at once — a
`v0.1.0` reusable against a `v0.1.5` gem is a latent bug source). **As of #244 that
race is fully closed, on both halves.** #242 took the gem `tag:` out of it first —
Dependabot's `bundler` ecosystem `ignore`s `cms-platform-theme`, so `platform-bump`
is the gem's only bumper — and #244 did the same for every `uses:@` platform
ref: Dependabot's `github-actions` ecosystem now `ignore`s every
`Adam-S-Daniel/cms-platform/*` dependency name too (see `docs/SYNC.md` for the
evidence and the wildcard-matcher detail). **No Dependabot ecosystem bumps a
cms-platform reference anymore** — `platform-bump` is the single writer of the
platform version a consumer carries, which is what makes the single-version
invariant below structurally maintainable rather than a race this guard merely
catches after the fact. **`platform-bump.yml`
rewrites `.github/workflows/*` and pushes, so its token (`CMS_PLATFORM_PAT`)
MUST carry `workflow` scope** or GitHub rejects the push (`refusing to allow …
to update workflow … without 'workflows' permission`) — the live half of #13.
It also seeds any workflow caller the release newly made platform-dictated —
copying the missing caller from `examples/site/.github/workflows/` at the new
ref, re-pinned to it — so the workflow-set-parity check (introduced v0.1.20,
#54) also passes on the bump PR alone. Observed live: v0.1.54 added
`dependabot-rearm-sweep.yml` and both consumers' bump PRs failed pin-consistency
with `workflow-set: MISSING (platform-dictated)` until hand-fixed.

`scripts/check-platform-pin-consistency.js` (platform-owned, Node, needs only the
repo's `yaml` lib) makes them all agree:

- **Canonical version = `platform.lock` `platform_ref`** (source of truth; missing/
  unparseable → hard fail with a clear message).
- Parses every `.github/workflows/**/*.yml` with the **`yaml` parser** (anchors
  resolved — NOT regex); collects `uses:@` refs targeting the platform owner/repo
  (configurable via `--owner/--repo`, defaulting from `platform.lock`
  `platform_repo`). Reusable refs `.../workflows/*.yml@<ref>`: the `<ref>` must ==
  `platform_ref`. Composite refs `.../actions/*@<ref>`: **the same rule** — the
  `<ref>` is a TAG and must == `platform_ref`.

  A composite used to be the exception: SHA-pinned, with its version carried in a
  trailing `# vX.Y.Z` COMMENT read by a LINE-AWARE pass (the one justified
  regex/line exception to "parse, don't scan"). That comment went with the
  2026-08-20 fleet-wide retirement of the action pin comment — it drifted
  silently and then actively lied, and Dependabot rewrote it inconsistently. The
  tag ties a composite to `platform.lock`'s `platform_ref` DIRECTLY and is
  auditable without parsing a comment, so the checker now reads no comments at
  all and reusables and composites obey one rule. The tag carve-out in AGENTS.md
  ("a reusable *workflow* from a repo this account owns stays on a tag") extends
  to these composites for exactly that reason; nothing third-party is ever a
  tag.
- **Checks the `platform_ref:` INPUT each caller passes (#220).** The reusable's
  platform checkout does `ref: ${{ inputs.platform_ref }}`, so this value — not
  the `uses:@` pin — decides WHICH platform tree the job actually runs. It is
  canonical by definition, **not** a site-specific `with:` value, which is
  precisely why the workflow-CONTENT parity check below (it deliberately MASKS
  `with:` VALUES) is blind to it: the one value that selects the platform tree
  was the one thing the anti-skew guard didn't check. A `platform_ref` Pair
  whose value is a MAP is an input DECLARATION, not a pin
  (`platform_ref: { type: string, default: main }` in the reusables) and is
  skipped; so is a `${{ … }}` expression (a forwarded parameter, not statically
  resolvable).
- Reads `Gemfile` (`gem "cms-platform-theme", …, tag:`) + `Gemfile.lock` (the
  cms-platform GIT-source `tag:`); both must == `platform_ref`. Tolerates a
  consumer with NO Gemfile; ignores non-cms-platform `uses:`.
- **Aggregates ALL** violations (doesn't stop at first); prints a precise per-file
  report (file + found + expected) + `::error file=` annotations under
  `GITHUB_ACTIONS`. Exit non-zero iff any mismatch; exit 0 + OK summary otherwise.

Reusable + thin caller: `.github/workflows/platform-pin-consistency.yml`
(`workflow_call`; it was modelled on the since-deleted `platform-drift-guard`'s
checkout-consumer + checkout-platform-at-`platform_ref`-into-`.cms-platform/` +
run-platform-script shape; the reusable `npm install --no-save yaml` before
running, since the script resolves `yaml` from cwd/node_modules) +
`examples/site/.github/workflows/...`
(`pull_request`, NO `paths:` filter — any pin-bearing file can skew). Self-test:
`e2e/check-platform-pin-consistency.test.js` (`@lane local`, runs in
node-unit-lints) — consistent fixture → 0; skewed fixture → non-zero, each
offending file/value named. It **used to be described as complementing**
`platform-drift-guard` (that one guarded file CONTENT byte-match; this one
guards VERSION CONSISTENCY) — but that guard was **deleted in v0.1.83** along
with the transport that vendored the files it compared, so since then this is
the only cross-repo guard left. See `docs/SYNC.md` "Single-version pin
invariant".

The same guard also enforces **workflow-content (call-interface) parity**
(companion to the workflow-SET parity): a consumer's thin caller must match the
canonical `examples/site` template's CALL INTERFACE — each job's `uses` target +
`with` KEY-set + `secrets:` map + permissions — modulo version refs, site-specific
`with` VALUES, and deliberately site-tuned `on:` triggers (all
normalized/masked/excluded). The version-pin checks compare only the `@ref`
STRINGS, so they were BLIND to a caller whose BODY drifted — e.g. jodidaniel's
sweep caller silently dropped the now-required `secrets: CMS_E2E_PAT:` map and
`startup_failure`'d the reusable for weeks. `checkWorkflowContentParity()` parses
both callers (comments/formatting drop out), compares the call interface, and
flags the exact drifting facet. It does NOT fight a legit site difference (e.g.
adamdaniel TRIMS the host-loop push `paths:` to dodge prod-loop co-arrival
eviction #1892 — an `on:` change, excluded).

### How a stale `platform_ref` INPUT got there, and why the seeder had to change (#220)

The live instance was not a hand-edit. `platform-bump.yml`'s **seeding** path
(the workflow-SET-parity feature, v0.1.20/#54) copies a newly-dictated caller
from `examples/site/.github/workflows/` and re-pins it — but it stamped only the
`uses:@` pin and the composite ref (then a SHA plus a `# vX.Y.Z` comment),
because those were "the ref shapes the pin-consistency checker recognizes." So
jodidaniel.com's
`cms-scheduled-publish-loop.yml`, seeded by the v0.1.62 bump, landed with
`uses:@v0.1.62` **and the example template's own `platform_ref: v0.1.59`**. Every
later bump's generic `CUR->LATEST` literal replace could never repair it — `CUR`
is the CONSUMER's previous ref, which `v0.1.59` never matched again — so the
input froze for 14 releases while the `uses:` line tracked every bump. At v0.1.70
the checkout it selected (a v0.1.59 tree) predated the
`install-playwright-browsers` composite and the job died on `Can't find
'action.yml'`, silently, on a scheduled workflow. The seeder now stamps
`platform_ref:` too (bare / `"quoted"` / `'quoted'`), so the guard and the seeder
recognize the same three shapes. **Note the loop this closes:** the seeder's
shape list was justified by the checker's shape list, so the checker's blind spot
propagated into the seeder — keep the two in lockstep, in both directions.

### A bump PR cut in the same minute as another `main` merge carries a stale tree (v0.1.81)

`platform-bump` branches off `main` at the moment it runs. Dispatch it seconds
after a release while another PR is mid-merge and the bump branch is cut from
the *pre-merge* `main` — so it silently omits whatever that PR changed. Two
symptoms, in increasing order of nastiness:

1. **`update-branch` returns `422 merge conflict between base and head`** when
   the other PR touched a line the bump also rewrites. Annoying but loud.
2. **The bump PR tests the wrong tree.** If the release being adopted adds a
   CHECK that reads a file the other PR fixed, that check runs on the bump PR
   against the unfixed content and fails for a reason that has nothing to do
   with the bump. Observed live at v0.1.81: both consumers' `platform/bump-v0.1.81`
   branches were cut ~17s after the release and ~seconds before the #242
   `dependabot.yml` change merged, so they would have run v0.1.81's new
   `dependabot-theme-gem-ignored.test.js` against a config that did not yet
   carry the ignore that lint asserts.

This is not a `platform-bump` bug — a branch cut at time T legitimately contains
`main` at time T. It is a **sequencing** hazard, and the fix is ordering:
**let every other `main` merge settle before dispatching `platform-bump`**, or,
if a bump PR is already open and stale, regenerate it rather than trying to
`update-branch` through the conflict. Regeneration is deterministic — apply the
same `CUR`→`LATEST` and `OLD_SHA`→`NEW_SHA` replace over `platform.lock`,
`Gemfile`, `Gemfile.lock` and `.github/workflows/**` on top of current `main`
(the workflow's own algorithm), then confirm with
`scripts/verify-consumer-pins.sh --platform-dir <platform>` before force-pushing
the bump branch. Caller SEEDING only matters if the release newly dictated a
workflow the consumer lacks; a release that adds none needs no seeding step.

### The consumer gate's stale-pin rule has one home, and two callers

`scripts/verify-consumer-pins.sh`'s check 2 — "no platform version token other
than the canonical one on any platform-mentioning line" — is the most GENERAL
pin detector here. Unlike `check-platform-pin-consistency.js`, which walks
parsed YAML by key, it reads LINES, so it sees a stale version token in a
LEFTOVER trailing `# vX.Y.Z (date)` comment on a `uses:` or a `platform_ref:` —
a shape a parser cannot see at all, because the parser drops comments. House
style carries no such comment since 2026-08-20, which is precisely why this
check still earns its place: it is what turns a stray surviving one into a
finding instead of an invisible lie.

It used to be an inline `awk` program. It now lives in
**`scripts/stale-platform-refs.js`** and is `require`d by
`e2e/template-pin-rules.js`, which is what the scaffold-template guard
(`e2e/examples-site-pins-current.test.js`) applies to `examples/site`. That is
deliberate and load-bearing: two earlier rounds gave the template guard its own
parse-only approximation of this rule, and each shipped a SPLIT — the guard
green on a drifted template while a site scaffolded from it exited 1 on its own
`verify-consumer-pins.sh`. Sharing the code removes the thing that can disagree.

Two consequences to know before changing either:

- **Changing the rule changes both.** Its output format is the awk's, verbatim,
  so the verifier's report is unchanged; the exit code is three-valued (0 clean,
  1 stale, 2 could-not-run) so "did not run" can never read as a pass.
- **`verify-consumer-pins.sh` now hard-FAILs without that file** in the
  `--platform-dir` tree, as it already did without the checker. Nothing in CI
  sparse-checks this script out (only `check-platform-pin-consistency.js` is,
  by `platform-pin-consistency.yml`), so no workflow needs a new path — but a
  hand-assembled platform dir does.
- `e2e/examples-site-scaffold-agreement.test.js` holds the line end-to-end: it
  mutates the template, applies the scaffolder's real `substitute()`, and runs
  this script on the result, asserting a shape can never red a scaffolded site
  while the template guard stays green.
