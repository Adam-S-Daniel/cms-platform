// @lane: local — pure-fs anti-drift lint for cms-automerge-nudge.yml (#1815)
//
// The nudge workflow only acts on a PR when EVERY required-status-check
// has latest=SUCCESS / NEUTRAL / SKIPPED. Upstream (adamdaniel.ai) that
// list was hard-coded inline in the workflow's github-script and this
// lint locked it to .github/rulesets/main.json.
//
// PLATFORM PORT NOTE: the platform extraction is site-agnostic — there
// is no `.github/rulesets/main.json` here (the ruleset is site-specific).
// So the required-context list is no longer hard-coded in the reusable;
// it is the `required_contexts` workflow_call INPUT, and the thin caller
// (examples/site/.github/workflows/cms-automerge-nudge.yml) supplies the
// site's contexts. This lint therefore re-anchors:
//
//   - the REUSABLE is checked for shape: workflow_call-only, a REQUIRED
//     set DERIVED from the `required_contexts` input (NOT a hard-coded
//     site-identity list), the `automated-test` label gate, and the
//     "never enable from scratch" guard;
//   - the CALLER is checked for the schedule trigger (no pull_request /
//     push), that it passes a non-empty `required_contexts`, and that it
//     forwards the CMS_E2E_PAT secret.
//
// On a CONSUMING SITE, the maintainer keeps a copy of this test pointed
// at its own `.github/rulesets/main.json` and asserts the caller's
// `required_contexts` matches that ruleset — that ruleset-lock cannot
// live in the platform (no ruleset to lock against), so it is documented
// in the caller header instead.

const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { readWorkflow, parseYaml, events } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const NUDGE_REUSABLE = "cms-automerge-nudge.yml";
const NUDGE_CALLER_PATH = path.join(
  REPO_ROOT,
  "examples",
  "site",
  ".github",
  "workflows",
  "cms-automerge-nudge.yml",
);

function reusableText() {
  return readWorkflow(NUDGE_REUSABLE);
}
function callerText() {
  return fs.readFileSync(NUDGE_CALLER_PATH, "utf8");
}

test.describe("cms-automerge-nudge reusable — shape lint (#1815)", () => {
  test("reusable is workflow_call-only (the caller owns schedule/dispatch)", () => {
    const evs = events(parseYaml(reusableText()).on);
    expect(
      evs,
      "the platform nudge must be a workflow_call-only reusable — the " +
        "schedule + workflow_dispatch triggers live on the site's thin caller",
    ).toEqual(["workflow_call"]);
  });

  test("reusable declares a required `required_contexts` input and the CMS_E2E_PAT secret", () => {
    const doc = parseYaml(reusableText());
    const wc = doc.on.workflow_call;
    expect(wc, "reusable must declare on.workflow_call").toBeTruthy();
    expect(
      wc.inputs && wc.inputs.required_contexts,
      "reusable must expose a `required_contexts` input so each site " +
        "passes its own required-status-check list",
    ).toBeTruthy();
    expect(wc.inputs.required_contexts.required).toBe(true);
    expect(wc.inputs.required_contexts.type).toBe("string");
    expect(
      wc.secrets && wc.secrets.CMS_E2E_PAT,
      "reusable must accept the CMS_E2E_PAT secret (the recovered merge " +
        "must push to main as a non-bot identity so deploy-production fires)",
    ).toBeTruthy();
    // The github-script must authenticate with that secret.
    expect(reusableText()).toMatch(
      /github-token:\s*\$\{\{\s*secrets\.CMS_E2E_PAT\s*\}\}/,
    );
  });

  test("reusable derives REQUIRED from the input — no hard-coded site-identity list", () => {
    const yaml = reusableText();
    // REQUIRED must be built from the input (via the REQUIRED_CONTEXTS
    // env), NOT a literal `new Set([ '...', '...' ])` of site contexts.
    expect(
      yaml,
      "REQUIRED must be parsed from process.env.REQUIRED_CONTEXTS (the " +
        "`required_contexts` input) so the reusable carries no hard-coded " +
        "site identity",
    ).toMatch(/process\.env\.REQUIRED_CONTEXTS/);
    expect(yaml).toMatch(/REQUIRED_CONTEXTS:\s*\$\{\{\s*inputs\.required_contexts\s*\}\}/);
    // Guard against a regression that re-hard-codes the list as a literal
    // Set of quoted contexts (the upstream pre-extraction shape).
    expect(
      /const REQUIRED = new Set\(\[\s*['"]/.test(yaml),
      "REQUIRED must not be a hard-coded `new Set([ '...' ])` literal — " +
        "that re-introduces a site-specific identity the platform forbids",
    ).toBe(false);
  });

  test("reusable filters to PRs carrying the `automated-test` label", () => {
    // Gate is in the GraphQL query (`labels:["automated-test"]`) — if
    // that's removed, the nudge could touch arbitrary PRs. Lock it.
    expect(reusableText()).toMatch(/labels:\s*\[\s*["']automated-test["']\s*\]/);
  });

  test("reusable only re-enables on PRs that already have auto-merge (never enables from scratch)", () => {
    // Guard: `if (!pr.autoMergeRequest) continue;`. If a future refactor
    // drops this guard, the nudge could enable auto-merge on a PR a human
    // explicitly disabled.
    expect(reusableText()).toMatch(/if\s*\(\s*!\s*pr\.autoMergeRequest\s*\)\s*continue\s*;/);
  });
});

test.describe("cms-automerge-nudge caller — wiring lint (#1815)", () => {
  test("caller exists and is schedule-driven (no pull_request / push triggers — by design)", () => {
    const yaml = callerText();
    expect(yaml).toMatch(/^\s*schedule:/m);
    // The nudge MUST NOT fire on pull_request or push — those triggers
    // would (a) make it pointless (it can't help a PR's own checks) and
    // (b) trip the workflow-path-audit skill's filter requirement.
    expect(yaml).not.toMatch(/^\s*pull_request:/m);
    expect(yaml).not.toMatch(/^\s*push:/m);
  });

  test("caller calls the platform reusable and forwards required_contexts + CMS_E2E_PAT", () => {
    const yaml = callerText();
    const doc = parseYaml(yaml);
    const job = doc.jobs && doc.jobs.nudge;
    expect(job, "caller must declare a `nudge` job").toBeTruthy();
    expect(
      job.uses,
      "caller's nudge job must `uses:` the platform reusable",
    ).toMatch(/cms-platform\/\.github\/workflows\/cms-automerge-nudge\.yml@/);
    // required_contexts must be passed and non-empty (the actual values
    // are the site's responsibility; the platform example mirrors the
    // canonical 9-context list).
    const required = job.with && job.with.required_contexts;
    expect(required, "caller must pass `required_contexts`").toBeTruthy();
    const contexts = String(required)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(
      contexts.length,
      "caller's required_contexts must list at least one context",
    ).toBeGreaterThan(0);
    // Secret must be forwarded.
    expect(yaml).toMatch(/CMS_E2E_PAT:\s*\$\{\{\s*secrets\.CMS_E2E_PAT\s*\}\}/);
  });
});
