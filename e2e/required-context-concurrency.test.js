// @lane: local — PURE-FS lint over repo-settings.yml, every workflow in this
// repo, AND every thin caller under examples/site/.github/workflows; no browser,
// no build, no network. Runs in self-ci.yml's node-unit-lints lane.
//
// PLATFORM-INTERNAL, and registered as such: it reads the root repo-settings.yml
// manifest and the platform's OWN workflow DEFINITIONS, neither of which a
// consumer ships, so it is listed in playwright.config.js's PLATFORM_META_SPECS
// and testIgnore'd on every CONSUMER lane. That ignore is why it is only HALF the
// coverage: the repos where the #285 bug actually wedges a PR are the two
// consumers, and this file cannot run there. Its CONSUMER-mode sibling
// `e2e/consumer-required-context-concurrency.test.js` — deliberately absent from
// the registry, reading `<SITE_ROOT>/.github/workflows/` and the consumer's own
// `.cms-platform/` checkout — is the half that does. Neither substitutes for the
// other: this one is the only coverage of the platform tree and the canonical
// templates, that one the only coverage of what a site actually ships.
//
// ── THE TRAP: A CANCELLED REQUIRED CHECK IS AN UNBLOCKABLE MERGE BLOCK ────
//
// A job that publishes a REQUIRED status context, sitting in a `concurrency`
// group, will eventually leave a CANCELLED run shadowing a successful one for the
// same context+SHA. GitHub then picks between them NON-DETERMINISTICALLY, and
// when cancelled wins the merge API answers
//
//     405 Required status check "<ctx>" is cancelled
//
// and NOTHING overrides it — not native auto-merge, not an explicit merge call,
// not a nudge bot, not an admin. The PR reads all-green in the UI and simply
// never lands. That is the whole reason this is a lint and not a code-review
// note: the symptom is a PR that looks fine, the cause is one line three screens
// away (often in another repository), and the failure is a coin flip so it does
// not reproduce on demand.
//
// `cancel-in-progress: false` IS NOT THE FIX, and is the fix that looks right.
// GitHub keeps the in-progress run plus only the LATEST pending run in a group
// and cancels the OTHER pending duplicates, so a same-SHA burst still strands
// cancelled runs.
//
// ── WHY THIS IS CATEGORICAL, AND WHY THE CARVE-OUT WAS DROPPED ───────────
//
// AGENTS.md states the rule twice. The categorical sentence — "a job that
// publishes a REQUIRED status context and can fire more than once on the same
// head sha gets no `concurrency` block at all" — is the headline. Four bullets
// down sits what reads as a carve-out: "Jobs triggered only by `push` /
// `synchronize` — each a new sha — are safe to cancel."
//
// An earlier version of this lint implemented the carve-out: it passed a required
// job in a group as long as every event reaching that group brought a distinct
// head SHA, and the fix it locked narrowed the callers' `types:` to
// `[opened, synchronize]`. Two independent findings killed that approach.
//
//   1. THE PREMISE IS FALSE, MEASURED IN PRODUCTION. adamdaniel.ai PR #3006
//      (2026-08-09): opened 01:57:10Z, head_ref_force_pushed 01:57:38Z, and
//      visual-regression runs 31289327061 (cancelled) and 31289327099 (skipped)
//      BOTH created 01:57:41Z carrying head_sha 68d7c777. Webhook delivery
//      latency dispatches the `opened` run AFTER the force-push has already moved
//      the head, so the two land on one SHA. On that occasion the required
//      `visual-regression / approve-regression` concluded success and the
//      cancelled check-run was the non-required `generate` — a near-miss, not an
//      outage. And `opened`/`synchronize` cannot be narrowed away: without them
//      the required context never reports at all. So NO trigger set makes a
//      shared key collision-free.
//   2. THE TRIGGER FIX CANNOT REACH PRODUCTION; THE GROUP FIX CAN. `concurrency`
//      lives in the PLATFORM reusable, so a `platform_ref` bump carries it to
//      both consumers. `pull_request.types` lives in the CONSUMER's own caller,
//      and nothing propagates it — `platform-bump.yml` seeds only a WHOLLY-MISSING
//      caller (its own comment says so) and `check-platform-pin-consistency.js`'s
//      `structuralShape()` compares `permissions` + `jobs.*` with `on:`
//      deliberately excluded. A template-only `types:` change would have reached
//      neither live site while THIS lint, reading examples/site/, reported green
//      forever.
//
// So the rule enforced here is the headline one, with no exemptions at all: a job
// publishing a required context carries NO `concurrency` declaration, at any of
// the four sites that can govern it. That is enforceable structurally without
// reasoning about triggers, expression semantics, or key spaces — and every
// exemption the carve-out version needed (an event allow-list, a PR-type
// allow-list, a GitHub-expression evaluator, a `github.run_id` sentinel) was a
// place a wrong shape could earn a pass. A group whose key is genuinely per-run
// never cancels anything, so it is pure machinery; deleting it loses nothing.
//
// THE COST IS REAL AND IS ACCEPTED: superseded runs finish instead of being
// cancelled, so a rapidly-pushed PR burns several full runs of the heaviest lanes
// in the family. Runner minutes are recoverable; a wedged required check has no
// operator remedy.
//
// ── WHY THIS PARSES YAML AND NEVER GREPS IT ──────────────────────────────
//
// Per AGENTS.md's standing rule, anything reasoning about workflow STRUCTURE goes
// through the real `yaml` parser via workflow-yaml-utils — a regex over source
// reads clean on structure it cannot see (an aliased `types:` list, a flow-style
// `on: [pull_request, push]`, a `concurrency:` inherited from a job rather than
// the workflow). It also matters that a BARE `on:` key can parse as the BOOLEAN
// `true` under a YAML 1.1 schema, which is why the trigger value is read through
// `workflowOn()` rather than off `doc.on` alone.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, readWorkflow, parseYaml, jobs, events } = require("./workflow-yaml-utils");
const {
  publishKind,
  concurrencyDeclarations,
  reusableBasename,
  splitContext,
  requiredContexts,
  workflowOn,
  describeConcurrency,
  dynamicNameSkeleton,
  stripMatrixSuffix,
  FIX_ADVICE,
} = require("./required-context-concurrency-utils");

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
// repo-settings question, not a concurrency one. No live exposure today: the job
// that would satisfy it is cms-editorial-workflow.yml's `validate-content`, which
// consumer-main already brings under this guard via `editorial / validate-content`
// and which declares no group. Resolve the bare-context question first; only then
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
            for (const { where, what } of concurrencyDeclarations({
              callerDoc: caller.doc,
              callerJob: callerJob.value,
            })) {
              offenders.push(
                `${label} → required context \`${context}\` (caller job \`${callerJob.name}\` ` +
                  `matched by ${how}; reusable \`${(callerJob.value || {}).uses}\` UNREADABLE, so ` +
                  `only the caller side was checked; triggers: ${triggers}) — ${where} declares ` +
                  `${what}. DELETE that block.`,
              );
            }
            continue;
          }
          for (const reusableJob of reusable.jobList) {
            if (!publishKind(reusableJob.name, reusableJob.value, reusableHalf)) continue;
            resolved.set(context, resolved.get(context) + 1);
            const decls = concurrencyDeclarations({
              callerDoc: caller.doc,
              callerJob: callerJob.value,
              reusableDoc: reusable.doc,
              reusableJob: reusableJob.value,
            });
            for (const { where, what } of decls) {
              offenders.push(
                `${label} → required context \`${context}\` (caller job \`${callerJob.name}\` ` +
                  `matched by ${how}; reusable ${basename} job \`${reusableJob.name}\`; caller ` +
                  `triggers: ${triggers}) — ${where} declares ${what}. DELETE that block.`,
              );
            }
          }
          continue;
        }

        // Bare context: the caller job reports it directly. Follow a `uses:`
        // anyway when there is one — a workflow-level group on the reusable
        // governs the run that produces this job's check-run.
        resolved.set(context, resolved.get(context) + 1);
        const decls = concurrencyDeclarations({
          callerDoc: caller.doc,
          callerJob: callerJob.value,
          reusableDoc: reusable ? reusable.doc : null,
        });
        for (const { where, what } of decls) {
          offenders.push(
            `${label} → required context \`${context}\` (job \`${callerJob.name}\` matched by ` +
              `${how}${basename ? `; calls reusable ${basename}` : ""}; triggers: ${triggers}) — ` +
              `${where} declares ${what}. DELETE that block.`,
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
      `cannot read, so the no-concurrency rule is UNENFORCED there. Fix the \`uses:\` (or the ` +
      `checkout that should have supplied the reusable) — do not widen this lint to ignore it.`,
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

test.describe("a required status context never sits in a concurrency group", () => {
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
  // what keeps it gone.
  test("no platform required-context job declares a concurrency group", () => {
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
  // NOTE WHICH REUSABLE IT READS. The templates pin `@v0.1.86`, but the second
  // half of each context is resolved against the WORKING TREE's
  // `.github/workflows/`, not against that tag. That is deliberate and is what
  // makes this a PRE-RELEASE gate: a group added to a reusable in this PR is
  // caught here, before the tag that would carry it to a consumer exists. The
  // trade is that this pass says nothing about what the pinned tag contains — the
  // CONSUMER-mode sibling, which reads the site's own `.cms-platform/` checkout at
  // its pinned ref, is what covers that.
  test("no consumer required context sits in a group, as templated here", () => {
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
test.describe("concurrencyDeclarations — all four sites, presence not value", () => {
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
});
