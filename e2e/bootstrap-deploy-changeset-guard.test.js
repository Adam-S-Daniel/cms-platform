// @lane: local — runs the real infrastructure/bootstrap/deploy.sh under a stub
// `aws` executable in a sealed environment. No network, no AWS.
//
// THE GAPS
//   - v0.1.125 grew infrastructure/bootstrap/template.yaml to 60,694 bytes, and
//     deploy.sh sent it inline: the AWS CLI refuses a template over 51,200
//     bytes, so the documented per-site deploy failed for every site. The
//     script now deploys a minified copy (minify-template.rb, locked by
//     bootstrap-template-minify.test.js) and stops before any aws call if that
//     copy is still over the limit.
//   - deploy.sh passes every parameter explicitly from its own defaults, so a
//     run missing CREATE_APEX_DNS_RECORDS=true removes a live apex's records
//     and a run without ADMIN_DOMAIN removes the admin host. The script now
//     creates a change set, prints it, and refuses to execute one that removes
//     or replaces a resource unless ALLOW_DESTRUCTIVE_CHANGES=1.
//   - site-params.env exports STACK_NAME for the OAuth proxy stack, and the
//     delegating wrapper sources it, so the bootstrap script used to inherit
//     the proxy's name. On a new site that CREATES the bootstrap stack under
//     the proxy's name: all Add actions, which the guard cannot catch. The
//     bootstrap stack is now named by BOOTSTRAP_STACK_NAME (default
//     <prefix>-bootstrap), the wrapper hands on no STACK_NAME from the file,
//     and the script refuses a bootstrap name equal to the file's STACK_NAME.
//
// WHAT THIS FILE PROVES (the stub plays back canned change-set JSON)
//   - Add/Modify only: executed, then waited on (update or create waiter);
//   - a Remove, a Replacement True or a Replacement Conditional: refused, and
//     execute-change-set is never called;
//   - ALLOW_DESTRUCTIVE_CHANGES=1 lets a destructive change set through; any
//     other value does not;
//   - an empty change set exits 0 without describing or executing anything;
//   - fail closed: a Dynamic, unknown or missing action is refused like a
//     Remove, and a response with no Changes list or with a NextToken (a page
//     left unread) is refused outright, whatever ALLOW_DESTRUCTIVE_CHANGES says;
//   - output with neither a change set ARN nor "No changes": refused;
//   - an over-size or unparseable template is refused before ANY aws call;
//   - stack name: the default and the documented `STACK_NAME=` and
//     `STACK_NAME=<prefix>-bootstrap` invocations target <prefix>-bootstrap;
//     the proxy's STACK_NAME is never sent as --stack-name, directly or through
//     the wrapper; any other STACK_NAME, and a bootstrap name equal to
//     site-params.env's STACK_NAME, stop before any aws call;
//   - a stack in a failed state stops with what to do, executing nothing;
//   - creating a stack (REVIEW_IN_PROGRESS after the change set) is refused
//     before execute-change-set unless ALLOW_STACK_CREATE=1 exactly: a create
//     is all Add actions, so a mistyped stack name would pass the guard;
//   - a failed change-set creation never echoes the CLI's message (ARNs);
//   - refusal messages name the change set, never its ARN (account id).
//   - the deploy call sends the minified template inline (no S3), with
//     --no-execute-changeset and the complete parameter list, defaults
//     unchanged (a wrong default deletes DNS records or replaces resources).
//   - AdminCspMode: an unset ADMIN_CSP_MODE keeps the deployed stack's value
//     (a redeploy without it used to put an enforcing site back on
//     report-only), and falls back to report-only only for a new stack or one
//     without the parameter; an explicit value always wins; anything but
//     enforce or report-only, explicit or deployed, stops before the deploy,
//     and so does a describe-stacks failure other than "does not exist".
//
// SEALED: PATH is a stub directory plus a private bin of symlinks to the few
// tools deploy.sh needs, taken from /usr/bin or /bin only; the environment is
// built from scratch (no AWS_PROFILE, no AWS_ACCESS_KEY_ID, no session token),
// the AWS config and credentials files are /dev/null, HOME and TMPDIR are
// scratch directories. beforeAll refuses to run deploy.sh at all unless
// `command -v aws` resolves to the stub. Same approach as
// oauth-proxy-deploy-credentials.test.js.
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: it runs this repo's
// infrastructure/bootstrap/deploy.sh, which a consumer ships as a delegating
// wrapper (that wrapper `exec`s this script).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const BOOTSTRAP = path.join(REPO_ROOT, "infrastructure", "bootstrap");
const DEPLOY = path.join(BOOTSTRAP, "deploy.sh");
const MINIFIER = path.join(BOOTSTRAP, "minify-template.rb");
const TEMPLATE = path.join(BOOTSTRAP, "template.yaml");
const INLINE_LIMIT_BYTES = 51200;
const STACK = "example-test-bootstrap";
// What a site-params.env fixture exports for the OAuth proxy stack.
const PROXY_STACK = "example-oauth-proxy";
const CHANGESET_NAME = "awscli-cloudformation-package-deploy-1";
const ACCOUNT_ID = "000000000000";
const CHANGESET_ARN =
  "arn:aws:cloudformation:us-east-1:000000000000:changeSet/awscli-cloudformation-package-deploy-1/00000000-0000-0000-0000-000000000000";

