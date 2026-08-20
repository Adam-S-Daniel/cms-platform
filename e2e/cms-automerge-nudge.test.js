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
//   - the TEMPLATE caller's `required_contexts` list against the AUTHORITATIVE
//     declaration of a consumer's required checks: this repo's own
//     `repo-settings.yml`, `ruleset_library.consumer-main`. Both files live
//     here, so the lock is entirely platform-side.
//
// That last one replaces a claim this header used to make and that was simply
// false: that a consuming site keeps its own copy of this spec pointed at its
// `.github/rulesets/main.json`, and that no ruleset existed in the platform to
// lock against. Neither holds. Consumers track no `e2e/` tree at all since the
// harness became platform-delivered; jodidaniel.com has no `.github/rulesets/`
// directory; adamdaniel.ai's is a vestige nothing reads (the applier
// `scripts/audit-repo-settings.js` reads `repo-settings.yml` and PUTs to the
// live API, and that stale file even declares a ruleset that does not exist
// live). Meanwhile `ruleset_library.consumer-main` has been the real
// declaration all along. Until this lock landed the template's list was checked
// against nothing and its own comment admitted it had been hand-copied from one
// site "as of v0.1.79" — free to rot, and a wrong entry silently disables
// stuck-PR recovery, because the nudge waits forever for a context no run will
// ever report.
//
// The comparison is a SET, and it is on the TEMPLATE only.
//
// An earlier version of this header justified that scoping with a worked example
// that was false when it was written: that jodidaniel.com "deliberately passes
// only `editorial / validate-content`". It did pass exactly one context — but not
// deliberately. That was an unrevisited seed value, and every one of the six
// commits touching that file between the seeding and the fix is a `chore: bump
// cms-platform to vX`. jodidaniel.com's live `main` ruleset requires all six
// `consumer-main` contexts, and jodidaniel.com#156 ("Give the auto-merge nudge
// all six required contexts, not one") brought the caller back in line. Citing
// that file as a legitimate narrowing recommended, to every site that reads the
// template this lock guards, the exact defect that was fixed the same day.
//
// What IS true: the authoritative per-repo declaration is this repo's own
// `repo-settings.yml`. `repos[<owner/repo>].rulesets.main` names an entry in
// `ruleset_library`, and THAT entry's `required_status_checks` is the list
// `scripts/audit-repo-settings.js --fix --yes` PUTs live. A site's
// `required_contexts` should equal ITS OWN ruleset's required set — today the
// same six for both consumers, because `repos:` maps `Adam-S-Daniel/adamdaniel.ai`
// and `jodidaniel/jodidaniel.com` alike to `consumer-main`. A site mapped to some
// other entry owes that entry's list, not this one's, which is why the lock stops
// at the template.
//
// The failure has TWO directions and only one was ever written down:
//   - a WRONG entry makes the nudge wait forever for a context nothing reports,
//     silently disabling stuck-PR recovery (the hazard already documented);
//   - a SHORT list makes it ask to merge on incomplete evidence — jodidaniel.com#156,
//     where one green context out of six would have fired `pulls.merge()` while the
//     other five were still pending. That was safe only because the ruleset answered
//     405; a guard that requests a merge it has not established is safe by accident,
//     and only for as long as branch protection holds.
//
// #284 — WHY THERE IS STILL NO CONSUMER-MODE VERSION OF THIS LOCK. The reason
// previously recorded ("making it consumer-mode would immediately red-fail
// jodidaniel.com for a deliberate choice") died with the false claim above: both
// consumers map to `consumer-main` and both now pass its six contexts, so nothing
// would red. The MECHANISM is available too, recorded here so the next reader need
// not re-derive it: `e2e-tests.yml`'s `project` job checks the WHOLE platform out
// to `.cms-platform` (no `sparse-checkout:`) and exports `SITE_ROOT` =
// `github.workspace` plus `CMS_REPO` = `github.repository` in BOTH target lanes, so
// `<SITE_ROOT>/.cms-platform/repo-settings.yml` is readable on a consumer lane and
// `repos:` is keyed by `owner/repo`, letting a site look itself up.
// `e2e/admin-spec-source-read-lint.test.js` does not object — it scans only
// `*.spec.js`, and its forbidden patterns are `theme/admin` and the legacy
// `../admin`, neither of which a `.cms-platform` read matches.
//
// It is nonetheless NOT built, and the reasons are about the ORACLE rather than the
// plumbing. First, the manifest a consumer can read is the copy pinned at its
// `platform_ref`, not the live ruleset; it lags, and it lags in the false-GREEN
// direction, since a consumer pinned behind a manifest change agrees with its own
// stale list. Reading the live ruleset instead is a `gh api` call, which the
// no-network rule forbids in this suite. Second, a freshly scaffolded site is not in
// `repos:` at all, so the lint needs an "absent from the manifest" skip — and that
// soft path would land on precisely the sites with the least review behind them.
// Neither objection is fatal and both want deciding before the lint earns its keep.
// For whoever picks this up: a pinned-manifest check WOULD have caught
// jodidaniel.com#156 (the manifest converged jodidaniel onto `consumer-main` on
// 2026-07-22, months before the caller was fixed), so the objection is to this
// shape, not to the idea.

