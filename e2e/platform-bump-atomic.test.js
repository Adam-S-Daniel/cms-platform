// @lane: local — pure-fs lint of the platform-bump reusable workflow.
//
// Locks the two halves of issue #13 so the automated down-sync can't regress
// to a state that either (a) can't push or (b) produces a PR that fails the
// single-version pin-consistency guard (#29):
//
//   1. PUSH AUTH — the bump rewrites `.github/workflows/*` (the `uses:@` pins +
//      `platform_ref:` inputs), so the push needs `workflows` permission. The
//      default Actions GITHUB_TOKEN's App lacks it, so the checkout MUST use the
//      caller's PAT (`secrets.gh_token`) as the persisted push credential.
//      Without it: "refusing to allow a GitHub App to ... update workflow ...
//      without 'workflows' permission" → the whole bump fails.
//   2. ATOMIC BUMP — the bump must move EVERY pinned reference in one PR, not
//      just `platform_ref:`: the `uses:@<tag>` pins, the `cms-platform-theme`
//      Gemfile `tag:`, and `Gemfile.lock` (`tag:` + git `revision:`). A
//      `platform_ref:`-only PR fails pin-consistency until Dependabot's piecemeal
//      PRs land. So the run script must resolve the release COMMIT sha and
//      rewrite the Gemfile / Gemfile.lock revision too.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const wf = parseYaml(readWorkflow("platform-bump.yml"));
const steps = wf.jobs.bump.steps;
const checkout = steps.find((s) => typeof s.uses === "string" && /actions\/checkout/.test(s.uses));
// Matches `gh api repos/$PLATFORM/releases/latest` (cms-platform#244) — NOT
// `gh release view`, which this step no longer calls (see the new test
// below locking that it stays gone).
const runStep = steps.find((s) => typeof s.run === "string" && /releases\/latest/.test(s.run));