// The complete parameter list with its defaults, for the sealed environment
// below (APEX_DOMAIN example.test, GITHUB_REPO example-repo, HOSTED_ZONE_ID
// Z123EXAMPLE, nothing else set). Unchanged by the guard: it must not add
// per-parameter special cases or move a default.
const EXPECTED_PARAMETERS = [
  "GitHubOrg=Adam-S-Daniel",
  "GitHubRepo=example-repo",
  "ResourcePrefix=example-test",
  "ArtifactBucketName=example-test-cfn-artifacts",
  "PreviewBucketName=example-test-previews",
  "ProductionBucketName=example-test-production",
  "ProductionDomainName=example.test",
  "CreateOIDCProvider=true",
  "CreateApexDnsRecords=false",
  "HostedZoneId=Z123EXAMPLE",
  "PreviewDomainName=*.example.test",
  "MediaArchiveBucketName=",
  "AdminDomainName=",
  "HstsMaxAgeSeconds=31536000",
  "HstsScope=this-host-only",
  "AdminCspMode=report-only",
];

// The tools deploy.sh runs besides aws (bash builtins aside), plus the
// delegating wrapper's awk and git (it clones a local fixture "platform").
const TOOLS = ["bash", "dirname", "tr", "python3", "ruby", "mktemp", "rm", "wc", "awk", "git"];
const SAFE_DIRS = ["/usr/bin", "/bin"];

// Records every call's argv, keeps a copy of the template `deploy` was handed,
// and answers from STUB_* variables. Builtins only, so the sealed bin stays
// exactly TOOLS.
const STUB = (bash) => `#!${bash}
{ printf 'CALL\\n'; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >>"$STUB_LOG"
case "$*" in
  "cloudformation deploy "*)
    prev=""
    for a in "$@"; do
      [[ "$prev" == "--template-file" ]] && printf '%s\\n' "$(<"$a")" >"$STUB_TEMPLATE_COPY"
      prev="$a"
    done
    case "$STUB_DEPLOY" in
      empty) printf '\\nNo changes to deploy. Stack is up to date\\n' ;;
      garbled) echo "something unexpected" ;;
      fail) echo "An error occurred (AccessDenied) when calling the CreateChangeSet operation: User: arn:aws:iam::000000000000:user/example is not authorized" >&2; exit 254 ;;
      failed-state) printf '\\nAn error occurred (ValidationError) when calling the CreateChangeSet operation: Stack:arn:aws:cloudformation:us-east-1:000000000000:stack/example/00000000-0000-0000-0000-000000000000 is in %s state and can not be updated.\\n' "$STUB_FAILED_STATE" >&2; exit 254 ;;
      *) printf 'Waiting for changeset to be created..\\nChangeset created successfully. Run the following command to review changes:\\naws cloudformation describe-change-set --change-set-name %s\\n' "$STUB_ARN" ;;
    esac ;;
  "cloudformation describe-change-set "*) printf '%s\\n' "$(<"$STUB_CHANGESET_JSON")" ;;
  "cloudformation describe-stacks "*"ParameterKey=='AdminCspMode'"*)
    case "\${STUB_DEPLOYED_CSP-report-only}" in
      missing-stack) echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id example does not exist" >&2; exit 254 ;;
      denied) echo "An error occurred (AccessDenied) when calling the DescribeStacks operation: User: arn:aws:iam::000000000000:user/example is not authorized" >&2; exit 254 ;;
      no-param) echo "" ;;
      *) echo "\${STUB_DEPLOYED_CSP-report-only}" ;;
    esac ;;
  "cloudformation describe-stacks "*"Stacks[0].StackStatus"*) echo "\${STUB_STACK_STATUS-UPDATE_COMPLETE}" ;;
  "cloudformation execute-change-set "*) exit 0 ;;
  "cloudformation wait "*) exit 0 ;;
  "cloudformation describe-stacks "*"Stacks[0].Outputs"*) echo '[{"OutputKey":"RoleArn","OutputValue":"arn:aws:iam::000000000000:role/example"}]' ;;
  *) echo "unexpected aws call" >&2; exit 99 ;;
esac
`;

let scratch;
let stubDir;
let binDir;
let bash;
let emptyCwd;
let siteCwd;
let siteDir;
let platformRepo;

// A site-params.env fixture: what the scaffolder writes, with the OAuth proxy
// stack's STACK_NAME. Never a real site's file.
const SITE_PARAMS = `export GITHUB_REPO="example-repo"
export APEX_DOMAIN="example.com"
export HOSTED_ZONE_ID="Z123EXAMPLE"
export ALLOWED_ORIGINS="https://example.com"
export STACK_NAME="${PROXY_STACK}"
`;

