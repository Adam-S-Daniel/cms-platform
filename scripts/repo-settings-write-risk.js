#!/usr/bin/env node
"use strict";
// Classify each write in a repo-settings fix plan as SAFE (cannot reduce
// protection) or GATED (might, or is not understood well enough to say).
//
// WHY THIS EXISTS. `repo-settings-apply.yml` puts every apply behind a human
// reviewer. That was the right default and it decayed exactly the way a
// blanket gate always does: the daily re-converge asked for an approval every
// morning, the approvals it asked for were routine tightenings a human had
// already merged into `repo-settings.yml`, and — because the request was
// indistinguishable from a request that mattered — the one item that actually
// needed a look (adamdaniel.ai's `main` ruleset losing
// `prerelease-guard / prerelease-guard`, #310) sat unapplied from 2026-08-27
// while four consecutive runs asked about it. A gate a person clicks daily is
// not a control; it is a habit, and habits do not read the diff.
//
// So the gate is narrowed to the writes where a human's judgement can change
// the outcome: anything that could REDUCE protection on a repository. A write
// that can only add protection is applied unattended.
//
// TWO PROPERTIES MAKE THAT SAFE, AND BOTH ARE LOAD-BEARING:
//
//  1. FAIL CLOSED, ALWAYS. This is an ALLOWLIST, not a denylist. A write is
//     SAFE only if it matches a shape enumerated below; every unrecognised
//     key, rule type, parameter or value — including one GitHub adds next
//     year — is GATED. The cost of a false GATED is one click. The cost of a
//     false SAFE is an unattended admin write that weakened a repo. Those are
//     not symmetric, and this file is written as though only the second one
//     exists.
//
//  2. IT IS ENFORCED AT WRITE TIME, NOT AT ROUTING TIME. The workflow uses
//     this classification to decide which job runs, but the ungated job also
//     passes `--refuse-weakening`, which re-runs the classifier against the
//     plan it is about to apply and refuses the whole plan if anything is
//     GATED. So a bug in a workflow `if:` cannot produce an unattended
//     weakening write — it can only produce a red job. Same shape as the
//     read/write token split in repo-settings-apply.yml's header note 2:
//     incapable, rather than trusted.
//
// A NOTE ON "TIGHTENING" AS A WORD. Nothing here reasons about whether a
// setting is *good*. It reasons about one question only: can applying this
// write leave the repository with FEWER constraints than it has now? Removing
// a required status check can. Adding one cannot. Disabling a merge method
// cannot. Enabling one can. Where the answer is "it depends", the answer is
// GATED.
//
// Consumed by scripts/audit-repo-settings.js (--refuse-weakening and the
// machine-readable plan line) and asserted by e2e/repo-settings-audit.test.js.

// Local, so this module has no dependency on the 1900-line audit script it is
// required BY (a cycle would be silent until the day one of them is loaded
// first).
function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}

// ── repo flags ──────────────────────────────────────────────────────────────
// Keyed by MANAGED_REPO_KEYS. A key ABSENT from this map is GATED whatever it
// is set to — including the cosmetic ones (`squash_merge_commit_title` and
// friends). They are omitted deliberately: they have never drifted, so keeping
// them out costs nothing and keeps this list to values whose protective
// meaning was actually reasoned about.
const SAFE_FLAG_VALUE = {
  // Turning a merge method OFF removes a way to land code. Turning one ON adds
  // one, which is why the direction — not the key — is what is allowlisted.
  allow_squash_merge: false,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_auto_merge: false,
  // Deleting a branch that has already merged removes nothing protective.
  delete_branch_on_merge: true,
  web_commit_signoff_required: true,
};

// ── Actions permissions ─────────────────────────────────────────────────────
const SAFE_ACTIONS_VALUE = { sha_pinning_required: true };
// Fork-PR approval, ordered least → most restrictive. Moving UP the list can
// only require more approvals; moving down requires fewer.
const APPROVAL_POLICY_RANK = [
  "first_time_contributors_new_to_github",
  "first_time_contributors",
  "all_external_contributors",
];

