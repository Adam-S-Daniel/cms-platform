// @lane: local — pure-fs lint for repo-settings-apply.yml (#172 deferral 1).
//
// This is the ONLY workflow in the fleet that holds a credential able to
// rewrite repo settings and rulesets across two owners, so its safety
// properties are asserted rather than assumed. Five of them are traps that
// look fine until the day they matter:
//
//  1. The plan must run UNGATED and the gated apply GATED. An environment gate
//     pauses a job before its first step, so a plan printed inside the gated
//     job is invisible at approval time — the reviewer would approve an unseen
//     diff.
//  2. The plan's token must be mint-time scoped to `administration=read`. That
//     makes the ungated job incapable of writing, rather than trusted not to.
//  3. The gated apply must VERIFY the environment carries a required_reviewers
//     rule. Naming an environment that does not exist does not fail — GitHub
//     creates it implicitly with NO protection rules, silently turning a
//     human-gated apply into an unattended one.
//  4. The two apply lanes must be mutually exclusive, and the UNGATED one must
//     pass `--refuse-weakening` — so a wrong `if:` costs a red job rather than
//     an unattended write that reduced protection.
//  5. The concurrency group must be PER OWNER. A constant group across a
//     two-leg matrix makes the legs cancel each other, non-deterministically,
//     on every run.
//
// PLATFORM-INTERNAL: reads .github/workflows + .github/actions + scripts/,
// absent on a consumer.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const {
  readWorkflow,
  parseYaml,
  runScripts,
} = require("./workflow-yaml-utils");

const WF = "repo-settings-apply.yml";
const ROOT = path.resolve(__dirname, "..");
const MINT = path.join(ROOT, "scripts", "mint-app-token.js");
const CONVERGE = path.join(
  ROOT,
  ".github",
  "actions",
  "repo-settings-converge",
  "action.yml",
);
const GATE_ISSUE = path.join(ROOT, "scripts", "gate-approval-issue.js");

function wfText() {
  return readWorkflow(WF);
}
function wfDoc() {
  return parseYaml(wfText());
}
function convergeText() {
  return fs.readFileSync(CONVERGE, "utf8");
}
function convergeDoc() {
  return parseYaml(convergeText());
}
// The credential-handling shell now lives in the composite action both apply
// lanes call, so a check that reads only the workflow would be reading the
// wrong file and passing vacuously.
function shell() {
  const blocks = [...runScripts(wfText()), ...runScripts(convergeText())].map(
    (r) => r.script,
  );
  // Guard against the "[object Object]" class of vacuous assertion: if the
  // extraction ever returns nothing, every content check below would pass by
  // matching an empty string.
  expect(
    blocks.length,
    "runScripts extracted no shell from " + WF + " + the composite",
  ).toBeGreaterThan(3);
  return blocks.join("\n");
}
function jobShell(job) {
  return (wfDoc().jobs[job].steps || [])
    .map((s) => s.run || "")
    .join("\n");
}