test.beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-deploy-guard-"));
  stubDir = path.join(scratch, "stubs");
  binDir = path.join(scratch, "bin");
  for (const d of [stubDir, binDir, path.join(scratch, "home"), path.join(scratch, "tmp")]) fs.mkdirSync(d);
  for (const tool of TOOLS) {
    const dir = SAFE_DIRS.find((d) => fs.existsSync(path.join(d, tool)));
    if (!dir) throw new Error(`${tool} not found in ${SAFE_DIRS.join(" or ")}`);
    fs.symlinkSync(path.join(dir, tool), path.join(binDir, tool));
  }
  bash = path.join(binDir, "bash");
  fs.writeFileSync(path.join(stubDir, "aws"), STUB(fs.realpathSync(bash)), { mode: 0o755 });
  emptyCwd = path.join(scratch, "cwd");
  fs.mkdirSync(emptyCwd);
  // A site root holding only the fixture site-params.env, for direct runs.
  siteCwd = path.join(scratch, "site-cwd");
  fs.mkdirSync(path.join(siteCwd, "infrastructure"), { recursive: true });
  fs.writeFileSync(path.join(siteCwd, "infrastructure", "site-params.env"), SITE_PARAMS);
  // A fixture "platform" repo at a branch the wrapper clones, and a site that
  // carries the delegating wrapper as infrastructure/bootstrap/deploy.sh.
  platformRepo = path.join(scratch, "platform");
  const pb = path.join(platformRepo, "infrastructure", "bootstrap");
  fs.mkdirSync(pb, { recursive: true });
  for (const f of [DEPLOY, MINIFIER, TEMPLATE]) fs.copyFileSync(f, path.join(pb, path.basename(f)));
  const git = (...args) => {
    const g = spawnSync(path.join(binDir, "git"), ["-C", platformRepo, ...args], { env: sealedEnv({}), encoding: "utf8" });
    if (g.status !== 0) throw new Error(`git ${args[0]} failed: ${g.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=Example", "-c", "user.email=ci@example.com", "commit", "-q", "-m", "fixture");
  git("branch", "fixture-ref");
  siteDir = path.join(scratch, "site");
  fs.mkdirSync(path.join(siteDir, "infrastructure", "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(siteDir, "platform.lock"), "platform_repo: example/platform\nplatform_ref: fixture-ref\n");
  fs.writeFileSync(path.join(siteDir, "infrastructure", "site-params.env"), SITE_PARAMS);
  fs.copyFileSync(`${DEPLOY}.delegating`, path.join(siteDir, "infrastructure", "bootstrap", "deploy.sh"));
  // Refuse to run deploy.sh at all unless aws resolves to the stub.
  const seal = spawnSync(bash, ["-c", "command -v aws"], { env: sealedEnv({}), encoding: "utf8" });
  if (seal.stdout !== `${path.join(stubDir, "aws")}\n`) {
    throw new Error("aws does not resolve to the stub; refusing to run deploy.sh");
  }
});

test.afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

// A fresh environment, never process.env: nothing AWS-shaped leaks in.
function sealedEnv(extra) {
  return {
    PATH: `${stubDir}:${binDir}`,
    HOME: path.join(scratch, "home"),
    TMPDIR: path.join(scratch, "tmp"),
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true",
    GITHUB_REPO: "example-repo",
    APEX_DOMAIN: "example.test",
    HOSTED_ZONE_ID: "Z123EXAMPLE",
    AWS_REGION: "us-east-1",
    STUB_LOG: path.join(scratch, "calls.log"),
    STUB_TEMPLATE_COPY: path.join(scratch, "deployed-template.yaml"),
    STUB_CHANGESET_JSON: path.join(scratch, "changeset.json"),
    STUB_ARN: CHANGESET_ARN,
    ...extra,
  };
}

// Each aws call is its argv array.
function readCalls(log) {
  if (!fs.existsSync(log)) return [];
  const calls = [];
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    if (line === "CALL") calls.push([]);
    else if (line.startsWith("ARG\t")) calls[calls.length - 1].push(line.slice(4));
  }
  return calls;
}

// One canned DescribeChangeSet response, shaped like the real API's.
const change = (Action, LogicalResourceId, ResourceType, Replacement) => ({
  Type: "Resource",
  ResourceChange: { Action, LogicalResourceId, ResourceType, ...(Replacement ? { Replacement } : {}) },
});

function runDeploy({ changes = [], changeset, deployScript = DEPLOY, cwd = emptyCwd, ...extra } = {}) {
  const env = sealedEnv(extra);
  for (const f of [env.STUB_LOG, env.STUB_TEMPLATE_COPY]) fs.rmSync(f, { force: true });
  fs.writeFileSync(
    env.STUB_CHANGESET_JSON,
    JSON.stringify(
      changeset ?? { ChangeSetId: CHANGESET_ARN, StackName: STACK, Status: "CREATE_COMPLETE", Changes: changes },
    ),
  );
  // cwd is a scratch dir, so no real infrastructure/site-params.env is read.
  const r = spawnSync(bash, [deployScript], { env, cwd, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stderr: r.stderr, calls: readCalls(env.STUB_LOG) };
}

const callsOf = (calls, sub) => calls.filter((c) => c[0] === "cloudformation" && c[1] === sub);
const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const overrides = (argv) => {
  const rest = argv.slice(argv.indexOf("--parameter-overrides") + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
};

const SAFE_CHANGES = [
  change("Modify", "ProductionDistribution", "AWS::CloudFront::Distribution", "False"),
  change("Add", "BaselineResponseHeadersPolicy", "AWS::CloudFront::ResponseHeadersPolicy"),
];

test("the environment is sealed: aws resolves to the stub, nothing AWS-shaped is set", () => {
  const r = spawnSync(bash, ["-c", "command -v aws; compgen -e"], { env: sealedEnv({}), encoding: "utf8" });
  expect(r.status).toBe(0);
  const lines = r.stdout.split("\n");
  expect(lines[0]).toBe(path.join(stubDir, "aws"));
  for (const name of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    expect(lines.includes(name), `${name} must not be set`).toBe(false);
  }
  expect(fs.readdirSync(binDir).sort()).toEqual([...TOOLS].sort());
});

test("Add/Modify only: the change set is printed, executed and waited on as an update", () => {
  const r = runDeploy({ changes: SAFE_CHANGES });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain("Modify   ProductionDistribution (AWS::CloudFront::Distribution) replacement=False");
  expect(r.out).toContain("Add      BaselineResponseHeadersPolicy (AWS::CloudFront::ResponseHeadersPolicy)");
  expect(r.out).not.toContain("DESTRUCTIVE");
  expect(flagValue(callsOf(r.calls, "describe-change-set")[0], "--change-set-name")).toBe(CHANGESET_ARN);
  const executes = callsOf(r.calls, "execute-change-set");
  expect(executes).toHaveLength(1);
  expect(flagValue(executes[0], "--change-set-name")).toBe(CHANGESET_ARN);
  const waits = callsOf(r.calls, "wait");
  expect(waits).toHaveLength(1);
  expect(waits[0][2]).toBe("stack-update-complete");
  expect(flagValue(waits[0], "--stack-name")).toBe(STACK);
  // Order: create, describe, status, execute, wait, then the outputs.
  const order = r.calls.map((c) => c[1]);
  expect(order.indexOf("execute-change-set")).toBeGreaterThan(order.indexOf("describe-change-set"));
  expect(order.indexOf("wait")).toBeGreaterThan(order.indexOf("execute-change-set"));
});

test("a new stack (REVIEW_IN_PROGRESS after the change set) with ALLOW_STACK_CREATE=1: executed, waits for stack-create-complete", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, STUB_STACK_STATUS: "REVIEW_IN_PROGRESS", ALLOW_STACK_CREATE: "1" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain(`ALLOW_STACK_CREATE=1: creating stack ${STACK}`);
  expect(callsOf(r.calls, "execute-change-set")).toHaveLength(1);
  expect(callsOf(r.calls, "wait")[0][2]).toBe("stack-create-complete");
});

// A create is all Add actions, so a mistyped stack name passes the guard;
// creating a stack therefore needs ALLOW_STACK_CREATE=1, and nothing else.
for (const [name, extra] of [
  ["no ALLOW_STACK_CREATE", {}],
  ["ALLOW_STACK_CREATE=true", { ALLOW_STACK_CREATE: "true" }],
  ["ALLOW_STACK_CREATE=yes", { ALLOW_STACK_CREATE: "yes" }],
  ["ALLOW_STACK_CREATE=0", { ALLOW_STACK_CREATE: "0" }],
  ["ALLOW_STACK_CREATE= (empty)", { ALLOW_STACK_CREATE: "" }],
]) {
  test(`a new stack with ${name}: refused before execute-change-set, change set left for review`, () => {
    const r = runDeploy({ changes: SAFE_CHANGES, STUB_STACK_STATUS: "REVIEW_IN_PROGRESS", ...extra });
    expect(r.status, r.out).not.toBe(0);
    expect(r.stderr).toContain(`stack ${STACK} does not exist`);
    expect(r.stderr).toContain("typo");
    expect(r.stderr).toContain("ALLOW_STACK_CREATE=1");
    expect(r.stderr).toContain(`left for review: ${CHANGESET_NAME} on stack ${STACK}`);
    expect(callsOf(r.calls, "describe-change-set")).toHaveLength(1);
    expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
    expect(callsOf(r.calls, "wait")).toEqual([]);
  });
}

test("an update of an existing stack needs no ALLOW_STACK_CREATE", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, STUB_STACK_STATUS: "UPDATE_COMPLETE" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).not.toContain("ALLOW_STACK_CREATE");
  expect(callsOf(r.calls, "execute-change-set")).toHaveLength(1);
  expect(callsOf(r.calls, "wait")[0][2]).toBe("stack-update-complete");
});

for (const [name, destructive] of [
  ["a Remove", change("Remove", "ProductionDnsRecord", "AWS::Route53::RecordSet")],
  ["Replacement True", change("Modify", "PreviewBucket", "AWS::S3::Bucket", "True")],
  ["Replacement Conditional", change("Modify", "AdminCertificate", "AWS::CertificateManager::Certificate", "Conditional")],
]) {
  test(`${name}: refused, execute-change-set never called`, () => {
    const r = runDeploy({ changes: [...SAFE_CHANGES, destructive] });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain(`${destructive.ResourceChange.LogicalResourceId} (`);
    expect(r.out).toContain("DESTRUCTIVE");
    expect(r.stderr).toContain("Refusing to execute");
    expect(r.stderr).toContain("ALLOW_DESTRUCTIVE_CHANGES=1");
    // Named, not by ARN: the ARN carries the account id.
    expect(r.stderr).toContain(`left for review: ${CHANGESET_NAME} on stack ${STACK}`);
    expect(r.stderr).not.toContain(ACCOUNT_ID);
    expect(callsOf(r.calls, "describe-change-set")).toHaveLength(1);
    expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
    expect(callsOf(r.calls, "wait")).toEqual([]);
  });
}

// Fail closed: anything not positively known to be safe is refused.
for (const [name, unknown] of [
  ["a Dynamic action (a nested stack's unknown)", change("Dynamic", "NestedThing", "AWS::CloudFormation::Stack")],
  ["an action the guard does not know", change("Teleport", "ProductionDistribution", "AWS::CloudFront::Distribution")],
  ["a change with no ResourceChange", { Type: "Resource" }],
]) {
  test(`${name}: refused as destructive, execute-change-set never called`, () => {
    const r = runDeploy({ changes: [...SAFE_CHANGES, unknown] });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("DESTRUCTIVE");
    expect(r.stderr).toContain("Refusing to execute");
    expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
  });
}

for (const [name, changeset] of [
  ["no Changes list", { ChangeSetId: CHANGESET_ARN, Status: "CREATE_COMPLETE" }],
  ["a JSON array", []],
]) {
  test(`a describe-change-set response with ${name}: unreadable, refused even with ALLOW_DESTRUCTIVE_CHANGES=1`, () => {
    const r = runDeploy({ changeset, ALLOW_DESTRUCTIVE_CHANGES: "1" });
    expect(r.status, r.out).not.toBe(0);
    expect(r.stderr).toContain(`Could not read change set ${CHANGESET_NAME} on stack ${STACK}`);
    expect(r.stderr).not.toContain(ACCOUNT_ID);
    expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
    expect(callsOf(r.calls, "wait")).toEqual([]);
  });
}

test("a NextToken (a page left unread): refused even with ALLOW_DESTRUCTIVE_CHANGES=1, saying why and what to do", () => {
  const r = runDeploy({
    changeset: { ChangeSetId: CHANGESET_ARN, Changes: SAFE_CHANGES, NextToken: "page-2" },
    ALLOW_DESTRUCTIVE_CHANGES: "1",
  });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain("NextToken");
  expect(r.stderr).toContain("ALLOW_DESTRUCTIVE_CHANGES=1 does not override this");
  expect(r.stderr).toContain("Inspect every page of the change set by hand");
  expect(r.stderr).toContain(`${CHANGESET_NAME} on stack ${STACK}`);
  expect(r.stderr).not.toContain(ACCOUNT_ID);
  expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
  expect(callsOf(r.calls, "wait")).toEqual([]);
});

test("ALLOW_DESTRUCTIVE_CHANGES=1 lets a destructive change set through", () => {
  const r = runDeploy({
    changes: [change("Remove", "ProductionDnsRecord", "AWS::Route53::RecordSet")],
    ALLOW_DESTRUCTIVE_CHANGES: "1",
  });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain("DESTRUCTIVE");
  expect(r.out).toContain("ALLOW_DESTRUCTIVE_CHANGES=1: executing");
  expect(callsOf(r.calls, "execute-change-set")).toHaveLength(1);
  expect(callsOf(r.calls, "wait")).toHaveLength(1);
});

test("ALLOW_DESTRUCTIVE_CHANGES set to anything but 1 still refuses", () => {
  const r = runDeploy({
    changes: [change("Remove", "ProductionDnsRecord", "AWS::Route53::RecordSet")],
    ALLOW_DESTRUCTIVE_CHANGES: "true",
  });
  expect(r.status, r.out).not.toBe(0);
  expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
});

test("an empty change set exits 0 without describing or executing anything", () => {
  const r = runDeploy({ STUB_DEPLOY: "empty" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain("No changes to deploy");
  expect(callsOf(r.calls, "deploy")).toHaveLength(1);
  expect(callsOf(r.calls, "describe-change-set")).toEqual([]);
  expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
  expect(callsOf(r.calls, "wait")).toEqual([]);
});

test("deploy output with no change set ARN: refused, nothing executed", () => {
  const r = runDeploy({ STUB_DEPLOY: "garbled" });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain("Could not find the change set ARN");
  expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
});

test("creating the change set fails: refused, nothing executed, the CLI's message (with an ARN) not echoed", () => {
  const r = runDeploy({ STUB_DEPLOY: "fail" });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain(`Creating the change set failed for stack ${STACK}`);
  expect(r.stderr).toContain(`aws cloudformation describe-stacks --stack-name ${STACK} --region us-east-1`);
  expect(r.out).not.toContain(ACCOUNT_ID);
  expect(r.out).not.toContain("arn:aws");
  expect(callsOf(r.calls, "describe-change-set")).toEqual([]);
  expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
});

test("deploy sends the minified template inline, never executes, and keeps the complete parameter list", () => {
  const r = runDeploy({ changes: SAFE_CHANGES });
  expect(r.status, r.out).toBe(0);
  const deploys = callsOf(r.calls, "deploy");
  expect(deploys).toHaveLength(1);
  const [deploy] = deploys;
  expect(overrides(deploy)).toEqual(EXPECTED_PARAMETERS);
  expect(flagValue(deploy, "--stack-name")).toBe(STACK);
  expect(flagValue(deploy, "--region")).toBe("us-east-1");
  expect(flagValue(deploy, "--capabilities")).toBe("CAPABILITY_NAMED_IAM");
  // Nothing but the known flags (so a new one cannot slip in unreviewed); no S3.
  expect(deploy.filter((a) => a.startsWith("--")).sort()).toEqual(
    [
      "--capabilities",
      "--no-execute-changeset",
      "--no-fail-on-empty-changeset",
      "--parameter-overrides",
      "--region",
      "--stack-name",
      "--template-file",
    ].sort(),
  );
  // The file handed to deploy is the minifier's output, inside the limit, and
  // not the raw template.
  expect(flagValue(deploy, "--template-file")).not.toBe("template.yaml");
  const sent = fs.readFileSync(sealedEnv({}).STUB_TEMPLATE_COPY);
  expect(sent.length).toBeLessThanOrEqual(INLINE_LIMIT_BYTES);
  const out = path.join(scratch, "expected-min.yaml");
  const m = spawnSync(path.join(binDir, "ruby"), [MINIFIER, TEMPLATE, out], { env: sealedEnv({}), encoding: "utf8" });
  expect(m.status, m.stderr).toBe(0);
  expect(sent.toString("utf8")).toBe(fs.readFileSync(out, "utf8"));
  // Its temp directory is gone once the script exits.
  expect(fs.readdirSync(path.join(scratch, "tmp"))).toEqual([]);
});

test("the parameters keep passing through when a site sets them", () => {
  const r = runDeploy({
    changes: SAFE_CHANGES,
    CREATE_APEX_DNS_RECORDS: "true",
    ADMIN_DOMAIN: "admin.example.test",
    MEDIA_ARCHIVE_BUCKET: "example-test-media-archive",
    ADMIN_CSP_MODE: "enforce",
  });
  expect(r.status, r.out).toBe(0);
  const params = overrides(callsOf(r.calls, "deploy")[0]);
  expect(params).toContain("CreateApexDnsRecords=true");
  expect(params).toContain("AdminDomainName=admin.example.test");
  expect(params).toContain("MediaArchiveBucketName=example-test-media-archive");
  expect(params).toContain("AdminCspMode=enforce");
});

// The script reads ./template.yaml next to itself, so a copy of the script
// and the minifier beside a synthetic template exercises the refusals without
// any test-only switch in deploy.sh.
function deployBeside(dirName, templateText) {
  const dir = path.join(scratch, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(DEPLOY, path.join(dir, "deploy.sh"));
  fs.copyFileSync(MINIFIER, path.join(dir, "minify-template.rb"));
  fs.writeFileSync(path.join(dir, "template.yaml"), templateText);
  return path.join(dir, "deploy.sh");
}

test("a template still over 51,200 bytes after minifying is refused before any aws call", () => {
  // Content, not comments: a block scalar the minifier must keep whole.
  const body = Array.from({ length: 700 }, (_, i) => `  line ${i} ${"x".repeat(80)}`).join("\n");
  const big = `AWSTemplateFormatVersion: '2010-09-09'\nDescription: |\n${body}\nResources: {}\n`;
  const r = runDeploy({ deployScript: deployBeside("oversize", big), HOSTED_ZONE_ID: "" });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain(`over the ${INLINE_LIMIT_BYTES}-byte limit`);
  expect(r.calls).toEqual([]);
});

test("a template the minifier cannot parse is refused before any aws call", () => {
  const r = runDeploy({ deployScript: deployBeside("unparseable", "Resources: [unclosed\n"), HOSTED_ZONE_ID: "" });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain("Could not minify template.yaml");
  expect(r.calls).toEqual([]);
});

// ── Stack name: never the OAuth proxy's STACK_NAME from site-params.env ─────
const stackNamesSent = (calls) =>
  calls.map((c) => flagValue(c, "--stack-name")).filter((v) => v !== undefined);

for (const [name, extra] of [
  ["no STACK_NAME (the default)", {}],
  ["STACK_NAME= (the documented empty form)", { STACK_NAME: "" }],
  ["STACK_NAME=<prefix>-bootstrap (docs/MEDIA-ARCHIVE.md's form)", { STACK_NAME: STACK }],
  ["BOOTSTRAP_STACK_NAME=<prefix>-bootstrap", { BOOTSTRAP_STACK_NAME: STACK }],
]) {
  test(`${name}: every aws call targets ${STACK}`, () => {
    const r = runDeploy({ changes: SAFE_CHANGES, ...extra });
    expect(r.status, r.out).toBe(0);
    const names = stackNamesSent(r.calls);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set([STACK]));
  });
}

test("BOOTSTRAP_STACK_NAME names a non-default bootstrap stack, and wins over STACK_NAME", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, BOOTSTRAP_STACK_NAME: "example-custom-bootstrap", STACK_NAME: PROXY_STACK });
  expect(r.status, r.out).toBe(0);
  expect(new Set(stackNamesSent(r.calls))).toEqual(new Set(["example-custom-bootstrap"]));
});

test("any other STACK_NAME, with no site-params.env to explain it: refused before any aws call, naming BOOTSTRAP_STACK_NAME", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, STACK_NAME: PROXY_STACK });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain("no longer reads STACK_NAME");
  expect(r.stderr).toContain("BOOTSTRAP_STACK_NAME");
  expect(r.calls).toEqual([]);
});

test("run directly from a site root after sourcing site-params.env: the proxy's STACK_NAME is ignored", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, cwd: siteCwd, STACK_NAME: PROXY_STACK });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain(`Ignoring STACK_NAME=${PROXY_STACK}`);
  expect(stackNamesSent(r.calls)).not.toContain(PROXY_STACK);
  expect(new Set(stackNamesSent(r.calls))).toEqual(new Set([STACK]));
});

for (const [name, viaEnv] of [
  ["found in ./infrastructure", false],
  ["named by SITE_PARAMS_FILE", true],
]) {
  test(`a bootstrap stack name equal to site-params.env's STACK_NAME (${name}): refused before any aws call`, () => {
    // Paths exist only once beforeAll has run.
    const extra = viaEnv
      ? { SITE_PARAMS_FILE: path.join(siteCwd, "infrastructure", "site-params.env") }
      : { cwd: siteCwd };
    const r = runDeploy({ changes: SAFE_CHANGES, BOOTSTRAP_STACK_NAME: PROXY_STACK, ...extra });
    expect(r.status, r.out).not.toBe(0);
    expect(r.stderr).toContain(`Refusing: the bootstrap stack name ${PROXY_STACK} is the STACK_NAME in`);
    expect(r.calls).toEqual([]);
  });
}

