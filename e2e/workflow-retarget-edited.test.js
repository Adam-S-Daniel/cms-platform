// @lane: local — pure-fs lint of workflow YAML; no browser, no network
//
// Issue #145: a PR retargeted onto a different base fires `pull_request:
// edited` (the payload carries `changes.base`), but no `branches: [main]`-
// filtered canonical caller listened for `edited` — so the whole required-
// check suite silently never re-ran against the new base. A title/body edit
// and a base retarget were indistinguishable to every gate.
//
// The fix: every canonical caller whose `pull_request` trigger is filtered to
// `branches: [main]` must (a) declare an explicit `types:` including `edited`,
// and (b) gate EVERY job with an `if:` containing the base-change gate —
//   github.event.action != 'edited' || github.event.changes.base.ref.from != ''
// — so a title/body edit stays a no-op (the reusable never expands, so the
// nested required contexts get NO new run and the head sha's existing
// successes stand — see AGENTS.md / recon section 4 on why caller-JOB-level
// gating, not reusable-side, is the safe placement) while a base retarget
// reruns the full suite against the new base (behaves like `synchronize`).
//
// Scans BOTH the canonical examples/site thin callers AND the platform's OWN
// pull_request-triggered self-* callers (self-dependabot-auto-merge.yml,
// self-secrets-scan.yml) — path-name-agnostic: any file (present or future)
// whose `pull_request.branches` includes `main` is in scope automatically,
// so a newly-added branches:[main] caller is swept in without touching this
// lint. In a consumed checkout (no examples/site/) only the platform side
// applies; if neither directory yields a candidate the describe block below
// simply generates no tests (nothing to assert).
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml, jobs, listWorkflows } = require("./workflow-yaml-utils");

const EXAMPLES_WF_DIR = path.join(__dirname, "..", "examples", "site", ".github", "workflows");

function exampleWorkflowPaths() {
  if (!fs.existsSync(EXAMPLES_WF_DIR)) return [];
  return fs
    .readdirSync(EXAMPLES_WF_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(EXAMPLES_WF_DIR, f));
}

// listWorkflows() reads the platform's own .github/workflows dir. Of those,
// only files whose `pull_request` trigger has a `branches:` filter containing
// `main` are in scope (checked below) — in practice just the two self-*
// callers (self-ci.yml's pull_request carries no branches filter).
function candidateWorkflowPaths() {
  return [...exampleWorkflowPaths(), ...listWorkflows()];
}

function branchesIncludeMain(onValue) {
  const pr = onValue && onValue.pull_request;
  if (!pr || typeof pr !== "object") return false;
  const branches = pr.branches;
  if (!branches) return false;
  const list = Array.isArray(branches) ? branches : [branches];
  return list.map(String).includes("main");
}

// A valid gate is the DISJUNCTION
//   github.event.action != 'edited' || github.event.changes.base.ref.from != ''
// matched as ONE unit — NOT two independent substring tests. Testing the two
// fragments independently accepted semantically inverted gates that stay green
// on exactly the regressions this lint exists to catch:
//   - the AND form `… != 'edited' && … .ref.from != ''` evaluates FALSE on every
//     opened/synchronize event (changes.base is empty there), skipping the caller
//     job on EVERY normal PR so its required contexts never report;
//   - the `== ''` form re-runs the suite on title edits while SKIPPING base
//     retargets — silently re-introducing the exact #145 hole.
// Substring-based (unanchored) so a caller may AND the gate onto a pre-existing
// condition as `existing && (gate)` per the W4 compound-if provision.
const BASE_CHANGE_GATE_RE =
  /github\.event\.action\s*!=\s*'edited'\s*\|\|\s*github\.event\.changes\.base\.ref\.from\s*!=\s*''/;
function hasBaseChangeGate(ifExpr) {
  return typeof ifExpr === "string" && BASE_CHANGE_GATE_RE.test(ifExpr);
}

const REPO_ROOT = path.join(__dirname, "..");

for (const file of candidateWorkflowPaths()) {
  const label = path.relative(REPO_ROOT, file);
  const yaml = fs.readFileSync(file, "utf8");
  const doc = parseYaml(yaml) || {};
  if (!branchesIncludeMain(doc.on)) continue;

  test.describe(`${label} — #145 retarget-edited gate`, () => {
    test("declares on.pull_request.types including 'edited'", () => {
      const types = doc.on.pull_request.types;
      expect(
        Array.isArray(types),
        `${label} must declare an explicit on.pull_request.types list (not the ` +
          `GitHub-defaulted [opened, synchronize, reopened]) so 'edited' can be added (#145)`,
      ).toBe(true);
      expect(
        types.map(String),
        `${label} must include 'edited' in on.pull_request.types so a base retarget ` +
          `re-fires this caller (#145)`,
      ).toContain("edited");
    });

    test("every job carries the base-change gate", () => {
      const jobList = jobs(yaml);
      expect(jobList.length, `${label} must declare at least one job`).toBeGreaterThan(0);
      for (const job of jobList) {
        expect(
          hasBaseChangeGate(job.value && job.value.if),
          `${label} job '${job.name}' must carry an if: containing the base-change gate ` +
            `(github.event.action != 'edited' || github.event.changes.base.ref.from != '') ` +
            `so a title/body edit stays a no-op while a base retarget re-runs (#145)`,
        ).toBe(true);
      }
    });
  });
}

// The gate detector must reject the two semantically inverted forms that a
// botched future edit could ship — this lint is the ONLY guard on the invariant.
test.describe("#145 base-change gate — hasBaseChangeGate detector", () => {
  const GATE = "github.event.action != 'edited' || github.event.changes.base.ref.from != ''";

  test("accepts the canonical disjunction gate", () => {
    expect(hasBaseChangeGate(GATE)).toBe(true);
  });

  test("accepts the gate AND-ed onto a pre-existing condition (compound-if)", () => {
    expect(hasBaseChangeGate(`github.actor != 'dependabot[bot]' && (${GATE})`)).toBe(true);
  });

  test("REJECTS the AND form (would skip the job on every opened/synchronize event)", () => {
    expect(
      hasBaseChangeGate("github.event.action != 'edited' && github.event.changes.base.ref.from != ''"),
    ).toBe(false);
  });

  test("REJECTS the == '' form (would re-run on title edits, skip base retargets — the #145 hole)", () => {
    expect(
      hasBaseChangeGate("github.event.action != 'edited' || github.event.changes.base.ref.from == ''"),
    ).toBe(false);
  });
});
