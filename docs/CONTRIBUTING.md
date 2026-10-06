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

`.github/workflows/self-ci.yml` is the machinery repo's own merge gate (most
other workflows here are `on: workflow_call` reusables; `self-ci.yml`, its
sibling `self-secrets-scan.yml` — which dogfoods the `secrets-scan.yml`
reusable on this repo's own history — `self-fixture-e2e.yml` (the browser
lane below) and `self-release-review-gate.yml` are the ones that report required
checks on a plain PR). It runs six FAST lanes on `pull_request` + `push` to `main`, all REQUIRED:

1. **actionlint** over `.github/workflows/*.yml` (downloads the pinned binary; hard-fail; REQUIRED).
2. **ruby-theme-specs** — `theme/spec/*_test.rb`, each run with plain `ruby`, no
   bundle (hard-fail; REQUIRED). The lane installs `liquid` 4.0.4 for the real
   RUM include render, plus `jekyll` 4.4.1, `jekyll-sitemap` 1.4.0 and `jekyll-seo-tag` 2.9.0 for
   [the fixture exclusion build regression](../theme/spec/exclude_e2e_posts_build_test.rb).
   That regression uses a temporary site to exercise front matter loading,
   generators, and public aggregation output; other specs stub the surfaces they touch.
3. **node-unit-lints** — the pure-fs `e2e/*.test.js` lints, selected by an
   exclusion DENY list (build-/repo-dependent specs are denied; a new pure-fs
   lint is picked up automatically). Run with `TARGET=prod` +
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so no Jekyll/browser bring-up (hard-fail; REQUIRED).
4. **plugin-validate** — `claude plugin validate .` over this repo's own plugin
   root (hard-fail; REQUIRED), NON-STRICT deliberately: the repo-root `CLAUDE.md` emits a
   permanent "not loaded as project context" warning that `--strict` would turn
   into a failure, and `CLAUDE.md` is managed by the `_agent-guidance` sync and
   is not ours to delete — so `--strict`'s only green path is removing a file we
   must keep.
