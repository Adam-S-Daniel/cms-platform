/*
 * Shared, PURE logic for the two required-context-concurrency lints:
 *
 *   e2e/required-context-concurrency.test.js           (PLATFORM mode — registered
 *                                                       in PLATFORM_META_SPECS)
 *   e2e/consumer-required-context-concurrency.test.js  (CONSUMER mode — deliberately
 *                                                       NOT registered)
 *
 * ── THE RULE THESE TWO ENFORCE ───────────────────────────────────────────
 *
 * A job that publishes a REQUIRED status context carries NO `concurrency`
 * declaration, at any of the four sites that can govern it. AGENTS.md states it
 * categorically, and cms-platform#285 is where the wording stopped being
 * negotiable.
 *
 * WHY NOT THE CARVE-OUT. AGENTS.md also says jobs triggered only by
 * `push` / `synchronize` are "safe to cancel — each a new sha". Measured in
 * production, that premise is false: on adamdaniel.ai PR #3006 (2026-08-09) the
 * PR opened at 01:57:10Z, a force-push moved the head at 01:57:38Z, and BOTH
 * visual-regression runs 31289327061 (cancelled) and 31289327099 (skipped) were
 * created at 01:57:41Z carrying the SAME head_sha 68d7c777. Webhook delivery
 * latency dispatches the `opened` run after the force-push has already advanced
 * the ref, so `opened` and `synchronize` land on one SHA. Neither can be
 * narrowed away — without them the required context never reports at all — so no
 * trigger set makes a shared key collision-free. Only the absence of a key does.
 *
 * WHY IT IS THE GROUP AND NOT THE TRIGGER THAT GETS FIXED. `concurrency` lives
 * in the PLATFORM reusable, so a `platform_ref` bump carries the fix to every
 * consumer automatically. `pull_request.types` lives in the CONSUMER's own
 * caller, and nothing propagates it: `platform-bump.yml` seeds only a
 * WHOLLY-MISSING caller and leaves an existing one alone even when it has
 * drifted, and `scripts/check-platform-pin-consistency.js`'s `structuralShape()`
 * compares only `permissions` + `jobs.*` — `on:` is excluded by design. A
 * template-only trigger change would therefore reach neither live site while the
 * lint reading `examples/site/` reported green forever.
 *
 * WHAT A GROUP COSTS WHEN IT GOES WRONG. A cancelled run shadowing a successful
 * one for the same context+SHA hard-blocks the merge: the API answers
 * `405 Required status check "<ctx>" is cancelled`, and NOTHING overrides it —
 * not native auto-merge, not an explicit merge call, not a nudge bot, not an
 * admin. GitHub picks between the two NON-DETERMINISTICALLY, so the PR reads
 * all-green and simply never lands, and it will not reproduce on demand.
 * `cancel-in-progress: false` is not a fix: GitHub keeps the in-progress run plus
 * only the LATEST pending run in a group and cancels the other pending
 * duplicates, so a same-SHA burst still strands cancelled runs.
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

const FIX_ADVICE =
  "A job publishing a REQUIRED status context carries a `concurrency` declaration. AGENTS.md " +
  "forbids that categorically, because two runs CAN share a head SHA on any trigger set that " +
  "still reports the context — measured on adamdaniel.ai PR #3006 (2026-08-09), where an " +
  "`opened` run and a force-push `synchronize` run were both created at 01:57:41Z on head_sha " +
  "68d7c777. Once GitHub cancels one of a same-SHA pair, a CANCELLED required context " +
  'hard-blocks the merge — the API answers `405 Required status check "<ctx>" is cancelled` — ' +
  "and nothing overrides it: not native auto-merge, not an explicit merge call, not a nudge " +
  "bot, not an admin. The PR reads all-green, never lands, and the failure is a coin flip so " +
  "it will not reproduce on demand. `cancel-in-progress: false` is NOT a fix (GitHub keeps the " +
  "in-progress run plus only the LATEST pending run and cancels the rest), and neither is " +
  "narrowing `pull_request.types` (the two types that cannot be removed are the pair that " +
  "collided). DELETE the `concurrency:` block from the site named below and accept that " +
  "superseded runs finish: runner minutes are recoverable, a wedged required check is not. ";

module.exports = {
  escapeRegExp,
  dynamicNameSkeleton,
  stripMatrixSuffix,
  hasMatrix,
  publishKind,
  jobPublishes,
  describeConcurrency,
  concurrencyDeclarations,
  reusableBasename,
  splitContext,
  requiredContexts,
  workflowOn,
  FIX_ADVICE,
};