const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { readWorkflow, parseYaml, events } = require("./workflow-yaml-utils");
const { parse, analyzeSpec, calleeName, stringValue } = require("./spec-ast");

const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "repo-settings.yml");
const CONSUMER_RULESET = "consumer-main";
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

  test("reusable only acts on PRs that already have auto-merge, OR a preview-only base that can never arm it [AST]", () => {
    // Guard: `if (!pr.autoMergeRequest && !basePreviewOnly) continue;` — an
    // IfStatement whose test is a `&&` of two negations: one negates a
    // `*.autoMergeRequest` member (never touch a main-based PR whose auto-merge
    // a human left/disabled — the original guard), the other negates the
    // `basePreviewOnly` identifier (still evaluate a preview-only PR, which can
    // NEVER get auto-merge armed in the first place — see
    // cms-editorial-workflow.yml's "clean status" / "unstable status" errors,
    // e.g. PR #2466 / run 28758624761, base `audit/preview-exercise`). Only
    // when BOTH negations hold (not armed AND not preview-only) does the nudge
    // skip the PR.
    let found = false;
    walk.full(nudgeAst(), (n) => {
      if (n.type !== "IfStatement") return;
      const t = n.test;
      if (!t || t.type !== "LogicalExpression" || t.operator !== "&&") return;
      const sides = [t.left, t.right];
      const negatesAutoMerge = sides.some(
        (s) =>
          s.type === "UnaryExpression" &&
          s.operator === "!" &&
          s.argument &&
          s.argument.type === "MemberExpression" &&
          s.argument.property &&
          s.argument.property.name === "autoMergeRequest",
      );
      const negatesBasePreviewOnly = sides.some(
        (s) =>
          s.type === "UnaryExpression" &&
          s.operator === "!" &&
          s.argument &&
          s.argument.type === "Identifier" &&
          s.argument.name === "basePreviewOnly",
      );
      const continues =
        (n.consequent && n.consequent.type === "ContinueStatement") ||
        (n.consequent &&
          n.consequent.type === "BlockStatement" &&
          n.consequent.body.some((s) => s.type === "ContinueStatement"));
      if (negatesAutoMerge && negatesBasePreviewOnly && continues) found = true;
    });
    expect(
      found,
      "the nudge must early-`continue` only when BOTH `!pr.autoMergeRequest` " +
        "AND `!basePreviewOnly` hold (never skip a preview-only PR just because " +
        "its auto-merge could never be armed in the first place)",
    ).toBe(true);
  });

  test("derives basePreviewOnly from baseRefName !== 'main', and the query fetches baseRefName [AST]", () => {
    // basePreviewOnly must be computed by comparing the PR's baseRefName to
    // the literal 'main' — reuse the same hasComparison helper used elsewhere
    // in this file for `mergeStateStatus !== 'BLOCKED'`.
    expect(
      hasComparison(nudgeAst(), {
        idTail: "baseRefName",
        operator: "!==",
        literal: "main",
      }),
      "basePreviewOnly must be derived by comparing `baseRefName !== 'main'`",
    ).toBe(true);
    expect(
      nudgeFacts().memberProps.has("baseRefName"),
      "the script must reference `.baseRefName` on the PR node",
    ).toBe(true);
    expect(
      nudgeFacts().strings.some((s) => s.includes("baseRefName")),
      "the GraphQL query string itself must request the `baseRefName` field " +
        "(not just reference it elsewhere in the script) so a reviewer can see " +
        "the field was actually added to the query",
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

  test("preview-only PRs are judged by the base-aware self-consistent predicate, not required_contexts (PR #2484 / run 28768313594)", () => {
    // The site's `required_contexts` mirror its MAIN-branch ruleset; most of
    // those workflows never run on a feature-base PR, so both the bulk
    // rollup pre-filter and headIsTrulyGreen are structurally unsatisfiable
    // for a `basePreviewOnly` PR — the v0.1.52 carve-out got these PRs INTO
    // the loop, but the REQUIRED-keyed gates then rejected every one,
    // forever (adamdaniel PR #2484 sat fully green with cms/ready +
    // cms/preview-only while the 04:42:33 nudge run 28768313594 logged
    // "Found 1 … Recovered 0"). The reusable must therefore carry a second,
    // SELF-consistent readiness predicate — the lockstep twin of
    // cms-editorial-workflow.yml's unstable-status fallback — and route
    // preview-only PRs through it.
    const ast = nudgeAst();
    const facts = nudgeFacts();

    // (a) The predicate exists as a named function AND is actually invoked.
    let declared = false;
    walk.full(ast, (n) => {
      if (n.type === "FunctionDeclaration" && n.id && n.id.name === "headIsSelfConsistentGreen") {
        declared = true;
      }
    });
    expect(
      declared,
      "the nudge must declare headIsSelfConsistentGreen — the base-aware " +
        "readiness predicate for preview-only PRs",
    ).toBe(true);
    expect(
      findCall(ast, "headIsSelfConsistentGreen"),
      "headIsSelfConsistentGreen must actually be called (a declared-but-dead " +
        "predicate means preview-only PRs are still gated on required_contexts)",
    ).toBeTruthy();

    // (b) auto-merge-when-ready job-class runs are excluded via a regex
    // literal — an in-flight sibling editorial poll on the same PR must not
    // read as "pending" (the #135 self-deadlock class).
    let excludesJobClass = false;
    walk.full(ast, (n) => {
      if (
        n.type === "Literal" &&
        n.regex &&
        n.regex.pattern.includes("auto-merge-when-ready")
      ) {
        excludesJobClass = true;
      }
    });
    expect(
      excludesJobClass,
      "the predicate must exclude auto-merge-when-ready job-class check runs " +
        "(regex literal) — counting an in-flight editorial poll as pending " +
        "re-creates the #135 self-deadlock through the nudge",
    ).toBe(true);

    // (c) Legacy combined status consulted, with empty-set-OK semantics
    // (GitHub reports total_count 0 as state:"pending").
    expect(
      facts.memberProps.has("getCombinedStatusForRef"),
      "the predicate must consult the combined commit status (deploy-preview.yml " +
        "posts a real deploy/preview status on PR heads)",
    ).toBe(true);
    expect(
      facts.memberProps.has("total_count"),
      "the combined-status check must special-case total_count (an EMPTY status " +
        "set reads state:\"pending\" and must count as OK)",
    ).toBe(true);

    // (c2) Zero-run anchor: right after a force-push GitHub may not have
    // CREATED the head's check runs yet, and zero present runs must read
    // as NOT-ready (never vacuous green) — the predicate's own "no runs"
    // reason string is the AST fact we lock (facts.strings).
    expect(
      facts.strings.some((s) => /no non-self check runs/.test(s)),
      "the predicate must treat ZERO non-self check runs as not-ready (a " +
        "just-force-pushed head with no runs created yet must never merge)",
    ).toBe(true);

    // (d) Conflict guard reads GitHub's COMPUTED mergeable flag off a fresh
    // pulls.get: a `… .mergeable === false` comparison must exist.
    let mergeableGuard = false;
    walk.full(ast, (n) => {
      if (n.type !== "BinaryExpression" || n.operator !== "===") return;
      const sides = [n.left, n.right];
      const refsMergeable = sides.some(
        (s) => s.type === "MemberExpression" && s.property && s.property.name === "mergeable",
      );
      const litFalse = sides.some((s) => s.type === "Literal" && s.value === false);
      if (refsMergeable && litFalse) mergeableGuard = true;
    });
    expect(
      mergeableGuard,
      "the preview-only path must skip on a computed conflict " +
        "(`freshPr.mergeable === false` from a fresh pulls.get)",
    ).toBe(true);

    // (e) Head-moved guard: the vetted head (commit.oid) must be compared
    // against the fresh head (freshPr.head.sha) so a Decap re-save force-push
    // between the bulk query and the merge can never land an unvetted head.
    let headMovedGuard = false;
    walk.full(ast, (n) => {
      if (n.type !== "BinaryExpression" || n.operator !== "!==") return;
      const tails = [n.left, n.right].map(
        (s) => (s.type === "MemberExpression" && s.property && s.property.name) || null,
      );
      if (tails.includes("sha") && tails.includes("oid")) headMovedGuard = true;
    });
    expect(
      headMovedGuard,
      "the preview-only path must re-check the head is UNCHANGED " +
        "(`freshPr.head.sha !== commit.oid`) before merging",
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

  test("caller's required_contexts SET equals repo-settings.yml's consumer-main ruleset", () => {
    // Both sides are PARSED, never regex-scanned: the manifest is YAML and so is
    // the caller, and the contexts sit three levels down inside a `rules` ARRAY
    // that is keyed by `type`, not by position.
    const manifest = parseYaml(fs.readFileSync(MANIFEST_PATH, "utf8")) || {};
    const ruleset = (manifest.ruleset_library || {})[CONSUMER_RULESET];
    expect(
      ruleset,
      `repo-settings.yml must declare ruleset_library.${CONSUMER_RULESET} — it is the ` +
        `authoritative statement of what a consumer's main branch requires, and what ` +
        `scripts/audit-repo-settings.js PUTs live.`,
    ).toBeTruthy();
    const rule = (ruleset.rules || []).find((r) => r && r.type === "required_status_checks");
    expect(
      rule,
      `ruleset_library.${CONSUMER_RULESET} must carry a required_status_checks rule — with ` +
        `none, a consumer's main is gated on nothing and this lock would mean nothing either.`,
    ).toBeTruthy();
    const declared = ((rule.parameters || {}).required_status_checks || []).map((c) =>
      String(c && c.context),
    );
    expect(
      declared.length,
      `ruleset_library.${CONSUMER_RULESET}'s required_status_checks list must be non-empty`,
    ).toBeGreaterThan(0);

    const passed = String((parseYaml(callerText()).jobs.nudge.with || {}).required_contexts || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(
      passed.length,
      "the template caller must pass a non-empty required_contexts block",
    ).toBeGreaterThan(0);

    // SET, not sequence: neither the ruleset body nor the nudge's suffix-tolerant
    // matcher cares about order, so ordering churn must not red this lint.
    // Duplicates would, and should — a repeated context is a hand-edit accident.
    expect(
      [...passed].sort(),
      `the TEMPLATE caller's required_contexts must equal ruleset_library.${CONSUMER_RULESET}'s ` +
        `required_status_checks contexts (as a set) — that is the shape a canonical consumer's ` +
        `main branch actually enforces. An entry here that no run ever reports makes the nudge ` +
        `wait on it forever and silently disables stuck-PR recovery; a MISSING entry lets the ` +
        `nudge merge a PR its branch protection has not cleared. Change repo-settings.yml and ` +
        `this template together.`,
    ).toEqual([...declared].sort());
    expect(
      new Set(passed).size,
      "the template caller's required_contexts must list each context exactly once",
    ).toBe(passed.length);
  });
});