// Drop full-line `#` comments before checking that a call does NOT reappear.
// The run script's own header comment quotes the OLD `gh release view` line
// verbatim as incident documentation (house style — comments carry the WHY,
// with evidence), so a plain substring/regex check over the whole script
// would false-positive on its own explanatory prose. Only the EXECUTABLE
// text is what the regression guard cares about.
function stripBashComments(script) {
  return script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

test.describe("platform-bump reusable — pushable + atomic (#13)", () => {
  test("checks out with the caller's PAT so the workflow-file push is authorised", () => {
    expect(checkout, "an actions/checkout step must exist").toBeTruthy();
    expect(checkout.with, "checkout must pass a token").toBeTruthy();
    expect(
      String(checkout.with.token),
      "checkout MUST use secrets.gh_token (the CMS_PLATFORM_PAT with Workflows:write) " +
        "as the push credential — the default GITHUB_TOKEN can't push .github/workflows/* changes",
    ).toMatch(/secrets\.gh_token/);
  });

  test("the bump step exists and resolves the latest release", () => {
    expect(runStep, "the bump run-step must exist").toBeTruthy();
    expect(runStep.run).toMatch(/releases\/latest/);
  });

  test("a release lookup FAILURE is loud, not a green no-op (#244)", () => {
    expect(runStep, "the bump run-step must exist").toBeTruthy();
    const run = runStep.run;

    // Queries the /releases/latest endpoint (not `gh release view`) so a
    // "no release yet" 404 is DISTINGUISHABLE from every other failure —
    // cms-platform is a public repo, so a 404 here can only mean "nothing
    // published yet," never "you lack access."
    expect(run, "must query the /releases/latest endpoint so 404 is unambiguous").toMatch(
      /gh api "repos\/\$PLATFORM\/releases\/latest"/,
    );

    // The benign path: a 404 (genuinely no release yet) is a quiet, GREEN
    // no-op — this is the one case the old line got right.
    expect(run, "a 404 (no release yet) must still exit 0, not fail the job").toMatch(
      /REL_CODE" = "404"[\s\S]{0,200}exit 0/,
    );

    // Every OTHER failure — an expired/under-scoped CMS_PLATFORM_PAT, a
    // revoked cross-repo grant, an API outage — must emit an `::error::`
    // annotation and exit non-zero. A red run here has to explain the
    // incident on its face, not just fail silently: it must name what to
    // check (the token) and reference the issue that root-caused the fix.
    expect(
      run,
      "a non-404 lookup failure must emit ::error:: naming the token to check, and exit 1",
    ).toMatch(/::error::could not read the latest release[\s\S]{0,400}gh_token[\s\S]{0,200}exit 1/);

    // An empty tag_name (the API call itself succeeded but returned no
    // usable release) is its own distinct failure — also loud, also non-zero.
    expect(run, "an empty tag_name response must also be loud, not silently swallowed").toMatch(
      /returned no tag_name[\s\S]{0,100}exit 1/,
    );

    // The old swallow-everything-into-green form must never reappear as
    // EXECUTABLE code in this step (comments are stripped first — see
    // stripBashComments — because the step's own header comment quotes the
    // old line verbatim as incident documentation). `gh release view`
    // legitimately exists elsewhere in this repo (release.yml's own,
    // unrelated, use) — this assertion is scoped to THIS step's `run`
    // script, not the whole file.
    expect(
      stripBashComments(run),
      "the old 'gh release view ... || echo \"\"' swallow must not come back as executable code " +
        "in this step",
    ).not.toMatch(/gh\s+release\s+view/);
  });

  test("it bumps EVERY reference atomically (not just platform_ref)", () => {
    const run = runStep.run;
    // Resolves the release tag -> commit sha (deref annotated) for the revision.
    expect(run, "must resolve the release tag's commit sha").toMatch(/git\/refs\/tags/);
    expect(run, "must dereference annotated tags").toMatch(/object\.type/);
    // Reads the OLD revision and rewrites it -> the new one.
    expect(run, "must read + rewrite the Gemfile.lock git revision").toMatch(/revision:/);
    expect(run, "must operate on Gemfile.lock").toMatch(/Gemfile\.lock/);
    // Touches the .github/workflows tree (the uses:@ / platform_ref: pins).
    expect(run, "must rewrite the .github/workflows pins").toMatch(/\.github\/workflows/);
    // Moves the version string AND the commit sha.
    expect(run, "must substitute the new version string").toMatch(/LATEST/);
    expect(run, "must substitute the new commit sha").toMatch(/NEW_SHA/);
  });

  test("opens the bump PR", () => {
    expect(runStep.run).toMatch(/gh pr create/);
  });
});

test.describe("platform-bump reusable — seeds newly-dictated workflow callers", () => {
  test("fetches the platform-dictated set from examples/site AT THE NEW ref", () => {
    expect(runStep.run).toMatch(/examples\/site\/\.github\/workflows/);
    expect(runStep.run).toMatch(/ref=\$LATEST/);
  });

  test("only seeds a caller that's wholly MISSING — never touches one that already exists", () => {
    expect(runStep.run, "must skip seeding when the destination file already exists").toMatch(
      /\[ -f "\$dest" \] && continue/,
    );
  });

  test("stamps the seeded file's platform-ref pin to $LATEST (not the example's own, possibly stale, pin)", () => {
    expect(runStep.run).toMatch(/ENV\{LATEST\}/);
  });

  test("logs which workflows were seeded", () => {
    expect(runStep.run).toMatch(/seeded.*newly platform-dictated workflow/i);
  });

  test("detects an add-only diff (untracked seeded file), not just a modified-file diff", () => {
    expect(runStep.run, "git diff --quiet alone misses brand-new untracked files").toMatch(
      /git status --porcelain/,
    );
  });
});

test.describe("platform-bump reusable — closes superseded platform/bump-* PRs", () => {
  // Each bump PR is an ATOMIC absolute rewrite (see #13 above), so it fully
  // supersedes whatever an older `platform/bump-*` PR proposed. Without a
  // closure step these pile up every time a release is cut before a
  // consumer merges the previous bump PR (observed live: a consumer accrued
  // 4 open bump PRs at once). These lints lock the closure step in place
  // and its fail-open shape — this is cosmetic cleanup, never worth failing
  // the bump over.
  test("closes other open PRs, scoped to the platform/bump- prefix", () => {
    const run = runStep.run;
    expect(run, "must list open PRs to find other bump PRs").toMatch(/gh pr list --state open/);
    expect(run, "must filter the enumeration to the platform/bump- prefix").toMatch(
      /startswith\(\\"platform\/bump-\\"\)/,
    );
    expect(run, "must close the matched PRs").toMatch(/gh pr close/);
  });

  test("excludes the current $BRANCH from the closure candidates", () => {
    expect(runStep.run, "must select .headRefName != the current bump's own $BRANCH").toMatch(
      /select\(\.headRefName\s*!=\s*\\"\$\{BRANCH\}\\"\)/,
    );
  });

  test("the closure step is fail-open under set -euo pipefail", () => {
    const run = runStep.run;
    expect(run, "the run block must be strict (set -euo pipefail)").toMatch(
      /set -euo pipefail/,
    );
    // Under `set -euo pipefail` a bare `gh pr close` would fail the whole
    // job on the first stale PR it can't close. It must be guarded inline —
    // `|| echo "::warning::..."` — exactly like the `gh pr merge --auto`
    // line it follows, never a bare unguarded call.
    expect(run, "gh pr close must degrade to a warning, not fail the job").toMatch(
      /gh pr close[\s\S]{0,300}\|\|\s*echo "::warning::/,
    );
    // The enumeration itself (gh pr list piped through mapfile) must also
    // be guarded — a transient `gh pr list` failure must not abort the bump.
    expect(run, "the gh pr list enumeration must also be fail-open").toMatch(
      /2>\/dev\/null \|\| true/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #315. Seeding moves a wholly-MISSING file INTO a consumer. Two other kinds of
// consumer-side change a release can require had no mechanism at all, and both
// reddened a required check on both consumers as delivered:
//
//   1. a caller that LEFT the canonical set was rewritten to a tag at which its
//      reusable no longer exists, instead of being deleted;
//   2. an input the platform dictates inside an EXISTING caller
//      (`required_contexts`) was never rewritten, so it went stale in the very
//      commit that moved the pin.
//
// Neither can be split into its own PR: pin-consistency compares the consumer's
// workflow set against the platform at that consumer's OWN pinned ref, so each
// half fails in the mirror-image direction on its own. They have to ride the
// bump commit, which is why they belong here rather than in a follow-up.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("platform-bump reusable — retires de-dictated callers (#315)", () => {
  test("it reads the canonical set at the OLD ref, not just the new one", () => {
    // The whole judgement call: "was this file ever platform-dictated?" is
    // answered by the canonical set at $CUR. Deciding from "the consumer has a
    // file we don't recognise" would delete site-authored workflows.
    expect(runStep.run).toMatch(
      /contents\/examples\/site\/\.github\/workflows\?ref=\$CUR/,
    );
    expect(runStep.run, "the new set is still read at the NEW ref").toMatch(
      /contents\/examples\/site\/\.github\/workflows\?ref=\$LATEST/,
    );
  });

  test("a file still in the new set is kept; one that left it is git rm'd", () => {
    const script = stripBashComments(runStep.run);
    expect(script).toMatch(/for name in "\$\{WAS_DICTATED\[@\]\}"/);
    expect(
      script,
      "membership of the NEW set must be an exact whole-line match — a substring " +
        "test would spare `e2e-tests.yml` on the strength of `e2e-tests.yml.bak`",
    ).toMatch(/grep -qxF -- "\$name"/);
    expect(script).toMatch(/git rm -q --ignore-unmatch -- "\$dest"/);
  });

  test("an unreadable canonical set on EITHER side deletes nothing", () => {
    // "Could not tell" must never become "not in the new set, so retire it".
    // An empty listing is exactly what a $CUR predating examples/site returns.
    const script = stripBashComments(runStep.run);
    expect(script).toMatch(
      /if \[ "\$\{#DICTATED\[@\]\}" -eq 0 \] \|\| \[ "\$\{#WAS_DICTATED\[@\]\}" -eq 0 \]; then/,
    );
    // …and the guard must come BEFORE the loop it guards, or it guards nothing.
    expect(script.indexOf('-eq 0 ] || [ "${#WAS_DICTATED[@]}" -eq 0 ]')).toBeLessThan(
      script.indexOf('for name in "${WAS_DICTATED[@]}"'),
    );
  });

  test("membership is tested with `if`, never `cmd && continue`", () => {
    // GitHub runs `run:` under `bash -e`, so a false AND-list as a loop body's
    // last command exits the step — the trap scheduled-run-health.yml's header
    // already records. A `continue` reached that way would abort the bump.
    const script = stripBashComments(runStep.run);
    expect(script).not.toMatch(/grep -qxF[^\n]*&&\s*continue/);
    expect(script).toMatch(/if printf '%s\\n' "\$\{DICTATED\[@\]\}" \| grep -qxF -- "\$name"; then continue; fi/);
  });

  test("the PR body names what was retired, so the diff is never a surprise", () => {
    expect(runStep.run).toMatch(/Retired de-dictated workflow caller\(s\)/);
  });
});

test.describe("platform-bump reusable — reconciles dictated caller inputs (#315)", () => {
  test("it derives the list from the MANIFEST at the new ref, not from the template", () => {
    // A consumer may map `main` to a library entry other than `consumer-main`.
    // Copying the template's list would silently impose the wrong set on it —
    // and a `required_contexts` shorter than the repo's real required set asks
    // the nudge for a merge it has not established (jodidaniel.com#156).
    expect(runStep.run).toMatch(/contents\/repo-settings\.yml\?ref=\$LATEST/);
    expect(runStep.run).toMatch(/contents\/scripts\/reconcile-nudge-contexts\.py\?ref=\$LATEST/);
    expect(runStep.run, "the consumer's own slug is what selects the ruleset").toMatch(
      /SLUG="\$GITHUB_REPOSITORY"/,
    );
  });

  test("a caller the consumer does not have is not conjured up", () => {
    const script = stripBashComments(runStep.run);
    expect(script).toMatch(/if \[ -f "\$NUDGE" \]; then/);
  });

  test("every non-success outcome reaches the PR body instead of passing quietly", () => {
    // Direction 3 of #315 as the fallback for directions 1-2: when it cannot be
    // done automatically the PR must SAY so. A silent skip is the failure mode
    // the issue exists to end ("the bump PR arrives red and a human works out
    // why"), and it is worse when the PR is green and merely wrong.
    const script = stripBashComments(runStep.run);
    for (const arm of ["UPDATED*", "MANUAL*"]) {
      expect(script, `the ${arm} outcome must be handled explicitly`).toContain(arm);
    }
    expect(script).toMatch(/CONTEXT_NOTE=/);
    expect(script, "and the note must actually reach the PR body").toMatch(
      /SEED_NOTE="\$\{SEED_NOTE\}\$\{CONTEXT_NOTE\}"/,
    );
  });

  test("the reconciler exists, parses both sides, and verifies its own splice", () => {
    // The script is the reviewable home for this logic — the workflow only
    // fetches and runs it. These assert the three properties that make a text
    // splice of a YAML block scalar defensible at all.
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "scripts", "reconcile-nudge-contexts.py"),
      "utf8",
    );
    expect(src, "both sides are read with a real parser, never line-scanned").toMatch(
      /yaml\.safe_load/,
    );
    expect(
      src,
      "the write is a splice so the caller's comments survive — including the " +
        "block telling the next reader to DERIVE this list rather than copy it",
    ).toMatch(/def splice_block_scalar/);
    expect(
      src,
      "and the splice is re-parsed and compared before anything is saved: a " +
        "splice nobody checks is how a mangled workflow ships",
    ).toMatch(/sorted\(verified\) != sorted\(contexts\)/);
  });
});
