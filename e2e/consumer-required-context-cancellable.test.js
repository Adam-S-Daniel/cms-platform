// @lane: local — pure-fs, CONSUMER-ONLY lint (parses with the `yaml` library,
// never regex) asserting that no job publishing one of a consumer's REQUIRED
// status contexts can end up `cancelled`.
//
// WHY THIS EXISTS — THE HALF ITS PLATFORM SIBLING CANNOT COVER
// ------------------------------------------------------------
// `e2e/required-context-cancellable.test.js` enforces the same invariant on the
// PLATFORM tree and on the canonical thin-caller TEMPLATES under this repo's
// examples/ directory. It is registered in playwright.config.js's
// PLATFORM_META_SPECS — it has to be, because it reads the platform's own
// workflow definitions — and `playwright.config.js` testIgnore's every registered
// name on a CONSUMER lane. So the sibling can never run on adamdaniel.ai or
// jodidaniel.com, which are the only two repos where this class of bug actually
// wedges a pull request. A template lint proves what a site COPIED FROM; only a
// consumer-mode lint proves what a site SHIPS.
//
// This file is therefore deliberately NOT in PLATFORM_META_SPECS. It reads only
// trees a consumer really has:
//
//   <SITE_ROOT>/.github/workflows/          — the consumer's OWN thin callers
//   <SITE_ROOT>/.cms-platform/              — the platform checkout the consumer
//                                             e2e job makes, at the consumer's
//                                             pinned `platform_ref`
//
// Both are verified present in the reusable rather than assumed: `e2e-tests.yml`
// checks the platform out with `path: .cms-platform` (a FULL checkout — that step
// passes no `sparse-checkout`) and exports `SITE_ROOT: ${{ github.workspace }}`
// unconditionally on the "Run Playwright suite" step, in both the local lane
// (harness copied to `<site>/e2e`) and the preview/prod lane (harness run in
// place from the platform checkout). `github.workspace` is the CONSUMER root in
// both, so one value is correct for both.
//
// ── THE INVARIANT ────────────────────────────────────────────────────────
//
// NO REQUIRED STATUS CONTEXT MAY END `cancelled`. A cancelled required check
// hard-blocks the merge: the API answers
// `405 Required status check "<ctx>" is cancelled`, which nothing overrides — not
// native auto-merge, not an explicit merge call, not a nudge bot, not an admin.
// The PR reads all-green and simply never lands.
//
// TWO CAUSES HAVE SHIPPED HERE, AND THE SECOND IS WHY THIS FILE IS NO LONGER
// NAMED AFTER THE FIRST:
//
//   1. A `concurrency` group governing the publishing job (cms-platform#285).
//      Measured on adamdaniel.ai PR #3006 (2026-08-09): opened 01:57:10Z,
//      head_ref_force_pushed 01:57:38Z, and two visual-regression runs BOTH
//      created 01:57:41Z on head_sha 68d7c777 — webhook latency dispatches the
//      `opened` run after the force-push has already advanced the ref. `opened`
//      and `synchronize` cannot be removed (the required context would never
//      report), so no trigger set is collision-free.
//   2. A `timeout-minutes` ON the publishing job (cms-platform#289). v0.1.87
//      deleted every group from every required-context publisher; four days
//      later three required contexts on adamdaniel.ai still concluded
//      `cancelled` — `parity / parity` at 30m26s (#3217) and 30m16s (#3202),
//      `preview-media / preview-media` at 30m20s (#3217) — all on a 30-minute
//      wall with no group anywhere near them. GitHub reports a job it killed at
//      its wall as `cancelled`, NOT `timed_out`, which is exactly why nothing
//      alerted: `timed_out` is already in audit-scheduled-runs.js's
//      BAD_CONCLUSIONS and `cancelled` necessarily is not.
//
// `cancellationHazards()` also reports two shapes that have never shipped here —
// `fail-fast` on a matrix publisher, and a `needs:` gate with no `always()` — for
// the reason the rename exists: a guard named after one cause does not grow a
// second one on its own.
//
// WHAT NONE OF IT SEES: a human pressing Cancel, `gh run cancel`, GitHub's
// 6-hour job and 35-day run ceilings, a runner evicted mid-job. Those are not in
// the workflow text and no static lint over that text can find them.
//
// ── THE ORACLE CAVEAT, STATED HONESTLY ───────────────────────────────────
//
// The required-context list comes from `repo-settings.yml` inside the consumer's
// `.cms-platform/` checkout — i.e. the copy pinned at that consumer's
// `platform_ref`, not the platform's current `main`. A context ADDED to
// `consumer-main` in a newer release is invisible here until the consumer bumps,
// so this lint lags in the FALSE-GREEN direction: it can miss a newly-required
// context, never invent one. That is the safe direction for a lint whose failure
// mode would otherwise be "reds a consumer PR over a manifest the consumer cannot
// edit", and the platform-side sibling covers the new context from the moment it
// lands. The REUSABLES are not subject to the same lag: `platform-bump.yml` moves
// each caller's `uses:@ref` and its `platform_ref:` input in one atomic PR, and
// `scripts/check-platform-pin-consistency.js` fails the build if they disagree —
// so the reusable definitions read here are exactly the ones the consumer runs.
//
// Parsing is the `yaml` library — a real parser, never a regex over workflow
// source — but deliberately NOT via `e2e/workflow-yaml-utils.js`: the meta-spec
// registry's `workflows-def` detector treats a require of that helper as an
// UNCONDITIONAL platform-internal signal, which would force this file into
// PLATFORM_META_SPECS and undo everything above. The shared MATCHER logic lives
// in `e2e/required-context-cancellable-utils.js`, which names no path at all and
// so carries no signal for either spec to inherit. Same shape as
// `e2e/dependabot-config-utils.js` and its consumer-only caller.
//
// Skip semantics: `test.skip()` fires ONLY when SITE_ROOT is unset (the
// platform's own self-CI, where the sibling named above is the coverage). A
// genuinely SITE_ROOT-having run whose consumer is missing the platform checkout
// FAILS rather than skipping — a consumer e2e lane without `.cms-platform/` is a
// broken harness, not a case to wave through as "nothing to guard here".
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const {
  publishKind,
  cancellationHazards,
  reusableBasename,
  splitContext,
  requiredContexts,
  workflowOn,
  FIX_ADVICE,
} = require("./required-context-cancellable-utils");

