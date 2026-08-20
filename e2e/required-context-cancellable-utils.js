/*
 * Shared, PURE logic for the two required-context-CANCELLABLE lints:
 *
 *   e2e/required-context-cancellable.test.js           (PLATFORM mode — registered
 *                                                       in PLATFORM_META_SPECS)
 *   e2e/consumer-required-context-cancellable.test.js  (CONSUMER mode — deliberately
 *                                                       NOT registered)
 *
 * ── THE INVARIANT THESE TWO ENFORCE ──────────────────────────────────────
 *
 * NO REQUIRED STATUS CONTEXT MAY EVER END `cancelled`.
 *
 * That is the property, and it is deliberately stated as the OUTCOME rather than
 * as a list of forbidden keys. A cancelled required context hard-blocks the
 * merge: the API answers `405 Required status check "<ctx>" is cancelled`, and
 * NOTHING overrides it — not native auto-merge, not an explicit merge call, not
 * a nudge bot, not an admin. The PR reads all-green in the UI and simply never
 * lands.
 *
 * These files were originally named "…-concurrency" and enforced ONE cause: a
 * `concurrency` declaration governing the publishing job (cms-platform#285).
 * Naming the guard after one cause is what let the SECOND one ship. v0.1.87
 * deleted every group from every required-context publisher and closed that
 * route — and four days later, on adamdaniel.ai PRs #3202 and #3217, three
 * required contexts still concluded `cancelled`:
 *
 *   #3217  preview-media / preview-media  cancelled  15:22:25Z → 15:52:45Z  30m20s
 *   #3217  parity / parity                cancelled  15:22:19Z → 15:52:45Z  30m26s
 *   #3202  parity / parity                cancelled  04:40:11Z → 05:10:27Z  30m16s
 *
 * All three sat on a 30-minute wall with no `concurrency` group within reach.
 * `timeout-minutes` was the cause, and a GitHub quirk is what hid it: a job
 * killed at its wall reports conclusion `cancelled`, NOT `timed_out`. Had the
 * API said `timed_out`, `scripts/audit-scheduled-runs.js` would already have
 * alerted on it — `timed_out` is in its BAD_CONCLUSIONS and `cancelled` is
 * necessarily excluded there (the runner-starvation carve-out is itself a
 * cancelled shape). cms-platform#289.
 *
 * BE HONEST ABOUT THE SCOPE: neither PR was "all-green but unmergeable" —
 * both also carried `e2e / e2e: failure`, so both were blocked for an ordinary
 * reason too. What is DEMONSTRATED is the MECHANISM, not the wedge.
 *
 * ── THE STRUCTURAL CAUSES THIS FILE CAN SEE, AND THE ONES IT CANNOT ──────
 *
 * `cancellationHazards()` reports four, all readable off parsed workflow YAML:
 *
 *   1. `concurrency` at any of the four sites that can govern the job. #285.
 *   2. `timeout-minutes` ON THE PUBLISHING JOB. #289.
 *   3. `strategy.fail-fast` left at its default `true` on a publishing job that
 *      HAS a `matrix` — a sibling leg's failure then cancels the rest.
 *   4. A publishing job that carries `needs:` but whose `if:` never says
 *      `always()`. That one is not a cancellation but its twin: the gate is
 *      SKIPPED whenever anything upstream fails or is cancelled, so the required
 *      context either hangs on "Waiting for status to be reported" or reports a
 *      `skipped` conclusion that never went red. Same wedge, opposite sign.
 *
 * WHAT IT CANNOT SEE, stated here so nobody infers coverage that is not present:
 * a human pressing Cancel; `gh run cancel`; GitHub's own 6-hour job and 35-day
 * run ceilings; a runner evicted mid-job; an organization-level cancellation
 * policy. None of those are in the workflow text, so no static lint over that
 * text can flag them. The rule this file CAN enforce is that no cause a reader
 * could have written down is present.
 *
 * ── WHY THE CARVE-OUT FOR CAUSE 1 WAS DROPPED ────────────────────────────
 *
 * AGENTS.md also says jobs triggered only by `push` / `synchronize` are "safe to
 * cancel — each a new sha". Measured in production, that premise is false: on
 * adamdaniel.ai PR #3006 (2026-08-09) the PR opened at 01:57:10Z, a force-push
 * moved the head at 01:57:38Z, and BOTH visual-regression runs 31289327061
 * (cancelled) and 31289327099 (skipped) were created at 01:57:41Z carrying the
 * SAME head_sha 68d7c777. Webhook delivery latency dispatches the `opened` run
 * after the force-push has already advanced the ref, so `opened` and
 * `synchronize` land on one SHA. Neither can be narrowed away — without them the
 * required context never reports at all — so no trigger set makes a shared key
 * collision-free. Only the absence of a key does.
 *
 * WHY IT IS THE GROUP (AND THE TIMEOUT) AND NOT THE TRIGGER THAT GETS FIXED.
 * Both live in the PLATFORM reusable, so a `platform_ref` bump carries the fix to
 * every consumer automatically. `pull_request.types` lives in the CONSUMER's own
 * caller, and nothing propagates it: `platform-bump.yml` seeds only a
 * WHOLLY-MISSING caller and leaves an existing one alone even when it has
 * drifted, and `scripts/check-platform-pin-consistency.js`'s `structuralShape()`
 * compares only `permissions` + `jobs.*` — `on:` is excluded by design. A
 * template-only trigger change would therefore reach neither live site while the
 * lint reading `examples/site/` reported green forever.
 *
 * WHAT A GROUP COSTS WHEN IT GOES WRONG. GitHub picks between a cancelled run and
 * a successful one for the same context+SHA NON-DETERMINISTICALLY, so the failure
 * is a coin flip and will not reproduce on demand. `cancel-in-progress: false` is
 * not a fix: GitHub keeps the in-progress run plus only the LATEST pending run in
 * a group and cancels the other pending duplicates, so a same-SHA burst still
 * strands cancelled runs.
 *
 * ── WHY THIS FILE IS PURE ────────────────────────────────────────────────
 *
 * It reads nothing from disk and names no path. The two specs supply their own
 * roots — the platform tree in one case, `<SITE_ROOT>` and the consumer's
 * `.cms-platform/` checkout in the other — and that separation is load-bearing:
 * `e2e/platform-meta-spec-registry.test.js` classifies a spec platform-internal
 * from its OWN source, and a spec that must run on a CONSUMER lane cannot afford
 * to carry a platform-rooted `.github/workflows` path or a
 * `require("./workflow-yaml-utils")`. Keeping the shared logic here lets both
 * specs run the SAME matcher without either of them being misclassified.
 */

