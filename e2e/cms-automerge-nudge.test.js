// @lane: local — AST anti-drift lint for cms-automerge-nudge.yml (#1815)
//
// "AST always, not regex" (see spec-ast.js / AGENTS.md Conventions): a lint that
// reasons about CODE STRUCTURE must parse a real AST, never regex-scan source.
// The nudge's logic lives in the reusable's `actions/github-script` body, so we
// extract that JS string from the workflow YAML and parse it with acorn (via
// spec-ast.js), then assert on AST facts — never on raw text.
//
// What this locks:
//   - the REUSABLE shape: workflow_call-only, a REQUIRED set DERIVED from the
//     `required_contexts` input (NOT a hard-coded site-identity list), the
//     `automated-test` label gate, the "never act unless auto-merge already
//     armed" guard, and the #1815 recovery behaviour (no mergeStateStatus gate,
//     a fresh head-sha re-query that rejects pending/stub greens, and an
//     explicit `pulls.merge({ merge_method: 'squash' })`);
//   - the CALLER wiring: schedule-driven (no pull_request/push), passes a
//     non-empty `required_contexts`, forwards CMS_E2E_PAT.
//
// On a CONSUMING SITE the maintainer keeps a copy pointed at its own
// `.github/rulesets/main.json` and asserts the caller's `required_contexts`
// matches that ruleset (a lock that can't live in the platform — no ruleset to
// lock against — so it's documented in the caller header instead).

const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { readWorkflow, parseYaml, events } = require("./workflow-yaml-utils");
const { parse, analyzeSpec, calleeName, stringValue } = require("./spec-ast");

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

// Extract the `actions/github-script` body (the JS the nudge runs) from the
// reusable, by NAVIGATING the parsed YAML — not by string-slicing.
function nudgeScriptSource() {
  const doc = parseYaml(reusableText());
  const steps = (doc.jobs && doc.jobs.nudge && doc.jobs.nudge.steps) || [];
  const gh = steps.find(
    (s) => typeof s.uses === "string" && s.uses.includes("actions/github-script"),
  );
  if (!gh || !gh.with || !gh.with.script) {
    throw new Error("could not find the actions/github-script step in cms-automerge-nudge.yml");
  }
  return gh.with.script;
}

// github-script bodies use top-level `await` AND top-level `return`; neither
// acorn sourceType alone accepts both. Wrap in an async IIFE so the body's
// statements parse legally, then the walker descends into them as usual.
function wrapped() {
  return `(async () => {\n${nudgeScriptSource()}\n})()`;
}
function nudgeAst() {
  return parse(wrapped());
}
function nudgeFacts() {
  return analyzeSpec(wrapped());
}

// Does any BinaryExpression in the AST compare a `…mergeStateStatus` reference
// to the string `op`-side literal `lit` with the given operator?
function hasComparison(ast, { idTail, operator, literal }) {
  let found = false;
  const refsId = (side) =>
    (side.type === "MemberExpression" && side.property && side.property.name === idTail) ||
    (side.type === "Identifier" && side.name === idTail);
  const isLit = (side) => stringValue(side) === literal;
  walk.full(ast, (n) => {
    if (n.type !== "BinaryExpression" || n.operator !== operator) return;
    if ((refsId(n.left) && isLit(n.right)) || (refsId(n.right) && isLit(n.left))) found = true;
  });
  return found;
}