test("a SITE_PARAMS_FILE that does not exist: refused before any aws call", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, SITE_PARAMS_FILE: path.join(scratch, "missing.env") });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain("does not exist");
  expect(r.calls).toEqual([]);
});

// The wrapper sources the fixture site-params.env (STACK_NAME = the proxy's)
// and execs the platform script it cloned from the fixture repo.
function runWrapper(extra = {}) {
  return runDeploy({
    changes: SAFE_CHANGES,
    deployScript: path.join(siteDir, "infrastructure", "bootstrap", "deploy.sh"),
    cwd: siteDir,
    PLATFORM_URL: `file://${platformRepo}`,
    APEX_DOMAIN: "",
    GITHUB_REPO: "",
    ...extra,
  });
}

for (const [name, extra] of [
  ["run plainly", {}],
  ["after the shell sourced site-params.env (the scaffolder's original step 4)", { STACK_NAME: PROXY_STACK }],
]) {
  test(`the delegating wrapper, ${name}: never sends the proxy's STACK_NAME as --stack-name`, () => {
    const r = runWrapper(extra);
    expect(r.status, r.out).toBe(0);
    const names = stackNamesSent(r.calls);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain(PROXY_STACK);
    // site-params.env's APEX_DOMAIN example.com -> the default bootstrap name.
    expect(new Set(names)).toEqual(new Set(["example-com-bootstrap"]));
    expect(callsOf(r.calls, "execute-change-set")).toHaveLength(1);
  });
}