const CONSUMER = !!process.env.SITE_ROOT;
const SITE_ROOT = process.env.SITE_ROOT || null;

// Every `.github`/`workflows` join in this file is rooted at SITE_ROOT, and each
// one names SITE_ROOT directly rather than going through an intermediate
// constant. That is not style: the #244 carve-out in
// e2e/platform-meta-spec-registry.test.js suppresses the `workflows-def` signal
// only for a join whose OWN ARGUMENTS contain the identifier `SITE_ROOT`, so
// hoisting `path.join(SITE_ROOT, ".cms-platform")` into a variable and joining
// off that would re-flag this file as platform-internal — and registering it
// would testIgnore it on the one lane it exists for.
const CALLER_DIR = CONSUMER ? path.join(SITE_ROOT, ".github", "workflows") : null;
const REUSABLE_DIR = CONSUMER
  ? path.join(SITE_ROOT, ".cms-platform", ".github", "workflows")
  : null;
const MANIFEST_PATH = CONSUMER ? path.join(SITE_ROOT, ".cms-platform", "repo-settings.yml") : null;

// The ruleset protecting a consumer's default branch. Its contexts are what a
// consumer PR must satisfy, so they are what may never sit in a cancellable
// group.
const CONSUMER_RULESET = "consumer-main";

// SCOPE LIMIT. repo-settings.yml also applies `cms-feature-branches` to this
// consumer over refs/heads/{cms,claude,feat,fix,chore,test,ci,docs}/**, requiring
// the BARE context `validate-content`. It is deliberately not scanned: no caller
// job carries that name (the callers publish `editorial / validate-content`), so
// scanning it would fail the resolution assertion on a repo-settings question
// rather than a concurrency one. The underlying job — cms-editorial-workflow.yml's
// `validate-content` — is already covered here through consumer-main, so this is a
// gap in ruleset coverage, not in job coverage. See the platform sibling for the
// same note.

const SKIP_REASON =
  "SITE_ROOT is unset (platform self-CI) — a consumer's own .github/workflows tree and its " +
  ".cms-platform checkout are not present here; see e2e/required-context-cancellable.test.js " +
  "for the platform-mode coverage of this same rule against the platform tree and the " +
  "canonical thin-caller templates.";

