// @lane: local — deterministic consumer API matrices; no network or servers.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");
const { gate, evaluate, pages, gemPin } = require("../scripts/release-candidate-gate");
const ROOT = path.resolve(__dirname, "..");
const ACTIONS_APP = 15368;
const platform = "Adam-S-Daniel/cms-platform";
const candidate = "a".repeat(40), head = "b".repeat(40), main = "c".repeat(40), old = "d".repeat(40);
const manifest = parseYaml(fs.readFileSync(path.join(ROOT, "repo-settings.yml"), "utf8"));
const repos = Object.keys(manifest.repos).filter((repo) => manifest.repos[repo].rulesets.main === "consumer-main");
const declared = manifest.ruleset_library["consumer-main"].rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks;
const matrix = fs.readFileSync(path.join(ROOT, ".github/workflows/e2e-tests.yml"), "utf8");
const slots = parseYaml(matrix).jobs.project.strategy.matrix.include;
const file = (content) => ({ encoding: "base64", content: Buffer.from(content).toString("base64") });
const lock = (ref) => `platform_repo: ${platform}\nplatform_ref: ${ref}\n`;
const gem = (ref = candidate) => `GIT\n  remote: https://github.com/${platform}.git\n  revision: ${ref}\n  ref: ${ref}\n  specs:\n    cms-platform-theme (0.1.160)\n\nGEM\n  remote: https://rubygems.org/\n`;
function fixture(change = () => {}) {
  const data = {};
  data[`repos/${platform}/contents/.github/workflows/e2e-tests.yml?ref=${candidate}`] = file(matrix);
  data[`repos/${platform}/commits/v0.1.159`] = { sha: old };
  for (const repo of repos) {
    data[`repos/${repo}/pulls/1`] = { state: "open", draft: true, head: { sha: head, repo: { full_name: repo } }, base: { ref: "main", repo: { full_name: repo } } };
    data[`repos/${repo}/commits/main`] = { sha: main };
    data[`repos/${repo}/contents/platform.lock?ref=${main}`] = file(lock("v0.1.159"));
    data[`repos/${repo}/contents/platform.lock?ref=${head}`] = file(lock(candidate));
    data[`repos/${repo}/contents/Gemfile.lock?ref=${head}`] = file(gem());
    data[`repos/${repo}/contents/Gemfile.lock?ref=${main}`] = file(gem(old).replace(`ref: ${old}`, "tag: v0.1.159"));
    data[`repos/${repo}/contents/Gemfile?ref=${head}`] = file(`source "https://rubygems.org"\ngem "cms-platform-theme", git: "https://github.com/${platform}", ref: "${candidate}"\n`);
    data[`repos/${repo}/contents/Gemfile?ref=${main}`] = file(`gem "cms-platform-theme", git: "https://github.com/${platform}", tag: "v0.1.159"\n`);
    const paths = [".github/workflows/e2e-tests.yml", ".github/workflows/site-verify.yml"];
    data[`repos/${repo}/contents/.github/workflows?ref=${head}`] = paths.map((p) => ({ path: p }));
    data[`repos/${repo}/contents/${paths[0]}?ref=${head}`] = file(`jobs:\n  e2e:\n    uses: ${platform}/.github/workflows/e2e-tests.yml@${candidate}\n    with:\n      platform_ref: ${candidate}\n      target: local\n      browser: all\n`);
    data[`repos/${repo}/contents/${paths[1]}?ref=${head}`] = file(`jobs:\n  site-verify:\n    uses: ${platform}/.github/workflows/site-verify.yml@${candidate}\n`);
    data[`repos/${repo}/contents/.github/workflows?ref=${main}`] = paths.map((p) => ({ path: p }));
    for (const rel of paths) data[`repos/${repo}/contents/${rel}?ref=${main}`] = file(
      Buffer.from(data[`repos/${repo}/contents/${rel}?ref=${head}`].content, "base64").toString().replaceAll(candidate, "v0.1.159"));
    data[`repos/${repo}/rules/branches/main`] = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "live-extra", integration_id: ACTIONS_APP }] } }];
    const names = [...declared.map((item) => item.context), "live-extra", ...slots.map((slot) => `e2e / project (${slot.slot})`), "site-verify / verify"];
    data[`repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100&page=1`] = { check_runs: names.map((name, index) => ({ id: index + 1, name, head_sha: head, app: { id: ACTIONS_APP }, status: "completed", conclusion: "success", details_url: `https://github.com/${repo}/actions/runs/1/job/${index + 1}` })) };
    data[`repos/${repo}/commits/${head}/statuses?per_page=100&page=1`] = [];
    data[`repos/${repo}/contents/scripts?ref=${head}`] = repo === repos[1]
      ? [{ path: "scripts/verify-build-artifacts.rb", type: "file" }] : [];
    for (const check of data[`repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100&page=1`].check_runs) {
      data[`repos/${repo}/actions/jobs/${check.id}`] = { id: check.id, run_id: 1, head_sha: head,
        name: check.name, status: "completed", conclusion: "success", steps:
          (check.name === "site-verify / verify" ? ["Detect the site's verifier and self-tests", "Run the site's verifier self-tests", "Build the site", "Run the site's verifier"] : ["Run Playwright suite"])
            .map((name) => ({ name, status: "completed", conclusion: name === "Build the site" || name === "Run the site's verifier" ? (repo === repos[1] ? "success" : "skipped") : "success" })) };
    }
  }
  change(data);
  return { data, args: { candidate, platform, version: "v0.1.160", manifest, prs: Object.fromEntries(repos.map((r) => [r, "1"])), read: async (_, endpoint) => {
    if (!(endpoint in data)) throw new Error("Mock endpoint missing");
    return structuredClone(data[endpoint]);
  } } };
}
const checksKey = (repo = repos[0]) => `repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100&page=1`;

