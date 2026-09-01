// @lane: local — pure-fs lint over every `on: workflow_call` reusable in THIS
// repo's `.github/workflows/`; no browser, no build, no network.
//
// THE DEFECT THIS LOCKS (measured, not hypothetical): dependabot-auto-merge.yml
// and dependabot-rearm-sweep.yml both ran
// `bash scripts/check-dependabot-manifest-paths.sh …` — a script that lives
// only in cms-platform's own scripts/ directory. A `workflow_call` job's
// default `actions/checkout` (no `repository:`) checks out the CALLER's tree
// (`github.repository` is the CONSUMER at run time, not the platform), so on
// every real invocation the script was simply not on disk. Bash's own
// "No such file or directory" made the `if bash …` conditional take its FALSE
// branch — never a shell error the job noticed — which zeroed `safe`, disabled
// auto-merge, and hard-failed the job on every Dependabot PR on both
// consumers since the script's introduction (cms-platform#303; measured on
// adamdaniel.ai run 33566180189 / PR #3465). The platform's own self-CI never
// saw it: on THIS repo the checkout IS the platform, so the script is right
// there — the same consumer-checkout blind spot AGENTS.md records for the
// `cms-platform-secrets` skill-name incident.
//
// THE INVARIANT: any `run:` step in a `workflow_call` job that invokes a
// script this repo ships under scripts/ must (a) reference it via the
// `.cms-platform/scripts/…` path a platform checkout produces, never a bare
// `scripts/…` path that only resolves in the platform's OWN checkout, and
// (b) have an EARLIER step in the same job that checks the platform out to
// `.cms-platform` — full, or sparse-including that exact script — the way
// pin-agreement.yml / editorial-label-audit.yml / scheduled-run-health.yml /
// dependabot-auto-merge.yml / dependabot-rearm-sweep.yml all do today.
//
// TWO LAYERS, DELIBERATELY MIXED. Which jobs exist, what a step's `uses:` /
// `with:` are, and step ORDER within a job are all CODE SHAPE — read from the
// real YAML AST via workflow-yaml-utils.js's `parseYaml`/`listWorkflows`
// (the `yaml` package), never a regex over the file text (AGENTS.md "AST
// always, never regex, for code-shape lints"). Finding a `scripts/<file>`
// TOKEN inside one already-extracted `run:` string's own CONTENT, by
// contrast, is the "genuinely lexical concern — a leaf token's own content"
// AGENTS.md carves regex back in for: the string is already isolated by the
// parser, and what's asked of it is "does this text mention this path",
// nothing about structure. `invocationsIn()` below does exactly that lexical
// read, and only within a `run:` body the AST already located — a comment or
// an unrelated key's value is invisible to it because the AST doesn't hand
// those to it. The regex is also boundary-guarded (see its comment) so it
// does not fire on a script path embedded in something else — e.g.
// platform-bump.yml's `gh api …/contents/scripts/reconcile-nudge-contexts.py`,
// which fetches platform script CONTENT over the API rather than invoking a
// checked-out file, and is correctly not this lint's concern.
//
// EXEMPT: `self-*.yml` — dogfood callers of these same reusables, triggered
// on `pull_request` / `schedule` / `workflow_dispatch`, never `workflow_call`
// — fall out of the `workflow_call` filter on their own; no separate
// carve-out needed.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { listWorkflows, readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");
const PLATFORM_SCRIPTS = new Set(fs.readdirSync(SCRIPTS_DIR));

function isWorkflowCall(doc) {
  const on = doc && doc.on;
  if (!on) return false;
  if (typeof on === "string") return on === "workflow_call";
  if (Array.isArray(on)) return on.includes("workflow_call");
  return Object.prototype.hasOwnProperty.call(on, "workflow_call");
}

