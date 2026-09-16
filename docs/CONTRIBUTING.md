# Contributing to cms-platform

What "done" means here, the lanes that gate a merge, how a workflow gets
added, and the house rule for writing a lint. AGENTS.md carries the
imperatives; this page carries the reasoning and the survey method behind
them.

## Definition of done (non-trivial changes)

A merged PR with green unit-lints is **NOT** "done" for any non-trivial change
to this platform or a consumer. Green unit lints routinely ship a LIVE
regression (Decap UI drift, deploy-chain, dialog handling — e.g. the
double-`dialog.accept()` crash on loop run 27013147945 that NO unit lint or
adversarial code-review lens caught). "Done" additionally requires:

1. **Drive the prod-mutate validation loop to GREEN.** Dispatch
   `cms-publish-loop-prod.yml` (and `cms-media-roundtrip.yml` where the change
   can affect it) on the affected site and ITERATE until a run actually
   succeeds end-to-end (create → reflect → delete → 404) — not "the fix looks
   right" or "the dispatch-proof passed." The live loop is the real acceptance
   test for these CMS repos.
2. **Survey + drive every workflow green, in ALL THREE repos.** A platform
   change cascades, so the audit spans `cms-platform` AND **both** consumers
   (`adamdaniel.ai`, `jodidaniel.com`) — not just "the repo you edited". For
   EVERY workflow: it must have a run AFTER the last non-CI-generated push, and
   its most-recent run must SUCCEED. Iterate — re-dispatch stale / scheduled /
   manual ones — until that holds. ("CI-generated / non-real" = loop-canary
   churn + cleanup/auto-merge bot PRs + the automated `platform-bump` PR +
   auto-docs regen; those don't reset the bar — the reference point is the last
   *substantive* (human / code / content) change.)

   Survey method + nuances (2026-06-05 — `gh api repos/<r>/actions/workflows`
   → per-workflow latest run on `main`; compare its `head_sha`/`created_at` to
   HEAD / the last non-bot commit):
   - **In `cms-platform` itself, most workflows are `workflow_call`-only
     reusables** — they CANNOT run standalone (they show "no main run"); they're
     exercised when a consumer's thin caller invokes them, plus the harness
     lints run in **Self CI**. So the platform's own bar = **Self CI green on
     HEAD** (+ Cut release / Dependabot). Don't chase "no main run" on a reusable.
   - **A bump-skip-SKIPPED loop run is GREEN but is NOT a real validation.** The
     `recursion-gate` skips the prod loops on a bump-only push, so their
     post-bump run "succeeds" by skipping — that satisfies #2's "latest run
     succeeded" but NOT #1. Drive a REAL prod-mutate cycle by `workflow_dispatch`
     (it bypasses the bump-skip), confirming the heavy job actually ran.
   - **PR-triggered workflows** (`parity`, `preview-media`, `e2e`,
     `visual-regression`, the preview-env loops) last ran on the PR head, not
     `main` — a green run on the last real PR satisfies the bar; their
     "no main run" / stale-main-sha is expected.
   - **`startup_failure` or an old failed manual dispatch still counts as a RED
     latest run** — re-dispatch on current HEAD (the preview-env loops need a
     live `preview-pr<N>` target) until the latest run is green.