5. **cfn-lint** over the CloudFormation templates (hard-fail; REQUIRED since
   #525). The cfn-lint version is pinned, so a new upstream rule reaches the lane
   only through a deliberate bump; it carried `continue-on-error` before #525,
   when it was unpinned, and every listed template must exist.
6. **python-unit-tests** — `python3 -m pytest scripts/cross_post oauth-proxy -q`
   (the cross-post suite plus the OAuth proxy's `oauth-proxy/test_lambda.py`;
   hard-fail; REQUIRED since #525).

`self-secrets-scan.yml` (#126) runs alongside it as its own workflow,
gitleaks-scanning the platform repo's diff on `pull_request`, incrementally on
`push` to `main`, and full-history weekly — the same posture the consumer
caller gets from `secrets-scan.yml`, applied to the machinery repo itself. Its
check run is reported as `scan / scan` (caller job / reusable job), REQUIRED
since #525.

`self-fixture-e2e.yml` (#527) is the platform's own BROWSER lane, kept out of
`self-ci.yml` so that file stays browser-free. It places the harness inside
`e2e/fixture-site` (a neutral consuming site whose Gemfile pins the theme by
local path, so the working tree's theme is built), installs gems from the
fixture's COMMITTED `Gemfile.lock` in frozen mode, and runs every `@lane: local`
spec on four matrix legs, each behind a `timeout-minutes` wall: the admin
projects `chromium-desktop-3k` and `webkit-iphone16` on `e2e/fixture-site`, and
since #702 ONE public project, `chromium-desktop-1080`, on both
`e2e/fixture-site` (`/` on the theme's default layout) and
`e2e/fixture-site-singlepage` (`/` on its own `_layouts/home.html`, the shape of
jodidaniel.com). Before #702 no public spec ran here, so v0.1.139's public-theme
specs first ran on a consumer bump and broke jodidaniel.com#351. `@lane: real`
specs are excluded explicitly (`admin-bundle-parity.spec.js` fetches
production). A step then fails the job unless the leg's proof test PASSED (the
matrix names it: the archived-PDF test in `cms-editorial-workflow.spec.js` on
the admin legs, a public test that runs only where the leg's `/` shape holds on
the public ones), so a future skip cannot read green. An early salience step
skips the work, with success, on a PR that touches only `docs/`,
`infrastructure/`, `oauth-proxy/`, `scripts/cross_post/`, `LICENSE` or `*.md`
outside the fixtures. The REQUIRED context is the `fixture-e2e` gate (`needs:` +
`if: always()`, no wall), which is red unless every matrix leg succeeded; the
public legs joined that matrix rather than adding a context, so the required set
did not change. The lane needs no secrets and touches no
production site, but it does need the public internet: npm, rubygems, the Ubuntu
archive, and `unpkg.com`, which every `admin/index*.html` loads `decap-cms.js`
from at runtime (accepted for #527, as every consumer's admin already depends on
it). The other seven public projects vary only the browser or viewport, so they
stay in CONSUMER e2e. A public spec that cannot hold on a fixture skips on a
predicate read from the site's source (`site-capabilities.js`), never on the
fixture's name. A change to the theme gemspec's dependencies must re-lock both
fixtures' `Gemfile.lock` (`bundle lock` in each) in the same PR, or the frozen
install fails.

`self-release-review-gate.yml` (#526, acceptance criterion 3; owner decision
2026-10-05) enforces the independent review of a RELEASE-BEARING PR: one whose
`plugin.json` or `.claude-plugin/plugin.json` `version` differs from the merge
base (every STABLE release needs one, because `release.yml` refuses a stable
tag that disagrees with the manifests), or whose head branch is `release/*`. A
prerelease is cut from `main` as-is with no PR (`release.yml` skips the manifest
guard for it), so this check does not gate it; that is the job of #526
criterion 4's release gate, which does not exist yet. Such a PR is red until its body carries, on a line of its own,

```text
Independent review: CLEAN at <the PR's current head sha, all 40 characters>
```

(`gh pr view <n> --json headRefOid --jq .headRefOid` prints it). A reviewer
independent of the change's author writes it after reviewing that head; no owner
approval and no bot identity are involved, and the check cannot verify who wrote
it. A 7+ character prefix is NOT accepted: an abbreviated SHA is what a hurried
reviewer copies, which is when a stale review slips through. A stamp quoted
(`>`), fenced, in an HTML comment or indented as code does not count, and any
push makes the stamp stale until it is re-reviewed and updated. Every other PR
gets success. The workflow fires on `edited` (unlike every other PR workflow
here, #222) because the stamp is a body edit that changes no SHA; it reads the
body from `$GITHUB_EVENT_PATH`, the manifests through the API at the merge base
and the head, and fails closed when either read fails. The logic is
`scripts/release-review-gate.js`, locked by `e2e/self-release-review-gate.test.js`.
It does not run the consumers' checks against the candidate or gate the tag
itself; those parts of #526 are separate.

The nine REQUIRED contexts are `repo-settings.yml`'s `ruleset_library.platform-main.
rules[required_status_checks]`: the six self-CI job ids, `scan / scan`,
`fixture-e2e` and `release-review-gate`. Two
lints lock them to the workflows. `e2e/ruleset-context-publishable.test.js`
checks that every one is reported on EVERY pull request to `main`: no `paths:`
filter, no job-level `if:`, no `continue-on-error`. It also checks that every
job a pull request runs here is either required or listed, with its reason, in
that file's `NOT_REQUIRED_PR_JOBS`. `e2e/required-context-cancellable.test.js`
checks that none of them can end `cancelled`. A new PR-time job therefore
fails CI until it is added to the ruleset or exempted. Take a new context's
string from the check run GitHub reports on a real PR, not from the YAML.

The FULL browser matrix (every project, sharded) runs in **CONSUMER** e2e
(dogfood / consuming-site CI); platform self-CI runs only the admin-project
subset above, against the fixture.

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

**A lint that forbids a token must not read comments.** The first draft of the
#329 `position: fixed` lint was `/position\s*:\s*fixed/` over the source, and it
red-failed the fixed file, whose header comment explains the defect it forbids.
It walks acorn's AST now (string literals and style writes only) —
`e2e/admin-329-shims.test.js`; see `docs/PUBLISHING-UX.md` §2.3.
