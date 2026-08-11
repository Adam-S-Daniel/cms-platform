// @lane: local — pure-fs lint for repo-settings-apply.yml (#172 deferral 1).
//
// This is the ONLY workflow in the fleet that holds a credential able to
// rewrite repo settings and rulesets across two owners, so its safety
// properties are asserted rather than assumed. Three of them are traps that
// look fine until the day they matter:
//
//  1. The plan must run UNGATED and the apply GATED. An environment gate pauses
//     a job before its first step, so a plan printed inside the gated job is
//     invisible at approval time — the reviewer would approve an unseen diff.
//  2. The plan's token must be mint-time scoped to `administration=read`. That
//     makes the ungated job incapable of writing, rather than trusted not to.
//  3. The apply must VERIFY the environment carries a required_reviewers rule.
//     Naming an environment that does not exist does not fail — GitHub creates
//     it implicitly with NO protection rules, silently turning a human-gated
//     apply into an unattended one.
//
// PLATFORM-INTERNAL: reads .github/workflows + scripts/, absent on a consumer.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { readWorkflow, parseYaml, runScripts } = require("./workflow-yaml-utils");

const WF = "repo-settings-apply.yml";
const MINT = path.resolve(__dirname, "..", "scripts", "mint-app-token.js");

function wfText() {
  return readWorkflow(WF);
}
function wfDoc() {
  return parseYaml(wfText());
}
function shell() {
  const blocks = runScripts(wfText()).map((r) => r.script);
  // Guard against the "[object Object]" class of vacuous assertion: if the
  // extraction ever returns nothing, every content check below would pass by
  // matching an empty string.
  expect(blocks.length, "runScripts extracted no shell from " + WF).toBeGreaterThan(3);
  return blocks.join("\n");
}

test.describe("repo-settings-apply.yml — the apply-in-CI safety properties", () => {
  test("the apply job is environment-gated and the plan job is NOT", () => {
    const jobs = wfDoc().jobs;
    expect(jobs.apply.environment, "apply must sit behind the repo-settings environment").toBe(
      "repo-settings",
    );
    expect(
      jobs.plan.environment,
      "plan must NOT be gated — a gate pauses the job before its first step, so the plan " +
        "would be invisible to the reviewer at approval time",
    ).toBeUndefined();
    expect(jobs.apply.needs, "apply must depend on plan").toContain("plan");
  });

  test("apply only runs when the plan found pending changes", () => {
    // Otherwise every scheduled no-op run pings a human for approval, and the
    // gate degrades into noise people click through.
    const cond = String(wfDoc().jobs.apply.if || "");
    expect(cond).toMatch(/needs\.plan\.outputs\.pending\s*==\s*'true'/);
    expect(cond).toMatch(/needs\.plan\.outputs\.onboarded\s*==\s*'true'/);
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
    // The write scope must appear ONLY in the gated job.
    const jobs = wfDoc().jobs;
    const jobShell = (j) =>
      (jobs[j].steps || [])
        .map((s) => s.run || "")
        .join("\n");
    expect(
      /administration=write/.test(jobShell("plan")),
      "the UNGATED plan job must never mint a write-scoped token",
    ).toBe(false);
    expect(/administration=write/.test(jobShell("apply"))).toBe(true);
  });

  test("the apply refuses to run if the environment has no required reviewer", () => {
    // NB: do NOT assert merely that "required_reviewers" appears somewhere. The
    // step's own error message contains that word, so a bare substring check
    // passes even with the guard neutered — verified by neutering it. Pin the
    // GUARD (the case pattern) and the refusal (exit 1), not the prose.
    const src = shell();
    expect(
      /environments\/repo-settings/.test(src),
      "the verification must query the repo-settings environment itself",
    ).toBe(true);
    expect(
      /\*,required_reviewers,\*\)/.test(src),
      "the guard must MATCH on required_reviewers — an undeclared environment is auto-created " +
        "with no protection rules, so reaching this step proves nothing on its own",
    ).toBe(true);
    // And the non-matching branch must actually refuse, not just warn.
    const verify = (wfDoc().jobs.apply.steps || []).find((s) =>
      /environments\/repo-settings/.test(String(s.run || "")),
    );
    expect(verify, "no step queries the environment").toBeTruthy();
    expect(
      /exit 1/.test(String(verify.run)),
      "the gate-missing branch must exit non-zero, not merely warn",
    ).toBe(true);
  });

  test("apply is serialized and never cancelled mid-write", () => {
    const c = wfDoc().concurrency;
    expect(c.group).toBe("repo-settings-apply");
    expect(
      c["cancel-in-progress"],
      "a cancelled half-apply leaves settings partly converged (the v0.1.27 lesson)",
    ).toBe(false);
  });

  test("it fails SOFT when un-onboarded, naming every required knob", () => {
    const src = shell() + fs.readFileSync(MINT, "utf8");
    for (const knob of ["REPO_SETTINGS_APP_ID", "REPO_SETTINGS_APP_PRIVATE_KEY", "repo-settings"]) {
      expect(src.includes(knob), `the un-onboarded notice must name ${knob}`).toBe(true);
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
      /res\.(json|text)\(\)[^\n]*\berror|throw new Error\([^)]*await res/.test(src),
      "the error path must not interpolate the response body",
    ).toBe(false);
  });
});