3. **No OPTIONAL / non-required check may fail either.** Drive `UNSTABLE` →
   clean, not just `BLOCKED` → mergeable. A merged PR with a red non-required
   check is not done — chase it to green, OR, if it is genuinely a
   user-credential / go-live blocker (jodidaniel `CMS_E2E_PAT`, the excluded
   jodidaniel #26), surface it explicitly rather than leaving it silently red.

This gate is part of the `platform-release-and-bump` flow — apply it after the
consumer bump, not before.

### Delegated mechanical work is done when a VERIFIER exits 0

From the v0.1.76 consumer bump, which was delegated to two small-model subagents
with an exact spec that ENDED in "run the authoritative gate":

- **Done means an exit code, not prose.** Name the exact verifier command in the
  spec as the definition of done and require its exit code in the report. Neither
  agent ran it, and its exit code was the one thing that would have caught the
  incomplete work unambiguously.
- **A subagent that cannot run the verifier must report BLOCKED.** Partial
  completion described as progress is the failure mode: one agent stopped after 3
  of 5 edit categories having INVENTED a constraint it was never given, left 58
  stale `v0.1.75` refs and no `app_private_key`, and its report read as near-done.
- **A count that disagrees with the spec's stated expectation is a
  STOP-AND-REPORT condition**, never "minor variance from counting methodology".
  Today's 35-vs-34 was benign (a prose `vX.Y.Z` mention in a comment), but nothing
  in the process established that — the orchestrator had to.
- **Prefer a verifier that CANNOT silently degrade.** `check-platform-pin-consistency.js`
  used to drop from 96 checks to 61 with no canonical set and still print "Pins are
  consistent", so even an agent that DID run it could be falsely reassured. Hence
  `--require-canonical` (which the `platform-pin-consistency` reusable now passes).

For a consumer pin bump that verifier is **`scripts/verify-consumer-pins.sh`**
(run from the consumer root; `--platform-dir <path>` when the platform tree is
elsewhere) — a green run of it, not a diff review, is what makes the bump done.

## Self-CI lanes

`.github/workflows/self-ci.yml` is the machinery repo's own merge gate (every
other workflow here is an `on: workflow_call` reusable; `self-ci.yml` plus its
sibling `self-secrets-scan.yml` — which dogfoods the `secrets-scan.yml`
reusable on this repo's own history — are the only two that run directly on a
plain PR). It runs five FAST lanes on `pull_request` + `push` to `main`:

1. **actionlint** over `.github/workflows/*.yml` (downloads the pinned binary; hard-fail).
2. **ruby-theme-specs** — `theme/spec/*_test.rb` (hard-fail).
3. **node-unit-lints** — the pure-fs `e2e/*.test.js` lints, selected by an
   exclusion DENY list (build-/repo-dependent specs are denied; a new pure-fs
   lint is picked up automatically). Run with `TARGET=prod` +
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so no Jekyll/browser bring-up (hard-fail).
4. **plugin-validate** — `claude plugin validate .` over this repo's own plugin
   root (hard-fail), NON-STRICT deliberately: the repo-root `CLAUDE.md` emits a
   permanent "not loaded as project context" warning that `--strict` would turn
   into a failure, and `CLAUDE.md` is managed by the `_agent-guidance` sync and
   is not ours to delete — so `--strict`'s only green path is removing a file we
   must keep.
5. **cfn-lint** over the CloudFormation templates (advisory, `continue-on-error`).

`self-secrets-scan.yml` (#126) runs alongside it as its own workflow,
gitleaks-scanning the platform repo's diff on `pull_request`, incrementally on
`push` to `main`, and full-history weekly — the same posture the consumer
caller gets from `secrets-scan.yml`, applied to the machinery repo itself.

The heavy browser matrix + `@admin-write` write-path specs run in **CONSUMER**
e2e (dogfood / consuming-site CI), NOT in platform self-CI.

## Adding / porting a workflow

Make it `on: workflow_call` with site identity as `inputs`/`secrets`; keep
`github.repository`/`context.repo` (already portable). The site's `on:` trigger
+ `paths-ignore` + `run-name` live in a **thin caller** under
`examples/site/.github/workflows/`. If the workflow needs platform-owned scripts,
check the platform out into `.cms-platform/` (a dot-dir Jekyll ignores) at
`inputs.platform_ref` and run them from there (see `deploy-preview.yml`).

## Code-shape lints parse an AST, never a regex

AST always, never regex. The fleet guidance's `base.md` carries the
general rule (a lint reasoning about code SHAPE — which `test()` blocks
exist, whether a call sits inside another's scope, what a call's arguments
are — parses a real AST, never a regex or line scan) and the jodidaniel
host-loop `page.goto(\`…#/collections/${col}\`)` incident that motivated it,
so this entry keeps only this repo's implementation. Parse with
`e2e/spec-ast.js` (acorn + acorn-walk): `analyzeSpec(src)` returns a fact bag
(string VALUES with `${…}` placeholders, call names+args, identifiers, requires,
Program-level `test()` blocks); the detector matches those facts, not raw text.
This mirrors `e2e/workflow-yaml-utils.js`, which parses workflow YAML with the
`yaml` parser for the same reason. The guard-registry detector
(`base-collections-guard-registry.test.js`) + `platformMetaSpecs()` are AST-based;
any NEW code-shape lint must be too. (Regex stays fine for genuinely lexical
concerns — a version string, a leaf token's content — never for code structure.)
Adding the parser deps respected the fleet's 7-day dependency cooling-off.
