// @lane: local — pure-fs lint of workflow YAML; no browser, no network
//
// Issue #222 (part 2): the `pull_request: edited` trigger and its base-change
// gate are GONE from every caller, and this lint keeps them gone.
//
// #145 introduced them. A PR retargeted onto a different base fires
// `pull_request: edited` (the payload carries `changes.base`), which no
// `branches: [main]`-filtered caller listened for — so the whole required-check
// suite silently never re-ran against the new base. The fix declared `edited`
// on every canonical caller and gated EVERY job on
//   github.event.action != 'edited' || github.event.changes.base.ref.from != ''
// so a title/body edit would "stay a no-op".
//
// That no-op is the bug. A SKIPPED caller never invokes its reusable, so no
// check-run named `<caller job> / <reusable job>` is produced AT ALL — the
// newest run WITHDRAWS a required context an earlier run already reported
// green, and only a new SHA restores it. An automated PR that is FINISHED
// (a `platform-bump` PR whose body got edited on a second run) never gets
// another push, so it wedges: "N of M required status checks are expected"
// with every check visibly green (adamdaniel.ai#3001, jodidaniel.com#115).
// Measured: the guard fired twice in four days — self-healing wherever another
// push was coming, terminal where none was — against ZERO base retargets in 60
// PRs, the only case it existed for. So the trigger goes, and a retarget is
// handled the way it was before #145: whoever retargets pushes or re-runs.
//
// What this asserts:
//   - no workflow that declares a `pull_request` trigger lists the `edited`
//     type — scanning BOTH the canonical `examples/site` thin callers AND the
//     platform's own `pull_request` workflows (the two self-* callers);
//   - no `if:` expression anywhere carries a base-change gate. A gate left on a
//     caller that no longer fires on `edited` is dead weight reading as live
//     intent, and it is one edit away from re-creating the withdrawal;
//   - `examples/site/.github/workflows/deploy-preview.yml` still declares
//     `closed` — asserted POSITIVELY, because it is the ONLY caller that does
//     and the reusable's `teardown-preview` job keys on `action == 'closed'`
//     (S3 `rm --recursive` + CloudFront invalidation + the bot-comment update).
//     Trimming that types list without this assertion would silently leak every
//     closed PR's `pr-N/` prefix forever, with no red check anywhere.
//
// Path-name-agnostic: any file (present or future) under either workflow
// directory is swept in automatically, so a newly-added caller is covered
// without touching this lint. In a consumed checkout (no examples/site/) only
// the platform side applies.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml, jobs, listWorkflows, allStrings, events } = require("./workflow-yaml-utils");

const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLES_WF_DIR = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const DEPLOY_PREVIEW = path.join(EXAMPLES_WF_DIR, "deploy-preview.yml");

function exampleWorkflowPaths() {
  if (!fs.existsSync(EXAMPLES_WF_DIR)) return [];
  return fs
    .readdirSync(EXAMPLES_WF_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(EXAMPLES_WF_DIR, f));
}

// listWorkflows() reads the platform's own .github/workflows dir; the
// `pull_request` filter below narrows it (in practice the two self-* callers
// plus self-ci / drift-guard / pat-verify, none of which may grow `edited`).
function candidateWorkflowPaths() {
  return [...exampleWorkflowPaths(), ...listWorkflows()];
}

// `on.pull_request.types` as a string list, or null when there is no
// `pull_request` trigger or it leaves the types DEFAULTED. A defaulted list is
// GitHub's [opened, synchronize, reopened] — no `edited` to remove — so null is
// a correct pass for the absence assertion, not a blind spot.
function prTypes(onValue) {
  if (onValue == null) return null;
  // `on: pull_request` / `on: [pull_request, push]` carry no types at all.
  if (typeof onValue === "string" || Array.isArray(onValue)) return null;
  const pr = onValue.pull_request;
  if (!pr || typeof pr !== "object" || pr.types == null) return null;
  const list = Array.isArray(pr.types) ? pr.types : [pr.types];
  return list.map(String);
}