test("the delegating wrapper with BOOTSTRAP_STACK_NAME set to the proxy's name: refused before any aws call", () => {
  const r = runWrapper({ BOOTSTRAP_STACK_NAME: PROXY_STACK });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain(`Refusing: the bootstrap stack name ${PROXY_STACK} is the STACK_NAME in`);
  expect(r.calls).toEqual([]);
});

// ── A stack in a failed state cannot take a change set ─────────────────────
const DELETE_FAILED_STACK = `delete the failed stack first (aws cloudformation delete-stack --stack-name ${STACK} --region us-east-1, then wait for the delete to finish)`;
for (const [state, advice] of [
  ["ROLLBACK_COMPLETE", DELETE_FAILED_STACK],
  ["CREATE_FAILED", DELETE_FAILED_STACK],
  ["UPDATE_ROLLBACK_FAILED", "Fix the rollback first"],
]) {
  test(`a stack in ${state}: stops, executes nothing, and says what to do`, () => {
    const r = runDeploy({ STUB_DEPLOY: "failed-state", STUB_FAILED_STATE: state });
    expect(r.status, r.out).not.toBe(0);
    expect(r.stderr).toContain(`Stack ${STACK} is in ${state}`);
    expect(r.stderr).toContain(advice);
    // The CLI's message (stack ARN, account id) is not echoed.
    expect(r.stderr).not.toContain(ACCOUNT_ID);
    expect(callsOf(r.calls, "deploy")).toHaveLength(1);
    expect(callsOf(r.calls, "describe-change-set")).toEqual([]);
    expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
    expect(callsOf(r.calls, "wait")).toEqual([]);
    // The command is printed for the operator, never run by the script.
    expect(callsOf(r.calls, "delete-stack")).toEqual([]);
  });
}

