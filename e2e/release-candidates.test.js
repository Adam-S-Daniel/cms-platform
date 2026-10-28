// @lane: local — release-candidates.yml + platform-bump.yml candidate mode.
//
// WHY THIS EXISTS. release.yml's stable gate needs an open DRAFT candidate PR
// in each consumer pinned to the exact platform `main` commit
// (scripts/release-candidate-gate.js). Those drafts were built and re-pinned by
// hand (adamdaniel.ai#4365, jodidaniel.com#411 for v0.1.164). Now one dispatch
// of release-candidates.yml asks each consumer's platform-bump to do it, via
// the `candidate_sha` input.
//
// What this locks, from the PARSED workflows and by EXECUTING their steps with
// stub executables (offline, no network, no clock):
//   - release-candidates.yml is dispatched or called, never a PR check,
//     contents: read, refuses any ref but main, fails closed on a missing
//     token, dispatches BOTH consumers with candidate_sha, and prints the exact
//     release.yml line (or, when release.yml calls it, outputs both draft
//     numbers) only once each draft's HEAD pins the commit;
//   - release.yml's one-dispatch mode (#898): with both candidate inputs empty
//     it refuses a wrong ref or version first, then calls release-candidates,
//     waits for scripts/release-candidate-gate.js through
//     scripts/release-candidate-wait.js, and runs the unchanged release job
//     with the draft numbers only after that wait succeeds;
//   - the reusable platform-bump declares `candidate_sha` and binds it through
//     env (never interpolated into `run:`), and the examples/site caller
//     declares the dispatch input and forwards it;
//   - candidate mode opens a DRAFT PR on candidate/<version>, re-pins an open
//     one with a comment and never a body edit, and never enables auto-merge,
//     marks it ready, labels it or closes other PRs.
//
// Reads the platform's own workflow definitions: registered in
// PLATFORM_META_SPECS (playwright.config.js), so it never runs in a consumer.
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");
const { writeStubs, runStep } = require("./workflow-step-harness");

const REPO_ROOT = path.resolve(__dirname, "..");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const CONSUMERS = ["Adam-S-Daniel/adamdaniel.ai", "jodidaniel/jodidaniel.com"];

const candidates = parseYaml(readWorkflow("release-candidates.yml"));
const release = parseYaml(readWorkflow("release.yml"));
const bump = parseYaml(readWorkflow("platform-bump.yml"));
const caller = parseYaml(
  fs.readFileSync(path.join(REPO_ROOT, "examples", "site", ".github", "workflows", "platform-bump.yml"), "utf8"),
);
const onOf = (wf) => wf.on ?? wf[true];
const stepNamed = (wf, job, name) => {
  const s = wf.jobs[job].steps.find((st) => st.name === name);
  expect(s, `${job}: ${name}`).toBeTruthy();
  return s;
};