// Deliberately BROAD — the inverse of #145's deliberately narrow matcher. That
// lint asserted the gate was PRESENT in exactly one shape, so precision was the
// point; this one asserts ABSENCE, so every variant must be caught: the
// canonical disjunction, the inverted `&&` / `== ''` forms, a gate AND-ed onto
// another condition, and either half on its own. `\s*` spans the operator so a
// block-scalar `if:` folded across lines still matches. Anything naming
// `github.event.action` beside the `edited` literal, or reaching into
// `github.event.changes.base` at all, IS a base-change gate.
const EDITED_ACTION_RE = /github\.event\.action\s*[!=]=\s*'edited'/;
const CHANGES_BASE_RE = /github\.event\.changes\.base/;
function hasBaseChangeGate(ifExpr) {
  if (typeof ifExpr !== "string") return false;
  return EDITED_ACTION_RE.test(ifExpr) || CHANGES_BASE_RE.test(ifExpr);
}

// Every job-level and step-level `if:` as { where, exprs }. The values go
// through `allStrings` so an aliased or multiline expression is still seen —
// never a grep over raw file text, which would also match the prose in
// `platform-bump.yml`'s run-block comment explaining this very bug.
function ifExpressions(yamlText) {
  const out = [];
  for (const job of jobs(yamlText)) {
    const value = job.value || {};
    out.push({ where: `job '${job.name}'`, exprs: allStrings(value.if) });
    const steps = Array.isArray(value.steps) ? value.steps : [];
    steps.forEach((step, i) => {
      out.push({
        where: `job '${job.name}' step ${i + 1}`,
        exprs: allStrings(step && step.if),
      });
    });
  }
  return out;
}

for (const file of candidateWorkflowPaths()) {
  const label = path.relative(REPO_ROOT, file);
  const yaml = fs.readFileSync(file, "utf8");
  const doc = parseYaml(yaml) || {};

  test.describe(`${label} — #222 no pull_request:edited`, () => {
    if (events(doc.on).includes("pull_request")) {
      test("on.pull_request.types does not declare 'edited'", () => {
        expect(
          prTypes(doc.on) || [],
          `${label} must NOT list 'edited' in on.pull_request.types — an edited run ` +
            `SKIPS this caller, which produces no check-run and WITHDRAWS a required ` +
            `context an earlier run already reported green (#222)`,
        ).not.toContain("edited");
      });
    }

    test("no if: carries a base-change gate", () => {
      for (const { where, exprs } of ifExpressions(yaml)) {
        for (const expr of exprs) {
          expect(
            hasBaseChangeGate(expr),
            `${label} ${where} carries a base-change gate (${expr}) — the 'edited' ` +
              `trigger it guarded is gone, so the gate is dead weight that reads as ` +
              `live intent and re-invites the required-context withdrawal (#222)`,
          ).toBe(false);
        }
      }
    });
  });
}

// `closed` is the one PR type that IS load-bearing, on the one caller that
// declares it. Asserted positively so a future types trim can't drop it.
test.describe("#222 deploy-preview keeps the `closed` type", () => {
  test("examples/site deploy-preview.yml declares 'closed'", () => {
    test.skip(
      !fs.existsSync(DEPLOY_PREVIEW),
      "examples/site deploy-preview caller absent (consumed checkout)",
    );
    const types = prTypes((parseYaml(fs.readFileSync(DEPLOY_PREVIEW, "utf8")) || {}).on);
    expect(
      types,
      "deploy-preview.yml must declare an explicit on.pull_request.types list",
    ).toBeTruthy();
    expect(
      types,
      "deploy-preview.yml must keep 'closed' — the reusable's teardown-preview job " +
        "keys on action == 'closed' (S3 rm --recursive + CloudFront invalidation + " +
        "the bot-comment update); without it every closed PR's pr-N/ prefix leaks",
    ).toContain("closed");
  });
});

