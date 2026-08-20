// @lane: local — pure-fs lint of every `dependabot-*.yml` reusable in the
// platform's own .github/workflows; no browser, no network.
//
// THE INVARIANT (the realized gap): a reusable the platform ships to consumers
// but never CALLS on itself is untested against the one repo whose maintainers
// would notice. The original instance was `dependabot-comment-sync.yml`, which
// shipped un-dogfooded and let the platform's own action-pin comments drift
// (#179, #194). That workflow — and the pin-comment convention it maintained —
// has since been deleted fleet-wide: a trailing `# vX.Y.Z (YYYY-MM-DD)` goes
// stale silently and then actively lies, and Dependabot rewrites it only
// sometimes. The SHA is the truth. The invariant this lint enforces outlived
// the workflow that motivated it and still binds the reusables that remain.
//
// THE RULE: every `dependabot-*.yml` reusable MUST be invoked by SOME workflow
// in this repo via a LOCAL `uses: ./.github/workflows/<file>` — i.e. dogfooded.
//
// Matched on the `uses:` TARGET, deliberately NOT on a "self-<basename>"
// filename convention: `dependabot-rearm-sweep.yml` is correctly dogfooded by
// `self-dependabot-rearm.yml`, and a name-based rule would false-fail it.
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const LOCAL_USES = /^\.\/\.github\/workflows\/(.+)$/;

function parsed(file) {
  try {
    return parseYaml(readWorkflow(file));
  } catch {
    return null; // actionlint owns YAML-validity; a parse error is its failure to report.
  }
}

// Every `dependabot-*.yml` under .github/workflows — the reusables in scope.
function dependabotReusables() {
  return listWorkflows()
    .map((p) => path.basename(p))
    .filter((f) => /^dependabot-.*\.ya?ml$/.test(f))
    .sort();
}

// Every workflow basename referenced by ANY job's local `uses:` in this repo.
function locallyCalledWorkflows() {
  const out = new Set();
  for (const wfPath of listWorkflows()) {
    const root = parsed(path.basename(wfPath));
    for (const job of Object.values((root && root.jobs) || {})) {
      const uses = job && typeof job.uses === "string" ? job.uses : "";
      const m = LOCAL_USES.exec(uses);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

const REUSABLES = dependabotReusables();
const CALLED = locallyCalledWorkflows();

test.describe("every dependabot-* reusable is dogfooded on this repo", () => {
  // Detector self-check: if the scan finds nothing, the lint would pass
  // vacuously. The platform ships two today (auto-merge, rearm-sweep) — it was
  // three until comment-sync was deleted with the pin-comment convention.
  test("the scan finds the platform's dependabot-* reusables (detector intact)", () => {
    expect(
      REUSABLES.length,
      `expected several 'dependabot-*.yml' reusables under .github/workflows, found ` +
        `${REUSABLES.length} — the scan likely drifted`,
    ).toBeGreaterThanOrEqual(2);
  });

  for (const reusable of REUSABLES) {
    test(`${reusable} is invoked by a local caller in this repo`, () => {
      expect(
        CALLED.has(reusable),
        `${reusable} is shipped to consumers but NO workflow in this repo calls it ` +
          `(no job with \`uses: ./.github/workflows/${reusable}\`). Add a self-* caller ` +
          `— the platform must run its own Dependabot machinery, or the machinery ` +
          `rots exactly where it is authored. Local callers found: ` +
          `${[...CALLED].sort().join(", ") || "(none)"}`,
      ).toBe(true);
    });
  }
});