// A step counts as "checks the platform out to .cms-platform" when it's an
// `actions/checkout` step naming a cms-platform repository (the literal slug,
// in any of the forms this repo's own reusables use, or the
// `${{ inputs.platform_repo }}` expression those reusables default to that
// slug) with `path: .cms-platform`. `sparseSet` is the file basenames a
// `sparse-checkout:` block names (`null` when the step omits `sparse-checkout`
// entirely, i.e. a FULL checkout — every script is present).
function platformCheckoutInfo(step) {
  if (!step || typeof step.uses !== "string") return null;
  if (!/^actions\/checkout@/.test(step.uses)) return null;
  const withObj = step.with || {};
  const repo = withObj.repository;
  const namesPlatform =
    typeof repo === "string" &&
    (repo.includes("cms-platform") || repo.includes("inputs.platform_repo"));
  if (!namesPlatform) return null;
  if (withObj.path !== ".cms-platform") return null;
  const sparse = withObj["sparse-checkout"];
  if (sparse == null) return { sparseSet: null };
  const sparseSet = new Set(
    String(sparse)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  return { sparseSet };
}

// Lexical read of one `run:` string's own content — find every occurrence of
// a `scripts/<file>` path used as an EXECUTION target: either handed to an
// interpreter keyword (`bash`/`sh`/`python3`/`python`/`ruby`/`node`) or
// executed directly (a leading `./`, at a shell command-start position —
// start of line, or after `;` `&` `|` a backtick or `(`, which also catches
// the `$( ./…script )` capture form deploy-preview.yml's SLUG line uses).
//
// This is deliberately narrower than "the substring appears anywhere", which
// is what makes it safe against three real, legitimate non-invocation shapes
// already in this repo: a `scripts/<file>` entry in a bash ARRAY literal that
// is only ever read back through a variable (dev-hooks-sync.yml's `FILES=(…)`
// + `src=".cms-platform/$f"`, and its later `chmod +x scripts/<file>…` on the
// SITE's own post-copy files — never the platform's), a script path inside a
// `gh api …/contents/scripts/<file>` URL segment (platform-bump.yml fetches
// script CONTENT over the API to a temp path, never checks the platform out
// at all), and a script path mentioned only in a `#`-prefixed shell comment
// (preview-media.yml's PORT NOTE). None of those precede the path with an
// interpreter or a command-start `./`, so none of them match here.
//
// Returns [{ scriptFile, prefixed, matchText }] where `prefixed` is true only
// when the captured path is exactly `.cms-platform/scripts/<file>` — the one
// prefix a platform checkout into `.cms-platform/` produces.
function invocationsIn(runText) {
  // Fresh RegExp per call — a shared `g`-flagged instance carries `lastIndex`
  // state across calls, which would silently skip or misalign matches on
  // every `run:` string after the first.
  //
  // The interpreter keyword must sit at a shell COMMAND position — start of
  // line, or after `;` `&` `|` a backtick or `(` — not merely after a `\b`
  // word boundary. A bare `\b(?:bash|sh|…)` matched the trailing "sh" of
  // "secrets-scan.**sh**" in dev-hooks-sync.yml's FILES array (`.` is a
  // non-word character, so `\b` alone is satisfied by any "…sh" substring)
  // and then happily "invoked" the NEXT array entry as if `sh` were a shell
  // interpreter — a false positive on real file content, not a hypothetical.
  const CMD_BOUNDARY = "(?:^|[\\s;&|`(])";
  const EXEC_RE = new RegExp(
    CMD_BOUNDARY +
      "(?:(?:bash|sh|python3?|ruby|node)\\s+(?:\\./)?|\\./)" +
      "((?:\\.[\\w.-]+/)*scripts/[\\w./-]+\\.(?:sh|js|py|rb))\\b",
    "gm",
  );
  const out = [];
  let m;
  while ((m = EXEC_RE.exec(runText))) {
    const captured = m[1];
    const scriptFile = captured.replace(/^.*?scripts\//, "");
    out.push({
      scriptFile,
      prefixed: captured.startsWith(".cms-platform/"),
      matchText: m[0],
    });
  }
  return out;
}

function findings() {
  const results = [];
  let workflowCallCount = 0;
  let invocationCount = 0;
  for (const file of listWorkflows()) {
    const name = path.basename(file);
    const raw = readWorkflow(name);
    let doc;
    try {
      doc = parseYaml(raw);
    } catch {
      continue;
    }
    if (!doc || !isWorkflowCall(doc)) continue;
    workflowCallCount += 1;
    const jobs = (doc && doc.jobs) || {};
    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = (job && job.steps) || [];
      const checkoutsSoFar = [];
      steps.forEach((step, idx) => {
        const checkout = platformCheckoutInfo(step);
        if (checkout) checkoutsSoFar.push(checkout);
        if (typeof step.run !== "string") return;
        for (const { scriptFile, prefixed, matchText } of invocationsIn(step.run)) {
          if (!PLATFORM_SCRIPTS.has(scriptFile)) continue; // not a platform-owned script
          invocationCount += 1;
          const where = `${name} :: ${jobName} :: step ${idx} (${step.name || "(unnamed)"})`;
          const checkedOut = checkoutsSoFar.some(
            (c) => c.sparseSet === null || c.sparseSet.has(`scripts/${scriptFile}`),
          );
          results.push({ where, scriptFile, prefixed, checkedOut, matchText });
        }
      });
    }
  }
  return { results, workflowCallCount, invocationCount };
}

const { results, workflowCallCount, invocationCount } = findings();

test("the lint sees `workflow_call` reusables and platform-script invocations to police", () => {
  // Recurrence guard: if the on:/steps: shape this lint reads ever changes
  // under it, this fails LOUD instead of the lint silently asserting nothing.
  expect(
    workflowCallCount,
    "no `on: workflow_call` reusable found — did the workflow directory move?",
  ).toBeGreaterThan(5);
  expect(
    invocationCount,
    "no platform-script invocation found in any workflow_call job — did every " +
      "reusable stop shelling out to scripts/, or did the scripts/ listing change?",
  ).toBeGreaterThan(0);
});

for (const r of results) {
  test(`${r.where} invokes scripts/${r.scriptFile} via a checked-out platform copy`, () => {
    expect(
      r.prefixed,
      `${r.where} invokes "${r.matchText}" as a bare scripts/ path — this is a ` +
        `workflow_call job, so the default checkout is the CALLER's tree, not the ` +
        `platform's. Prefix the invocation with the platform checkout's path ` +
        `(".cms-platform/scripts/${r.scriptFile}").`,
    ).toBe(true);
    expect(
      r.checkedOut,
      `${r.where} invokes scripts/${r.scriptFile} with no earlier step in the same ` +
        `job checking the platform out to .cms-platform (full, or sparse-including ` +
        `this script).`,
    ).toBe(true);
  });
}