// ── Stack status before execute: an allow-list, not "anything but a create" ──
for (const status of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_COMPLETE"]) {
  test(`stack status ${status}: executed as an update, no ALLOW_STACK_CREATE needed`, () => {
    const r = runDeploy({ changes: SAFE_CHANGES, STUB_STACK_STATUS: status });
    expect(r.status, r.out).toBe(0);
    expect(callsOf(r.calls, "execute-change-set")).toHaveLength(1);
    expect(callsOf(r.calls, "wait")[0][2]).toBe("stack-update-complete");
  });
}

for (const [status, token] of [
  ["", "unreadable"],
  ["None", "unreadable"],
  ["ZZZ", "ZZZ"],
  ["UPDATE_IN_PROGRESS", "UPDATE_IN_PROGRESS"],
]) {
  test(`stack status ${JSON.stringify(status)}: refused before execute-change-set`, () => {
    const r = runDeploy({ changes: SAFE_CHANGES, STUB_STACK_STATUS: status, ALLOW_STACK_CREATE: "1" });
    expect(r.status, r.out).not.toBe(0);
    expect(r.stderr).toContain(`stack ${STACK} has status ${token},`);
    expect(r.stderr).toContain(`left for review: ${CHANGESET_NAME} on stack ${STACK}`);
    expect(callsOf(r.calls, "execute-change-set")).toEqual([]);
    expect(callsOf(r.calls, "wait")).toEqual([]);
  });
}

