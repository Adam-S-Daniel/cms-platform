// @lane: local — runs the real infrastructure/bootstrap/deploy.sh under a stub
// `aws` executable in a sealed environment. No network, no AWS.
//
// THE GAP (found in a real deploy, 2026-10-04): infrastructure/bootstrap/
// template.yaml grew past 51,200 bytes when the response-headers policies
// arrived (v0.1.125), and deploy.sh ran `aws cloudformation deploy
// --template-file template.yaml` with no --s3-bucket. The AWS CLI refuses:
//   Templates with a size greater than 51,200 bytes must be deployed via an
//   S3 Bucket. Please add the --s3-bucket parameter
// so the documented per-site redeploy (docs/ADMIN-AUTH-SECURITY.md, "Rolling
// it out, per site") could not run as written.
//
// WHAT THIS FILE PROVES
//   - LINT: template.yaml is measured in BYTES; once it exceeds the CLI's
//     inline limit, the recorded argv of the real deploy.sh must carry an S3
//     bucket. (The shape is read off the argv the script actually emits, not
//     off its source text.)
//   - existing stack: deploy gets --s3-bucket <artifact bucket> and
//     --s3-prefix bootstrap-templates;
//   - missing stack, TEMPLATE_S3_BUCKET unset: refused with a message naming
//     TEMPLATE_S3_BUCKET, and NO deploy call;
//   - missing stack, TEMPLATE_S3_BUCKET set: deploy gets that bucket;
//   - TEMPLATE_S3_BUCKET set on an existing stack overrides the artifact
//     bucket and skips the existence check;
//   - a stack with no artifact bucket yet (REVIEW_IN_PROGRESS): refused;
//   - the existence check failing ambiguously: refused, no deploy, the aws
//     error text is not echoed;
//   - everything else is untouched: the full --parameter-overrides list
//     (names AND defaults: a wrong default deletes DNS records or replaces
//     resources) and the other deploy flags equal the pre-fix script's.
//
// SEALED: PATH is a stub directory plus a private bin of symlinks to the few
// tools deploy.sh needs, taken from /usr/bin or /bin only; the environment is
// built from scratch and HOME is a scratch directory. A beforeAll check asserts
// `command -v aws` resolves to the stub before deploy.sh ever runs.
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: it runs this repo's
// infrastructure/bootstrap/deploy.sh, which a consumer ships as a delegating
// wrapper (that wrapper `exec`s this script, so the environment, including
// TEMPLATE_S3_BUCKET from site-params.env, reaches it unchanged).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const BOOTSTRAP = path.join(REPO_ROOT, "infrastructure", "bootstrap");
const DEPLOY = path.join(BOOTSTRAP, "deploy.sh");
const TEMPLATE = path.join(BOOTSTRAP, "template.yaml");
// The AWS CLI's inline template limit for `cloudformation deploy`.
const CLI_INLINE_LIMIT_BYTES = 51200;
const STACK = "example-test-bootstrap";
const ARTIFACT_BUCKET = "example-test-cfn-artifacts";
const PREFIX = "bootstrap-templates";