// ── rulesets ────────────────────────────────────────────────────────────────
// Parameters of the `required_status_checks` rule whose direction is
// understood. Everything else on that rule, and every parameter of every OTHER
// rule type, is GATED when it differs.
const SAFE_RSC_PARAM_VALUE = {
  // "require branches to be up to date before merging" — on is stricter.
  strict_required_status_checks_policy: true,
  // "skip these checks on branch creation" — off is stricter.
  do_not_enforce_on_create: false,
};

// `RepositoryRole#5 (always)` — type, id and mode are the three things a
// reviewer needs to decide whether an actor belongs in a bypass list.
function describeActor(a) {
  const mode = a && a.bypass_mode ? ` (${a.bypass_mode})` : "";
  return `${(a && a.actor_type) || "?"}#${a && a.actor_id != null ? a.actor_id : "?"}${mode}`;
}

function gated(reason) {
  return { verdict: "gated", reason };
}
function safe(reason) {
  return { verdict: "safe", reason };
}

// Classify ONE write. `w` is the normalised shape buildFixPlan hands us:
//   { kind:"flag",               key, live, desired }
//   { kind:"actions-permission", key, live, desired }
//   { kind:"ruleset-put",        name, live, desired }   // projected bodies
//   { kind:"ruleset-post",       name, desired }
//   { kind:"environment-put",    name, desired }
function classifyWrite(w) {
  switch (w && w.kind) {
    case "flag":
      if (!(w.key in SAFE_FLAG_VALUE))
        return gated(`repo flag \`${w.key}\` is not on the non-weakening list`);
      if (!deepEqual(w.desired, SAFE_FLAG_VALUE[w.key]))
        return gated(
          `repo flag \`${w.key}\` -> ${JSON.stringify(w.desired)} can add capability`,
        );
      return safe(`repo flag \`${w.key}\` -> ${JSON.stringify(w.desired)}`);

    case "actions-permission":
      if (w.key === "approval_policy") {
        const from = APPROVAL_POLICY_RANK.indexOf(w.live);
        const to = APPROVAL_POLICY_RANK.indexOf(w.desired);
        if (to === -1)
          return gated(
            `fork-PR \`approval_policy\` -> ${JSON.stringify(w.desired)} is not a known policy`,
          );
        // An unknown/absent live value means we cannot prove the direction.
        if (from === -1)
          return gated(
            `fork-PR \`approval_policy\`: live value ${JSON.stringify(w.live)} is unknown, so the direction cannot be established`,
          );
        return to >= from
          ? safe(`fork-PR \`approval_policy\` -> ${w.desired} (more restrictive)`)
          : gated(`fork-PR \`approval_policy\` -> ${w.desired} (less restrictive)`);
      }
      if (!(w.key in SAFE_ACTIONS_VALUE))
        return gated(
          `Actions permission \`${w.key}\` is not on the non-weakening list`,
        );
      if (!deepEqual(w.desired, SAFE_ACTIONS_VALUE[w.key]))
        return gated(
          `Actions permission \`${w.key}\` -> ${JSON.stringify(w.desired)} can relax enforcement`,
        );
      return safe(`Actions permission \`${w.key}\` -> ${JSON.stringify(w.desired)}`);

    case "security-analysis":
      // Dependabot vulnerability alerts / automated security fixes. The
      // METHOD is the value: PUT enables, DELETE disables. Enabling adds a
      // protection the repo did not have; disabling removes one, and removing
      // a security control unattended is the single least acceptable write on
      // this whole surface.
      if (w.desired === true)
        return safe(`security analysis \`${w.key}\` -> enabled`);
      return gated(`security analysis \`${w.key}\` -> DISABLED`);

    case "unknown-bucket":
      // See planWrites: a fix-plan bucket this module has never been taught
      // about. It reaches here rather than being skipped, because a write the
      // classifier cannot see is a write the ungated lane would perform
      // unexamined — which is the one outcome this file exists to prevent.
      return gated(
        `fix-plan bucket \`${w.key}\` is not known to the write-risk classifier ` +
          "(a new managed surface shipped without teaching it) — routing to a human",
      );

    case "ruleset-post":
      // GitHub enforces the UNION of every ruleset on a repo, so a ruleset
      // that does not exist yet cannot be relaxing anything by existing — its
      // bypass_actors bypass only itself.
      return safe(`new ruleset "${w.name}" (rulesets union, so this only adds)`);

    case "environment-put":
      // Reached only on the CREATE path: buildFixPlan never emits an
      // environment PUT for a name that exists and has drifted
      // (ENV_FIX_FORBIDDEN). The body is the manifest's, so the only reachable
      // outcome is the declared, protected state.
      return safe(`create environment "${w.name}" from the manifest`);

    case "ruleset-put":
      return classifyRulesetPut(w);

    default:
      return gated(`unrecognised write kind ${JSON.stringify(w && w.kind)}`);
  }
}

