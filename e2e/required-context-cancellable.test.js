// @lane: local — PURE-FS lint over repo-settings.yml, every workflow in this
// repo, AND every thin caller under examples/site/.github/workflows; no browser,
// no build, no network. Runs in self-ci.yml's node-unit-lints lane.
//
// PLATFORM-INTERNAL, and registered as such: it reads the root repo-settings.yml
// manifest and the platform's OWN workflow DEFINITIONS, neither of which a
// consumer ships, so it is listed in playwright.config.js's PLATFORM_META_SPECS
// and testIgnore'd on every CONSUMER lane. That ignore is why it is only HALF the
// coverage: the repos where this bug actually wedges a PR are the two consumers,
// and this file cannot run there. Its CONSUMER-mode sibling
// `e2e/consumer-required-context-cancellable.test.js` — deliberately absent from
// the registry, reading `<SITE_ROOT>/.github/workflows/` and the consumer's own
// `.cms-platform/` checkout — is the half that does. Neither substitutes for the
// other: this one is the only coverage of the platform tree and the canonical
// templates, that one the only coverage of what a site actually ships.
//
// ── THE INVARIANT: NO REQUIRED CONTEXT MAY END `cancelled` ───────────────
//
// A cancelled required check is an UNBLOCKABLE merge block. GitHub's merge API
// answers
//
//     405 Required status check "<ctx>" is cancelled
//
// and NOTHING overrides it — not native auto-merge, not an explicit merge call,
// not a nudge bot, not an admin. The PR reads all-green in the UI and simply
// never lands. That is the whole reason this is a lint and not a code-review
// note: the symptom is a PR that looks fine, and the cause is one line three
// screens away, often in another repository.
//
// ── WHY THE INVARIANT IS STATED AS AN OUTCOME, NOT AS A FORBIDDEN KEY ────
//
// This file used to be `required-context-concurrency.test.js` and enforced ONE
// cause: a `concurrency` declaration governing the publishing job
// (cms-platform#285). It enforced that correctly and it is still enforced below.
// Naming the guard after one cause is what let a SECOND one ship underneath it.
//
// v0.1.87 deleted every `concurrency` group from every required-context
// publisher. Four days later, on adamdaniel.ai PRs #3202 and #3217, three
// required contexts concluded `cancelled` anyway:
//
//     #3217  preview-media / preview-media  cancelled  15:22:25Z → 15:52:45Z  30m20s
//     #3217  parity / parity                cancelled  15:22:19Z → 15:52:45Z  30m26s
//     #3202  parity / parity                cancelled  04:40:11Z → 05:10:27Z  30m16s
//
// Every one sat on a 30-minute wall, and there was no `concurrency` group within
// reach of any of them. `timeout-minutes` was the cause. What hid it is a GitHub
// quirk worth writing down: A JOB KILLED AT ITS `timeout-minutes` WALL REPORTS
// CONCLUSION `cancelled`, NOT `timed_out`. `timed_out` is already alertable in
// scripts/audit-scheduled-runs.js's BAD_CONCLUSIONS — had the API used it, that
// audit would have caught this without any of this file. cms-platform#289.
//
// SCOPE, STATED HONESTLY: neither PR was "all-green but unmergeable". Both also
// carried `e2e / e2e: failure`, so both were blocked for an ordinary reason too.
// What is DEMONSTRATED is the MECHANISM — a required context reaching `cancelled`
// with no concurrency group anywhere near it. The wedge-with-everything-else-green
// case has not been observed, and this comment does not claim it.
//
// AGGRAVATING, and the reason this is not "wait and see": deleting the groups in
// v0.1.87 increases runner QUEUEING, and queueing is charged against the same
// 30-minute wall. The #285 fix may make the #289 route MORE likely, not less.
//
// ── WHAT THIS LINT CAN SEE, AND WHAT IT CANNOT ──────────────────────────
//
// `cancellationHazards()` in required-context-cancellable-utils.js reports four
// structural causes, each readable off parsed workflow YAML:
//
//   1. `concurrency` at any of the four sites that can govern the job (#285).
//   2. `timeout-minutes` ON THE PUBLISHING JOB (#289).
//   3. `strategy.fail-fast` not explicitly false on a MATRIX publisher.
//   4. `needs:` without `always()` — the twin failure, where the gate SKIPS
//      instead of reporting and the required context hangs or never reddens.
//
// IT CANNOT SEE: a human pressing Cancel, `gh run cancel`, GitHub's 6-hour job
// and 35-day run ceilings, a runner evicted mid-job, an org-level cancellation
// policy. None of those live in the workflow text, so no static lint over that
// text can flag them. Nothing here should be read as covering them.
//
// ── WHY THE #285 CARVE-OUT WAS DROPPED (cause 1) ────────────────────────
//
// AGENTS.md states the concurrency rule twice. The categorical sentence — "a job
// that publishes a REQUIRED status context and can fire more than once on the
// same head sha gets no `concurrency` block at all" — is the headline. Four
// bullets down sits what reads as a carve-out: "Jobs triggered only by
// `push` / `synchronize` — each a new sha — are safe to cancel."
//
// An earlier version of this lint implemented the carve-out. Two independent
// findings killed it.
//
//   1. THE PREMISE IS FALSE, MEASURED IN PRODUCTION. adamdaniel.ai PR #3006
//      (2026-08-09): opened 01:57:10Z, head_ref_force_pushed 01:57:38Z, and
//      visual-regression runs 31289327061 (cancelled) and 31289327099 (skipped)
//      BOTH created 01:57:41Z carrying head_sha 68d7c777. Webhook delivery
//      latency dispatches the `opened` run AFTER the force-push has already moved
//      the head, so the two land on one SHA. And `opened`/`synchronize` cannot be
//      narrowed away: without them the required context never reports at all. So
//      NO trigger set makes a shared key collision-free.
//   2. THE TRIGGER FIX CANNOT REACH PRODUCTION; THE REUSABLE-SIDE FIX CAN.
//      `concurrency` and `timeout-minutes` both live in the PLATFORM reusable, so
//      a `platform_ref` bump carries either fix to both consumers.
//      `pull_request.types` lives in the CONSUMER's own caller, and nothing
//      propagates it — `platform-bump.yml` seeds only a WHOLLY-MISSING caller
//      (its own comment says so) and `check-platform-pin-consistency.js`'s
//      `structuralShape()` compares `permissions` + `jobs.*` with `on:`
//      deliberately excluded. A template-only `types:` change would have reached
//      neither live site while THIS lint, reading examples/site/, reported green
//      forever.
//
// So the rule enforced here has no exemptions at all, and neither does the
// timeout rule: a bigger wall only moves the number. THE COST IS REAL AND IS
// ACCEPTED — superseded runs finish instead of being cancelled, and a runaway job
// is bounded by a wall on a job whose conclusion nobody requires rather than on
// the publisher. Runner minutes are recoverable; a wedged required check has no
// operator remedy.
//
// ── WHY THIS PARSES YAML AND NEVER GREPS IT ──────────────────────────────
//
// Per AGENTS.md's standing rule, anything reasoning about workflow STRUCTURE goes
// through the real `yaml` parser via workflow-yaml-utils — a regex over source
// reads clean on structure it cannot see (an aliased `types:` list, a flow-style
// `on: [pull_request, push]`, a `concurrency:` or a `timeout-minutes:` inherited
// through a merge key). It also matters that a BARE `on:` key can parse as the
// BOOLEAN `true` under a YAML 1.1 schema, which is why the trigger value is read
// through `workflowOn()` rather than off `doc.on` alone.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, readWorkflow, parseYaml, jobs, events } = require("./workflow-yaml-utils");
const {
  publishKind,
  concurrencyDeclarations,
  timeoutDeclarations,
  failFastDeclarations,
  gateShapeDeclarations,
  cancellationHazards,
  reusableBasename,
  splitContext,
  requiredContexts,
  workflowOn,
  describeConcurrency,
  dynamicNameSkeleton,
  stripMatrixSuffix,
  FIX_ADVICE,
} = require("./required-context-cancellable-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "repo-settings.yml");
const PLATFORM_WORKFLOW_DIR = path.join(REPO_ROOT, ".github", "workflows");
const CALLER_DIR = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const CALLER_LABEL = path.join("examples", "site", ".github", "workflows");

// The ruleset in repo-settings.yml that protects THIS repo's default branch. Its
// required_status_checks list is the SSOT for which contexts are required here;
// deriving the set instead of hardcoding it means adding a fifth required context
// to the ruleset automatically brings that job under this guard.
const PLATFORM_RULESET = "platform-main";

// The ruleset protecting BOTH consumers' default branch. Its six contexts are
// caller/reusable-shaped and are published by the thin callers this repo ships.
const CONSUMER_RULESET = "consumer-main";

// SCOPE LIMIT, STATED SO NOBODY INFERS COVERAGE THAT ISN'T HERE. repo-settings.yml
// carries a THIRD ruleset, `cms-feature-branches`, applied to both consumers over
// refs/heads/{cms,claude,feat,fix,chore,test,ci,docs}/**, and it requires one BARE
// context: `validate-content`. This lint does not scan it, for a reason worth
// writing down rather than rediscovering: no caller job is named `validate-content`
// (the consumer callers publish it as the two-part `editorial / validate-content`
// under consumer-main), so pointing this scanner at that ruleset would fail
// `assertResolved` on a shape whose real publisher is unclear — that is a
// repo-settings question, not a cancellation one. No live exposure today: the job
// that would satisfy it is cms-editorial-workflow.yml's `validate-content`, which
// consumer-main already brings under this guard via `editorial / validate-content`
// and which carries no group, no `timeout-minutes` and no `needs:` — clean against
// all four causes, not just the first. Resolve the bare-context question first; only then
// add the ruleset here.

function manifest() {
  return parseYaml(fs.readFileSync(MANIFEST_PATH, "utf8")) || {};
}

function contextsOf(rulesetName) {
  return requiredContexts(manifest(), rulesetName);
}

// Parse one workflow file into `{ doc, jobList }`, or null when it is not a
// mapping. A YAML syntax error returns null too — actionlint owns YAML validity
// and a parse error is ITS finding to report, not a second red here.
function loadWorkflow(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let doc;
  try {
    doc = parseYaml(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  return { doc, jobList: jobs(raw) };
}

// ── THE ONE SCANNER BOTH PASSES USE ──────────────────────────────────────
//
// For every required context, find the job(s) that publish it and report every
// `concurrency` declaration governing them.
//
// A context is BARE (`node-unit-lints`) or CALLER/REUSABLE-shaped (`scan / scan`).
// The bare arm additionally follows a `uses:` when the matched caller job has one:
// a group on the reusable's workflow level governs the whole run that produces the
// caller's check-run, and NOT following it is exactly the miss (M3) that let a
// required platform context published through a reusable pass green.
//
// Returns `{ offenders, resolved, examined }`. `resolved` counts how many
// (file, job) pairs each context matched — zero for any context is a hard failure
// upstream, because a required context nothing publishes deadlocks every PR AND a
// lint that matches nothing asserts nothing.
function scanCallers({ contexts, callerFiles, callerLabel, reusableDir }) {
  const offenders = [];
  const unreadable = [];
  const resolved = new Map(contexts.map((c) => [c, 0]));
  let examined = 0;

  for (const callerFile of callerFiles) {
    const caller = loadWorkflow(callerFile);
    if (!caller) continue;
    examined += 1;
    const triggers = events(workflowOn(caller.doc)).join(", ") || "(no `on:`)";
    const label = path.join(callerLabel, path.basename(callerFile));

    for (const callerJob of caller.jobList) {
      for (const context of contexts) {
        const { callerHalf, reusableHalf } = splitContext(context);
        const how = publishKind(callerJob.name, callerJob.value, callerHalf);
        if (!how) continue;

        const basename = reusableBasename((callerJob.value || {}).uses);
        const reusablePath = basename ? path.join(reusableDir, basename) : null;
        const reusable = reusablePath && fs.existsSync(reusablePath)
          ? loadWorkflow(reusablePath)
          : null;

        // Two-part context: it exists ONLY if the caller job really calls a
        // reusable this repo owns, and that reusable really has a job matching
        // the second half.
        if (reusableHalf != null) {
          // A caller job with NO `uses:` publishes the BARE context `<job>`, not
          // `<job> / <something>`, so it is not a publisher of THIS context and
          // owes nothing here.
          if ((callerJob.value || {}).uses == null) continue;

          // THE REUSABLE IS UNREADABLE — report, never skip. This `continue` used
          // to sit before everything below, which meant an unresolvable `uses:`
          // silently discarded the CALLER-side declarations too, even though
          // those need no reusable to be read and govern the caller job outright.
          // That was a live bypass: lowercasing the owner in a caller's `uses:`
          // (which GitHub resolves identically) turned a real cancelling group on
          // a required-context caller from 1 failed into 15 passed. The owner
          // match is case-insensitive now, but the class of cause is not limited
          // to case — a reusable renamed in a later release, or a consumer whose
          // pinned `.cms-platform` checkout predates the file — so the blind spot
          // itself is reported rather than trusted away.
          if (!reusable) {
            unreadable.push(
              `${label} job \`${callerJob.name}\` publishes the first half of required ` +
                `context \`${context}\` through \`uses: ${(callerJob.value || {}).uses}\`, which ` +
                `does not resolve to a readable workflow under ${reusableDir}. This lint cannot ` +
                `see whether that reusable declares a \`concurrency:\` block, so the rule is ` +
                `UNENFORCED for this context.`,
            );
            for (const { where, what, fix } of cancellationHazards({
              callerDoc: caller.doc,
              callerJob: callerJob.value,
            })) {
              offenders.push(
                `${label} → required context \`${context}\` (caller job \`${callerJob.name}\` ` +
                  `matched by ${how}; reusable \`${(callerJob.value || {}).uses}\` UNREADABLE, so ` +
                  `only the caller side was checked; triggers: ${triggers}) — ${where} ${what}. ` +
                  `${fix}`,
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
                `${label} → required context \`${context}\` (caller job \`${callerJob.name}\` ` +
                  `matched by ${how}; reusable ${basename} job \`${reusableJob.name}\`; caller ` +
                  `triggers: ${triggers}) — ${where} ${what}. ${fix}`,
              );
            }
          }
          continue;
        }

        // Bare context: the caller job reports it directly. Follow a `uses:`
        // anyway when there is one — a workflow-level group on the reusable
        // governs the run that produces this job's check-run.
        resolved.set(context, resolved.get(context) + 1);
        const decls = cancellationHazards({
          callerDoc: caller.doc,
          callerJob: callerJob.value,
          reusableDoc: reusable ? reusable.doc : null,
        });
        for (const { where, what, fix } of decls) {
          offenders.push(
            `${label} → required context \`${context}\` (job \`${callerJob.name}\` matched by ` +
              `${how}${basename ? `; calls reusable ${basename}` : ""}; triggers: ${triggers}) — ` +
              `${where} ${what}. ${fix}`,
          );
        }
      }
    }
  }

  return { offenders, unreadable, resolved, examined };
}

// A reusable this lint cannot read is a HOLE in the rule, and a hole that stays
// quiet is indistinguishable from compliance. It gets its own assertion rather
// than riding on `assertResolved`, because that counter is keyed per CONTEXT
// across all files: `e2e / e2e` has TWO publishers here (e2e-stub.yml and
// e2e-tests.yml), so one of them going unresolvable leaves the counter at 1 and
// the pass green. That is precisely the context the live bypass reproduced on.
function assertReadable(unreadable, callerLabel) {
  expect(
    unreadable,
    `a caller under ${callerLabel} publishes a required context through a reusable this lint ` +
      `cannot read, so the never-cancelled invariant is UNENFORCED there. Fix the \`uses:\` (or ` +
      `the checkout that should have supplied the reusable) — do not widen this lint to ignore it.`,
  ).toEqual([]);
}

function assertResolved(resolved, rulesetName, callerLabel) {
  const unresolved = [...resolved.entries()].filter(([, n]) => n === 0).map(([ctx]) => ctx);
  expect(
    unresolved,
    `these \`${rulesetName}\` required contexts resolve to NO job under ${callerLabel} — a ` +
      `required context nothing publishes deadlocks every PR on that ruleset, and a lint that ` +
      `matches nothing asserts nothing. Either a job was renamed (fix the ruleset or the job) ` +
      `or this lint stopped looking (fix the lint).`,
  ).toEqual([]);
}

test.describe("a required status context can never end `cancelled`", () => {
  test("required_status_checks parses out of repo-settings.yml", () => {
    // A lint whose required set silently empties would sweep every workflow and
    // find nothing to assert — green, and protecting nothing.
    expect(
      contextsOf(PLATFORM_RULESET),
      `ruleset_library.${PLATFORM_RULESET}.rules[required_status_checks] must yield at least ` +
        `one context — an empty set makes the platform gate below vacuous`,
    ).not.toEqual([]);
    expect(
      contextsOf(CONSUMER_RULESET),
      `ruleset_library.${CONSUMER_RULESET}.rules[required_status_checks] must yield at least ` +
        `one context — an empty set makes the consumer gate below vacuous`,
    ).not.toEqual([]);
  });

  // ── PASS 1: the PLATFORM's own required contexts ────────────────────────
  //
  // `platform-main` requires four BARE contexts, all published by self-ci.yml.
  // That workflow carried `group: self-ci-<event>-<pr|ref>` with
  // `cancel-in-progress: true` until #285; the group is gone and this pass is
  // what keeps it gone. None of the four carries a `timeout-minutes` either, and
  // this pass is now what keeps THAT true as well (#289) — a wall added to
  // `node-unit-lints` would be the same defect in a different key.
  test("no platform required-context job can be cancelled structurally", () => {
    const contexts = contextsOf(PLATFORM_RULESET);
    const files = listWorkflows();
    // `listWorkflows()` returns ABSOLUTE paths while `readWorkflow()` takes a
    // BASENAME — passing the former made an earlier lint in this repo throw
    // ENOENT on every file, which a blanket try/catch swallowed as "skip", so it
    // examined zero files and passed. Hence the counters below.
    expect(
      files.length,
      "listWorkflows() returned nothing — this lint would pass vacuously",
    ).toBeGreaterThan(0);

    const { offenders, unreadable, resolved, examined } = scanCallers({
      contexts,
      callerFiles: files,
      callerLabel: path.join(".github", "workflows"),
      reusableDir: PLATFORM_WORKFLOW_DIR,
    });

    expect(examined, "no workflow parsed — this lint would pass vacuously").toBeGreaterThan(0);
    assertReadable(unreadable, path.join(".github", "workflows"));
    assertResolved(resolved, PLATFORM_RULESET, path.join(".github", "workflows"));
    expect(offenders, `${FIX_ADVICE}Offenders:\n  ` + offenders.join("\n  ")).toEqual([]);
  });

  // ── PASS 2: the CONSUMER contexts, as this repo TEMPLATES them ──────────
  //
  // The six `consumer-main` contexts are NOT published by anything under
  // `.github/workflows/` — those are `workflow_call` reusables, which publish
  // nothing on their own. They are published by the thin callers this repo SHIPS
  // under `examples/site/.github/workflows/`, as `<caller job> / <reusable job>`.
  // Pass 1 cannot see them at all, which is why #285 — a consumer-side incident —
  // would sail straight past it.
  //
  // This pass reads the TEMPLATES. What a consumer actually ships is a copy that
  // is free to drift, and no lint here can see that copy — hence the CONSUMER-mode
  // sibling named in the header.
  //
  // NOTE WHICH REUSABLE IT READS. The templates pin a RELEASED tag, but the second
  // half of each context is resolved against the WORKING TREE's
  // `.github/workflows/`, not against that tag. That is deliberate and is what
  // makes this a PRE-RELEASE gate: a group added to a reusable in this PR is
  // caught here, before the tag that would carry it to a consumer exists. The
  // trade is that this pass says nothing about what the pinned tag contains — the
  // CONSUMER-mode sibling, which reads the site's own `.cms-platform/` checkout at
  // its pinned ref, is what covers that.
  test("no consumer required context can be cancelled, as templated here", () => {
    const contexts = contextsOf(CONSUMER_RULESET);
    // Read OUTSIDE any try: an absent or emptied caller directory is a bug in
    // this repo or in this spec, and must fail loudly rather than read as
    // "nothing to check". This pass's whole value is that the callers this repo
    // ships are the things publishing those six contexts.
    const callerFiles = fs
      .readdirSync(CALLER_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => path.join(CALLER_DIR, f));
    expect(
      callerFiles.length,
      `${CALLER_LABEL} listed no workflows — the consumer-template pass would assert nothing`,
    ).toBeGreaterThan(0);

    const { offenders, unreadable, resolved, examined } = scanCallers({
      contexts,
      callerFiles,
      callerLabel: CALLER_LABEL,
      reusableDir: PLATFORM_WORKFLOW_DIR,
    });

    expect(examined, "no caller parsed — this lint would pass vacuously").toBeGreaterThan(0);
    assertReadable(unreadable, CALLER_LABEL);
    assertResolved(resolved, CONSUMER_RULESET, CALLER_LABEL);
    expect(offenders, `${FIX_ADVICE}Offenders:\n  ` + offenders.join("\n  ")).toEqual([]);
  });
});

// The detector must fire on every shape a future edit could ship, and on none of
// the innocent ones — otherwise the gate above can regress to a no-op while still
// reporting green, which is the exact failure mode it exists to prevent.
test.describe("publishKind — a job's context is its `name:`, falling back to its id", () => {
  test("matches on the job id when no `name:` is set", () => {
    expect(publishKind("node-unit-lints", {}, "node-unit-lints")).toContain("job id");
    expect(publishKind("node-unit-lints", {}, "actionlint")).toBe(null);
  });

  test("matches a plain `name:` that differs from the job id", () => {
    // job id `foo`, `name: node-unit-lints` -> publishes the REQUIRED context,
    // and an id-only matcher sails straight past it.
    expect(publishKind("foo", { name: "node-unit-lints" }, "node-unit-lints")).toContain("name:");
  });

  test("still matches the id when a `name:` is set — a deliberate superset", () => {
    expect(publishKind("node-unit-lints", { name: "Lints" }, "node-unit-lints")).toContain(
      "job id",
    );
  });

  test("a DYNAMIC `name:` matches only what its literal skeleton can expand to", () => {
    // The real one in this repo: repo-settings-pat-verify.yml's `verify` job.
    const dynamic = { name: "verify ${{ matrix.owner }} PAT" };
    expect(publishKind("verify", dynamic, "node-unit-lints")).toBe(null);
    expect(publishKind("verify", dynamic, "verify Adam-S-Daniel PAT")).toContain("skeleton");
    // …and one that CAN expand to a required context is caught conservatively.
    expect(publishKind("x", { name: "${{ matrix.k }}-unit-lints" }, "node-unit-lints")).toContain(
      "skeleton",
    );
    expect(dynamicNameSkeleton("verify ${{ matrix.owner }} PAT").test("verify x PAT")).toBe(true);
  });

  // A matrix job publishes `<name> (<matrix values>)`, never the bare name, so a
  // ruleset requiring the expanded form named a job an exact matcher cannot find.
  test("a MATRIX job matches the expanded `<name> (…)` form of a required context", () => {
    const matrixJob = { strategy: { matrix: { os: ["ubuntu-latest"] } } };
    expect(publishKind("check", matrixJob, "check (ubuntu-latest)")).toContain("matrix expansion");
    // The over-match is one level deep and anchored at the END, so an unrelated
    // context is still not swept in.
    expect(publishKind("check", matrixJob, "other (ubuntu-latest)")).toBe(null);
    // Without `strategy.matrix` the suffix is NOT stripped — a non-matrix job
    // genuinely cannot publish an expanded context.
    expect(publishKind("check", {}, "check (ubuntu-latest)")).toBe(null);
    expect(stripMatrixSuffix("check (ubuntu-latest, 20)")).toBe("check");
  });
});

// concurrencyDeclarations must see a declaration wherever it sits — including on
// the REUSABLE, which is where BOTH live consumer offenders hid theirs.
test.describe("cause 1 — concurrencyDeclarations: all four sites, presence not value", () => {
  test("reports all four declaration sites, and none when there are none", () => {
    expect(concurrencyDeclarations({ callerDoc: {}, callerJob: {} })).toEqual([]);
    const all = concurrencyDeclarations({
      callerDoc: { concurrency: { group: "a" } },
      callerJob: { concurrency: "b" },
      reusableDoc: { concurrency: { group: "c" } },
      reusableJob: { concurrency: { group: "d" } },
    });
    expect(all).toHaveLength(4);
    expect(all.map((d) => d.where).join(" | ")).toContain("REUSABLE workflow's");
    expect(all.map((d) => d.where).join(" | ")).toContain("REUSABLE job's");
    expect(all.map((d) => d.what).join(" | ")).toContain("group `a`");
  });

  // PRESENCE is the finding. A `concurrency:` with no value, or a map with no
  // `group:`, is the shape nobody can read at a glance — treating either as "no
  // declaration" would be a silent exemption, and exemptions are what the
  // carve-out version got wrong.
  test("a valueless `concurrency:` and a groupless map both count", () => {
    expect(concurrencyDeclarations({ callerDoc: { concurrency: null } })).toHaveLength(1);
    const groupless = concurrencyDeclarations({
      callerDoc: { concurrency: { "cancel-in-progress": true } },
    });
    expect(groupless).toHaveLength(1);
    expect(groupless[0].what).toContain("no usable");
    // Even a per-RUN key counts: it can never cancel anything, so it is pure
    // machinery, and blessing it would put an exemption back that a static group
    // could later be smuggled through (a literal `deploy-<run-id>-lane` looked
    // per-run to the substring test the carve-out version used).
    expect(
      concurrencyDeclarations({ callerDoc: { concurrency: { group: "g-${{ github.run_id }}" } } }),
    ).toHaveLength(1);
    expect(describeConcurrency(undefined)).toContain("no value");
  });
});

// ── CAUSE 2, the one #285's name hid ────────────────────────────────────
//
// PRESENCE ON THE PUBLISHING JOB is the finding, exactly as with `concurrency`.
// The unit cases below are what stop this arm being quietly narrowed to "a
// timeout larger than N" or "a timeout on the reusable only" — either narrowing
// re-opens #289 while the pass stays green.
test.describe("cause 2 — timeoutDeclarations: a wall on the PUBLISHER", () => {
  test("fires on the publishing job at either site, and on neither when absent", () => {
    expect(timeoutDeclarations({ callerJob: {}, reusableJob: {} })).toEqual([]);
    const both = timeoutDeclarations({
      callerJob: { "timeout-minutes": 10 },
      reusableJob: { "timeout-minutes": 30 },
    });
    expect(both).toHaveLength(2);
    expect(both[0].where).toContain("publishing job's own");
    expect(both[1].where).toContain("REUSABLE publishing job's");
    expect(both[1].what).toContain("timeout-minutes: 30");
    // The remedy must name the SHAPE, not a bigger number — a larger wall moves
    // the number and keeps the failure mode.
    expect(both[1].fix).toContain("always()");
    expect(both[1].fix).not.toMatch(/increase|raise|larger/i);
  });

  // There is no safe VALUE, so there is no threshold to smuggle one under. A
  // 30-minute wall cancelled `parity / parity` twice in one week.
  test("any value counts — 1 minute, 30, or a `${{ }}` expression", () => {
    for (const v of [1, 30, 360, "${{ inputs.budget }}"]) {
      expect(timeoutDeclarations({ reusableJob: { "timeout-minutes": v } })).toHaveLength(1);
    }
  });

  // A STEP-level wall is NOT a finding and must not become one: GitHub kills an
  // over-running step and marks it FAILED, so the job concludes `failure` — the
  // outcome this invariant wants. Flagging it would push authors toward removing
  // the one bound that already behaves correctly.
  test("a STEP-level `timeout-minutes` is not a finding", () => {
    expect(
      timeoutDeclarations({ reusableJob: { steps: [{ run: "x", "timeout-minutes": 5 }] } }),
    ).toEqual([]);
  });
});

// ── CAUSE 3: fail-fast over a matrix ────────────────────────────────────
//
// No publisher in this repo has a matrix today, so this arm finds nothing over
// the real tree and is exercised ONLY here. It is present because the invariant
// is the outcome, not the cause list — and a cause a reader can write down in one
// line is exactly the kind that shipped past a guard named after a different one.
test.describe("cause 3 — failFastDeclarations: a matrix publisher that cancels siblings", () => {
  test("only an EXPLICIT `fail-fast: false` is clean", () => {
    const matrix = { os: ["ubuntu-latest"] };
    const ff = (value) =>
      failFastDeclarations({ callerJob: { strategy: { matrix, ...value } } });
    expect(ff({ "fail-fast": false })).toEqual([]);
    expect(failFastDeclarations({ callerJob: { strategy: { matrix } } })).toHaveLength(1);
    expect(ff({ "fail-fast": true })).toHaveLength(1);
    // An expression this file cannot evaluate is reported: "we could not tell"
    // is not "clean" — the same posture the scheduled-run health audit takes on
    // an unknown answer.
    expect(ff({ "fail-fast": "${{ inputs.ff }}" })).toHaveLength(1);
  });

  test("a job with no matrix is never a fail-fast finding", () => {
    expect(failFastDeclarations({ callerJob: { strategy: { "fail-fast": true } } })).toEqual([]);
    expect(failFastDeclarations({ callerJob: {} })).toEqual([]);
  });
});

// ── CAUSE 4: the twin failure the cause-2 FIX can introduce ─────────────
//
// Splitting a required job into work + gate is only an improvement while the
// gate actually reports. Without `always()` the gate SKIPS the moment the work
// job fails or is cancelled, and the required context hangs on "Waiting for
// status to be reported" or reports a `skipped` conclusion that never reddens.
test.describe("cause 4 — gateShapeDeclarations: `needs:` without `always()`", () => {
  test("a publisher with `needs:` must reference always(); one without owes nothing", () => {
    expect(gateShapeDeclarations({ callerJob: { needs: "work", if: "${{ always() }}" } })).toEqual(
      [],
    );
    expect(gateShapeDeclarations({ callerJob: { needs: ["a", "b"], if: "always()" } })).toEqual([]);
    expect(gateShapeDeclarations({ callerJob: { needs: "work" } })).toHaveLength(1);
    expect(gateShapeDeclarations({ callerJob: { needs: "w", if: "success()" } })).toHaveLength(1);
    // No `needs:` — the job runs on its own and cannot be skipped by an upstream
    // result, so an `if:` here is none of this rule's business.
    expect(gateShapeDeclarations({ callerJob: { if: "github.event_name == 'push'" } })).toEqual([]);
  });

  // STATED AS THE FLOOR IT IS: this arm is textual on the `if:` expression and
  // evaluates nothing, so a condition that MENTIONS always() and can still be
  // false passes here. Asserted so the limitation is a decision on record rather
  // than something a later reader discovers as a bug.
  test("it is a substring test, and does not pretend to evaluate the expression", () => {
    expect(
      gateShapeDeclarations({
        callerJob: { needs: "work", if: "always() && github.event_name == 'push'" },
      }),
      "documented floor: an always() that is ANDed with a falsifiable clause still passes",
    ).toEqual([]);
  });
});

// One entry point, so the two specs cannot drift apart on WHICH causes they
// check. Every hazard carries its OWN remedy, because the two live causes have
// opposite fixes: delete the block vs. move the work into a job whose conclusion
// nobody requires.
test.describe("cancellationHazards — one call, every cause, each with its own fix", () => {
  test("aggregates all four causes and is empty on a clean job", () => {
    expect(cancellationHazards({ callerDoc: {}, callerJob: {} })).toEqual([]);
    const all = cancellationHazards({
      callerDoc: { concurrency: { group: "g" } },
      callerJob: {
        "timeout-minutes": 30,
        needs: "work",
        strategy: { matrix: { os: ["ubuntu-latest"] } },
      },
    });
    expect(all).toHaveLength(4);
    expect(all.every((h) => h.where && h.what && h.fix)).toBe(true);
    const fixes = all.map((h) => h.fix).join(" | ");
    expect(fixes).toContain("DELETE that block");
    expect(fixes).toContain("fail-fast: false");
    expect(fixes).toContain("always()");
  });

  test("the shared preamble states the OUTCOME and names both live causes", () => {
    expect(FIX_ADVICE).toContain("NO REQUIRED STATUS CONTEXT MAY END `cancelled`");
    expect(FIX_ADVICE).toContain("concurrency");
    expect(FIX_ADVICE).toContain("timeout-minutes");
    expect(FIX_ADVICE).toContain("cms-platform#289");
  });
});

// The required set is derived, not hardcoded — so prove the derivation actually
// reaches self-ci.yml's four job ids and the six consumer contexts, and that the
// context splitter handles both shapes a ruleset can carry.
test.describe("required-context derivation", () => {
  test("yields the four self-ci.yml job ids the platform-main ruleset requires", () => {
    const contexts = contextsOf(PLATFORM_RULESET);
    for (const id of ["actionlint", "ruby-theme-specs", "node-unit-lints", "plugin-validate"]) {
      expect(
        contexts,
        `repo-settings.yml ruleset_library.${PLATFORM_RULESET} must require \`${id}\` — this ` +
          `lint keys off the ruleset, so a context dropped there silently drops the guard`,
      ).toContain(id);
    }
  });

  test("yields the six caller/reusable-shaped consumer-main contexts", () => {
    const contexts = contextsOf(CONSUMER_RULESET);
    for (const ctx of [
      "editorial / validate-content",
      "scan / scan",
      "parity / parity",
      "preview-media / preview-media",
      "e2e / e2e",
      "visual-regression / approve-regression",
    ]) {
      expect(contexts, `ruleset_library.${CONSUMER_RULESET} must require \`${ctx}\``).toContain(
        ctx,
      );
    }
  });

  // A BARE context in a caller/reusable ruleset used to make the consumer pass
  // UNSATISFIABLE: the old code `continue`d on it, so the context never resolved
  // and the "everything resolved" assertion failed with no edit that could fix
  // it. `cms-feature-branches` already requires a bare `validate-content`, so the
  // shape is not hypothetical.
  test("splitContext handles both a bare context and a caller/reusable one", () => {
    expect(splitContext("node-unit-lints")).toEqual({
      callerHalf: "node-unit-lints",
      reusableHalf: null,
    });
    expect(splitContext("visual-regression / approve-regression")).toEqual({
      callerHalf: "visual-regression",
      reusableHalf: "approve-regression",
    });
  });

  test("reusableBasename resolves both `uses:` spellings and rejects the rest", () => {
    expect(
      reusableBasename("Adam-S-Daniel/cms-platform/.github/workflows/secrets-scan.yml@v0.1.86"),
    ).toBe("secrets-scan.yml");
    expect(reusableBasename("./.github/workflows/secrets-scan.yml")).toBe("secrets-scan.yml");
    expect(reusableBasename("actions/checkout@v4")).toBe(null);
    expect(reusableBasename(undefined)).toBe(null);
  });

  // GitHub resolves owner and repo case-INSENSITIVELY, so this spelling runs the
  // identical reusable in production. While the matcher was case-sensitive it
  // returned null here, an unreadable reusable meant "report nothing", and a real
  // cancelling group on a required-context caller went from 1 failed to 15 passed
  // on one character. The BASENAME stays case-sensitive — it is a path on disk.
  test("reusableBasename matches the owner/repo case-insensitively", () => {
    expect(
      reusableBasename("adam-s-daniel/cms-platform/.github/workflows/secrets-scan.yml@v0.1.86"),
    ).toBe("secrets-scan.yml");
    expect(
      reusableBasename("ADAM-S-DANIEL/CMS-PLATFORM/.github/workflows/secrets-scan.yml@v0.1.86"),
    ).toBe("secrets-scan.yml");
    expect(reusableBasename("someone-else/cms-platform/.github/workflows/x.yml@v1")).toBe(null);
  });

  // A `concurrency:` arriving through a YAML MERGE KEY must be visible, or the
  // "presence has nothing to forge" property is false. `yaml` v2 leaves `<<` as a
  // literal key unless `merge: true` is passed, which is why both parse seams set
  // it. Asserted through the SHARED parser the scanner actually uses.
  test("a `concurrency:` arriving through a YAML merge key is visible to the parser", () => {
    const merged = parseYaml(
      "x-defaults: &d\n  concurrency:\n    group: g\n    cancel-in-progress: true\n" +
        "jobs:\n  scan:\n    <<: *d\n    uses: ./.github/workflows/secrets-scan.yml\n",
    );
    expect(
      Object.prototype.hasOwnProperty.call(merged.jobs.scan, "concurrency"),
      "a merge key must resolve — otherwise `<<` survives as a literal key and every " +
        "presence-based workflow lint in this repo reads the job as clean",
    ).toBe(true);
    expect(concurrencyDeclarations({ callerJob: merged.jobs.scan })).toHaveLength(1);
  });

  // The three workflows #285 stripped. Asserted by NAME so a re-added block reds
  // here with a message that says which file, even if the scanner above were ever
  // narrowed: `readWorkflow` throws on a missing file rather than skipping.
  test("self-ci, secrets-scan and visual-regression declare no `concurrency:` at all", () => {
    for (const name of ["self-ci.yml", "secrets-scan.yml", "visual-regression.yml"]) {
      const doc = parseYaml(readWorkflow(name)) || {};
      expect(
        Object.prototype.hasOwnProperty.call(doc, "concurrency"),
        `${name} publishes a REQUIRED status context, so it must declare NO workflow-level ` +
          `\`concurrency:\` (cms-platform#285). Re-adding one re-opens a hard merge block that ` +
          `no merge mechanism can override.`,
      ).toBe(false);
    }
  });

  // ── The #289 SPLIT, locked by name ───────────────────────────────────────
  //
  // The scanner above already rejects a `timeout-minutes` on the publisher, so
  // half of this is belt-and-braces. The half that is NOT redundant is the
  // positive side: that the work job still carries a wall at all, and that the
  // gate still translates. Delete the probe's `timeout-minutes` and the scanner
  // stays green while an unbounded job replaces a bounded one; delete the gate's
  // translating step and the scanner stays green while the required context goes
  // permanently pass. Neither is a cancellation-cause question, so neither belongs in
  // the pass above — and both are one careless edit away.
  //
  // Named by file/job on purpose: `readWorkflow` throws on a missing file rather
  // than skipping, so a rename reds here with the name in the message instead of
  // quietly examining nothing.
  test("parity-preview and preview-media publish their required context from a gate", () => {
    for (const { file, gate, probe } of [
      { file: "parity-preview.yml", gate: "parity", probe: "parity-probe" },
      { file: "preview-media.yml", gate: "preview-media", probe: "media-probe" },
    ]) {
      const doc = parseYaml(readWorkflow(file)) || {};
      const gateJob = (doc.jobs || {})[gate];
      const probeJob = (doc.jobs || {})[probe];
      expect(
        probeJob,
        `${file} must keep its \`${probe}\` WORK job — it is what carries the wall clock`,
      ).toBeTruthy();
      expect(
        gateJob,
        `${file} must keep its \`${gate}\` job: it publishes the required context ` +
          `\`${gate} / ${gate}\` that both consumers' main ruleset names. Renaming it makes ` +
          `that context unreportable, which hangs every PR on "Waiting for status".`,
      ).toBeTruthy();

      // The wall stays on the probe. PRESENCE is asserted first and separately:
      // `toBeGreaterThan` on an absent key reports a Playwright MATCHER ERROR
      // ("received value must be a number") and swallows the custom message, so
      // the one reader who needs the explanation would not get it.
      expect(
        Object.prototype.hasOwnProperty.call(probeJob, "timeout-minutes"),
        `${file} job \`${probe}\` must keep a \`timeout-minutes\` — the wall is not being ` +
          `removed by #289, only moved onto a job whose conclusion no ruleset requires`,
      ).toBe(true);
      expect(probeJob["timeout-minutes"]).toBeGreaterThan(0);
      // …and never on the gate, which must be unkillable-at-a-wall.
      expect(
        Object.prototype.hasOwnProperty.call(gateJob, "timeout-minutes"),
        `${file} job \`${gate}\` publishes a REQUIRED context and must carry NO ` +
          `\`timeout-minutes\`: GitHub reports a job killed at its wall as \`cancelled\`, and ` +
          `a cancelled required context cannot be merged past by any mechanism ` +
          `(cms-platform#289).`,
      ).toBe(false);

      // And the gate must actually TRANSLATE: depend on the probe, run anyway,
      // and read the probe's rolled-up `result`. Without the last of those it is
      // a job that always passes — a required check that can never go red.
      expect(String(gateJob.needs)).toContain(probe);
      expect(String(gateJob.if)).toContain("always()");
      const body = JSON.stringify(gateJob.steps || []);
      expect(
        body,
        `${file} job \`${gate}\` must READ \`needs.${probe}.result\` and exit non-zero unless ` +
          `it is \`success\`. A gate that never inspects the job it needs is a required check ` +
          `that can never fail.`,
      ).toContain(`needs.${probe}.result`);
      expect(body).toContain("success");
      expect(body).toContain("exit 1");
    }
  });
});