// The deploy.sh invocation as it stood before the S3 fix: every flag except
// the S3 pair, and the complete parameter list with its defaults, for the
// sealed environment below (APEX_DOMAIN example.test, GITHUB_REPO example-repo,
// HOSTED_ZONE_ID Z123EXAMPLE, nothing else set).
const EXPECTED_PARAMETERS = [
  "GitHubOrg=Adam-S-Daniel",
  "GitHubRepo=example-repo",
  "ResourcePrefix=example-test",
  `ArtifactBucketName=${ARTIFACT_BUCKET}`,
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

// The tools deploy.sh runs besides aws (bash builtins aside).
const TOOLS = ["bash", "dirname", "tr", "python3"];
const SAFE_DIRS = ["/usr/bin", "/bin"];

const STUB = (bash) => `#!${bash}
{ printf 'CALL\\n'; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >>"$STUB_LOG"
case "$*" in
  *"describe-stacks"*"Stacks[0].StackStatus"*)
    case "$STUB_STACK" in
      exists) echo UPDATE_COMPLETE ;;
      review) echo REVIEW_IN_PROGRESS ;;
      absent) echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $STACK_NAME does not exist" >&2; exit 254 ;;
      *) echo "STUB-ERROR-TEXT: An error occurred (ExpiredToken) when calling the DescribeStacks operation" >&2; exit 254 ;;
    esac ;;
  *"cloudformation deploy"*) exit 0 ;;
  *"describe-stacks"*"Stacks[0].Outputs"*) echo '[{"OutputKey":"RoleArn","OutputValue":"arn:aws:iam::000000000000:role/example"}]' ;;
  *) echo "unexpected aws call" >&2; exit 99 ;;
esac
`;

let scratch;
let stubDir;
let binDir;
let bash;

test.beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-deploy-s3-"));
  stubDir = path.join(scratch, "stubs");
  binDir = path.join(scratch, "bin");
  fs.mkdirSync(stubDir);
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(scratch, "home"));
  for (const tool of TOOLS) {
    const dir = SAFE_DIRS.find((d) => fs.existsSync(path.join(d, tool)));
    if (!dir) throw new Error(`${tool} not found in ${SAFE_DIRS.join(" or ")}`);
    fs.symlinkSync(path.join(dir, tool), path.join(binDir, tool));
  }
  bash = path.join(binDir, "bash");
  fs.writeFileSync(path.join(stubDir, "aws"), STUB(fs.realpathSync(bash)), { mode: 0o755 });
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
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true",
    GITHUB_REPO: "example-repo",
    APEX_DOMAIN: "example.test",
    HOSTED_ZONE_ID: "Z123EXAMPLE",
    STACK_NAME: STACK,
    AWS_REGION: "us-east-1",
    STUB_LOG: path.join(scratch, "calls.log"),
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