// ── AdminCspMode: an unset ADMIN_CSP_MODE keeps what is deployed ───────────
const cspQueries = (calls) =>
  callsOf(calls, "describe-stacks").filter((c) => (flagValue(c, "--query") || "").includes("AdminCspMode"));
const cspSent = (r) => overrides(callsOf(r.calls, "deploy")[0]).filter((p) => p.startsWith("AdminCspMode="));

test("ADMIN_CSP_MODE unset, deployed stack enforces: enforce is kept, not downgraded", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, STUB_DEPLOYED_CSP: "enforce" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain("Admin CSP mode: enforce (kept from deployed stack)");
  expect(cspSent(r)).toEqual(["AdminCspMode=enforce"]);
  const [q] = cspQueries(r.calls);
  expect(flagValue(q, "--stack-name")).toBe(STACK);
  expect(flagValue(q, "--region")).toBe("us-east-1");
  // Read before the change set is created.
  expect(r.calls.indexOf(q)).toBeLessThan(r.calls.indexOf(callsOf(r.calls, "deploy")[0]));
});

for (const [name, deployed, reason] of [
  ["a new stack (describe-stacks: does not exist)", "missing-stack", `stack ${STACK} does not exist yet`],
  ["a deployed stack without the parameter", "no-param", "the deployed stack has no AdminCspMode parameter"],
  ["a deployed stack answering None", "None", "the deployed stack has no AdminCspMode parameter"],
]) {
  test(`ADMIN_CSP_MODE unset, ${name}: falls back to report-only`, () => {
    const r = runDeploy({ changes: SAFE_CHANGES, STUB_DEPLOYED_CSP: deployed });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Admin CSP mode: report-only (default: ${reason})`);
    expect(cspQueries(r.calls)).toHaveLength(1);
    expect(cspSent(r)).toEqual(["AdminCspMode=report-only"]);
  });
}

for (const [explicit, deployed] of [
  ["report-only", "enforce"],
  ["enforce", "report-only"],
]) {
  test(`ADMIN_CSP_MODE=${explicit} over a deployed ${deployed}: the explicit value wins, no lookup`, () => {
    const r = runDeploy({ changes: SAFE_CHANGES, ADMIN_CSP_MODE: explicit, STUB_DEPLOYED_CSP: deployed });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Admin CSP mode: ${explicit} (set by ADMIN_CSP_MODE)`);
    expect(cspSent(r)).toEqual([`AdminCspMode=${explicit}`]);
    expect(cspQueries(r.calls)).toEqual([]);
  });
}