// Read + parse one workflow. The read sits OUTSIDE any try: an ENOENT or a
// permissions failure must surface as the error it is, never be mistaken for a
// malformed-input case this lint decided to tolerate. A YAML SYNTAX error does
// return null — the consumer's own `actionlint` owns YAML validity, and a second
// red here would only obscure it.
// `merge: true` mirrors workflow-yaml-utils.parseYaml(). Without it a YAML MERGE
// KEY (`<<: *defaults`) survives as a literal `<<` key, so a `concurrency:`
// arriving through one is INVISIBLE to the presence check below — the one shape
// that could still defeat a rule whose whole strength is that presence has no
// value to inspect. This spec cannot require workflow-yaml-utils (that import is
// one of the signals that would force it into PLATFORM_META_SPECS and testIgnore
// it on the very lanes it exists to guard), so the option is spelled out here.
function loadWorkflow(file) {
  const raw = fs.readFileSync(file, "utf8");
  let doc;
  try {
    doc = YAML.parse(raw, { merge: true });
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const jobsObj = (doc.jobs && typeof doc.jobs === "object" && doc.jobs) || {};
  return { doc, jobList: Object.keys(jobsObj).map((name) => ({ name, value: jobsObj[name] })) };
}

function listYaml(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

// Assert the two trees this lint reads are really there, and return the caller
// basenames. An empty or absent directory is a FAILURE, never a skip: a lint that
// examines zero files looks exactly like a lint that found nothing wrong, and
// that is the precise miss this whole effort exists to close.
function callerFiles() {
  expect(
    fs.existsSync(CALLER_DIR),
    `${CALLER_DIR} does not exist. A consumer with no workflow directory publishes none of the ` +
      `required contexts its main ruleset demands, so every PR would hang on "Waiting for ` +
      `status to be reported".`,
  ).toBe(true);
  expect(
    fs.existsSync(REUSABLE_DIR),
    `${REUSABLE_DIR} does not exist. The consumer e2e job checks the platform out there ` +
      `(e2e-tests.yml, "Checkout platform"), and without it the reusable half of every ` +
      `<caller job> / <reusable job> context is unreadable — this lint would silently resolve ` +
      `nothing and pass.`,
  ).toBe(true);
  expect(
    fs.existsSync(MANIFEST_PATH),
    `${MANIFEST_PATH} does not exist. It is the SSOT for which contexts are required; without ` +
      `it this lint has no oracle and would sweep every workflow looking for nothing.`,
  ).toBe(true);

  const files = listYaml(CALLER_DIR);
  expect(
    files.length,
    `${CALLER_DIR} listed no workflows — this lint must examine a non-zero number of callers`,
  ).toBeGreaterThan(0);
  return files;
}

function consumerContexts() {
  const manifest = YAML.parse(fs.readFileSync(MANIFEST_PATH, "utf8"), { merge: true }) || {};
  const contexts = requiredContexts(manifest, CONSUMER_RULESET);
  expect(
    contexts,
    `ruleset_library.${CONSUMER_RULESET}.rules[required_status_checks] yielded no contexts — ` +
      `an empty required set makes every assertion below vacuous`,
  ).not.toEqual([]);
  return contexts;
}

// Scan the consumer's callers for required contexts that can end cancelled.
// Mirrors scanCallers() in the platform sibling exactly — same matcher module,
// same `cancellationHazards()` cause set, same bare/two-part context handling —
// differing only in which trees it reads. Both go through the ONE hazard function
// on purpose: a cause added there arms this consumer lane in the same commit,
// which is precisely what did not happen when the guard was named after
// `concurrency` alone.
function scan() {
  // callerFiles() FIRST: it is the function that asserts all three trees exist,
  // with messages that name the missing one and say what its absence means. Read
  // the manifest before that and a missing `.cms-platform/` surfaces as a raw
  // ENOENT stack instead — still a loud failure, but one that tells the reader
  // nothing about why the harness cares.
  const files = callerFiles();
  const contexts = consumerContexts();
  const offenders = [];
  const unreadable = [];
  const resolved = new Map(contexts.map((c) => [c, 0]));
  let examined = 0;

  for (const callerName of files) {
    const caller = loadWorkflow(path.join(CALLER_DIR, callerName));
    if (!caller) continue;
    examined += 1;

    for (const callerJob of caller.jobList) {
      for (const context of contexts) {
        const { callerHalf, reusableHalf } = splitContext(context);
        const how = publishKind(callerJob.name, callerJob.value, callerHalf);
        if (!how) continue;

        const basename = reusableBasename((callerJob.value || {}).uses);
        const reusablePath = basename ? path.join(REUSABLE_DIR, basename) : null;
        const reusable =
          reusablePath && fs.existsSync(reusablePath) ? loadWorkflow(reusablePath) : null;

        if (reusableHalf != null) {
          // No `uses:` -> this job publishes the BARE context, not this one.
          if ((callerJob.value || {}).uses == null) continue;

          // UNREADABLE REUSABLE: report the caller side anyway and record the
          // hole. Skipping outright was a live bypass in the platform sibling —
          // an unresolvable `uses:` (a lowercased owner, which GitHub resolves
          // identically; a reusable renamed upstream; a `.cms-platform` checkout
          // pinned before the file existed) discarded the caller's OWN
          // declarations, which need no reusable to be read. This is the mode
          // that matters most here: the consumer's caller is the one site a
          // `platform_ref` bump can never correct.
          if (!reusable) {
            unreadable.push(
              `${callerName} job \`${callerJob.name}\` publishes the first half of required ` +
                `context \`${context}\` through \`uses: ${(callerJob.value || {}).uses}\`, which ` +
                `does not resolve under ${REUSABLE_DIR}. The never-cancelled invariant is ` +
                `UNENFORCED for this context.`,
            );
            for (const { where, what, fix } of cancellationHazards({
              callerDoc: caller.doc,
              callerJob: callerJob.value,
            })) {
              offenders.push(
                `${callerName} → required context \`${context}\` (caller job ` +
                  `\`${callerJob.name}\` matched by ${how}; reusable ` +
                  `\`${(callerJob.value || {}).uses}\` UNREADABLE, so only the caller side was ` +
                  `checked) — ${where} ${what}. ${fix}`,
              );
            }
            continue;
          }
          for (const reusableJob of reusable.jobList) {
            if (!publishKind(reusableJob.name, reusableJob.value, reusableHalf)) continue;
            resolved.set(context, resolved.get(context) + 1);
            const decls = cancellationHazards({
              callerDoc: caller.doc,
              callerJob: callerJob.value,
              reusableDoc: reusable.doc,
              reusableJob: reusableJob.value,
            });
            for (const { where, what, fix } of decls) {
              offenders.push(
                `${callerName} → required context \`${context}\` (caller job ` +
                  `\`${callerJob.name}\` matched by ${how}; reusable ${basename} job ` +
                  `\`${reusableJob.name}\`) — ${where} ${what}. ${fix}`,
              );
            }
          }
          continue;
        }

        resolved.set(context, resolved.get(context) + 1);
        const decls = cancellationHazards({
          callerDoc: caller.doc,
          callerJob: callerJob.value,
          reusableDoc: reusable ? reusable.doc : null,
        });
        for (const { where, what, fix } of decls) {
          offenders.push(
            `${callerName} → required context \`${context}\` (job \`${callerJob.name}\` matched ` +
              `by ${how}) — ${where} ${what}. ${fix}`,
          );
        }
      }
    }
  }

  return { contexts, offenders, unreadable, resolved, examined };
}

test.describe("this consumer's required contexts can never end `cancelled`", () => {
  // Fail-on-zero, asserted before the rule itself so a harness that reads nothing
  // is distinguishable from a tree that is clean.
  test("this consumer's callers, reusables and ruleset manifest were all read", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { contexts, unreadable, resolved, examined } = scan();
    expect(examined, "this lint must parse a non-zero number of caller workflows").toBeGreaterThan(
      0,
    );
    expect(contexts.length, "consumer-main must declare required contexts").toBeGreaterThan(0);

    // Every required context must resolve to a real job in THIS consumer's tree.
    // One that resolves to nothing is either a renamed caller — in which case the
    // required check now deadlocks every PR here, because nothing will ever report
    // it — or this lint having quietly stopped looking, and the second failure mode
    // is what makes a green run meaningless. A consumer's caller set is not free to
    // drift: `check-platform-pin-consistency.js` already fails on a MISSING dictated
    // caller, so an unresolved context is a real defect either way.
    const unresolved = [...resolved.entries()].filter(([, n]) => n === 0).map(([ctx]) => ctx);
    expect(
      unresolved,
      `these consumer-main required contexts resolve to NO job in this consumer's ` +
        `.github/workflows — a required context nothing publishes hangs every PR on "Waiting ` +
        `for status to be reported", and a lint that matches nothing asserts nothing`,
    ).toEqual([]);

    // A reusable this lint cannot read is a HOLE, and a quiet hole reads exactly
    // like compliance. It is asserted separately from the resolution counter
    // above because that counter is keyed per CONTEXT across all callers, so a
    // context with a second publisher stays non-zero while one publisher has
    // silently stopped being checked.
    expect(
      unreadable,
      `a caller in this consumer publishes a required context through a reusable this lint ` +
        `cannot read under .cms-platform/, so the never-cancelled invariant is UNENFORCED for ` +
        `it. ` +
        `Either the caller's \`uses:\` drifted off the pinned platform or the \`.cms-platform\` ` +
        `checkout is incomplete — fix that, do not widen this lint.`,
    ).toEqual([]);
  });

  test("no job publishing a required context can be cancelled structurally", () => {
    test.skip(!CONSUMER, SKIP_REASON);

    const { offenders } = scan();
    expect(offenders, `${FIX_ADVICE}Offenders:\n  ` + offenders.join("\n  ")).toEqual([]);
  });
});