function runDeploy(extra) {
  const env = sealedEnv(extra);
  fs.rmSync(env.STUB_LOG, { force: true });
  const r = spawnSync(bash, [DEPLOY], { env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stderr: r.stderr, calls: readCalls(env.STUB_LOG) };
}

const isDeploy = (argv) => argv[0] === "cloudformation" && argv[1] === "deploy";
const deployCalls = (calls) => calls.filter(isDeploy);
const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const overrides = (argv) => {
  const rest = argv.slice(argv.indexOf("--parameter-overrides") + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
};

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

test("lint: a template over the CLI's 51,200-byte inline limit is deployed through S3", () => {
  // BYTES, not characters: the CLI's limit is on the encoded size.
  const bytes = fs.statSync(TEMPLATE).size;
  test.info().annotations.push({ type: "template-bytes", description: String(bytes) });
  const r = runDeploy({ STUB_STACK: "exists" });
  expect(r.status, r.out).toBe(0);
  const [deploy] = deployCalls(r.calls);
  expect(deploy, "deploy must run").toBeDefined();
  if (bytes > CLI_INLINE_LIMIT_BYTES) {
    const bucket = flagValue(deploy, "--s3-bucket");
    expect(
      bucket,
      `template.yaml is ${bytes} bytes (> ${CLI_INLINE_LIMIT_BYTES}): the AWS CLI refuses it inline, so deploy.sh must pass --s3-bucket`,
    ).toBeTruthy();
    expect(bucket.trim()).not.toBe("");
  }
});

test("existing stack: the template goes through the stack's own artifact bucket", () => {
  const r = runDeploy({ STUB_STACK: "exists" });
  expect(r.status, r.out).toBe(0);
  const deploys = deployCalls(r.calls);
  expect(deploys).toHaveLength(1);
  expect(flagValue(deploys[0], "--s3-bucket")).toBe(ARTIFACT_BUCKET);
  expect(flagValue(deploys[0], "--s3-prefix")).toBe(PREFIX);
});

test("existing stack with a custom ARTIFACT_BUCKET: that bucket is used", () => {
  const r = runDeploy({ STUB_STACK: "exists", ARTIFACT_BUCKET: "custom-artifacts" });
  expect(r.status, r.out).toBe(0);
  expect(flagValue(deployCalls(r.calls)[0], "--s3-bucket")).toBe("custom-artifacts");
});

test("deploy keeps every other flag and the complete parameter list, defaults included", () => {
  const r = runDeploy({ STUB_STACK: "exists" });
  expect(r.status, r.out).toBe(0);
  const [deploy] = deployCalls(r.calls);
  expect(overrides(deploy)).toEqual(EXPECTED_PARAMETERS);
  expect(flagValue(deploy, "--template-file")).toBe("template.yaml");
  expect(flagValue(deploy, "--stack-name")).toBe(STACK);
  expect(flagValue(deploy, "--region")).toBe("us-east-1");
  expect(flagValue(deploy, "--capabilities")).toBe("CAPABILITY_NAMED_IAM");
  expect(deploy).toContain("--no-fail-on-empty-changeset");
  // Nothing but the known flags (so a new one cannot slip in unreviewed).
  const flags = deploy.filter((a) => a.startsWith("--")).sort();
  expect(flags).toEqual(
    [
      "--capabilities",
      "--no-fail-on-empty-changeset",
      "--parameter-overrides",
      "--region",
      "--s3-bucket",
      "--s3-prefix",
      "--stack-name",
      "--template-file",
    ].sort(),
  );
});

test("the parameters keep passing through when a site sets them", () => {
  const r = runDeploy({
    STUB_STACK: "exists",
    CREATE_APEX_DNS_RECORDS: "true",
    ADMIN_DOMAIN: "admin.example.test",
    MEDIA_ARCHIVE_BUCKET: "example-test-media-archive",
    ADMIN_CSP_MODE: "enforce",
  });
  expect(r.status, r.out).toBe(0);
  const params = overrides(deployCalls(r.calls)[0]);
  expect(params).toContain("CreateApexDnsRecords=true");
  expect(params).toContain("AdminDomainName=admin.example.test");
  expect(params).toContain("MediaArchiveBucketName=example-test-media-archive");
  expect(params).toContain("AdminCspMode=enforce");
});

test("missing stack, TEMPLATE_S3_BUCKET unset: refused, names TEMPLATE_S3_BUCKET, no deploy", () => {
  const r = runDeploy({ STUB_STACK: "absent" });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`Stack ${STACK} does not exist`);
  expect(r.stderr).toContain("TEMPLATE_S3_BUCKET");
  expect(r.stderr).toContain("51,200");
  expect(deployCalls(r.calls)).toEqual([]);
});

test("missing stack, TEMPLATE_S3_BUCKET set: the template goes through that bucket", () => {
  const r = runDeploy({ STUB_STACK: "absent", TEMPLATE_S3_BUCKET: "my-existing-bucket" });
  expect(r.status, r.out).toBe(0);
  const deploys = deployCalls(r.calls);
  expect(deploys).toHaveLength(1);
  expect(flagValue(deploys[0], "--s3-bucket")).toBe("my-existing-bucket");
  expect(flagValue(deploys[0], "--s3-prefix")).toBe(PREFIX);
  expect(overrides(deploys[0])).toEqual(EXPECTED_PARAMETERS);
});

test("existing stack, TEMPLATE_S3_BUCKET set: it overrides the artifact bucket", () => {
  const r = runDeploy({ STUB_STACK: "exists", TEMPLATE_S3_BUCKET: "my-existing-bucket" });
  expect(r.status, r.out).toBe(0);
  expect(flagValue(deployCalls(r.calls)[0], "--s3-bucket")).toBe("my-existing-bucket");
  // The override makes the existence check unnecessary: it is not made.
  expect(r.calls.filter((c) => c.includes("Stacks[0].StackStatus"))).toEqual([]);
});

test("a stack stuck in REVIEW_IN_PROGRESS has no artifact bucket: refused, no deploy", () => {
  const r = runDeploy({ STUB_STACK: "review" });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("no artifact bucket");
  expect(r.stderr).toContain("TEMPLATE_S3_BUCKET");
  expect(deployCalls(r.calls)).toEqual([]);
});

test("the existence check failing ambiguously: refused, no deploy, the aws error is not echoed", () => {
  const r = runDeploy({ STUB_STACK: "fail" });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`Could not tell whether stack ${STACK} exists`);
  expect(r.out).not.toContain("STUB-ERROR-TEXT");
  expect(deployCalls(r.calls)).toEqual([]);
});