// The first CallExpression whose dotted callee name ends with `suffix`.
function findCall(ast, suffix) {
  let hit = null;
  walk.full(ast, (n) => {
    if (hit || n.type !== "CallExpression") return;
    const name = calleeName(n.callee) || "";
    if (name === suffix || name.endsWith(`.${suffix}`)) hit = n;
  });
  return hit;
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
    // The github-script step authenticates with that secret (YAML structure).
    const step = doc.jobs.nudge.steps.find(
      (s) => typeof s.uses === "string" && s.uses.includes("actions/github-script"),
    );
    expect(step.with["github-token"]).toBe("${{ secrets.CMS_E2E_PAT }}");
  });

  test("reusable derives REQUIRED from the input — no hard-coded site-identity list [AST]", () => {
    const ast = nudgeAst();
    // REQUIRED must be built from the input (process.env.REQUIRED_CONTEXTS),
    // wired from the `required_contexts` input via the REQUIRED_CONTEXTS env.
    expect(
      nudgeFacts().memberProps.has("REQUIRED_CONTEXTS"),
      "REQUIRED must be parsed from process.env.REQUIRED_CONTEXTS so the reusable " +
        "carries no hard-coded site identity",
    ).toBe(true);
    const doc = parseYaml(reusableText());
    const step = doc.jobs.nudge.steps.find(
      (s) => typeof s.uses === "string" && s.uses.includes("actions/github-script"),
    );
    expect(step.env.REQUIRED_CONTEXTS).toBe("${{ inputs.required_contexts }}");
    // Guard against a regression that re-hard-codes the list as `new Set([...])`
    // of string literals (the upstream pre-extraction shape).
    let hardCoded = false;
    walk.full(ast, (n) => {
      if (
        n.type === "NewExpression" &&
        calleeName(n.callee) === "Set" &&
        n.arguments[0] &&
        n.arguments[0].type === "ArrayExpression" &&
        n.arguments[0].elements.some((e) => e && e.type === "Literal" && typeof e.value === "string")
      ) {
        hardCoded = true;
      }
    });
    expect(
      hardCoded,
      "REQUIRED must not be a hard-coded `new Set([ '...' ])` literal — that " +
        "re-introduces a site-specific identity the platform forbids",
    ).toBe(false);
  });

  test("reusable filters to PRs carrying the `automated-test` label [AST]", () => {
    // The label gate lives in the GraphQL query string; extract every string
    // value from the AST and require one to carry the label filter. If it's
    // removed, the nudge could touch arbitrary PRs.
    const hasLabelGate = nudgeFacts().strings.some((s) =>
      /labels:\s*\[\s*"automated-test"\s*\]/.test(s),
    );
    expect(
      hasLabelGate,
      "the GraphQL query must filter `labels:[\"automated-test\"]` so the nudge " +
        "never touches a human-authored PR",
    ).toBe(true);
  });

  test("reusable only acts on PRs that already have auto-merge (never enables from scratch) [AST]", () => {
    // Guard: `if (!pr.autoMergeRequest) continue;` — an IfStatement whose test is
    // a logical-NOT of a `*.autoMergeRequest` member, with a ContinueStatement
    // consequent. If dropped, the nudge could act on a PR a human disabled.
    let found = false;
    walk.full(nudgeAst(), (n) => {
      if (n.type !== "IfStatement") return;
      const t = n.test;
      const negatesAutoMerge =
        t &&
        t.type === "UnaryExpression" &&
        t.operator === "!" &&
        t.argument &&
        t.argument.type === "MemberExpression" &&
        t.argument.property &&
        t.argument.property.name === "autoMergeRequest";
      const continues =
        (n.consequent && n.consequent.type === "ContinueStatement") ||
        (n.consequent &&
          n.consequent.type === "BlockStatement" &&
          n.consequent.body.some((s) => s.type === "ContinueStatement"));
      if (negatesAutoMerge && continues) found = true;
    });
    expect(
      found,
      "the nudge must early-`continue` on `!pr.autoMergeRequest` (never act on a " +
        "PR whose auto-merge a human left/disabled)",
    ).toBe(true);
  });
});