// ── WHICH CONTEXT A JOB ACTUALLY PUBLISHES ───────────────────────────────
//
// GitHub publishes a job's `name:` as the status-check context when one is set,
// and falls back to the job id only when it is not. Matching a required context
// against the job ID ALONE — which the first cut of this lint did — is blind to
// the exact shape that most needs catching: a workflow whose job id is `foo` but
// whose `name:` is `node-unit-lints` publishes a REQUIRED context, and the lint
// sails straight past it.
//
// So a job is matched on the id AND on the name. Matching both is deliberately a
// SUPERSET of GitHub's own rule (a named job publishes only the name): the extra
// arm can only ever ADD findings, never hide one, and a ruleset naming a job id
// is strong evidence someone meant that job.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A `name:` carrying an interpolation is DYNAMIC — its value is not knowable
// here — so the job is matched CONSERVATIVELY, against the name's literal
// skeleton with every interpolation widened to "anything". This repo's one real
// case, `verify ${{ matrix.owner }} PAT`, becomes /^verify [\s\S]* PAT$/, which
// still cannot be `node-unit-lints`; a `${{ … }}-unit-lints` name would match and
// be flagged. Widening to "matches everything" was the other option and was
// rejected: it turns every unrelated dynamically-named job in a grouped workflow
// into a false positive, and a lint that cries wolf gets waved through.
function dynamicNameSkeleton(name) {
  const literals = name.split(/\$\{\{[\s\S]*?\}\}/).map(escapeRegExp);
  return new RegExp(`^${literals.join("[\\s\\S]*")}$`);
}