// A ruleset PUT replaces the whole body, so the question is whether the
// live -> desired delta can remove a constraint. Walk every key that differs;
// each one must be individually provable.
function classifyRulesetPut(w) {
  const live = w.live || {};
  const desired = w.desired || {};
  const reasons = [];
  const keys = new Set([...Object.keys(live), ...Object.keys(desired)]);
  for (const key of keys) {
    if (deepEqual(live[key], desired[key])) continue;
    switch (key) {
      case "name":
        // Matched by name upstream, so this cannot differ; if it somehow does,
        // we are not looking at the ruleset we think we are.
        return gated(`ruleset "${w.name}": \`name\` differs`);
      case "enforcement":
        if (desired.enforcement !== "active")
          return gated(
            `ruleset "${w.name}": enforcement -> ${JSON.stringify(desired.enforcement)}`,
          );
        reasons.push("enforcement -> active");
        break;
      case "bypass_actors": {
        // Only REMOVALS are safe. An added actor is a new way around the rules.
        const liveSet = new Set((live.bypass_actors || []).map((a) => JSON.stringify(canon(a))));
        const added = (desired.bypass_actors || []).filter(
          (a) => !liveSet.has(JSON.stringify(canon(a))),
        );
        // NAME the actors. "1 bypass actor(s) added" sent a reviewer to
        // re-derive which one from a full ruleset body (#396).
        if (added.length)
          return gated(
            `ruleset "${w.name}": ${added.length} bypass actor(s) added: ` +
              added.map(describeActor).join(", "),
          );
        reasons.push("bypass actor(s) removed");
        break;
      }
      case "rules": {
        const verdict = classifyRules(w.name, live.rules || [], desired.rules || []);
        if (verdict.verdict === "gated") return verdict;
        reasons.push(verdict.reason);
        break;
      }
      // `conditions` decides WHICH refs the ruleset covers, and `target`
      // decides what kind of ref. Narrowing either silently un-protects a
      // branch, and the include/exclude glob semantics are not something to
      // reason about unattended.
      default:
        return gated(
          `ruleset "${w.name}": \`${key}\` differs, and this key is not on the non-weakening list`,
        );
    }
  }
  if (!reasons.length)
    // Should be unreachable — buildFixPlan only emits a PUT for a DRIFTED
    // ruleset — but a no-delta PUT is still a full-body write, so say so
    // rather than blessing it silently.
    return gated(`ruleset "${w.name}": no comparable delta found`);
  return safe(`ruleset "${w.name}": ${reasons.join("; ")}`);
}

function classifyRules(name, liveRules, desiredRules) {
  const liveByType = new Map(liveRules.map((r) => [r.type, r]));
  const desiredByType = new Map(desiredRules.map((r) => [r.type, r]));
  const reasons = [];
  for (const type of liveByType.keys()) {
    if (!desiredByType.has(type))
      return gated(`ruleset "${name}": rule \`${type}\` removed`);
  }
  for (const type of desiredByType.keys()) {
    if (!liveByType.has(type)) reasons.push(`rule \`${type}\` added`);
  }
  for (const [type, desiredRule] of desiredByType) {
    const liveRule = liveByType.get(type);
    if (!liveRule) continue;
    if (deepEqual(liveRule, desiredRule)) continue;
    if (type !== "required_status_checks")
      return gated(
        `ruleset "${name}": rule \`${type}\` parameters changed, and only ` +
          "`required_status_checks` has an understood direction",
      );
    const v = classifyRequiredStatusChecks(
      name,
      (liveRule && liveRule.parameters) || {},
      (desiredRule && desiredRule.parameters) || {},
    );
    if (v.verdict === "gated") return v;
    reasons.push(v.reason);
  }
  return reasons.length
    ? safe(reasons.join("; "))
    : gated(`ruleset "${name}": rules differ in a way this classifier cannot name`);
}