test.describe("repo-settings-apply.yml — the apply-in-CI safety properties", () => {
  test("the GATED apply sits behind the environment and the plan job does NOT", () => {
    const jobs = wfDoc().jobs;
    expect(
      jobs["apply-gated"].environment,
      "apply-gated must sit behind the repo-settings environment",
    ).toBe("repo-settings");
    expect(
      jobs.plan.environment,
      "plan must NOT be gated — a gate pauses the job before its first step, so the plan " +
        "would be invisible to the reviewer at approval time",
    ).toBeUndefined();
    expect(jobs["apply-gated"].needs, "apply-gated must depend on plan").toContain(
      "plan",
    );
    expect(jobs["apply-auto"].needs, "apply-auto must depend on plan").toContain(
      "plan",
    );
  });

  test("exactly ONE apply lane is environment-gated", () => {
    // The ungated lane is safe only because of what it refuses to write (see
    // the --refuse-weakening test below). Gating both would be harmless;
    // gating NEITHER would hand an unattended admin write to every plan.
    const jobs = wfDoc().jobs;
    const gatedLanes = Object.entries(jobs)
      .filter(([name]) => name.startsWith("apply"))
      .filter(([, j]) => j.environment);
    expect(gatedLanes.map(([n]) => n)).toEqual(["apply-gated"]);
  });

  test("the two apply lanes are mutually exclusive on the SAME output", () => {
    // If both could fire, two matrix legs would converge the same owner
    // concurrently; if neither could, a pending plan would silently never
    // apply — the #313 outage's shape, arrived at from the other direction.
    const jobs = wfDoc().jobs;
    const auto = String(jobs["apply-auto"].if || "");
    const gated = String(jobs["apply-gated"].if || "");
    expect(auto).toMatch(/needs\.plan\.outputs\.gate\s*==\s*'false'/);
    expect(gated).toMatch(/needs\.plan\.outputs\.gate\s*==\s*'true'/);
    for (const cond of [auto, gated]) {
      expect(cond).toMatch(/needs\.plan\.outputs\.pending\s*==\s*'true'/);
      expect(cond).toMatch(/needs\.plan\.outputs\.onboarded\s*==\s*'true'/);
    }
    // …and `gate` must actually be an output of the plan job, or both lanes
    // compare against an empty string and only `== 'false'` is ever true.
    expect(
      Object.keys(jobs.plan.outputs || {}),
      "plan must publish the `gate` output both lanes key on",
    ).toContain("gate");
  });

  test("the UNGATED lane refuses weakening writes at WRITE time", () => {
    // The routing `if:` is not the enforcement. This is: the ungated lane
    // re-derives the write-risk verdict from the plan it is about to apply and
    // refuses the whole plan if anything could reduce protection. A wrong `if:`
    // therefore costs a red job, never an unattended weakening write.
    const jobs = wfDoc().jobs;
    const uses = (job) =>
      (jobs[job].steps || []).find((s) =>
        /repo-settings-converge/.test(String(s.uses || "")),
      );
    const auto = uses("apply-auto");
    const gated = uses("apply-gated");
    expect(auto, "apply-auto must call the converge composite").toBeTruthy();
    expect(gated, "apply-gated must call the converge composite").toBeTruthy();
    expect(
      String((auto.with || {})["refuse-weakening"]),
      "the ungated lane must pass refuse-weakening: true",
    ).toBe("true");
    expect(
      String((gated.with || {})["refuse-weakening"] ?? "false"),
      "the gated lane must NOT refuse weakening — a human is what authorises it",
    ).toBe("false");
    // And the flag must reach the script, not just the action's inputs.
    expect(
      /--refuse-weakening/.test(convergeText()),
      "the composite must forward refuse-weakening to audit-repo-settings.js",
    ).toBe(true);
  });

  test("the plan mints a READ-scoped token and the apply a WRITE-scoped one", () => {
    const src = shell();
    expect(
      /--permissions administration=read\b/.test(src),
      "the plan must mint administration=read so the ungated job cannot write",
    ).toBe(true);
    expect(
      /--permissions administration=write\b/.test(src),
      "the apply must mint administration=write",
    ).toBe(true);
    // The write scope must appear ONLY in the composite the apply lanes call —
    // never in a step of the ungated plan job.
    expect(
      /administration=write/.test(jobShell("plan")),
      "the UNGATED plan job must never mint a write-scoped token",
    ).toBe(false);
    expect(/administration=write/.test(convergeText())).toBe(true);
  });

  test("the gated apply refuses to run if the environment has no required reviewer", () => {
    // NB: do NOT assert merely that "required_reviewers" appears somewhere. The
    // step's own error message contains that word, so a bare substring check
    // passes even with the guard neutered — verified by neutering it. Pin the
    // GUARD (the case pattern) and the refusal (exit 1), not the prose.
    // ONE parse: `parseYaml` returns a fresh object per call, so a `verify`
    // taken from a second parse is never identity-equal to a member of the
    // first one's step list — and `indexOf` would silently return -1.
    const steps = wfDoc().jobs["apply-gated"].steps || [];
    const verify = steps.find((s) =>
      /environments\/repo-settings/.test(String(s.run || "")),
    );
    expect(verify, "no step in apply-gated queries the environment").toBeTruthy();
    expect(
      /\*,required_reviewers,\*\)/.test(String(verify.run)),
      "the guard must MATCH on required_reviewers — an undeclared environment is auto-created " +
        "with no protection rules, so reaching this step proves nothing on its own",
    ).toBe(true);
    expect(
      /exit 1/.test(String(verify.run)),
      "the gate-missing branch must exit non-zero, not merely warn",
    ).toBe(true);
    // It must run BEFORE the converge step, or the write happens either way.
    const iVerify = steps.indexOf(verify);
    const iApply = steps.findIndex((s) =>
      /repo-settings-converge/.test(String(s.uses || "")),
    );
    expect(iVerify).toBeGreaterThanOrEqual(0);
    expect(iApply).toBeGreaterThan(iVerify);
  });

  // #313, then its sequel. This test asserted a WORKFLOW-level group with
  // `cancel-in-progress: false` until 2026-08-27; that shape produced an
  // eleven-day silent outage (a run parked at the un-approved gate held the
  // group from 2026-08-17 to 2026-08-27, and because `false` retains only the
  // LATEST pending run, runs #10-#21 were each cancelled with ZERO jobs).
  //
  // The fix moved the group onto `apply` — but left it a CONSTANT, and `apply`
  // is a two-leg matrix, so both legs shared one group and one killed the
  // other within a second, on every run, with the winner chosen
  // non-deterministically. MEASURED over runs 33123351877, 33259840589,
  // 33318291358 and 33420951576: two killed the `jodidaniel` leg, two killed
  // the `Adam-S-Daniel` leg, and the only real drift in the fleet (#310) sat
  // unapplied for five days while a human approved every day. Hence: per
  // owner, on both lanes.
  test("the concurrency group is PER OWNER, on the writing jobs, never on the workflow", () => {
    const doc = wfDoc();
    expect(
      doc.concurrency,
      "a workflow-level group makes a gate-parked run wedge every later run " +
        "before it can allocate a single job (#313) — the group belongs on the apply lanes",
    ).toBeUndefined();
    expect(
      doc.jobs.plan.concurrency,
      "`plan` is read-only and must never queue: un-grouping it is what makes a " +
        "wedged gate visible instead of silent",
    ).toBeUndefined();
    for (const lane of ["apply-auto", "apply-gated"]) {
      const c = doc.jobs[lane].concurrency;
      expect(c, `${lane} must be serialized — it is a job that writes`).toBeTruthy();
      expect(
        String(c.group),
        `${lane}'s group must interpolate matrix.owner, or the two matrix legs ` +
          "land in ONE group and cancel each other on every run",
      ).toMatch(/\$\{\{\s*matrix\.owner\s*\}\}/);
      expect(
        c["cancel-in-progress"],
        "newest-wins: what this cancels is a same-owner job that has written nothing, " +
          "and superseding it is the point — the newer run planned against newer `main`",
      ).toBe(true);
    }
    // A group shared across owners would re-create the bug under a new name.
    const groups = ["apply-auto", "apply-gated"].map((l) =>
      String(doc.jobs[l].concurrency.group),
    );
    expect(new Set(groups).size, "both lanes converge the same owners, so they share one group per owner").toBe(1);
  });

  // General form of the trap above: hardcoding `apply-auto`/`apply-gated` and
  // `matrix.owner` (the test above) proves THOSE two jobs are safe today but
  // says nothing about a THIRD job added later with its own matrix — exactly
  // the shape that let a static group ship unnoticed the first time. This
  // derives the dimension names from each job's OWN `strategy.matrix` (an
  // `include:` list's dimensions are the keys of its entries; a classic
  // `matrix: { axis: [...] }` block's are its own top-level keys other than
  // `include`) rather than hardcoding `owner`, so the guard still fires if the
  // matrix is ever reshaped — a `probe`-keyed group, or `owner` renamed to
  // `installation`, would still have to interpolate SOME axis of its own.
  test("REGRESSION GUARD: no matrix job's concurrency group can omit its own matrix axis", () => {
    const jobs = wfDoc().jobs;
    let checked = 0;
    for (const [name, job] of Object.entries(jobs)) {
      if (!job.strategy || !job.strategy.matrix || !job.concurrency) continue;
      checked += 1;
      const matrix = job.strategy.matrix;
      const dimensions = new Set();
      if (Array.isArray(matrix.include)) {
        for (const entry of matrix.include) {
          for (const key of Object.keys(entry || {})) dimensions.add(key);
        }
      }
      for (const key of Object.keys(matrix)) {
        if (key !== "include") dimensions.add(key);
      }
      expect(
        dimensions.size,
        `job "${name}" declares strategy.matrix but no dimension name could be derived from it`,
      ).toBeGreaterThan(0);
      const group = String(job.concurrency.group || "");
      const interpolatesOwnAxis = [...dimensions].some((dim) =>
        new RegExp(`\\$\\{\\{\\s*matrix\\.${dim}\\s*\\}\\}`).test(group),
      );
      expect(
        interpolatesOwnAxis,
        `job "${name}" has both a matrix and a concurrency group ("${group}") that interpolates ` +
          `none of its own matrix dimensions (${[...dimensions].join(", ")}) — a STATIC group on a ` +
          "MATRIX job admits exactly one leg per run and cancels the rest with no runner allocated, " +
          "so the matrix silently collapses to one leg (header note 4's second outage).",
      ).toBe(true);
    }
    // A vacuous pass (nothing in the workflow has both a matrix and a group)
    // would make every assertion above true by never running — this file
    // currently has two such jobs, and the guard is worthless if that count
    // ever drops to zero without anyone noticing.
    expect(
      checked,
      "no job with BOTH strategy.matrix and concurrency was found — this test would pass vacuously",
    ).toBeGreaterThan(0);
  });

  test("a human who IS needed gets told, and untold when the gate resolves", () => {
    // An `environment:` gate is invisible unless you are watching the Actions
    // tab — #313 sat unapproved for ten days partly for that reason.
    const doc = wfDoc();
    const planShell = jobShell("plan");
    expect(
      /gate-approval-issue\.js open/.test(planShell),
      "the plan job must OPEN an approval issue when the plan needs a human",
    ).toBe(true);
    expect(
      /gate-approval-issue\.js close/.test(planShell),
      "the plan job must also CLOSE a stale one — that reconcile is what makes a " +
        "cleanup job lost to a cancelled run self-heal instead of lying",
    ).toBe(true);
    const closer = doc.jobs["close-approval-issue"];
    expect(closer, "a job must close the issue when the gate resolves").toBeTruthy();
    expect(closer.needs).toContain("apply-gated");
    expect(
      /always\(\)/.test(String(closer.if || "")),
      "it must run on rejection and cancellation too — an issue that outlives its " +
        "question is the failure mode this lane exists to avoid",
    ).toBe(true);
    expect(
      /--run-id/.test(jobShell("close-approval-issue")),
      "the close must name THIS run, so a superseded run cannot retract the live request",
    ).toBe(true);
    expect(fs.existsSync(GATE_ISSUE)).toBe(true);
  });

  test("issues:write is granted per job, never at workflow level", () => {
    // Least privilege, and the reason note 2 still holds: `github.token` with
    // issues:write cannot touch repo settings, but there is no reason for the
    // apply lanes to hold it at all.
    const doc = wfDoc();
    expect(doc.permissions).toEqual({ contents: "read" });
    for (const lane of ["apply-auto", "apply-gated"]) {
      expect(
        (doc.jobs[lane].permissions || {}).issues,
        `${lane} has no issue to write`,
      ).toBeUndefined();
    }
    for (const j of ["plan", "close-approval-issue"]) {
      expect((doc.jobs[j].permissions || {}).issues).toBe("write");
    }
  });

  test("the plan refuses to guess when the classifier verdict is unreadable", () => {
    // Defaulting a missing verdict to "no human needed" would route an
    // unclassified plan to the ungated lane. Fail loud instead.
    const planShell = jobShell("plan");
    expect(/repo-settings-plan: /.test(planShell)).toBe(true);
    expect(
      /if \[ -z "\$gated" \]; then\n\s*echo "::error::/.test(planShell),
      "an absent verdict must be an ::error:: + non-zero exit, not a default",
    ).toBe(true);
  });

  test("the plan VERDICT LINE and the workflow's parser agree", () => {
    // A one-line contract spanning two files and two languages: the script
    // prints it, the shell greps and seds it, and nothing else connects them.
    // Break either side and the plan job hard-fails on every run (by design —
    // see the test above — but for a reason nobody would guess). Assert both
    // sides against the same literal.
    const EXAMPLE = "repo-settings-plan: writes=3 safe=2 gated=1 unfixable=0";
    const audit = fs.readFileSync(
      path.join(ROOT, "scripts", "audit-repo-settings.js"),
      "utf8",
    );
    expect(
      /repo-settings-plan: writes=\$\{[^}]+\} safe=\$\{[^}]+\} `\s*\+\s*`gated=\$\{[^}]+\} unfixable=\$\{[^}]+\}/.test(
        audit.replace(/\n\s*/g, " "),
      ),
      "audit-repo-settings.js must emit the verdict line in the shape the workflow parses",
    ).toBe(true);

    const planShell = jobShell("plan");
    const grepPat = /grep -m1 '(\^[^']+)'/.exec(planShell);
    expect(grepPat, "the plan job must grep the verdict line").toBeTruthy();
    expect(new RegExp(grepPat[1]).test(EXAMPLE)).toBe(true);

    // Re-implement the sed the workflow runs, rather than trusting it by eye.
    const gated = /.*gated=([0-9][0-9]*).*/.exec(EXAMPLE);
    expect(gated && gated[1], "the workflow's sed must extract gated=N").toBe("1");
    expect(
      planShell.includes("s/.*gated=\\([0-9][0-9]*\\).*/\\1/p"),
      "the extraction must key on `gated=`, not on field position — the line's " +
        "other counts are informational and may be reordered",
    ).toBe(true);
  });

  test("it fails SOFT when un-onboarded, naming every required knob", () => {
    const src = shell() + fs.readFileSync(MINT, "utf8");
    for (const knob of [
      "REPO_SETTINGS_APP_CLIENT_ID",
      "REPO_SETTINGS_APP_PRIVATE_KEY",
      "repo-settings",
    ]) {
      expect(
        src.includes(knob),
        `the un-onboarded notice must name ${knob}`,
      ).toBe(true);
    }
    // The presence check must be a run-step output, not a step-level `if:` on
    // secrets.* — the expression evaluator forbids that and startup-fails.
    const steps = wfDoc().jobs.plan.steps || [];
    for (const s of steps) {
      expect(
        /secrets\./.test(String(s.if || "")),
        `step ${JSON.stringify(s.name)} uses secrets.* in a step-level if:, which startup-fails`,
      ).toBe(false);
    }
  });

  test("the converge composite is the ONLY place the write path is spelled out", () => {
    // Two lanes running near-identical credential shell in two places is how
    // "they drifted" becomes a question nobody remembers to ask.
    const doc = convergeDoc();
    expect(doc.runs.using).toBe("composite");
    const wf = wfText();
    expect(
      (wf.match(/audit-repo-settings\.js --fix --yes/g) || []).length,
      "the applying command must not be duplicated into the workflow",
    ).toBe(0);
    expect(
      (convergeText().match(/audit-repo-settings\.js --fix --yes/g) || []).length,
    ).toBe(1);
  });

  test("mint-app-token scopes DOWN only, and never logs a response body", () => {
    const src = fs.readFileSync(MINT, "utf8");
    expect(/\bpermissions\b/.test(src)).toBe(true);
    expect(
      /::add-mask::/.test(src),
      "the minted token must be masked before it reaches any other surface",
    ).toBe(true);
    // The data-exposure rule: an error may carry status + method + url, never
    // the body (it can quote data into a public log).
    expect(
      /res\.(json|text)\(\)[^\n]*\berror|throw new Error\([^)]*await res/.test(
        src,
      ),
      "the error path must not interpolate the response body",
    ).toBe(false);
  });

  test("the approval issue never echoes an API response body", () => {
    // Same public-log rule, on the new writer. It posts into a PUBLIC repo.
    const src = fs.readFileSync(GATE_ISSUE, "utf8");
    expect(
      /e\.stdout|JSON\.stringify\(e\)|\$\{e\.stderr\}/.test(src),
      "an error path must not interpolate a gh response body into the issue or the log",
    ).toBe(false);
    expect(
      /HTTP \(\\d\{3\}\)/.test(src),
      "the error path should reduce a failure to its status code",
    ).toBe(true);
  });
});