// A MATRIX job does not publish its bare name. GitHub appends the matrix values
// in parentheses — `check (ubuntu-latest, 20)` — so a ruleset requiring
// `check (ubuntu-latest, 20)` names a job whose id and `name:` are both `check`,
// and an exact-match-only matcher never connects the two.
//
// The correction OVER-matches on purpose: for a job carrying `strategy.matrix`,
// the required context is ALSO tried with one trailing parenthesised group
// stripped. That can pair a required `deploy (prod)` with an unrelated matrix job
// literally named `deploy`, which is a FINDING that a human then dismisses —
// whereas the miss it replaces is a required context sitting in a cancellable
// group that nobody sees. Findings are recoverable; a wedged merge is not. The
// match kind reported below says WHICH arm fired, so a spurious one is
// identifiable from the failure text alone rather than needing a re-derivation.
function stripMatrixSuffix(context) {
  return context.replace(/\s*\([^()]*\)\s*$/, "");
}

function hasMatrix(jobValue) {
  const strategy = (jobValue || {}).strategy;
  return !!(strategy && typeof strategy === "object" && strategy.matrix != null);
}

// How this job comes to publish `requiredName`, or null when it does not. The
// STRING is part of the contract: every offender message quotes it, so a reader
// can tell "the ruleset names this job id" from "this is a matrix over-match"
// without opening the workflow.
function publishKind(jobId, jobValue, requiredName) {
  const value = jobValue || {};
  const rawName = typeof value.name === "string" && value.name.trim() !== "" ? value.name : null;
  const matrix = hasMatrix(value);

  const candidates = [{ text: String(requiredName), via: "" }];
  if (matrix) {
    const stripped = stripMatrixSuffix(String(requiredName));
    if (stripped !== String(requiredName)) {
      candidates.push({ text: stripped, via: " (matched through its matrix expansion)" });
    }
  }

  for (const { text, via } of candidates) {
    if (text === jobId) return `the job id \`${jobId}\`${via}`;
    if (rawName && !rawName.includes("${{") && text === rawName) {
      return `its \`name: ${rawName}\`${via}`;
    }
    if (rawName && rawName.includes("${{") && dynamicNameSkeleton(rawName).test(text)) {
      return `the literal skeleton of its DYNAMIC \`name: ${rawName}\`${via}`;
    }
  }
  return null;
}

// Boolean convenience for the callers that only need "does it publish this?".
function jobPublishes(jobId, jobValue, requiredName) {
  return publishKind(jobId, jobValue, requiredName) !== null;
}

// ── WHERE A CONCURRENCY GROUP CAN HIDE ───────────────────────────────────
//
// A short, quotable rendering of a `concurrency:` node for the offender text.
// The VALUE is informational only — under the categorical rule the mere PRESENCE
// of the key is the finding, so a node with no usable `group:` (or none at all)
// is reported exactly like a keyed one.
function describeConcurrency(node) {
  if (node == null) return "`concurrency:` present with no value";
  if (typeof node === "string") return `group \`${node}\``;
  if (typeof node === "object" && typeof node.group === "string") {
    return `group \`${node.group.replace(/\s+/g, " ").trim()}\``;
  }
  return "`concurrency:` present with no usable `group:`";
}

// EVERY concurrency declaration that can govern this job, as `{ where, what }`.
// All four sites are reported, not just the first: a job-level group cancels
// duplicates exactly as a workflow-level one does, and for a reusable-workflow
// call BOTH the caller's group and the reusable's own are live at once. Reading
// fewer than four is how the two live consumer offenders hid theirs — a reader
// grepping the CALLER for `concurrency:` finds nothing, because the group is on
// the REUSABLE, three repositories away from the PR that wedges.
//
// PRESENCE, not value. `hasOwnProperty` rather than "is there a group string":
// `concurrency:` written with no value parses to null, and treating that as "no
// declaration" would be a silent exemption for the one shape nobody can read at
// a glance. Any site the caller does not supply is simply skipped.
function concurrencyDeclarations({ callerDoc, callerJob, reusableDoc, reusableJob }) {
  const sites = [
    [callerDoc, "the caller workflow's top-level `concurrency:`"],
    [callerJob, "the caller job's `concurrency:`"],
    [reusableDoc, "the REUSABLE workflow's top-level `concurrency:`"],
    [reusableJob, "the REUSABLE job's `concurrency:`"],
  ];
  const out = [];
  for (const [node, where] of sites) {
    if (!node || typeof node !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(node, "concurrency")) continue;
    out.push({ where, what: describeConcurrency(node.concurrency) });
  }
  return out;
}