function classifyRequiredStatusChecks(name, liveP, desiredP) {
  const reasons = [];
  const keys = new Set([...Object.keys(liveP), ...Object.keys(desiredP)]);
  for (const key of keys) {
    if (deepEqual(liveP[key], desiredP[key])) continue;
    if (key === "required_status_checks") {
      const liveCtx = new Set(
        (liveP.required_status_checks || []).map((c) => c && c.context),
      );
      const desiredCtx = (desiredP.required_status_checks || []).map(
        (c) => c && c.context,
      );
      const desiredSet = new Set(desiredCtx);
      const removed = [...liveCtx].filter((c) => !desiredSet.has(c));
      if (removed.length)
        return gated(
          `ruleset "${name}": required check(s) removed — ${removed.join(", ")}`,
        );
      // Additions only. Guard the entry SHAPE too: a context carrying an
      // integration_id pin is a different assertion from a bare context.
      for (const entry of desiredP.required_status_checks || []) {
        const extra = Object.keys(entry || {}).filter((k) => k !== "context");
        if (extra.length)
          return gated(
            `ruleset "${name}": required check \`${entry && entry.context}\` carries ` +
              `unhandled field(s) ${extra.join(", ")}`,
          );
      }
      const added = desiredCtx.filter((c) => !liveCtx.has(c));
      reasons.push(`required check(s) added — ${added.join(", ")}`);
      continue;
    }
    if (!(key in SAFE_RSC_PARAM_VALUE))
      return gated(
        `ruleset "${name}": required_status_checks parameter \`${key}\` is not on the ` +
          "non-weakening list",
      );
    if (!deepEqual(desiredP[key], SAFE_RSC_PARAM_VALUE[key]))
      return gated(
        `ruleset "${name}": \`${key}\` -> ${JSON.stringify(desiredP[key])} relaxes the check`,
      );
    reasons.push(`\`${key}\` -> ${JSON.stringify(desiredP[key])}`);
  }
  return reasons.length
    ? safe(reasons.join("; "))
    : gated(`ruleset "${name}": required_status_checks differ inexplicably`);
}

// Every key a fix-plan entry may carry, split by what it means. This list is
// the classifier's model of buildFixPlan's output, and it is ENFORCED rather
// than assumed — see the unknown-bucket handling in planWrites.
//
// It exists because the obvious implementation of planWrites (iterate the
// buckets I know about) fails OPEN on a bucket added later: the new writes are
// silently absent from the verdict, so a plan carrying one reports gated=0 and
// the UNGATED lane applies it unexamined. That is not hypothetical — it
// happened within six minutes of this module landing. `securityWrites` (#355,
// Dependabot alerts and automated security fixes) merged just ahead of it, and
// until the `security-analysis` case above existed, a plan mixing one safe
// ruleset write with a security DELETE would have disabled a repo's security
// alerts with nobody asked.
const PLAN_IDENTITY_KEYS = ["repo"];
// Not writes: findings --fix --yes deliberately refuses to perform.
const PLAN_UNFIXABLE_KEYS = ["manualOnly", "skipped", "unmanaged", "envManualOnly"];
// Not a write either: the live values patchBody's keys are being changed FROM.
const PLAN_METADATA_KEYS = ["flagLive"];
// The buckets applyFixPlan actually writes from.
const PLAN_WRITE_KEYS = [
  "patchBody",
  "puts",
  "posts",
  "actionsPuts",
  "envPuts",
  "securityWrites",
];
const PLAN_KNOWN_KEYS = new Set([
  ...PLAN_IDENTITY_KEYS,
  ...PLAN_UNFIXABLE_KEYS,
  ...PLAN_METADATA_KEYS,
  ...PLAN_WRITE_KEYS,
]);

// True when a plan bucket actually holds something. An empty array or object
// is not a write and must not gate a plan — only CONTENT does.
function bucketHasContent(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return v !== undefined && v !== null && v !== false;
}

