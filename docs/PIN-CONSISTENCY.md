# Platform-pin consistency (anti-skew)

What this is: how `scripts/check-platform-pin-consistency.js` keeps every
place a consumer references the platform version — reusable `uses:@ref`
pins, SHA-pinned composite `# vX.Y.Z` comments, `Gemfile`/`Gemfile.lock`
`tag:`, `platform.lock` `platform_ref`, and each caller's `platform_ref:`
input — in lockstep, plus the workflow-content (call-interface) parity check
that catches a thin caller whose body drifted from the canonical template.
Read this before changing the pin-consistency script, `platform-bump.yml`'s
seeding logic, or anything that adds a new "pin shape" a consumer can carry.
See also the `platform-release-and-bump` skill and `docs/SYNC.md`'s
"Single-version pin invariant".

## Single-version pin consistency guard (anti-skew, #29)

A consumer references the platform version in MANY places (every reusable
`uses: …/.github/workflows/<n>.yml@<ref>`, every SHA-pinned composite
`uses: …/.github/actions/<n>@<sha>  # vX.Y.Z` COMMENT, the `Gemfile`/`Gemfile.lock`
`tag:`, and `platform.lock` `platform_ref`). Dependabot + `platform-bump` land
bumps PIECEMEAL, so consumers drift (observed live: adamdaniel.ai pinned `@v0.1.0`
loop/deploy callers, gem `@v0.1.5`, others `@v0.1.3`/`@v0.1.6` at once — a `v0.1.0`
reusable against a `v0.1.5` gem is a latent bug source). **`platform-bump.yml`
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
  `platform_ref`. Composite refs `.../actions/*@<sha>`: SHA-pinned, so the gate is
  the trailing `# vX.Y.Z` COMMENT == `platform_ref`. **The comment is read by a
  LINE-AWARE pass** because the YAML parser drops comments — the one justified
  regex/line exception (same rationale as `scripts/sync-action-pin-comments.sh`,
  documented in the script header).
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
(`workflow_call`; mirrors `platform-drift-guard`'s checkout-consumer +
checkout-platform-at-`platform_ref`-into-`.cms-platform/` + run-platform-script
shape; the reusable `npm install --no-save yaml` before running, since the script
resolves `yaml` from cwd/node_modules) + `examples/site/.github/workflows/...`
(`pull_request`, NO `paths:` filter — any pin-bearing file can skew). Self-test:
`e2e/check-platform-pin-consistency.test.js` (`@lane local`, runs in
node-unit-lints) — consistent fixture → 0; skewed fixture → non-zero, each
offending file/value named. **Complements** `platform-drift-guard` (that guards
file CONTENT byte-match; this guards VERSION CONSISTENCY). See `docs/SYNC.md`
"Single-version pin invariant".

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
`uses:@` pin and the composite `# vX.Y.Z` comment, because those were "the ref
shapes the pin-consistency checker recognizes." So jodidaniel.com's
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
