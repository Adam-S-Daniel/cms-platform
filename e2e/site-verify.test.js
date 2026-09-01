// @lane: local — pure-fs lint over two workflow files plus two bash scripts
// lifted out of them and executed in scratch dirs. No browser, no network, no
// build. Runs in self-ci.yml's node-unit-lints lane (picked up by exclusion).
//
// THE GAP (#377): a consumer's OWN post-build verifier ran nowhere.
// jodidaniel.com's `scripts/verify-build-artifacts.rb` asserts ~190 things
// about the BUILT site — media links resolve, the category triangle agrees,
// the admin seam's anchors match built section ids, no PDF bytes are
// committed, the `pdf_public` gate withholds and publishes — and its docs cite
// it in six places as the guard for those. No workflow invoked it, so the
// `pdf_public: true`-with-no-file case its own table calls "better a loud red
// than a 'Download PDF' button that 404s" shipped to production. The consumer
// cannot own the workflow (workflow-SET parity flags any caller absent from
// examples/site as EXTRA on a required check), so it is a platform seam:
// `.github/workflows/site-verify.yml` (reusable) + the dictated thin caller
// `examples/site/.github/workflows/site-verify.yml`.
//
// WHAT THIS FILE PROVES
//   - the reusable is `workflow_call`-only with NO inputs and NO secrets —
//     convention, not configuration: a fixed script path, nothing to misset;
//   - the WORK/GATE split holds against every cause
//     required-context-cancellable-utils.js can see: the gate `needs:` the
//     work job, says `always()`, and carries no wall and no group anywhere;
//   - the two scripts BEHAVE: the detect step writes `verifier=false` + a
//     notice when the script is absent and `verifier=true` when present, and
//     the gate exits 0 only on `success` — executed, not pattern-matched;
//   - the build is the deploy's build: same Ruby as deploy-preview's default,
//     same `JEKYLL_ENV` as deploy-production, same action pins;
//   - the caller publishes exactly `site-verify / site-verify`, on the same
//     `pull_request` types every other required-context caller uses, with NO
//     path filter (the verifier sweeps the whole tree, so every path is
//     salient — and a filter would set up the missing-check trap the moment
//     the context becomes required).
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: it reads this repo's
// own workflow definitions and the examples/site templates, which a consumer
// does not ship. The CONSUMER-side coverage of the pair a site actually
// carries is consumer-required-context-cancellable.test.js, once the context
// is required there.
//
// Parses YAML through workflow-yaml-utils — never a line scan (house rule).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, readWorkflow, listWorkflows, events } = require("./workflow-yaml-utils");
const {
  cancellationHazards,
  reusableBasename,
  requiredContexts,
} = require("./required-context-cancellable-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const REUSABLE = "site-verify.yml";
const CALLER_PATH = path.join(REPO_ROOT, "examples", "site", ".github", "workflows", REUSABLE);
const E2E_CALLER_PATH = path.join(REPO_ROOT, "examples", "site", ".github", "workflows", "e2e-tests.yml");
const MANIFEST_PATH = path.join(REPO_ROOT, "repo-settings.yml");

// The convention the reusable keys on. One path, fixed, so there is no input.
const VERIFIER_PATH = "scripts/verify-build-artifacts.rb";
const WORK_JOB = "verify";
const GATE_JOB = "site-verify";
const CALLER_JOB = "site-verify";
const CONTEXT = `${CALLER_JOB} / ${GATE_JOB}`;

const reusable = () => parseYaml(readWorkflow(REUSABLE)) || {};
const caller = () => parseYaml(fs.readFileSync(CALLER_PATH, "utf8")) || {};
const workSteps = () => ((reusable().jobs || {})[WORK_JOB] || {}).steps || [];
const stepRun = (s) => String((s && s.run) || "");

const findStep = (steps, pred, what) => {
  const s = steps.find(pred);
  expect(s, `the ${WORK_JOB} job must carry ${what}`).toBeTruthy();
  return s;
};
const isCheckout = (s) => /^actions\/checkout@/.test(String(s.uses || ""));
const isDetect = (s) => s.id === "detect";
const isSetupRuby = (s) => /^ruby\/setup-ruby@/.test(String(s.uses || ""));
const isBuild = (s) => /\bjekyll build\b/.test(stepRun(s));
const isRunVerifier = (s) => stepRun(s).includes(`ruby ${VERIFIER_PATH}`);

// Every scratch dir this file makes, reaped in afterAll — this runs in the
// REQUIRED lane on every developer machine and CI runner, forever.
const SCRATCH_DIRS = [];
test.afterAll(() => {
  for (const dir of SCRATCH_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-verify-"));
  SCRATCH_DIRS.push(dir);
  return dir;
}

// Run a step's `run:` script under bash exactly as the runner would (the
// script's own `set -euo pipefail` is inside it), in `cwd`, with `env` on top
// of a minimal environment. Returns { status, stdout }.
function runScript(script, { cwd, env }) {
  const r = spawnSync("bash", ["-c", script], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  return { status: r.status, stdout: `${r.stdout || ""}${r.stderr || ""}` };
}

test.describe("#377 site-verify — the reusable's contract", () => {
  test("exists, is workflow_call-only, and takes NO inputs and NO secrets", () => {
    expect(
      listWorkflows().map((f) => path.basename(f)),
      "the reusable must exist — the consumer cannot own this workflow (workflow-SET parity)",
    ).toContain(REUSABLE);
    const on = reusable().on || {};
    expect(Object.keys(on), "a reusable: the caller owns trigger and run-name").toEqual([
      "workflow_call",
    ]);
    const call = on.workflow_call || {};
    expect(
      call.inputs,
      "convention, not configuration — the verifier lives at ONE path by convention, so there " +
        "is no input a consumer can misconfigure. adamdaniel.ai has none and no-ops; " +
        "jodidaniel.com has one and runs it",
    ).toBeUndefined();
    expect(call.secrets, "and it needs no credential of any kind").toBeUndefined();
    expect(reusable().permissions, "read-only: it builds and reads, never writes").toEqual({
      contents: "read",
    });
  });

  test("is a WORK job plus a GATE job, and nothing else", () => {
    expect(Object.keys(reusable().jobs || {}).sort()).toEqual([GATE_JOB, WORK_JOB].sort());
    const work = reusable().jobs[WORK_JOB];
    expect(
      typeof work["timeout-minutes"],
      "the work job is where the wall lives — its conclusion is required by nothing, so a " +
        "runaway build is bounded there",
    ).toBe("number");
    expect(work.needs, "the work job depends on nothing").toBeUndefined();
    expect(
      work.permissions,
      "no job-level permissions: the top-level `contents: read` is the whole grant",
    ).toBeUndefined();
  });

  test("the gate is clean against EVERY cancellation cause the guard can see", () => {
    const reusableDoc = reusable();
    const callerDoc = caller();
    const gate = reusableDoc.jobs[GATE_JOB];
    expect(gate.needs, "the gate translates the work job's result and nothing else").toBe(
      WORK_JOB,
    );
    const hazards = cancellationHazards({
      callerDoc,
      callerJob: (callerDoc.jobs || {})[CALLER_JOB],
      reusableDoc,
      reusableJob: gate,
    });
    expect(
      hazards.map((h) => `${h.where}: ${h.what}`),
      "a required context that can end `cancelled` is an unblockable merge block (#285/#289): " +
        "no `concurrency` at any of the four sites, no `timeout-minutes` on the gate, " +
        "`if: always()` beside its `needs:`",
    ).toEqual([]);
    // The gate must publish a real red on a non-success, never a skip: the
    // `always()` above is what keeps it from being skipped, and this is what
    // makes the un-skipped run go red.
    const run = (gate.steps || []).map(stepRun).join("\n");
    expect(run, "the gate reads the work job's result").toContain("VERIFY_RESULT");
    expect(
      (gate.steps || []).some((s) => s.env && String(s.env.VERIFY_RESULT || "").includes(`needs.${WORK_JOB}.result`)),
      "and that result arrives through env from `needs.verify.result`",
    ).toBe(true);
  });

  test("the gate script BEHAVES: exit 0 only on success (executed, not grepped)", () => {
    const gate = reusable().jobs[GATE_JOB];
    const script = stepRun((gate.steps || []).find((s) => s.run));
    expect(script).toBeTruthy();
    const cwd = scratch();
    expect(runScript(script, { cwd, env: { VERIFY_RESULT: "success" } }).status).toBe(0);
    for (const bad of ["failure", "cancelled", "skipped", ""]) {
      const r = runScript(script, { cwd, env: { VERIFY_RESULT: bad } });
      expect(
        r.status,
        `a work-job result of ${JSON.stringify(bad)} must red the gate — a gate that passes ` +
          `on a skipped or cancelled work job is a green light wired to nothing`,
      ).toBe(1);
      expect(r.stdout, "with a ::error:: annotation so the failure is visible on the PR").toContain(
        "::error::",
      );
    }
  });

  test("the work job's steps are checkout → detect → (setup-ruby → build → verifier), in that order", () => {
    const steps = workSteps();
    const checkout = findStep(steps, isCheckout, "a checkout of the CALLER's tree");
    expect(
      checkout.with,
      "the checkout names no `repository:` — the tree under test is the caller's own",
    ).toBeUndefined();
    const detect = findStep(steps, isDetect, "a step with id `detect`");
    const ruby = findStep(steps, isSetupRuby, "a ruby/setup-ruby step");
    const build = findStep(steps, isBuild, "a `jekyll build` step");
    const verifier = findStep(steps, isRunVerifier, `a \`ruby ${VERIFIER_PATH}\` step`);
    const order = [checkout, detect, ruby, build, verifier].map((s) => steps.indexOf(s));
    expect(order, "and they run in dependency order").toEqual([...order].sort((a, b) => a - b));

    // The convention is enforced by the `if:` wiring, not by prose: every step
    // that costs money or can fail for a build reason is gated on the detect
    // output, and the two that establish it are not.
    const gated = `steps.detect.outputs.verifier == 'true'`;
    for (const s of [ruby, build, verifier]) {
      expect(
        String(s.if || ""),
        `step ${JSON.stringify(s.name || s.uses)} must run only when the verifier is present`,
      ).toBe(gated);
    }
    for (const s of [checkout, detect]) {
      expect(s.if, `step ${JSON.stringify(s.name || s.uses)} must be unconditional`).toBeUndefined();
    }
    expect(steps.length, "no other step: there is nothing else this job should do").toBe(5);
  });

  test("the detect script BEHAVES: false + notice when absent, true when present (executed)", () => {
    const detect = findStep(workSteps(), isDetect, "a step with id `detect`");
    const script = stepRun(detect);
    expect(script, "the detect step keys on the one conventional path").toContain(VERIFIER_PATH);

    // ABSENT — adamdaniel.ai's shape today. Must succeed, must say so.
    const absent = scratch();
    const absentOut = path.join(absent, "github_output");
    const a = runScript(script, { cwd: absent, env: { GITHUB_OUTPUT: absentOut } });
    expect(a.status, `absent verifier must not fail the job. Output:\n${a.stdout}`).toBe(0);
    expect(fs.readFileSync(absentOut, "utf8")).toContain("verifier=false");
    expect(
      a.stdout,
      "and it must SAY it found nothing — a silent no-op is indistinguishable from a run that " +
        "verified something",
    ).toContain("::notice");

    // PRESENT — jodidaniel.com's shape. Must flip the output.
    const present = scratch();
    fs.mkdirSync(path.join(present, "scripts"));
    fs.writeFileSync(path.join(present, VERIFIER_PATH), "#!/usr/bin/env ruby\nexit 0\n");
    const presentOut = path.join(present, "github_output");
    const p = runScript(script, { cwd: present, env: { GITHUB_OUTPUT: presentOut } });
    expect(p.status).toBe(0);
    expect(fs.readFileSync(presentOut, "utf8")).toContain("verifier=true");
    expect(fs.readFileSync(presentOut, "utf8")).not.toContain("verifier=false");
  });

  test("the build is the DEPLOY's build: same Ruby, same JEKYLL_ENV, same action pins", () => {
    const steps = workSteps();
    const ruby = findStep(steps, isSetupRuby, "a ruby/setup-ruby step");
    const build = findStep(steps, isBuild, "a `jekyll build` step");

    const preview = parseYaml(readWorkflow("deploy-preview.yml")) || {};
    const previewRuby = preview.on.workflow_call.inputs.ruby_version.default;
    expect(
      String(ruby.with["ruby-version"]),
      "the verifier asserts on a tree built by THIS Ruby; the deploys build with " +
        "deploy-preview's default. A site pins no Ruby in its lockfile, so the two must not drift",
    ).toBe(String(previewRuby));
    expect(ruby.with["bundler-cache"], "cached bundle, keyed on the caller's Gemfile.lock").toBe(
      true,
    );

    const production = parseYaml(readWorkflow("deploy-production.yml")) || {};
    const prodBuild = Object.values(production.jobs || {})
      .flatMap((j) => j.steps || [])
      .find(isBuild);
    expect(prodBuild, "deploy-production must still build with jekyll").toBeTruthy();
    expect(
      (build.env || {}).JEKYLL_ENV,
      "the verifier asserts on what SHIPS, so it builds under the same JEKYLL_ENV as " +
        "deploy-production — a verifier that passes on a dev build proves nothing about prod",
    ).toBe((prodBuild.env || {}).JEKYLL_ENV);
    expect(stepRun(build).trim()).toBe("bundle exec jekyll build");

    // Pins: full SHAs, no comment (the pin-comment lint covers the comment;
    // this holds the SHA equal to deploy-preview's so a Dependabot bump moves
    // both or neither).
    const previewSteps = Object.values(preview.jobs || {}).flatMap((j) => j.steps || []);
    const pinOf = (list, pred) => String(list.find(pred).uses).split("@")[1];
    for (const [pred, what] of [
      [isCheckout, "actions/checkout"],
      [isSetupRuby, "ruby/setup-ruby"],
    ]) {
      const sha = pinOf(steps, pred);
      expect(sha, `${what} is pinned to a full 40-hex SHA`).toMatch(/^[0-9a-f]{40}$/);
      expect(sha, `${what} pin equals deploy-preview.yml's`).toBe(pinOf(previewSteps, pred));
    }
  });

  test("no step interpolates `${{ }}` into a run block", () => {
    for (const job of Object.values(reusable().jobs || {})) {
      for (const s of job.steps || []) {
        expect(
          stepRun(s),
          "an interpolated expression is echoed to the log as a rendered command and re-parsed " +
            "by the shell — values reach a script through env",
        ).not.toContain("${{");
      }
    }
  });
});

test.describe("#377 site-verify — the dictated thin caller", () => {
  test("exists, calls the reusable, and passes NOTHING", () => {
    expect(fs.existsSync(CALLER_PATH), "the caller is platform-dictated (examples/site), so " +
      "platform-bump seeds it into every consumer (#315) and workflow-SET parity accepts it").toBe(
      true,
    );
    const jobs = caller().jobs || {};
    expect(
      Object.keys(jobs),
      `one job named ${JSON.stringify(CALLER_JOB)}, so the published context is exactly ` +
        `\`${CONTEXT}\``,
    ).toEqual([CALLER_JOB]);
    const job = jobs[CALLER_JOB];
    expect(reusableBasename(job.uses), "it must call THIS reusable").toBe(REUSABLE);
    expect(
      String(job.uses),
      "on the platform's release tag (the one carve-out from SHA pinning)",
    ).toMatch(/^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/site-verify\.yml@v\d+\.\d+\.\d+$/);
    expect(job.with, "no `with:` — the reusable declares no inputs").toBeUndefined();
    expect(job.secrets, "no `secrets:` — the reusable declares none").toBeUndefined();
    expect(caller().permissions).toEqual({ contents: "read" });
  });

  test("fires on pull_request only, on the canonical types, with NO path filter", () => {
    const doc = caller();
    expect(events(doc.on), "a PR check, nothing scheduled and nothing dispatched").toEqual([
      "pull_request",
    ]);
    const pr = doc.on.pull_request || {};
    const e2ePr = (parseYaml(fs.readFileSync(E2E_CALLER_PATH, "utf8")).on || {}).pull_request || {};
    expect(
      pr.types,
      "the same `types:` every other required-context caller uses — no `edited` (#222), " +
        "`reopened` kept (#285)",
    ).toEqual(e2ePr.types);
    expect(pr.branches).toEqual(["main"]);
    // THE DECISION. jodidaniel.com's verifier globs `**/*.pdf` over the WHOLE
    // tree, so a docs-only PR can break it exactly as a layout PR can — every
    // path is salient, and a `paths-ignore` here would blind the check for the
    // ignored paths. It would also arm the missing-check trap (a required
    // context that never reports on a filtered PR) the moment this becomes
    // required, which only a stub twin escapes. Always-run is the honest
    // filter for a whole-tree assertion.
    expect(pr.paths, "no `paths:` — every path is salient to a whole-tree verifier").toBeUndefined();
    expect(pr["paths-ignore"], "no `paths-ignore:` — see the comment in the caller").toBeUndefined();
  });

  test("declares a dynamic run-name (the reusable never displays its own)", () => {
    // workflow-run-name.test.js lints only this repo's .github/workflows, and
    // it exempts a workflow_call-only reusable BECAUSE the caller carries the
    // title. So the caller's run-name is asserted here, by the same rules.
    const runName = caller()["run-name"];
    expect(typeof runName === "string" && runName.trim() !== "").toBe(true);
    expect(runName).toContain("${{");
    expect(runName, "balanced — a `#` in an unquoted single-line run-name truncates it").toContain(
      "}}",
    );
  });

  // SEQUENCING GUARD. Making `site-verify / site-verify` required before both
  // consumers publish it blocks every consumer PR on a context that never
  // arrives. This test reds the PR that adds it to the manifest, so that PR
  // has to answer the question first: has the caller landed on BOTH consumers
  // (the platform-bump PR after the release that ships it), and does the
  // context report there? When the answer is yes, delete THIS test, add the
  // context to `ruleset_library.consumer-main.required_status_checks`, and
  // reconcile each consumer's cms-automerge-nudge `required_contexts` in the
  // same change (platform-bump does the latter from the manifest).
  test("SEQUENCING: the context is not yet required — confirm it reports on both consumers first", () => {
    // Read through the same helper the cancellable guard uses, so this sees
    // the manifest's real shape (`rules[].parameters.required_status_checks[]
    // .context`) and not a key that happens not to exist. The first cut read
    // `ruleset.required_status_checks` directly and passed on a manifest that
    // DID require the context — measured by the negative control.
    const manifest = parseYaml(fs.readFileSync(MANIFEST_PATH, "utf8")) || {};
    const rulesetNames = Object.keys(manifest.ruleset_library || {});
    expect(rulesetNames.length, "the manifest must have parsed to something").toBeGreaterThan(0);
    const requiredAnywhere = rulesetNames.filter((name) =>
      requiredContexts(manifest, name).includes(CONTEXT),
    );
    expect(
      requiredAnywhere,
      `\`${CONTEXT}\` is required by ruleset(s) ${JSON.stringify(requiredAnywhere)}. Before this ` +
        `is right: the caller must have landed on BOTH consumers via platform-bump and the ` +
        `context must have reported there. If it has, delete this test in the same PR ` +
        `(cms-platform#377, "Sequencing").`,
    ).toEqual([]);
  });
});