// Flatten a fix plan (the array buildFixPlan returns) into the normalised
// write list, in the order applyFixPlan would perform them.
function planWrites(plan) {
  const writes = [];
  for (const p of plan || []) {
    // FAIL CLOSED on a surface this module has not been taught. Emitted as a
    // write so it both counts toward "is there anything to do" and classifies
    // as gated — the two things a silently-skipped bucket got wrong.
    for (const key of Object.keys(p || {})) {
      if (PLAN_KNOWN_KEYS.has(key)) continue;
      if (!bucketHasContent(p[key])) continue;
      writes.push({ repo: p.repo, kind: "unknown-bucket", key });
    }
    for (const [key, desired] of Object.entries(p.patchBody || {})) {
      writes.push({
        repo: p.repo,
        kind: "flag",
        key,
        live: (p.flagLive || {})[key],
        desired,
      });
    }
    for (const put of p.puts || [])
      writes.push({
        repo: p.repo,
        kind: "ruleset-put",
        name: put.name,
        live: put.live,
        // `desiredSorted` carries the manifest body under the SAME
        // normalization the live side already went through. Falling back to
        // the raw body keeps an older plan shape working, but it compares
        // sorted against unsorted and will read array ORDER as a delta — see
        // buildFixPlan's note.
        desired: put.desiredSorted || put.body,
        // The audit's per-facet delta, passed through untouched so the plan
        // document can show a reviewer WHAT changes (#396). Not read here.
        changes: put.changes,
      });
    for (const post of p.posts || [])
      writes.push({
        repo: p.repo,
        kind: "ruleset-post",
        name: post.name,
        desired: post.body,
      });
    for (const put of p.actionsPuts || [])
      writes.push({
        repo: p.repo,
        kind: "actions-permission",
        key: put.key,
        live: (put.live === undefined ? null : put.live),
        desired: put.body[put.key],
      });
    for (const put of p.envPuts || [])
      writes.push({
        repo: p.repo,
        kind: "environment-put",
        name: put.environment,
        desired: put.body,
      });
    for (const w of p.securityWrites || [])
      writes.push({
        repo: p.repo,
        kind: "security-analysis",
        key: w.key,
        // The METHOD is the value on this surface; `desired` mirrors it.
        desired: w.desired,
      });
  }
  return writes;
}

// The whole-plan verdict. `gated` is non-empty iff at least one write needs a
// human; `safe` lists the rest. An EMPTY plan is neither — callers decide what
// "nothing to do" means, and none of them should be asking a human about it.
function classifyPlan(plan) {
  const writes = planWrites(plan);
  const safeWrites = [];
  const gatedWrites = [];
  for (const w of writes) {
    const c = classifyWrite(w);
    (c.verdict === "safe" ? safeWrites : gatedWrites).push({ ...w, ...c });
  }
  return { writes, safe: safeWrites, gated: gatedWrites };
}

// Count the findings a plan carries that `--fix --yes` will NOT write. These
// are why the plan can be non-empty while there is nothing to apply, and why
// asking a human about them is asking for something they cannot give through
// this workflow.
function planUnfixables(plan) {
  const out = [];
  for (const p of plan || []) {
    for (const key of p.manualOnly || [])
      out.push(`${p.repo}: manual-only key \`${key}\``);
    for (const n of p.skipped || [])
      out.push(`${p.repo}: fix-skipped ruleset "${n}" (live body carries an unknown field)`);
    for (const n of p.unmanaged || [])
      out.push(`${p.repo}: unmanaged live ruleset "${n}"`);
    for (const n of p.envManualOnly || [])
      out.push(`${p.repo}: fix-forbidden environment "${n}"`);
  }
  return out;
}

module.exports = {
  PLAN_KNOWN_KEYS,
  PLAN_WRITE_KEYS,
  classifyWrite,
  classifyPlan,
  planWrites,
  planUnfixables,
  SAFE_FLAG_VALUE,
  SAFE_ACTIONS_VALUE,
  SAFE_RSC_PARAM_VALUE,
  APPROVAL_POLICY_RANK,
};