// A detector that silently stops looking is the failure mode this file exists
// to prevent — an empty candidate scan (a moved directory, a changed filter)
// would generate zero assertions and report green.
test.describe("#222 lint coverage — the candidate scan sees the real callers", () => {
  test("platform self-* callers are in scope", () => {
    const labels = candidateWorkflowPaths().map((f) => path.relative(REPO_ROOT, f));
    for (const name of ["self-dependabot-auto-merge.yml", "self-secrets-scan.yml"]) {
      expect(labels).toContain(path.join(".github", "workflows", name));
    }
  });

  test("canonical examples/site thin callers are in scope", () => {
    test.skip(
      !fs.existsSync(EXAMPLES_WF_DIR),
      "examples/site callers absent (consumed checkout)",
    );
    const labels = candidateWorkflowPaths().map((f) => path.relative(REPO_ROOT, f));
    for (const name of ["deploy-preview.yml", "e2e-tests.yml", "e2e-stub.yml"]) {
      expect(labels).toContain(path.join("examples", "site", ".github", "workflows", name));
    }
  });
});

// The gate detector must flag every shape a botched future edit could ship, and
// none of the unrelated conditions the real workflows legitimately carry.
test.describe("#222 base-change gate — hasBaseChangeGate detector", () => {
  const GATE = "github.event.action != 'edited' || github.event.changes.base.ref.from != ''";

  test("flags the #145 canonical disjunction gate", () => {
    expect(hasBaseChangeGate(GATE)).toBe(true);
  });

  test("flags the gate AND-ed onto a pre-existing condition", () => {
    expect(hasBaseChangeGate(`github.actor != 'dependabot[bot]' && (${GATE})`)).toBe(true);
  });

  test("flags the inverted AND / == '' variants", () => {
    expect(
      hasBaseChangeGate(
        "github.event.action != 'edited' && github.event.changes.base.ref.from != ''",
      ),
    ).toBe(true);
    expect(
      hasBaseChangeGate(
        "github.event.action != 'edited' || github.event.changes.base.ref.from == ''",
      ),
    ).toBe(true);
  });

  test("flags either half on its own, and a positive `== 'edited'` form", () => {
    expect(hasBaseChangeGate("github.event.action != 'edited'")).toBe(true);
    expect(hasBaseChangeGate("github.event.changes.base.ref.from != ''")).toBe(true);
    expect(hasBaseChangeGate("github.event.action == 'edited'")).toBe(true);
  });

  test("flags a block-scalar gate folded across lines", () => {
    expect(hasBaseChangeGate("github.event.action !=\n  'edited' ||\n  true")).toBe(true);
  });

  test("does NOT flag the unrelated conditions real callers carry", () => {
    // deploy-preview's reusable gates its two jobs on 'closed', and several
    // callers gate on the actor — neither is a base-change gate.
    expect(hasBaseChangeGate("github.event.action != 'closed'")).toBe(false);
    expect(hasBaseChangeGate("github.event.action == 'closed'")).toBe(false);
    expect(hasBaseChangeGate("github.actor == 'dependabot[bot]'")).toBe(false);
    expect(hasBaseChangeGate(undefined)).toBe(false);
  });
});

// prTypes must not report a phantom list (which would make the absence check
// vacuous) nor miss a real one — every `on:` shape GitHub accepts.
test.describe("#222 prTypes detector", () => {
  test("null for a defaulted or absent pull_request trigger", () => {
    expect(prTypes(null)).toBe(null);
    expect(prTypes("pull_request")).toBe(null);
    expect(prTypes(["pull_request", "push"])).toBe(null);
    expect(prTypes({ push: { branches: ["main"] } })).toBe(null);
    expect(prTypes({ pull_request: { branches: ["main"] } })).toBe(null);
    expect(prTypes({ pull_request: null })).toBe(null);
  });

  test("the declared list for a map trigger, scalar or sequence", () => {
    expect(prTypes({ pull_request: { types: ["opened", "closed"] } })).toEqual([
      "opened",
      "closed",
    ]);
    expect(prTypes({ pull_request: { types: "edited" } })).toEqual(["edited"]);
  });
});