test("both consumers' exact candidate matrices pass", async () => {
  const result = await gate(fixture().args);
  expect(result.ok).toBe(true);
  expect(result.consumers.map((c) => c.repo)).toEqual(repos);
  expect(result.consumers.every((c) => c.results.length === declared.length + 1 + slots.length + 1)).toBe(true);
});
for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) {
  test(`required ${conclusion} result refuses promotion`, async () => {
    const { args } = fixture((data) => { data[checksKey()].check_runs[0].conclusion = conclusion; });
    await expect(gate(args)).rejects.toThrow();
  });
}
test("pending, missing, and wrong-head validations refuse promotion", async () => {
  for (const alter of [
    (checks) => { checks[0].status = "in_progress"; },
    (checks) => { checks.shift(); },
    (checks) => { checks[0].head_sha = old; },
  ]) {
    await expect(gate(fixture((data) => alter(data[checksKey()].check_runs)).args)).rejects.toThrow();
  }
});
test("live integration binding cannot be satisfied by a different app", async () => {
  await expect(gate(fixture((data) => { data[checksKey()].check_runs.find((c) => c.name === "live-extra").app.id = 5; }).args)).rejects.toThrow(/missing/);
});
test("same-name results cannot hide a different app failure or pending legacy status", async () => {
  const success = { id: 2, name: "required", head_sha: head, app: { id: ACTIONS_APP }, status: "completed", conclusion: "success" };
  expect(() => evaluate([success, { ...success, id: 1, app: { id: 5 }, conclusion: "failure" }], [], [{ context: "required" }], head)).toThrow();
  expect(() => evaluate([success], [{ id: 3, context: "required", state: "pending" }], [{ context: "required" }], head)).toThrow();
});
test("legacy statuses participate and latest results supersede older attempts", async () => {
  const { args } = fixture((data) => {
    const check = data[checksKey()].check_runs.shift();
    data[`repos/${repos[0]}/commits/${head}/statuses?per_page=100&page=1`] = [
      { id: 1, context: check.name, state: "failure" }, { id: 2, context: check.name, state: "success" },
    ];
    const latest = data[checksKey()].check_runs[0];
    data[checksKey()].check_runs.push({ ...latest, id: 0, conclusion: "failure" });
  });
  expect((await gate(args)).ok).toBe(true);
});
test("all check and legacy-status pages are read", async () => {
  for (const key of ["check_runs", null]) {
    const requested = [];
    const values = await pages(async (_, endpoint) => {
      requested.push(endpoint);
      const batch = endpoint.endsWith("page=1") ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }];
      return key ? { [key]: batch } : batch;
    }, repos[0], "results", key);
    expect(values).toHaveLength(101);
    expect(requested).toEqual(["results?per_page=100&page=1", "results?per_page=100&page=2"]);
  }
});
test("old lock, workflow pin, input pin, and theme revision refuse promotion", async () => {
  for (const rel of ["platform.lock", "Gemfile", "Gemfile.lock", ".github/workflows/e2e-tests.yml"]) {
    const { args } = fixture((data) => {
      const key = `repos/${repos[0]}/contents/${rel}?ref=${head}`;
      data[key] = file(Buffer.from(data[key].content, "base64").toString().replace(candidate, old));
    });
    await expect(gate(args)).rejects.toThrow();
  }
  expect(() => gemPin(gem().replace(`ref: ${candidate}`, `ref: ${old}`), platform, candidate)).toThrow();
  const { args } = fixture((data) => {
    const key = `repos/${repos[0]}/contents/.github/workflows/e2e-tests.yml?ref=${head}`;
    data[key] = file(Buffer.from(data[key].content, "base64").toString().replace(`platform_ref: ${candidate}`, `platform_ref: ${old}`));
  });
  await expect(gate(args)).rejects.toThrow();
});
test("both consumers are mandatory and unsafe PR identities refuse promotion", async () => {
  const missing = fixture().args; delete missing.prs[repos[1]];
  await expect(gate(missing)).rejects.toThrow();
  for (const field of ["draft", "state", "fork", "base", "head"]) {
    const { args } = fixture((data) => {
      const pull = data[`repos/${repos[1]}/pulls/1`];
      if (field === "draft") pull.draft = false;
      if (field === "state") pull.state = "closed";
      if (field === "fork") pull.head.repo.full_name = "example/fork";
      if (field === "base") pull.base.ref = "other";
      if (field === "head") pull.head.sha = "short";
    });
    await expect(gate(args)).rejects.toThrow();
  }
});
test("production tag resolving candidate and drifting revisions refuse promotion", async () => {
  await expect(gate(fixture((data) => { data[`repos/${platform}/commits/v0.1.159`].sha = candidate; }).args)).rejects.toThrow(/production/);
  for (const endpoint of [`repos/${repos[0]}/pulls/1`, `repos/${repos[0]}/commits/main`]) {
    const { args } = fixture(); const read = args.read; let count = 0;
    args.read = async (repo, route) => {
      const value = await read(repo, route);
      if (route === endpoint && ++count === 3) { if (value.head) value.head.sha = old; else value.sha = old; }
      return value;
    };
    await expect(gate(args)).rejects.toThrow(/changed/);
  }
});
test("production pins cannot partially adopt the candidate before promotion", async () => {
  for (const rel of ["Gemfile", "Gemfile.lock", ".github/workflows/e2e-tests.yml"]) {
    const { args } = fixture((data) => {
      data[`repos/${repos[0]}/contents/${rel}?ref=${main}`] = data[`repos/${repos[0]}/contents/${rel}?ref=${head}`];
    });
    await expect(gate(args)).rejects.toThrow();
  }
});
test("green aggregate cannot hide incomplete or skipped work", async () => {
  for (const name of ["site-verify / verify", `e2e / project (${slots[0].slot})`]) {
    for (const conclusion of ["missing", "skipped"]) {
      const { args } = fixture((data) => {
        const checks = data[checksKey()].check_runs;
        if (conclusion === "missing") data[checksKey()].check_runs = checks.filter((c) => c.name !== name);
        else checks.find((c) => c.name === name).conclusion = conclusion;
      });
      await expect(gate(args)).rejects.toThrow();
    }
  }
});
test("successful work jobs require their actual validation steps", async () => {
  for (const name of [`e2e / project (${slots[0].slot})`, "site-verify / verify"]) {
    for (const conclusion of ["missing", "skipped", "failure", "cancelled"]) {
      const { args } = fixture((data) => {
        const check = data[checksKey(repos[1])].check_runs.find((c) => c.name === name);
        const job = data[`repos/${repos[1]}/actions/jobs/${check.id}`];
        const stepName = name.startsWith("e2e") ? "Run Playwright suite" : "Run the site's verifier";
        if (conclusion === "missing") job.steps = job.steps.filter((step) => step.name !== stepName);
        else job.steps.find((step) => step.name === stepName).conclusion = conclusion;
      });
      await expect(gate(args)).rejects.toThrow(/step/);
    }
  }
});
test("work validation cannot be spoofed by statuses, another app, or another head's job", async () => {
  for (const change of [
    (data, check) => { check.app.id = 5; },
    (data, check) => { data[`repos/${repos[0]}/actions/jobs/${check.id}`].head_sha = old; },
    (data, check) => { check.details_url = "https://example.com/job/1"; },
    (data, check) => { check.details_url = `https://github.com/${repos[1]}/actions/runs/1/job/1`; },
  ]) await expect(gate(fixture((data) => change(data,
    data[checksKey()].check_runs.find((c) => c.name.startsWith("e2e / project")))).args)).rejects.toThrow();
});
test("candidate harness input cannot default to main or another repository", async () => {
  for (const replacement of ["", `platform_ref: ${old}`, `platform_ref: ${candidate}\n      platform_repo: example/other`]) {
    await expect(gate(fixture((data) => {
      const key = `repos/${repos[0]}/contents/.github/workflows/e2e-tests.yml?ref=${head}`;
      data[key] = file(Buffer.from(data[key].content, "base64").toString().replace(`platform_ref: ${candidate}`, replacement));
    }).args)).rejects.toThrow();
  }
});
test("theme source must contain unique exact revision and ref fields", () => {
  for (const text of [gem().replace("  specs:", `  ref: ${candidate}\n  specs:`),
    gem().replace("  specs:", `  tag: ${old}\n  specs:`), gem().replace("  specs:", `  branch: main\n  specs:`)]) {
    expect(() => gemPin(text, platform, candidate)).toThrow();
  }
});
test("optional actuator skips are allowed but optional failures are refused", async () => {
  for (const conclusion of ["skipped", "failure", "cancelled"]) {
    const { args } = fixture((data) => { data[checksKey()].check_runs.push({ id: 100, name: "optional actuator", head_sha: head, app: { id: ACTIONS_APP }, status: "completed", conclusion }); });
    if (conclusion === "skipped") expect((await gate(args)).ok).toBe(true);
    else await expect(gate(args)).rejects.toThrow();
  }
});
test("malformed rules, file data, and local validation callers fail closed", async () => {
  for (const modify of [
    (data) => { data[`repos/${repos[0]}/rules/branches/main`] = []; },
    (data) => { data[`repos/${repos[0]}/contents/platform.lock?ref=${head}`] = {}; },
    (data) => {
      const key = `repos/${repos[0]}/contents/.github/workflows/e2e-tests.yml?ref=${head}`;
      data[key] = file(Buffer.from(data[key].content, "base64").toString().replace("target: local", "target: prod"));
    },
  ]) await expect(gate(fixture(modify).args)).rejects.toThrow();
});
test("stable tag creation follows validation and report upload; prereleases bypass both gates and fanout", () => {
  const workflow = parseYaml(fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8"));
  expect(workflow.jobs.release["continue-on-error"]).toBeUndefined();
  const steps = workflow.jobs.release.steps;
  const gateIndex = steps.findIndex((s) => s.run === "node scripts/release-candidate-gate.js");
  const uploadIndex = steps.findIndex((s) => s.with?.name === "release-candidate-results");
  const tagIndex = steps.findIndex((s) => s.name === "Create the release");
  expect(gateIndex).toBeGreaterThan(0);
  expect(uploadIndex).toBeGreaterThan(gateIndex);
  expect(tagIndex).toBeGreaterThan(uploadIndex);
  expect(steps[gateIndex].if).toBe("${{ inputs.prerelease != true }}");
  expect(steps[gateIndex]["continue-on-error"]).toBeUndefined();
  expect(steps[tagIndex].if).toBeUndefined();
  expect(steps[uploadIndex].if).toBe("${{ always() && inputs.prerelease != true }}");
  expect(steps[uploadIndex].with["if-no-files-found"]).toBe("error");
  expect(steps.find((s) => s.name === "Fan out bump dispatches to consumers").if).toBe("${{ inputs.prerelease != true }}");
});
test("CLI reads only mocked GET endpoints and writes a sanitized report on pass and failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-cli-"));
  try {
    fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[0] !== 'api' || args[1] !== '--method' || args[2] !== 'GET') process.exit(98);\nconst data = JSON.parse(fs.readFileSync(process.env.MOCK_DATA, 'utf8'));\nif (!(args[3] in data)) { console.error('sensitive-response-body'); process.exit(1); }\nprocess.stdout.write(JSON.stringify(data[args[3]]));\n`, { mode: 0o755 });
    const reportPath = path.join(dir, "report.json");
    const env = { ...process.env, PATH: [process.env.PATH.split(path.delimiter)[0], dir, ...process.env.PATH.split(path.delimiter).slice(1)].join(path.delimiter), GH_TOKEN: "", TOKEN_ADAMDANIEL_AI: "", TOKEN_JODIDANIEL_COM: "", GH_REPO: platform, CANDIDATE_SHA: candidate, VERSION: "v0.1.160", CANDIDATE_ADAMDANIEL_AI_PR: "1", CANDIDATE_JODIDANIEL_COM_PR: "1", MOCK_DATA: path.join(dir, "data.json"), CANDIDATE_REPORT: reportPath };
    fs.writeFileSync(env.MOCK_DATA, JSON.stringify(fixture().data));
    const pass = spawnSync(process.execPath, ["scripts/release-candidate-gate.js"], { cwd: ROOT, env, encoding: "utf8" });
    expect(pass.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(reportPath)).ok).toBe(true);
    fs.writeFileSync(env.MOCK_DATA, "{}");
    const fail = spawnSync(process.execPath, ["scripts/release-candidate-gate.js"], { cwd: ROOT, env, encoding: "utf8" });
    expect(fail.status).toBe(1);
    expect(fail.stderr).not.toContain("sensitive-response-body");
    expect(JSON.parse(fs.readFileSync(reportPath)).ok).toBe(false);
    const badReport = spawnSync(process.execPath, ["scripts/release-candidate-gate.js"], { cwd: ROOT, env: { ...env, CANDIDATE_REPORT: path.join(dir, "missing/report.json") }, encoding: "utf8" });
    expect(badReport.status).toBe(1);
    expect(badReport.stderr).toContain("Could not write");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
