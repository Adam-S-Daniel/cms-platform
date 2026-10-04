// Run one workflow step's `run:` script under bash, the way a GitHub-hosted
// runner does, so a test can assert what the step DOES instead of guessing
// at its shape from the YAML. Offline and deterministic: the caller supplies
// the working directory, the environment and (optionally) stub executables.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listWorkflows, readWorkflow, parseYaml } = require("./workflow-yaml-utils");

// Every step of every workflow whose `run:` script satisfies `matches`, as
// { workflow, job, step } — found by parsing the YAML, not by scanning text.
function findRunSteps(matches) {
  const found = [];
  for (const file of listWorkflows()) {
    const workflow = path.basename(file);
    const wf = parseYaml(readWorkflow(workflow));
    for (const [job, def] of Object.entries((wf && wf.jobs) || {})) {
      for (const step of (def && def.steps) || []) {
        if (step && typeof step.run === "string" && matches(step.run)) found.push({ workflow, job, step });
      }
    }
  }
  return found;
}

// A directory of executable stubs: `stubs` maps a command name to its
// `/bin/sh` body. Returns the directory, to be put first on PATH.
function writeStubs(dir, stubs) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(stubs)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

// Execute `step.run` with the default Linux shell GitHub uses
// (`bash --noprofile --norc -e -o pipefail`). Every key the step binds in
// `env:` is set from `stepEnv` (the `${{ ... }}` expressions are not
// evaluated here, so the test supplies the values). `GITHUB_OUTPUT` points
// at a fresh file under `scratch`; its content comes back as `output`.
function runStep(step, { cwd, scratch, env, stepEnv = {} }) {
  if (step.shell) throw new Error(`step ${step.name} sets shell: ${step.shell}; the harness runs bash`);
  fs.mkdirSync(scratch, { recursive: true });
  const script = path.join(scratch, "step.sh");
  const outputFile = path.join(scratch, "github_output");
  fs.writeFileSync(script, step.run);
  fs.writeFileSync(outputFile, "");
  const bound = {};
  for (const key of Object.keys(step.env || {})) {
    if (!(key in stepEnv)) throw new Error(`step ${step.name} reads env ${key}; pass it in stepEnv`);
    bound[key] = stepEnv[key];
  }
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
    cwd,
    encoding: "utf8",
    env: { ...env, ...bound, GITHUB_OUTPUT: outputFile, GITHUB_WORKSPACE: cwd, RUNNER_TEMP: scratch },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    output: fs.readFileSync(outputFile, "utf8"),
  };
}

module.exports = { findRunSteps, writeStubs, runStep };