let scratch;
test.afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});
function sandbox() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "release-candidates-"));
  const root = path.join(scratch, "root");
  fs.mkdirSync(root);
  return root;
}
function put(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function calls(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
// A `gh` stub in Node: logs argv as one JSON line and answers from FIXTURE_*.
function ghStub(root, body) {
  const file = path.join(scratch, "gh.js");
  fs.writeFileSync(file, `const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(a) + "\\n");
const out = (s) => process.stdout.write(s);
const b64 = (s) => Buffer.from(s).toString("base64") + "\\n";
${body}
`);
  return `exec "${process.execPath}" "${file}" "$@"`;
}

test.describe("release-candidates.yml — shape", () => {
  test("dispatched with no inputs, or called by release.yml: never a pull-request check", () => {
    const on = onOf(candidates);
    expect(Object.keys(on)).toEqual(["workflow_dispatch", "workflow_call"]);
    expect(on.workflow_dispatch).toBeFalsy();
    expect(on.workflow_call.inputs).toEqual({ chained: expect.objectContaining({ type: "boolean", default: false }) });
  });

  test("the reusable takes only the two dispatch secrets, neither required", () => {
    expect(onOf(candidates).workflow_call.secrets).toEqual({
      BUMP_DISPATCH_ADAMDANIEL_AI: { required: false },
      BUMP_DISPATCH_JODIDANIEL_COM: { required: false },
    });
  });

  test("its outputs are the version and both draft numbers, from the dispatch step", () => {
    const outputs = onOf(candidates).workflow_call.outputs;
    const job = candidates.jobs.candidates;
    for (const key of ["version", "adamdaniel_ai_pr", "jodidaniel_com_pr"]) {
      expect(outputs[key].value).toBe(`\${{ jobs.candidates.outputs.${key} }}`);
      expect(job.outputs[key]).toBe(`\${{ steps.drafts.outputs.${key} }}`);
    }
    expect(stepNamed(candidates, "candidates", "Dispatch both consumers' candidate bumps and wait for the drafts").id).toBe("drafts");
  });

  test("least privilege: contents: read, and no job widens it", () => {
    expect(candidates.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(candidates.jobs)) expect(job.permissions).toBeUndefined();
  });

  test("tokens come from the release fanout's secrets, through env only", () => {
    const step = stepNamed(candidates, "candidates", "Dispatch both consumers' candidate bumps and wait for the drafts");
    expect(step.env.TOKEN_ADAMDANIEL_AI).toBe("${{ secrets.BUMP_DISPATCH_ADAMDANIEL_AI }}");
    expect(step.env.TOKEN_JODIDANIEL_COM).toBe("${{ secrets.BUMP_DISPATCH_JODIDANIEL_COM }}");
    expect(step.env.CANDIDATE_SHA).toBe("${{ github.sha }}");
    for (const job of Object.values(candidates.jobs)) {
      for (const s of job.steps) if (s.run) expect(s.run, s.name).not.toContain("${{");
    }
  });
});

test.describe("release-candidates.yml — the main-only guard", () => {
  const guard = stepNamed(candidates, "candidates", "Refuse unless dispatched on main");
  for (const [ref, status] of [["refs/heads/main", 0], ["refs/heads/feature", 1], ["refs/tags/v0.1.164", 1]]) {
    test(`${ref} → exit ${status}`, () => {
      const root = sandbox();
      const r = runStep(guard, { cwd: root, scratch: path.join(scratch, "run"), env: { PATH: process.env.PATH }, stepEnv: { GH_REF: ref } });
      expect(r.status, r.stdout + r.stderr).toBe(status);
      if (status) expect(r.stdout).toContain("::error::release candidates must be prepared from main");
    });
  }
  test("the guard runs before anything else", () => {
    expect(candidates.jobs.candidates.steps[0]).toBe(guard);
  });
});

test.describe("release-candidates.yml — dispatch and wait", () => {
  const step = stepNamed(candidates, "candidates", "Dispatch both consumers' candidate bumps and wait for the drafts");

  // `pins` maps a consumer to the SHA its draft head's platform.lock names.
  function run({ tokens = ["tok-a", "tok-b"], pins = { [CONSUMERS[0]]: SHA, [CONSUMERS[1]]: SHA }, draft = true, poll = "600", chained = "false" } = {}) {
    const root = sandbox();
    put(root, "plugin.json", JSON.stringify({ name: "cms-platform", version: "0.1.165" }));
    const log = path.join(scratch, "gh.jsonl");
    const summary = path.join(scratch, "summary.md");
    // The step's own --jq filters run through the real jq, the way gh applies them.
    const gh = ghStub(root, `
const { execFileSync } = require("node:child_process");
const respond = (json) => {
  const q = a.indexOf("--jq");
  out(q === -1 ? JSON.stringify(json) : execFileSync("jq", ["-r", a[q + 1]], { input: JSON.stringify(json), encoding: "utf8" }));
};
const pins = JSON.parse(process.env.FIXTURE_PINS);
const prs = { "${CONSUMERS[0]}": [4401, "a".repeat(40)], "${CONSUMERS[1]}": [412, "b".repeat(40)] };
const repo = a[a.indexOf("-R") + 1];
if (a[0] === "workflow" && a[1] === "run") process.exit(0);
if (a[0] === "pr" && a[1] === "list") {
  const [number, headRefOid] = prs[repo];
  respond([{ number, isDraft: process.env.FIXTURE_DRAFT === "true", headRefOid }]);
  process.exit(0);
}
const m = a[0] === "api" && /^repos\\/([^/]+\\/[^/]+)\\/contents\\/platform\\.lock\\?ref=([0-9a-f]{40})$/.exec(a[1]);
if (m && prs[m[1]] && prs[m[1]][1] === m[2]) {
  respond({ content: Buffer.from("platform_repo: Adam-S-Daniel/cms-platform\\nplatform_ref: " + pins[m[1]] + "\\n").toString("base64") });
  process.exit(0);
}
process.exit(1);
`);
    const r = runStep(step, {
      cwd: root,
      scratch: path.join(scratch, "run"),
      env: {
        PATH: `${writeStubs(path.join(scratch, "bin"), { gh, sleep: "exit 0" })}:${process.env.PATH}`,
        GH_CALL_LOG: log, FIXTURE_PINS: JSON.stringify(pins), FIXTURE_DRAFT: String(draft),
        GITHUB_REPOSITORY: "Adam-S-Daniel/cms-platform", GITHUB_STEP_SUMMARY: summary,
      },
      stepEnv: {
        CANDIDATE_SHA: SHA, TOKEN_ADAMDANIEL_AI: tokens[0], TOKEN_JODIDANIEL_COM: tokens[1],
        POLL_SECONDS: poll, POLL_INTERVAL: "15", CHAINED: chained,
      },
    });
    return { r, calls: calls(log), summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "", output: r.output };
  }

  test("dispatches BOTH consumers with candidate_sha and prints the exact release line", () => {
    const { r, calls: c, summary } = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const dispatches = c.filter((a) => a[0] === "workflow" && a[1] === "run");
    expect(dispatches).toEqual(CONSUMERS.map((repo) => ["workflow", "run", "platform-bump.yml", "-R", repo, "-f", `candidate_sha=${SHA}`]));
    expect(summary).toContain(
      `gh workflow run release.yml -R Adam-S-Daniel/cms-platform --ref main -f version=v0.1.165 -f candidate_adamdaniel_ai_pr=4401 -f candidate_jodidaniel_com_pr=412`,
    );
    expect(summary).toContain(`https://github.com/${CONSUMERS[0]}/pull/4401`);
    expect(summary).toContain(`https://github.com/${CONSUMERS[1]}/pull/412`);
    expect(c.filter((a) => a[0] === "pr" && a[1] === "list").every((a) => a.includes("candidate/v0.1.165"))).toBe(true);
    expect(r.stdout + r.stderr).not.toMatch(/tok-[ab]/);
  });

  test("writes the version and both draft numbers to the step outputs", () => {
    const { r, output } = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(output.trim().split("\n")).toEqual(["version=v0.1.165", "adamdaniel_ai_pr=4401", "jodidaniel_com_pr=412"]);
  });

  test("called by release.yml: the summary says the release follows and prints no dispatch line", () => {
    const { r, summary, output } = run({ chained: "true" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(summary).toContain("This run's release job waits for both drafts to pass the candidate gate, then cuts v0.1.165");
    expect(summary).not.toContain("gh workflow run release.yml");
    expect(output).toContain("adamdaniel_ai_pr=4401");
  });

  test("the chained flag reaches the step only as a boolean comparison", () => {
    const step = stepNamed(candidates, "candidates", "Dispatch both consumers' candidate bumps and wait for the drafts");
    expect(step.env.CHAINED).toBe("${{ inputs.chained == true }}");
  });

  for (const which of [0, 1]) {
    test(`a missing ${which ? "jodidaniel.com" : "adamdaniel.ai"} token fails closed before any dispatch`, () => {
      const tokens = ["tok-a", "tok-b"];
      tokens[which] = "";
      const { r, calls: c, summary } = run({ tokens });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(`::error::no ${which ? "BUMP_DISPATCH_JODIDANIEL_COM" : "BUMP_DISPATCH_ADAMDANIEL_AI"} secret`);
      expect(c).toEqual([]);
      expect(summary).toBe("");
    });
  }

  test("a draft still pinned to an older commit does not count; the poll gives up loudly", () => {
    const { r, summary } = run({ pins: { [CONSUMERS[0]]: SHA, [CONSUMERS[1]]: OLD_SHA }, poll: "0" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`::error::no open draft PR on ${CONSUMERS[1]}'s candidate/v0.1.165 pins ${SHA}`);
    expect(r.stdout).not.toContain(`no open draft PR on ${CONSUMERS[0]}`);
    expect(summary).toBe("");
  });

  test("a candidate PR that is not a draft does not count", () => {
    const { r, summary } = run({ draft: false, poll: "0" });
    expect(r.status).toBe(1);
    for (const repo of CONSUMERS) expect(r.stdout).toContain(`no open draft PR on ${repo}'s`);
    expect(summary).toBe("");
  });
});

test.describe("platform-bump.yml — the candidate_sha interface", () => {
  test("the reusable declares candidate_sha: a string defaulting to empty", () => {
    expect(onOf(bump).workflow_call.inputs.candidate_sha).toEqual({ type: "string", default: "" });
  });

  test("the bump step binds it through env and no run: interpolates it", () => {
    const step = bump.jobs.bump.steps.find((s) => s.id === "bump");
    expect(step.env.CANDIDATE_SHA).toBe("${{ inputs.candidate_sha }}");
    for (const s of bump.jobs.bump.steps) if (s.run) expect(s.run, s.name).not.toMatch(/\$\{\{\s*inputs\./);
  });

  test("the examples/site caller declares the dispatch input and forwards it", () => {
    const input = onOf(caller).workflow_dispatch.inputs.candidate_sha;
    expect(input.type).toBe("string");
    expect(input.required).toBe(false);
    expect(caller.jobs.bump.with).toEqual({ candidate_sha: "${{ inputs.candidate_sha }}" });
  });
});

test.describe("platform-bump.yml — candidate mode, executed", () => {
  const step = bump.jobs.bump.steps.find((s) => s.id === "bump");

  // Runs the whole bump step in a scratch consumer on platform v1.2.2 with every
  // external command stubbed; returns the gh and git calls it made.
  function bumpRun({ candidate = SHA, existing = "", isDraft = "true" } = {}) {
    const root = sandbox();
    put(root, "platform.lock", "platform_repo: fixture/platform\nplatform_ref: v1.2.2\n");
    put(root, ".github/workflows/cms-automerge-nudge.yml", "fixture\n");
    put(root, "oauth-proxy/deploy.sh", "fixture\n");
    put(root, "infrastructure/bootstrap/deploy.sh", "fixture\n");
    const log = path.join(scratch, "gh.jsonl");
    const gitLog = path.join(scratch, "git.log");
    const summary = path.join(scratch, "summary.md");
    const gh = ghStub(root, `
if (a[0] === "api") {
  const e = a[1];
  if (e.endsWith("/releases/latest")) out("v1.2.3\\n");
  else if (e.includes("/git/refs/tags/")) out(a.includes(".object.type") ? "commit\\n" : "${OLD_SHA}\\n");
  else if (e === "repos/fixture/platform/commits/${SHA}") out("${SHA}\\n");
  else if (e.startsWith("repos/fixture/platform/contents/plugin.json?ref=")) out(b64(JSON.stringify({ version: "1.2.3" })));
  else if (e.includes("/contents/examples/site/.github/workflows?")) out("cms-automerge-nudge.yml\\n");
  else out(a.includes(".content") ? b64("fixture\\n") : "fixture\\n");
} else if (a[0] === "pr" && a[1] === "list") out(process.env.FIXTURE_EXISTING ? process.env.FIXTURE_EXISTING + "\\n" : "");
else if (a[0] === "pr" && a[1] === "view") out(a.includes("isDraft") ? process.env.FIXTURE_IS_DRAFT + "\\n" : "101\\n");
`);
    const r = runStep(step, {
      cwd: root,
      scratch: path.join(scratch, "run"),
      env: {
        PATH: `${writeStubs(path.join(scratch, "bin"), {
          gh,
          npm: "exit 0",
          node: "exit 0",
          python3: "exit 0",
          git: `printf '%s\\n' "$*" >> "${gitLog}"\nif [ "$1" = diff ]; then exit 1; fi\nexit 0`,
        })}:${process.env.PATH}`,
        HOME: scratch,
        GH_CALL_LOG: log, FIXTURE_EXISTING: existing, FIXTURE_IS_DRAFT: isDraft,
        GITHUB_REPOSITORY: "fixture/site", GITHUB_REF_NAME: "main", GITHUB_STEP_SUMMARY: summary,
      },
      stepEnv: { GH_TOKEN: "fixture", PLATFORM: "fixture/platform", CANDIDATE_SHA: candidate },
    });
    return {
      r,
      gh: calls(log),
      git: fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8").trim().split("\n") : [],
      summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
    };
  }
  const prCalls = (gh, verb) => gh.filter((a) => a[0] === "pr" && a[1] === verb);
  // Anything that would land, label, un-draft or close a PR.
  function expectNoMergeAutomation(gh) {
    expect(prCalls(gh, "merge"), "candidate mode must never enable auto-merge").toEqual([]);
    expect(prCalls(gh, "edit"), "a body/label edit fires pull_request: edited (#222)").toEqual([]);
    expect(prCalls(gh, "close")).toEqual([]);
    expect(prCalls(gh, "ready").filter((a) => !a.includes("--undo")), "never marked ready").toEqual([]);
    expect(gh.filter((a) => a.some((x) => /label/.test(x)))).toEqual([]);
  }

  test("a new candidate: SAME bump to the SHA, pushed to candidate/<version>, opened as a DRAFT", () => {
    const { r, gh, git, summary } = bumpRun();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // The target is the commit, not the latest release, and no tag is resolved.
    expect(gh.some((a) => a[0] === "api" && a[1].endsWith("/releases/latest"))).toBe(false);
    expect(gh.some((a) => a[0] === "api" && a[1].includes("/git/refs/tags/"))).toBe(false);
    expect(gh).toContainEqual(["api", `repos/fixture/platform/contents/scripts/rewrite-platform-pins.js?ref=${SHA}`,
      "-H", "Accept: application/vnd.github.raw+json"]);
    expect(gh.some((a) => a[1] === `repos/fixture/platform/contents/examples/site/.github/workflows?ref=${SHA}`)).toBe(true);
    expect(git).toContain("checkout -b candidate/v1.2.3");
    expect(git).toContain(`commit -m chore: pin cms-platform release candidate v1.2.3 (${SHA})`);
    expect(git).toContain("push -f origin candidate/v1.2.3");
    const create = prCalls(gh, "create");
    expect(create).toHaveLength(1);
    expect(create[0]).toContain("--draft");
    expect(create[0][create[0].indexOf("--title") + 1]).toBe("Release candidate: cms-platform v1.2.3 (do not merge)");
    expect(create[0][create[0].indexOf("--head") + 1]).toBe("candidate/v1.2.3");
    const body = create[0][create[0].indexOf("--body") + 1];
    expect(body).toContain("**Do not merge.**");
    expect(body).toContain(`[\`${SHA}\`](https://github.com/fixture/platform/commit/${SHA})`);
    expect(summary).toContain(`draft PR #101 (\`candidate/v1.2.3\`) pins \`${SHA}\``);
    expectNoMergeAutomation(gh);
  });

  test("an open candidate PR is re-pinned in place: a comment, kept (or put back) as a draft", () => {
    for (const isDraft of ["true", "false"]) {
      const { r, gh, git } = bumpRun({ existing: "77", isDraft });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(git).toContain("push -f origin candidate/v1.2.3");
      expect(prCalls(gh, "create")).toEqual([]);
      expect(prCalls(gh, "comment")).toHaveLength(1);
      expect(prCalls(gh, "comment")[0][2]).toBe("77");
      expect(prCalls(gh, "ready")).toEqual(isDraft === "true" ? [] : [["pr", "ready", "77", "--undo"]]);
      expectNoMergeAutomation(gh);
    }
  });

  for (const bad of ["ABCDEF0123456789ABCDEF0123456789ABCDEF01", SHA.slice(1), `${SHA};x`, "main"]) {
    test(`candidate_sha ${JSON.stringify(bad)} fails before any API call or push`, () => {
      const { r, gh, git } = bumpRun({ candidate: bad });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("::error::candidate_sha must be a full 40-character lowercase commit SHA");
      expect(gh).toEqual([]);
      expect(git).toEqual([]);
    });
  }

  test("control: with no candidate the normal bump still targets the release and enables auto-merge", () => {
    const { r, gh, git } = bumpRun({ candidate: "" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git).toContain("push -f origin platform/bump-v1.2.3");
    expect(prCalls(gh, "create")[0]).not.toContain("--draft");
    expect(prCalls(gh, "merge")).toEqual([["pr", "merge", "--auto", "--squash", "platform/bump-v1.2.3"]]);
  });
});

test.describe("release.yml — one-dispatch mode (#898)", () => {
  const jobs = release.jobs;
  const inputsEmpty = "inputs.candidate_adamdaniel_ai_pr == '' && inputs.candidate_jodidaniel_com_pr == ''";

  test("still workflow_dispatch only, so no wall in it can cancel a required context", () => {
    expect(Object.keys(onOf(release))).toEqual(["workflow_dispatch"]);
  });

  test("the mode runs only for a stable dispatch with BOTH candidate inputs empty", () => {
    expect(jobs.preflight.if).toBe(`\${{ inputs.prerelease != true && ${inputsEmpty} }}`);
    expect(jobs.candidates.needs).toBe("preflight");
    expect(jobs["wait-for-candidates"].needs).toBe("candidates");
  });

  test("candidates calls release-candidates.yml in chained mode with only the two dispatch secrets", () => {
    expect(jobs.candidates.uses).toBe("./.github/workflows/release-candidates.yml");
    expect(jobs.candidates.with).toEqual({ chained: true });
    expect(jobs.candidates.secrets).toEqual({
      BUMP_DISPATCH_ADAMDANIEL_AI: "${{ secrets.BUMP_DISPATCH_ADAMDANIEL_AI }}",
      BUMP_DISPATCH_JODIDANIEL_COM: "${{ secrets.BUMP_DISPATCH_JODIDANIEL_COM }}",
    });
  });

  test("only the release job can write: the mode's jobs are contents: read", () => {
    for (const name of ["preflight", "candidates", "wait-for-candidates"]) expect(jobs[name].permissions, name).toEqual({ contents: "read" });
    expect(jobs.release.permissions).toBeUndefined();
  });

  test("the wait runs the wait script on the called workflow's draft numbers, bounded by the job wall", () => {
    const job = jobs["wait-for-candidates"];
    const step = stepNamed(release, "wait-for-candidates", "Wait for both candidates to pass the release gate");
    expect(step.run).toBe("node scripts/release-candidate-wait.js");
    expect(step.env.CANDIDATE_SHA).toBe("${{ github.sha }}");
    expect(step.env.VERSION).toBe("${{ inputs.version }}");
    expect(step.env.CANDIDATE_ADAMDANIEL_AI_PR).toBe("${{ needs.candidates.outputs.adamdaniel_ai_pr }}");
    expect(step.env.CANDIDATE_JODIDANIEL_COM_PR).toBe("${{ needs.candidates.outputs.jodidaniel_com_pr }}");
    expect(step.env.TOKEN_ADAMDANIEL_AI).toBe("${{ secrets.BUMP_DISPATCH_ADAMDANIEL_AI }}");
    expect(step.env.TOKEN_JODIDANIEL_COM).toBe("${{ secrets.BUMP_DISPATCH_JODIDANIEL_COM }}");
    // The poll must give up before the wall does, so a timeout reports what it
    // was waiting on instead of being cut off.
    expect(Number(step.env.POLL_SECONDS)).toBeGreaterThan(0);
    expect(Number(step.env.POLL_SECONDS) / 60).toBeLessThan(job["timeout-minutes"] - 10);
    // Node and Ruby are set up before the gate runs, as in the release job.
    const names = job.steps.map((s) => s.name);
    expect(names.indexOf("Set up Ruby for candidate Gemfile parsing")).toBeLessThan(names.indexOf(step.name));
    expect(names.indexOf("Install candidate gate dependencies")).toBeLessThan(names.indexOf(step.name));
  });

  test("the wait's artifact does not take the release gate's artifact name", () => {
    const upload = stepNamed(release, "wait-for-candidates", "Upload candidate wait results");
    expect(upload.if).toBe("${{ always() }}");
    expect(upload.with.name).toBe("release-candidate-wait-results");
    expect(stepNamed(release, "release", "Upload candidate validation results").with.name).toBe("release-candidate-results");
  });

  test("the release job runs after a passed wait, or as before when the mode is skipped", () => {
    expect(jobs.release.needs).toEqual(["preflight", "candidates", "wait-for-candidates"]);
    expect(jobs.release.if).toBe(
      "${{ !cancelled() && (needs.preflight.result == 'skipped' || needs.wait-for-candidates.result == 'success') }}",
    );
  });

  test("the release gate takes the hand-given numbers first, else the called workflow's", () => {
    const step = stepNamed(release, "release", "Validate both consumer release candidates");
    expect(step.env.CANDIDATE_ADAMDANIEL_AI_PR).toBe("${{ inputs.candidate_adamdaniel_ai_pr || needs.candidates.outputs.adamdaniel_ai_pr }}");
    expect(step.env.CANDIDATE_JODIDANIEL_COM_PR).toBe("${{ inputs.candidate_jodidaniel_com_pr || needs.candidates.outputs.jodidaniel_com_pr }}");
    expect(step.env.CANDIDATE_SHA).toBe("${{ github.sha }}");
  });

  test("no run: in the mode interpolates an expression", () => {
    for (const name of ["preflight", "wait-for-candidates"]) {
      for (const s of jobs[name].steps) if (s.run) expect(s.run, s.name).not.toContain("${{");
    }
  });

  test.describe("the preflight refuses before any consumer is touched", () => {
    const guard = stepNamed(release, "preflight", "Refuse unless main declares this version and it is unreleased");
    function preflight({ ref = "refs/heads/main", version = "v0.1.166", manifests = ["0.1.166", "0.1.166"], released = false } = {}) {
      const root = sandbox();
      put(root, "plugin.json", JSON.stringify({ version: manifests[0] }));
      put(root, ".claude-plugin/plugin.json", JSON.stringify({ version: manifests[1] }));
      const log = path.join(scratch, "gh.jsonl");
      const gh = ghStub(root, `process.exit(a[0] === "release" && a[1] === "view" && process.env.FIXTURE_RELEASED === "true" ? 0 : 1);`);
      const r = runStep(guard, {
        cwd: root,
        scratch: path.join(scratch, "run"),
        env: { PATH: `${writeStubs(path.join(scratch, "bin"), { gh })}:${process.env.PATH}`, GH_CALL_LOG: log, FIXTURE_RELEASED: String(released) },
        stepEnv: { GH_TOKEN: "fixture", GH_REPO: "Adam-S-Daniel/cms-platform", GH_REF: ref, VERSION: version },
      });
      return { r, calls: calls(log) };
    }

    test("main, a matching version and no existing release: passes", () => {
      const { r, calls: c } = preflight();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(c).toEqual([["release", "view", "v0.1.166", "--repo", "Adam-S-Daniel/cms-platform"]]);
    });
    test("a feature branch is refused", () => {
      const { r } = preflight({ ref: "refs/heads/feature" });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("::error::releases must be cut from main");
    });
    for (const version of ["0.1.166", "v0.1.166-rc.1", "v0.1"]) {
      test(`version ${version} is refused`, () => {
        const { r } = preflight({ version });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("::error::version must look like vX.Y.Z");
      });
    }
    for (const which of [0, 1]) {
      test(`a ${which ? ".claude-plugin/" : ""}plugin.json on another version is refused`, () => {
        const manifests = ["0.1.166", "0.1.166"];
        manifests[which] = "0.1.165";
        const { r, calls: c } = preflight({ manifests });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain(`declares version '0.1.165', not '0.1.166'`);
        expect(c).toEqual([]);
      });
    }
    test("an existing release is refused", () => {
      const { r } = preflight({ released: true });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("::error::release v0.1.166 already exists");
    });
  });
});
