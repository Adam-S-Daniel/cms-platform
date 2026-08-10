// @lane: local — pure-fs lint of every `dependabot-*.yml` reusable in the
// platform's own .github/workflows; no browser, no network.
//
// THE INVARIANT (the realized gap): a reusable the platform ships to consumers
// but never CALLS on itself is untested against the one repo whose maintainers
// would notice. `dependabot-comment-sync.yml` shipped that way, and the
// platform's OWN action-pin comments drifted as a direct result — PR #179 moves
// actions/setup-node onto v7.0.0's SHA across 18 files with every comment still
// reading "# v6.4.0 (2026-04-20)", and #194's SHA is v6.2.3 while its comment
// says "# v6.1.1 (2026-05-05)" (stale by TWO releases). The repo whose whole
// convention is "the SHA and its comment stay in lockstep" was the one repo not
// running the lockstep-keeper.
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
  // vacuously. The platform ships three today (auto-merge, comment-sync,
  // rearm-sweep).
  test("the scan finds the platform's dependabot-* reusables (detector intact)", () => {
    expect(
      REUSABLES.length,
      `expected several 'dependabot-*.yml' reusables under .github/workflows, found ` +
        `${REUSABLES.length} — the scan likely drifted`,
    ).toBeGreaterThanOrEqual(3);
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
