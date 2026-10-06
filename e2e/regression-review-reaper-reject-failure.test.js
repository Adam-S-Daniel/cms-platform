// @lane: local — parsed platform workflow step executed with an offline `gh` stub.
// cms-platform#788: a failed reject of a superseded run's pending deployment
// (HTTP 403 from a reviewer PAT without access) used to be swallowed into a
// ::warning:: and the job went green. The reaper now re-reads the run's pending
// deployments: still waiting is an ::error:: and a red job, already resolved
// stays a notice and a green job.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox } = require("./git-fixture");
const { findRunSteps, writeStubs, runStep } = require("./workflow-step-harness");

const WORKFLOW = "regression-review-reaper.yml";
const RUN_ID = "37463094549";
const ENV_ID = "15976001510";
let sb;
test.afterEach(() => sb && sb.cleanup());

// A `gh` stub keyed on the argument shape the step uses. `reject` is the exit
// status and stderr of the POST; `reread` is what the second pending_deployments
// GET prints (an environment id when still waiting, nothing when resolved) and
// its exit status.
function execute({ rejectExit, rejectErr, rereadOut = "", rereadExit = 0, token = "pat" }) {
  sb = createSandbox("regression-review-reaper-");
  const rows = Buffer.from(JSON.stringify({ id: Number(RUN_ID), head_sha: "f".repeat(40) })).toString("base64");
  const bin = writeStubs(path.join(sb.root, "bin"), {
    gh: `
case "$*" in
  *"-X POST"*) echo "${rejectErr}" >&2; exit ${rejectExit} ;;
  *"actions/runs?"*|*"actions/runs "*|*"--paginate"*) echo "${rows}" ;;
  *"environment.id =="*) printf '%s' "${rereadOut}"; exit ${rereadExit} ;;
  *"pending_deployments"*) echo "${ENV_ID}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac`,
  });
  const found = findRunSteps(() => true).find(
    (s) => s.workflow === WORKFLOW && s.step.name === "Reject superseded regression-review deployments",
  );
  expect(found, "reaper step").toBeTruthy();
  return runStep(found.step, {
    cwd: sb.root,
    scratch: path.join(sb.root, "run"),
    env: { ...sb.env, PATH: `${bin}:${sb.env.PATH}` },
    stepEnv: {
      GH_TOKEN: token,
      GH_REPO: "example/site",
      WF: "visual-regression.yml",
      ENVNAME: "regression-review",
      HEAD_REF: "feature/x",
      KEEP_SHA: "a".repeat(40),
      ACTION: "synchronize",
      PR_NUMBER: "382",
    },
  });
}

const FORBIDDEN = "gh: Resource not accessible by personal access token (HTTP 403)";

test("403 on reject while the deployment is still waiting fails the job with an ::error::", () => {
  const r = execute({ rejectExit: 1, rejectErr: FORBIDDEN, rereadOut: ENV_ID });
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stdout).toMatch(new RegExp(`::error::failed to reject run ${RUN_ID} env ${ENV_ID} \\(HTTP 403\\); the deployment is still waiting`));
  expect(r.stdout).not.toContain("::warning::");
  expect(r.stdout).toContain("::error::Reap incomplete");
  // The log names the reviewer requirement and the docs, and does not prescribe a scope.
  expect(r.stdout).toContain("required reviewer of 'regression-review'");
  expect(r.stdout).toContain("https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens");
  expect(r.stdout).toContain("Deployments: write");
  expect(r.stdout).not.toContain("Actions: write");
  // The error body is never echoed; only the status is.
  expect(r.stdout).not.toContain("Resource not accessible");
});

test("403 on reject when the deployment is already resolved stays green", () => {
  const r = execute({ rejectExit: 1, rejectErr: FORBIDDEN, rereadOut: "" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toMatch(new RegExp(`::notice::reject of run ${RUN_ID} env ${ENV_ID} failed \\(HTTP 403\\) but the deployment is no longer pending`));
  expect(r.stdout).not.toContain("::error::");
  expect(r.stdout).toContain("::notice::Reap complete.");
});

test("a failed reject whose re-read also fails cannot confirm resolution and fails the job", () => {
  const r = execute({ rejectExit: 1, rejectErr: FORBIDDEN, rereadExit: 1 });
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stdout).toMatch(/::error::failed to reject run \d+ env \d+ \(HTTP 403\) and could not re-read/);
});

test("a successful reject stays green with no error", () => {
  const r = execute({ rejectExit: 0, rejectErr: "" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).not.toContain("::error::");
  expect(r.stdout).not.toContain("::warning::");
  expect(r.stdout).toContain("::notice::Reap complete.");
});

test("an unset reviewer PAT is still a clean no-op", () => {
  const r = execute({ rejectExit: 1, rejectErr: FORBIDDEN, token: "" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain("nothing to reap");
});