// ── CAUSE 2: A `timeout-minutes` ON THE PUBLISHING JOB ───────────────────
//
// A job GitHub kills at its `timeout-minutes` wall reports conclusion
// `cancelled`, not `timed_out`. That single API quirk is what made this cause
// invisible for as long as it was: `timed_out` is already alertable in
// scripts/audit-scheduled-runs.js's BAD_CONCLUSIONS, so had GitHub used it the
// audit would have caught #289 without any of this. It did not, and `cancelled`
// cannot simply be added there — the runner-starvation carve-out that audit
// depends on is itself a cancelled-jobs shape, so admitting `cancelled` would
// make that suppression meaningless.
//
// PRESENCE ON THE PUBLISHER IS THE FINDING, exactly as with `concurrency`, and
// for the same reason: there is no safe value. A wall of 30 minutes cancelled
// `parity / parity` twice in one week; a wall of 300 would just move the number.
// The remedy is never a bigger number, it is to put the wall on a job whose
// conclusion nobody requires.
//
// STEP-level `timeout-minutes` is deliberately NOT flagged. GitHub kills an
// over-running STEP and marks it FAILED, so the job concludes `failure` — which
// is exactly the outcome this invariant wants. Only the JOB-level key cancels.
//
// The caller site is checked as well as the reusable one. A caller job that
// `uses:` a reusable cannot legally carry `timeout-minutes` (actionlint rejects
// it), but a BARE required context — self-ci.yml's four — is published by a
// caller job with steps of its own, and that job can carry one.
function timeoutDeclarations({ callerJob, reusableJob }) {
  const sites = [
    [callerJob, "the publishing job's own `timeout-minutes:`"],
    [reusableJob, "the REUSABLE publishing job's `timeout-minutes:`"],
  ];
  const out = [];
  for (const [node, where] of sites) {
    if (!node || typeof node !== "object") continue;
    if (!Object.prototype.hasOwnProperty.call(node, "timeout-minutes")) continue;
    out.push({
      where,
      what: `sets \`timeout-minutes: ${JSON.stringify(node["timeout-minutes"])}\``,
      fix:
        "MOVE the work (and this wall) into a separate job, and leave THIS job as a gate " +
        "that does nothing but `needs:` that job, carries `if: ${{ always() }}`, and exits " +
        "non-zero unless `needs.<job>.result == 'success'`. That is the shape " +
        "`e2e-tests.yml` already uses to publish `e2e / e2e` over its `project` matrix, and " +
        "`visual-regression.yml` to publish `visual-regression / approve-regression`. The " +
        "gate itself gets NO `timeout-minutes` — being unkillable-at-a-wall is its entire " +
        "job. cms-platform#289.",
    });
  }
  return out;
}

// ── CAUSE 3: `strategy.fail-fast` ON A MATRIX PUBLISHER ──────────────────
//
// `fail-fast` defaults to TRUE, and when one leg of a matrix fails GitHub
// CANCELS the rest. If a ruleset requires a matrix-expanded context — which
// publishKind() below deliberately resolves, because a ruleset naming
// `check (ubuntu-latest, 20)` is naming a matrix job — a single red leg leaves
// its siblings' required contexts `cancelled`.
//
// NO PUBLISHER IN THIS REPO HAS A MATRIX TODAY, so over the real tree this arm
// currently finds nothing; it is exercised only by the unit cases in the two
// specs. It is here because the invariant is the OUTCOME, not the cause list,
// and this is a cause a reader can write down in one line — which is exactly how
// #289 shipped past a guard named after a different one. `e2e-tests.yml`'s
// `project` matrix already sets `fail-fast: false` for a related reason ("one red
// project doesn't cancel the others"), so the shape is not exotic here.
function failFastDeclarations({ callerJob, reusableJob }) {
  const sites = [
    [callerJob, "the publishing job's `strategy`"],
    [reusableJob, "the REUSABLE publishing job's `strategy`"],
  ];
  const out = [];
  for (const [node, where] of sites) {
    if (!node || typeof node !== "object") continue;
    const strategy = node.strategy;
    if (!strategy || typeof strategy !== "object" || strategy.matrix == null) continue;
    // Only an EXPLICIT `false` is safe. Absent means GitHub's default `true`;
    // any other value (a `${{ }}` expression this file cannot evaluate) is
    // reported, because "we could not tell" is not "clean".
    if (strategy["fail-fast"] === false) continue;
    const declared = Object.prototype.hasOwnProperty.call(strategy, "fail-fast")
      ? `\`fail-fast: ${JSON.stringify(strategy["fail-fast"])}\``
      : "no `fail-fast:` at all, so GitHub's default `true`";
    out.push({
      where,
      what: `runs a \`matrix\` with ${declared}`,
      fix:
        "set `fail-fast: false`. With it true, one red leg CANCELS its siblings, and a " +
        "ruleset naming a matrix-expanded context (`<name> (<values>)`) then holds a " +
        "cancelled required check. cms-platform#289.",
    });
  }
  return out;
}