test.describe("cms-automerge-nudge reusable — recovery behavior (#1815) [AST]", () => {
  test("does NOT gate on mergeStateStatus (so UNKNOWN-state stuck PRs get recovered)", () => {
    // The bulk GraphQL returns mergeStateStatus=UNKNOWN for un-evaluated PRs;
    // the old `if (pr.mergeStateStatus !== 'BLOCKED') continue;` skipped every
    // one — the exact reason stuck-green canaries (#1812/#1815) were never
    // recovered. There must be NO `…mergeStateStatus !== 'BLOCKED'` comparison.
    expect(
      hasComparison(nudgeAst(), {
        idTail: "mergeStateStatus",
        operator: "!==",
        literal: "BLOCKED",
      }),
      "the nudge must NOT compare `mergeStateStatus !== 'BLOCKED'` — that drops " +
        "UNKNOWN-state stuck PRs; gate on the fresh check state instead",
    ).toBe(false);
  });

  test("re-queries the head sha's check-runs fresh and rejects pending/stub greens", () => {
    const facts = nudgeFacts();
    // Authoritative fresh re-query (not just the lagging bulk rollup): a
    // reference to `…checks.listForRef`, anchored on the head commit `oid`.
    expect(
      facts.memberProps.has("listForRef"),
      "the nudge must re-query the head sha's check-runs (checks.listForRef) " +
        "before merging — the bulk rollup can lag",
    ).toBe(true);
    expect(
      facts.memberProps.has("oid"),
      "the fresh re-query must be anchored on the head commit oid",
    ).toBe(true);
    // Stub-hazard guard: a context with any non-completed run is NOT green (the
    // real check still running behind a docs-only stub-green). See the
    // adamdaniel-automerge-fires-on-stub-checks hazard. Look for a `… !==
    // 'completed'` comparison anywhere (the run-status pending check).
    let rejectsPending = false;
    walk.full(nudgeAst(), (n) => {
      if (
        n.type === "BinaryExpression" &&
        n.operator === "!==" &&
        (stringValue(n.left) === "completed" || stringValue(n.right) === "completed")
      ) {
        rejectsPending = true;
      }
    });
    expect(
      rejectsPending,
      "the nudge must treat a queued/in-progress required run as NOT green " +
        "(never merge on a stub-green while the real check is still pending)",
    ).toBe(true);
  });

  test("recovery is an EXPLICIT squash merge, not just a no-op re-enable", () => {
    // The strong recovery: an explicit `pulls.merge` forces GitHub to
    // re-evaluate mergeability fresh, dislodging the stale BLOCKED snapshot a
    // re-enable does NOT clear (#1965 stayed open 6+ h after a re-enable).
    const mergeCall = findCall(nudgeAst(), "pulls.merge");
    expect(mergeCall, "recovery must call pulls.merge (explicit merge)").toBeTruthy();
    const arg = mergeCall.arguments[0];
    expect(
      arg && arg.type === "ObjectExpression",
      "pulls.merge must take an options object",
    ).toBe(true);
    const prop = arg.properties.find(
      (p) => p.key && (p.key.name === "merge_method" || p.key.value === "merge_method"),
    );
    expect(
      prop && stringValue(prop.value),
      "the recovery merge must use merge_method: 'squash'",
    ).toBe("squash");
  });
});

test.describe("cms-automerge-nudge caller — wiring lint (#1815)", () => {
  test("caller exists and is schedule-driven (no pull_request / push triggers — by design)", () => {
    const evs = events(parseYaml(callerText()).on);
    expect(evs, "caller must be schedule-driven").toContain("schedule");
    // The nudge MUST NOT fire on pull_request or push — those triggers would
    // (a) make it pointless (it can't help a PR's own checks) and (b) trip the
    // workflow-path-audit skill's filter requirement.
    expect(evs).not.toContain("pull_request");
    expect(evs).not.toContain("push");
  });

  test("caller calls the platform reusable and forwards required_contexts + CMS_E2E_PAT", () => {
    const doc = parseYaml(callerText());
    const job = doc.jobs && doc.jobs.nudge;
    expect(job, "caller must declare a `nudge` job").toBeTruthy();
    expect(
      job.uses,
      "caller's nudge job must `uses:` the platform reusable",
    ).toMatch(/cms-platform\/\.github\/workflows\/cms-automerge-nudge\.yml@/);
    // required_contexts must be passed and non-empty (the actual values are the
    // site's responsibility; the platform example mirrors the canonical list).
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
    // Secret forwarded (YAML structure).
    expect(job.secrets && job.secrets.CMS_E2E_PAT).toBe("${{ secrets.CMS_E2E_PAT }}");
  });
});