for (const value of ["Enforce", "enforced", "report_only", "off"]) {
  test(`ADMIN_CSP_MODE=${value}: refused before any aws call`, () => {
    const r = runDeploy({ changes: SAFE_CHANGES, ADMIN_CSP_MODE: value });
    expect(r.status, r.out).not.toBe(0);
    expect(r.stderr).toContain(`ADMIN_CSP_MODE=${value} is not enforce or report-only`);
    expect(r.calls).toEqual([]);
  });
}

test("ADMIN_CSP_MODE unset, deployed stack holds an unexpected value: refused before the change set", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, STUB_DEPLOYED_CSP: "sideways" });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain("AdminCspMode that is not enforce or report-only");
  expect(callsOf(r.calls, "deploy")).toEqual([]);
});

test("ADMIN_CSP_MODE unset, describe-stacks fails for another reason: refused, the CLI's message not echoed", () => {
  const r = runDeploy({ changes: SAFE_CHANGES, STUB_DEPLOYED_CSP: "denied" });
  expect(r.status, r.out).not.toBe(0);
  expect(r.stderr).toContain(`Could not read the deployed AdminCspMode of stack ${STACK}`);
  expect(r.stderr).toContain("ADMIN_CSP_MODE");
  expect(r.out).not.toContain(ACCOUNT_ID);
  expect(callsOf(r.calls, "deploy")).toEqual([]);
});