// ── CAUSE 4: A GATE THAT SKIPS INSTEAD OF REPORTING ──────────────────────
//
// The twin of a cancelled context, and the failure mode the fix for cause 2
// introduces if it is done carelessly. A publishing job with `needs:` and no
// `always()` in its `if:` is SKIPPED the moment anything upstream fails or is
// cancelled — so the required context either hangs the PR forever on "Waiting
// for status to be reported" (the missing-check trap) or reports a `skipped`
// conclusion that never went red. Splitting a required job into work + gate is
// only an improvement while the gate actually reports.
//
// The test is textual ON THE `if:` EXPRESSION and nothing more: this file does
// not evaluate GitHub expressions, and it says so rather than pretending to. An
// `if:` mentioning `always()` inside a condition that can still be false —
// `always() && github.event_name == 'push'` — passes here and would still skip.
// Reported as the floor it is.
function gateShapeDeclarations({ callerJob, reusableJob }) {
  const sites = [
    [callerJob, "the publishing job's `if:`"],
    [reusableJob, "the REUSABLE publishing job's `if:`"],
  ];
  const out = [];
  for (const [node, where] of sites) {
    if (!node || typeof node !== "object") continue;
    if (node.needs == null) continue;
    const cond = node.if == null ? "" : String(node.if);
    if (cond.includes("always()")) continue;
    out.push({
      where,
      what:
        `never says \`always()\` (it is ${cond === "" ? "absent" : `\`${cond}\``}) while the ` +
        "job declares `needs:`",
      fix:
        "add `if: ${{ always() }}`. Without it the gate is SKIPPED whenever the job it " +
        "`needs:` fails or is cancelled, and a required context that skips either hangs the " +
        "PR on \"Waiting for status to be reported\" or reports a `skipped` conclusion that " +
        "never went red. cms-platform#289.",
    });
  }
  return out;
}

// EVERY structural route to a cancelled (or never-reported) required context that
// this file can see, for one publishing job, as `{ where, what, fix }`.
//
// One function so the two scanners cannot drift apart on WHICH causes they check
// — the whole lesson of #289 is that a guard named and shaped around a single
// cause does not grow a second one on its own. Adding a cause here arms both
// specs at once.
function cancellationHazards(sites) {
  return [
    ...concurrencyDeclarations(sites).map((d) => ({
      ...d,
      what: `declares ${d.what}`,
      fix:
        "DELETE that block and accept that superseded runs finish: runner minutes are " +
        "recoverable, a wedged required check is not. cms-platform#285.",
    })),
    ...timeoutDeclarations(sites),
    ...failFastDeclarations(sites),
    ...gateShapeDeclarations(sites),
  ];
}

// `uses: <owner>/<repo>/.github/workflows/<file>@<ref>` or the local
// `uses: ./.github/workflows/<file>` form self-secrets-scan.yml uses. Returns
// the reusable's BASENAME, or null when the target is not a cms-platform
// workflow (a third-party reusable's jobs are unreadable from here, and an
// `actions/checkout@v4`-shaped step `uses:` is not a workflow call at all).
//
// THE OWNER/REPO MATCH IS CASE-INSENSITIVE, and that is not cosmetic. GitHub
// resolves an owner and a repository name case-insensitively, so
// `adam-s-daniel/cms-platform/...` runs the IDENTICAL reusable in production —
// but an anchored case-SENSITIVE literal returned null for it, and a null
// basename used to mean "reusable unreadable", which used to mean "report
// nothing". A one-character case difference in a consumer's caller therefore
// silently switched this lint off for that file while the workflow kept running
// normally. Measured: with the group in place and only the owner lowercased,
// this pass went from 1 failed to 15 passed. The file BASENAME stays
// case-sensitive on purpose — it is a path on disk, and Linux treats it so.
function reusableBasename(usesValue) {
  const uses = String(usesValue || "");
  const local = /^\.\/\.github\/workflows\/([^@\s]+)$/.exec(uses);
  if (local) return local[1];
  const remote = /^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/([^@\s]+)@/i.exec(uses);
  return remote ? remote[1] : null;
}

// A required status context is either BARE (`node-unit-lints` — a job in the
// workflow that reports it directly) or CALLER/REUSABLE-shaped (`scan / scan` —
// a caller job invoking a reusable, which GitHub publishes as
// `<caller job> / <reusable job>`). Both shapes must resolve, because a context
// this lint cannot resolve is either a renamed job — in which case the required
// check now deadlocks every PR, since nothing will ever report it — or the lint
// having quietly stopped looking. An earlier cut `continue`d on a bare context,
// which made the whole pass UNSATISFIABLE the moment a ruleset grew one: the
// context could never resolve, so the "everything resolved" assertion failed with
// no edit that could fix it.
function splitContext(context) {
  const parts = String(context).split(" / ");
  if (parts.length === 1) return { callerHalf: parts[0].trim(), reusableHalf: null };
  return { callerHalf: parts[0].trim(), reusableHalf: parts.slice(1).join(" / ").trim() };
}

// The `context:` strings of one ruleset's required_status_checks rule, out of an
// already-parsed repo-settings.yml manifest object.
function requiredContexts(manifest, rulesetName) {
  const rules = (((manifest || {}).ruleset_library || {})[rulesetName] || {}).rules || [];
  const rule = rules.find((r) => r && r.type === "required_status_checks");
  const checks = ((rule || {}).parameters || {}).required_status_checks || [];
  return checks.map((c) => String((c && c.context) || "")).filter(Boolean);
}

// A workflow's `on:` value. `doc.on` normally holds it, but a BARE `on:` key
// parses to the boolean `true` under a YAML 1.1 schema (both PyYAML and some
// `yaml` configurations), which lands the triggers under the "true" property
// instead — so both are consulted, the same defensive read
// workflow-prod-loop-serialized.test.js and publish-scheduled-posts-flow.test.js
// already use. Never `doc.on` alone. Kept here even though the categorical rule
// no longer reasons about triggers: the offender text names the caller's events,
// and reading them off `doc.on` alone would print `undefined` for a bare `on:`.
function workflowOn(doc) {
  if (!doc || typeof doc !== "object") return null;
  return doc.on != null ? doc.on : doc[true];
}

// The preamble every offender list carries. It states the INVARIANT, not one
// cause — each offender then names its own cause and its own remedy in the
// `fix` field, because the two causes have opposite fixes (delete the block vs.
// move the work into a job whose conclusion nobody requires).
const FIX_ADVICE =
  "NO REQUIRED STATUS CONTEXT MAY END `cancelled`. A cancelled required check hard-blocks " +
  "the merge: the API answers `405 Required status check \"<ctx>\" is cancelled`, and " +
  "nothing overrides it — not native auto-merge, not an explicit merge call, not a nudge " +
  "bot, not an admin. The PR reads all-green and simply never lands. Two routes to that " +
  "outcome are known and BOTH have shipped here: a `concurrency` group (cms-platform#285, " +
  "measured on adamdaniel.ai PR #3006 where an `opened` run and a force-push `synchronize` " +
  "run were created at the same second on head_sha 68d7c777), and a `timeout-minutes` wall " +
  "(cms-platform#289, measured on adamdaniel.ai PRs #3202 and #3217 where `parity / parity` " +
  "and `preview-media / preview-media` concluded `cancelled` at 30m16s, 30m20s and 30m26s " +
  "with no group anywhere near them — GitHub reports a job it killed at its wall as " +
  "`cancelled`, never as `timed_out`). Each offender below names its own remedy. Do NOT " +
  "reach for `cancel-in-progress: false` (GitHub keeps the in-progress run plus only the " +
  "LATEST pending run and cancels the rest) or for a larger timeout (that moves the number, " +
  "not the failure mode). "

module.exports = {
  escapeRegExp,
  dynamicNameSkeleton,
  stripMatrixSuffix,
  hasMatrix,
  publishKind,
  jobPublishes,
  describeConcurrency,
  concurrencyDeclarations,
  timeoutDeclarations,
  failFastDeclarations,
  gateShapeDeclarations,
  cancellationHazards,
  reusableBasename,
  splitContext,
  requiredContexts,
  workflowOn,
  FIX_ADVICE,
};
