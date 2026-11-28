// @lane: local — pure-fs lint of the cms-editorial-workflow workflow YAML
/*
 * Regression test: cms-editorial-workflow must enable GitHub's
 * native auto-merge (queue-based, respects required checks) — never
 * an unconditional `gh pr merge --merge` / `--squash` that would
 * bypass the required-checks list. (Audit finding #26.)
 */
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, allStrings } = require("./workflow-yaml-utils");

// Every script / expression / github-script body the workflow carries,
// joined. Reading these off the parsed tree (rather than grepping the
// raw file) means YAML comments are already gone and an aliased value
// is still seen. Shell `#` comments inside a run: block are stripped
// separately where they'd otherwise read as live commands.
function scripts(yaml) {
  return allStrings(parseYaml(yaml)).join("\n");
}

function stripShellComments(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

test("no unconditional `gh pr merge --merge|--squash` (without --auto)", () => {
  const code = stripShellComments(scripts(readWorkflow("cms-editorial-workflow.yml")));
  // Each `gh pr merge ...` call ends at the next newline / pipe / &&.
  const re = /gh\s+pr\s+merge\b([^\n;|&]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const flags = m[1];
    if (/--disable-auto/.test(flags)) continue; // disable-auto is fine
    expect(flags, `Found: 'gh pr merge${flags}'`).toMatch(/--auto\b/);
  }
});

test("enablePullRequestAutoMerge GraphQL mutation IS used", () => {
  expect(scripts(readWorkflow("cms-editorial-workflow.yml"))).toMatch(
    /enablePullRequestAutoMerge\b/,
  );
});

test("clean-status fallback lands an already-mergeable PR with a conditional direct squash merge (#80 layer 9 / #85)", () => {
  // When enablePullRequestAutoMerge fails with "Pull request is in clean
  // status" — every required check already passed, so there is nothing to
  // enqueue — the job must land the PR directly (a squash merge, gated on
  // that error string) instead of throwing. Branch protection still enforces
  // the required checks at merge time, so this can only land a green PR.
  const code = scripts(readWorkflow("cms-editorial-workflow.yml"));
  expect(code).toMatch(/clean status/i);
  expect(code).toMatch(/pulls\.merge/);
  expect(code).toMatch(/merge_method:\s*['"]squash['"]/);
});

test("unstable-status fallback polls per-check readiness (self-excluding) and lands it with a squash merge (PR #2466 run 28758624761; PR #2469 run 28761800674)", () => {
  // "Pull request is in unstable status" is the SIBLING error to "clean
  // status" above — both stem from the same root cause: a PR whose base
  // isn't `main` (cms/preview-only) has no required-status-check
  // protection rules on that base, so GitHub's auto-merge "wait for
  // checks" has nothing well-defined to arm against and
  // enablePullRequestAutoMerge always errors. Empirical: PR #2466 (base
  // `audit/preview-exercise`, all content checks already green) hit this
  // exact error in run 28758624761. Because this job fires ONLY on the
  // `labeled` event and nothing re-triggers it afterward, the fallback
  // must poll and land the PR itself with a squash merge.
  //
  // The readiness test must be PER-CHECK and SELF-EXCLUDING — NOT
  // `mergeable_state === 'clean'`, which the first (v0.1.52) version
  // gated on and which SELF-DEADLOCKS: this job is itself a check run
  // on the PR's head sha and stays in_progress for the entire poll, so
  // the rollup can never leave "unstable" while the job watches it.
  // Empirical: PR #2469 / run 28761800674 — every other check run on
  // head 46bc047 completed by 01:19:35, yet the poll gave up at
  // 01:29:36 and its own check run completed at 01:29:38. The fallback
  // must therefore: list the head sha's check runs, exclude its own
  // job class (by name + run id — a queued SIBLING auto-merge-when-ready
  // run shares the per-PR concurrency lane and can never complete while
  // this one holds it), consult the combined commit status (deploy-
  // preview.yml posts a real `deploy/preview` status; an EMPTY status
  // set reads state:"pending" and must count as OK), and require
  // `mergeable !== false` from a fresh pulls.get (never the stale
  // webhook payload).
  const code = scripts(readWorkflow("cms-editorial-workflow.yml"));
  expect(code).toMatch(/unstable status/i);
  expect(code).toMatch(/pulls\.get/);
  // Per-check readiness, not rollup: list check runs on the head sha…
  expect(code).toMatch(/checks\.listForRef/);
  // …excluding this job's own class by name AND by own-run-id URL.
  expect(code).toMatch(/auto-merge-when-ready.*\.test\(|isOwnJobClass/);
  expect(code).toMatch(/context\.runId/);
  // Legacy commit statuses consulted, with empty-set treated as OK.
  expect(code).toMatch(/getCombinedStatusForRef/);
  expect(code).toMatch(/total_count\s*===\s*0/);
  // Conflict guard reads GitHub's computed flag off the fresh GET.
  expect(code).toMatch(/mergeable\s*(?:===|!==)\s*false/);
  // The old self-deadlocking rollup gate must NOT come back as the
  // readiness condition (a `mergeable_state === 'clean'` comparison).
  expect(code).not.toMatch(/mergeable_state\s*===\s*['"]clean['"]/);
  expect(code).toMatch(/pulls\.merge/);
  expect(code).toMatch(/merge_method:\s*['"]squash['"]/);
});

test("enablePullRequestAutoMerge retries a transient 5xx with backoff and rethrows anything else (cms-platform#1130)", () => {
  // A `503 no healthy upstream` on the enable call used to fail the run and
  // strand the publish PR until the throttled nudge. The call is retried a
  // bounded number of times, only for a gateway-style error; every other
  // error still reaches the existing already-merged / clean / unstable
  // handling.
  const code = scripts(readWorkflow("cms-editorial-workflow.yml"));
  expect(code).toMatch(/ENABLE_ATTEMPTS\s*=\s*4/);
  expect(code).toMatch(/TRANSIENT_5XX\s*=.*no healthy upstream/);
  expect(code).toMatch(/attempt >= ENABLE_ATTEMPTS \|\| !TRANSIENT_5XX\.test\(retryMsg\)\) throw retryErr/);
  expect(code).toMatch(/setTimeout\(resolve, 5000 \* attempt\)/);
});

// ── Re-arm when GitHub disables auto-merge (cms-platform#1130 item 2) ──────
// Parsed, not grepped: the job's `if:` and the site caller's `types:` come off
// the YAML tree, and the guard's shape comes off an acorn AST of the script.
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");

function autoMergeJob() {
  return parseYaml(readWorkflow("cms-editorial-workflow.yml")).jobs["auto-merge-when-ready"];
}

function autoMergeScriptAst() {
  const step = autoMergeJob().steps.find((s) => s.with && typeof s.with.script === "string");
  const src = `(async function () {\n${step.with.script}\n})`;
  return { src, ast: acorn.parse(src, { ecmaVersion: "latest" }) };
}

function isActionCheck(node) {
  return (
    node.type === "BinaryExpression" &&
    node.operator === "===" &&
    node.right.type === "Literal" &&
    node.right.value === "auto_merge_disabled"
  );
}

test("auto-merge-when-ready also runs on auto_merge_disabled while a ready label is on the PR", () => {
  const cond = autoMergeJob().if;
  expect(cond).toMatch(/github\.event\.action == 'auto_merge_disabled'/);
  expect(cond).toMatch(/github\.event\.pull_request\.state == 'open'/);
  for (const label of ["cms/ready", "decap-cms/ready", "decap-cms/pending_publish"]) {
    expect(cond).toContain(`contains(github.event.pull_request.labels.*.name, '${label}')`);
  }
});

test("the example site caller triggers the editorial workflow on auto_merge_disabled", () => {
  const caller = parseYaml(
    fs.readFileSync(
      path.resolve(__dirname, "..", "examples", "site", ".github", "workflows", "cms-editorial-workflow.yml"),
      "utf8",
    ),
  );
  expect(caller.on.pull_request.types).toEqual(
    expect.arrayContaining(["opened", "synchronize", "labeled", "auto_merge_disabled"]),
  );
});

test("the re-arm guard runs before the enable call, skips a reasonless disable, is capped, and never fails the run", () => {
  const { src, ast } = autoMergeScriptAst();
  let guard = null;
  walk.simple(ast, {
    IfStatement(node) {
      if (!guard && isActionCheck(node.test)) guard = node;
    },
  });
  expect(guard, "no `if (… === 'auto_merge_disabled')` guard in the script").not.toBeNull();

  const enableAt = src.indexOf("enablePullRequestAutoMerge(input");
  expect(enableAt).toBeGreaterThan(-1);
  expect(guard.end).toBeLessThan(enableAt);

  let cap = null;
  let reasonlessReturn = false;
  let failsRun = false;
  walk.full(guard.consequent, (node) => {
    if (node.type === "VariableDeclarator" && node.id.name === "MAX_REARMS") cap = node.init.value;
    if (
      node.type === "IfStatement" &&
      node.test.type === "UnaryExpression" &&
      node.test.operator === "!" &&
      node.test.argument.type === "Identifier" &&
      node.test.argument.name === "reason"
    ) {
      walk.simple(node.consequent, { ReturnStatement() { reasonlessReturn = true; } });
    }
    if (node.type === "ThrowStatement") failsRun = true;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property.name === "setFailed"
    ) {
      failsRun = true;
    }
  });
  expect(cap).toBe(3);
  expect(reasonlessReturn).toBe(true);
  expect(failsRun).toBe(false);
});
