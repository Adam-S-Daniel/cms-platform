// @lane: local — runs the real oauth-proxy/deploy.sh under stub `aws` and
// `sam` executables in a sealed environment. No network, no AWS, no build.
//
// THE GAP (#518, owner comment): deploy.sh passed GITHUB_CLIENT_ID and
// GITHUB_CLIENT_SECRET on every run, so a site-params.env still holding the
// example's all-x placeholders would overwrite the live client secret and
// break every sign-in.
//
// WHAT THIS FILE PROVES
//   - a placeholder id or secret (the example file's all-x values, the
//     header's your_client_id / your_client_secret) is refused before either
//     stub runs, and the value never reaches the output;
//   - both unset (or empty) and the stack exists: sam deploy runs without
//     either credential parameter, so CloudFormation keeps the stack's values;
//   - both unset and no stack (or one sam treats as missing): refused, no sam;
//   - exactly one set: refused, no stub runs;
//   - a credential with surrounding whitespace (a blank-looking " "): refused,
//     no stub runs;
//   - both set: both parameters are passed, as before;
//   - the stack-existence check failing: refused, no sam.
//
// ALLOWED_ORIGINS (#524, #535)
//   - one table of entries is run through BOTH validators, deploy.sh and
//     lambda.py's _origin_patterns, and each must reach the expected verdict:
//     a `*` only beneath APEX_DOMAIN, so `https://*.github.io` and
//     `https://*.co.uk` are refused before any aws or sam call;
//   - no preview-* entry: a warning, and the deploy still runs;
//     PREVIEW_SIGN_IN=disabled silences it, and contradicting it is refused;
//   - APEX_DOMAIN reaches the stack as SiteApex, and only when set.
//
// SEALED: PATH is a stub directory plus a private bin of symlinks to the few
// tools deploy.sh needs, taken from /usr/bin or /bin only. The environment is
// built from scratch (no AWS_PROFILE, no AWS_ACCESS_KEY_ID, no session token),
// the AWS config and credentials files are /dev/null, and HOME is a scratch
// directory. A test below asserts `command -v aws sam` resolves to the stubs
// before anything else runs.
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: it runs this repo's
// oauth-proxy/deploy.sh, which a consumer does not ship.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEPLOY = path.join(REPO_ROOT, "oauth-proxy", "deploy.sh");
const STACK = "example-test-oauth-proxy";
const APEX = "example.test";

// Obvious, low-entropy fakes. Never a real credential.
const FAKE_ID = "fake-client-id-aaaa";
const FAKE_SECRET = "fake-client-secret-bbbb";
// The placeholder shapes this repo ships (site-params.example.env, deploy.sh's
// Usage lines).
const X_ID = "x".repeat(16);
const X_SECRET = "x".repeat(40);

// The tools deploy.sh runs besides aws/sam (bash builtins aside).
const TOOLS = ["bash", "dirname", "tr", "git", "python3"];
const SAFE_DIRS = ["/usr/bin", "/bin"];

const STUB = (bash, name) => `#!${bash}
{ printf 'CALL\\t%s\\n' ${name}; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >>"$STUB_LOG"
[[ ${name} == aws ]] || exit 0
case "$*" in
  *"describe-stacks"*"Stacks[0].StackStatus"*)
    case "$STUB_STACK" in
      exists) echo UPDATE_COMPLETE ;;
      review) echo REVIEW_IN_PROGRESS ;;
      absent) echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $STACK_NAME does not exist" >&2; exit 254 ;;
      *) echo "STUB-ERROR-TEXT: An error occurred (ExpiredToken) when calling the DescribeStacks operation" >&2; exit 254 ;;
    esac ;;
  *"describe-stacks"*"Stacks[0].Outputs"*)
    echo '[{"OutputKey":"ApiUrl","OutputValue":"https://api.example.test"},{"OutputKey":"CallbackEndpoint","OutputValue":"https://api.example.test/prod/callback"}]' ;;
  *) echo "unexpected aws call" >&2; exit 99 ;;
esac
`;

let scratch;
let stubDir;
let binDir;
let bash;

test.beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-deploy-creds-"));
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
  for (const name of ["aws", "sam"]) {
    fs.writeFileSync(path.join(stubDir, name), STUB(fs.realpathSync(bash), name), { mode: 0o755 });
  }
  // Refuse to run deploy.sh at all unless aws and sam resolve to the stubs.
  const seal = spawnSync(bash, ["-c", "command -v aws sam"], { env: sealedEnv({}), encoding: "utf8" });
  if (seal.stdout !== `${path.join(stubDir, "aws")}\n${path.join(stubDir, "sam")}\n`) {
    throw new Error("aws/sam do not resolve to the stubs; refusing to run deploy.sh");
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
    STACK_NAME: STACK,
    AWS_REGION: "us-east-1",
    ALLOWED_ORIGINS: "https://example.test",
    STUB_LOG: path.join(scratch, "calls.log"),
    ...extra,
  };
}

// Each call is { tool, args }.
function readCalls(log) {
  if (!fs.existsSync(log)) return [];
  const calls = [];
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    const [kind, value] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
    if (kind === "CALL") calls.push({ tool: value, args: [] });
    else if (kind === "ARG") calls[calls.length - 1].args.push(value);
  }
  return calls;
}

function runDeploy(extra) {
  const env = sealedEnv(extra);
  fs.rmSync(env.STUB_LOG, { force: true });
  const r = spawnSync(bash, [DEPLOY], { env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stderr: r.stderr, calls: readCalls(env.STUB_LOG) };
}

const samDeploy = (calls) => calls.find((c) => c.tool === "sam" && c.args[0] === "deploy");
const overrides = (call) => {
  const i = call.args.indexOf("--parameter-overrides");
  const rest = call.args.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
};

test("the environment is sealed: aws and sam resolve to the stubs, nothing AWS-shaped is set", () => {
  const r = spawnSync(bash, ["-c", "command -v aws sam; compgen -e"], { env: sealedEnv({}), encoding: "utf8" });
  expect(r.status).toBe(0);
  const lines = r.stdout.split("\n");
  expect(lines.slice(0, 2)).toEqual([path.join(stubDir, "aws"), path.join(stubDir, "sam")]);
  for (const name of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    expect(lines.includes(name), `${name} must not be set`).toBe(false);
  }
  expect(fs.readdirSync(binDir).sort()).toEqual([...TOOLS].sort());
});

const refusals = [
  { name: "all-x placeholder id", id: X_ID, secret: FAKE_SECRET, names: "GITHUB_CLIENT_ID", value: X_ID },
  { name: "all-x placeholder secret", id: FAKE_ID, secret: X_SECRET, names: "GITHUB_CLIENT_SECRET", value: X_SECRET },
  { name: "Usage-line placeholder id", id: "your_client_id", secret: FAKE_SECRET, names: "GITHUB_CLIENT_ID", value: "your_client_id" },
  {
    name: "Usage-line placeholder secret",
    id: FAKE_ID,
    secret: "your_client_secret",
    names: "GITHUB_CLIENT_SECRET",
    value: "your_client_secret",
  },
  { name: "placeholder id with the secret unset", id: X_ID, secret: undefined, names: "GITHUB_CLIENT_ID", value: X_ID },
];

for (const c of refusals) {
  test(`refuses the ${c.name} before any aws or sam call, without echoing it`, () => {
    const extra = { GITHUB_CLIENT_ID: c.id, STUB_STACK: "exists" };
    if (c.secret !== undefined) extra.GITHUB_CLIENT_SECRET = c.secret;
    const r = runDeploy(extra);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${c.names} is still the example placeholder`);
    expect(r.calls, "neither stub may run").toEqual([]);
    expect(r.out).not.toContain(c.value);
  });
}

for (const [label, creds] of [
  ["unset", {}],
  ["empty", { GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }],
]) {
  test(`both ${label} and the stack exists: deploys without either credential parameter`, () => {
    const r = runDeploy({ ...creds, STUB_STACK: "exists" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("keeping the stack's existing credentials");
    expect(r.out).not.toContain("setting credentials from the environment");
    const tools = r.calls.map((c) => `${c.tool} ${c.args[0]}`);
    expect(tools[0], "the existence check comes before sam").toBe("aws cloudformation");
    const deploy = samDeploy(r.calls);
    expect(deploy, "sam deploy must run").toBeDefined();
    expect(deploy.args).toContain("--stack-name");
    expect(deploy.args[deploy.args.indexOf("--stack-name") + 1]).toBe(STACK);
    const params = overrides(deploy);
    expect(params.some((p) => p.startsWith("GitHubClientId"))).toBe(false);
    expect(params.some((p) => p.startsWith("GitHubClientSecret"))).toBe(false);
    expect(params).toContain("AllowedOrigins=https://example.test");
    expect(params.some((p) => p.startsWith("FunctionName="))).toBe(true);
    expect(params.some((p) => p.startsWith("PlatformRelease="))).toBe(true);
  });
}

for (const [label, state, message] of [
  ["does not exist", "absent", `stack ${STACK} does not exist`],
  ["is REVIEW_IN_PROGRESS (sam treats it as missing)", "review", "has no deployed credentials to keep"],
]) {
  test(`both unset and the stack ${label}: refused, sam never runs`, () => {
    const r = runDeploy({ STUB_STACK: state });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(message);
    expect(r.calls.filter((c) => c.tool === "sam")).toEqual([]);
  });
}

test("both unset and the existence check fails: refused, sam never runs, the aws error is not echoed", () => {
  const r = runDeploy({ STUB_STACK: "fail" });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`Could not tell whether stack ${STACK} exists`);
  expect(r.out).not.toContain("keeping the stack's existing credentials");
  expect(r.out).not.toContain("STUB-ERROR-TEXT");
  expect(r.calls.filter((c) => c.tool === "sam")).toEqual([]);
});

for (const [label, creds, name] of [
  ["a blank-looking id and secret", { GITHUB_CLIENT_ID: " ", GITHUB_CLIENT_SECRET: " " }, "GITHUB_CLIENT_ID"],
  ["a secret with a trailing newline", { GITHUB_CLIENT_ID: FAKE_ID, GITHUB_CLIENT_SECRET: `${FAKE_SECRET}\n` }, "GITHUB_CLIENT_SECRET"],
  ["a placeholder id with a trailing carriage return", { GITHUB_CLIENT_ID: `${X_ID}\r`, GITHUB_CLIENT_SECRET: FAKE_SECRET }, "GITHUB_CLIENT_ID"],
]) {
  test(`refuses ${label} before any aws or sam call`, () => {
    const r = runDeploy({ ...creds, STUB_STACK: "exists" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${name} starts or ends with whitespace`);
    expect(r.calls).toEqual([]);
    expect(r.out).not.toContain(FAKE_SECRET);
    expect(r.out).not.toContain(X_ID);
  });
}

for (const [label, creds, setName] of [
  ["only the id", { GITHUB_CLIENT_ID: FAKE_ID }, "GITHUB_CLIENT_ID"],
  ["only the secret", { GITHUB_CLIENT_SECRET: FAKE_SECRET }, "GITHUB_CLIENT_SECRET"],
  ["the id with an empty secret", { GITHUB_CLIENT_ID: FAKE_ID, GITHUB_CLIENT_SECRET: "" }, "GITHUB_CLIENT_ID"],
]) {
  test(`${label} set: refused before any aws or sam call`, () => {
    const r = runDeploy({ ...creds, STUB_STACK: "exists" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`Only ${setName} is set`);
    expect(r.calls).toEqual([]);
    expect(r.out).not.toContain(FAKE_ID);
    expect(r.out).not.toContain(FAKE_SECRET);
  });
}

test("both set: passes both credential parameters, as before, without printing them", () => {
  const r = runDeploy({ GITHUB_CLIENT_ID: FAKE_ID, GITHUB_CLIENT_SECRET: FAKE_SECRET, STUB_STACK: "absent" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain("setting credentials from the environment");
  expect(r.out).not.toContain("keeping the stack's existing credentials");
  const params = overrides(samDeploy(r.calls));
  expect(params).toContain(`GitHubClientId=${FAKE_ID}`);
  expect(params).toContain(`GitHubClientSecret=${FAKE_SECRET}`);
  expect(r.out).not.toContain(FAKE_ID);
  expect(r.out).not.toContain(FAKE_SECRET);
});

// ── ALLOWED_ORIGINS (#524, #535) ─────────────────────────────────────────────

// lambda.py's own verdict on one entry: true when _origin_patterns keeps it.
// `lambda` is a reserved word, so the module is imported by name.
const KEEP_SNIPPET = [
  "import importlib, json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "m = importlib.import_module('lambda')",
  "print(json.dumps(len(m._origin_patterns(sys.argv[2], sys.argv[3])) == 1))",
].join("\n");

function lambdaKeeps(entry, apex) {
  const r = spawnSync(path.join(binDir, "python3"), ["-c", KEEP_SNIPPET, path.join(REPO_ROOT, "oauth-proxy"), entry, apex], {
    encoding: "utf8",
    env: {
      PATH: binDir,
      HOME: path.join(scratch, "home"),
      GITHUB_CLIENT_ID: "fake-client-id-aaaa",
      GITHUB_CLIENT_SECRET: "fake-client-secret-bbbb",
      // Importing the module must not write __pycache__ into the source tree.
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  if (r.status !== 0) throw new Error(`python3 exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// [entry, APEX_DOMAIN ("" = unset), valid]
const ORIGIN_CASES = [
  ["https://example.test", "", true],
  ["https://admin.example.test:8443", "", true],
  ["https://preview-*.example.test", APEX, true],
  ["https://*.example.test", APEX, true],
  ["https://pr-*.staging.example.test", APEX, true],
  ["HTTPS://Preview-*.Example.TEST/", APEX, true],
  // The two broad patterns #535 reported, and their relatives.
  ["https://*.pages.example", APEX, false],
  ["https://*.co.example", APEX, false],
  ["https://preview-*.pages.example", APEX, false],
  ["https://*.example.co.example", APEX, false],
  ["https://*.com", APEX, false],
  ["https://example.*", APEX, false],
  // Lookalikes of the apex.
  ["https://*example.test", APEX, false],
  ["https://preview-*.notexample.test", APEX, false],
  ["https://preview-*.example.test.example.net", APEX, false],
  // No apex, no wildcard.
  ["https://preview-*.example.test", "", false],
  // The grammar's other refusals.
  ["*", APEX, false],
  ["http://example.test", APEX, false],
  ["https://example.test/path", APEX, false],
];

for (const [entry, apex, valid] of ORIGIN_CASES) {
  test(`ALLOWED_ORIGINS ${entry} with APEX_DOMAIN '${apex}': deploy.sh and lambda.py both say ${valid ? "valid" : "invalid"}`, () => {
    expect(lambdaKeeps(entry, apex), "lambda.py's verdict").toBe(valid);
    const extra = { ALLOWED_ORIGINS: entry, STUB_STACK: "exists" };
    if (apex) extra.APEX_DOMAIN = apex;
    const r = runDeploy(extra);
    if (valid) {
      expect(r.status, r.out).toBe(0);
      expect(overrides(samDeploy(r.calls))).toContain(`AllowedOrigins=${entry}`);
    } else {
      expect(r.status, r.out).not.toBe(0);
      expect(r.stderr).toMatch(/ALLOWED_ORIGINS entry '[^']*' (is not valid|has a '\*', which needs APEX_DOMAIN)/);
      expect(r.calls, "neither stub may run").toEqual([]);
    }
  });
}

test("one bad entry refuses the whole list, before any aws or sam call", () => {
  const r = runDeploy({ ALLOWED_ORIGINS: "https://example.test,https://*.pages.example", APEX_DOMAIN: APEX, STUB_STACK: "exists" });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("'https://*.pages.example' is not valid");
  expect(r.calls).toEqual([]);
});

test("a wildcard with APEX_DOMAIN unset is refused with the fix named, before any aws or sam call", () => {
  const r = runDeploy({ ALLOWED_ORIGINS: `https://example.test,https://preview-*.${APEX}`, STUB_STACK: "exists" });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("has a '*', which needs APEX_DOMAIN set to the site's own domain");
  // The file to edit and the line to add, for a site whose site-params.env
  // predates the apex bound.
  expect(r.stderr).toContain('Add export APEX_DOMAIN="<apex>"');
  expect(r.stderr).toContain("infrastructure/site-params.env");
  expect(r.calls).toEqual([]);
});

for (const apex of ["test", "*.example.test", "example.test.", "https://example.test", " example.test", "example.test "]) {
  test(`a malformed APEX_DOMAIN '${apex}' is refused before any aws or sam call`, () => {
    const r = runDeploy({ ALLOWED_ORIGINS: "https://example.test", APEX_DOMAIN: apex, STUB_STACK: "exists" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not a domain name");
    expect(r.calls).toEqual([]);
  });
}

const PREVIEW_WARNING = "will hang after GitHub consent";

for (const [label, apex] of [
  ["trailing LF", "example.com\n"],
  ["repeated trailing LF", "example.com\n\n"],
  ["trailing CRLF", "example.com\r\n"],
  ["trailing space", "example.com "],
  ["trailing tab", "example.com\t"],
  ["leading space", " example.com"],
  ["leading tab", "\texample.com"],
  ["leading LF", "\nexample.com"],
]) {
  test(`APEX_DOMAIN ${label}: rejects whitespace before normalization without echoing it`, () => {
    const r = runDeploy({ ALLOWED_ORIGINS: "https://example.com", APEX_DOMAIN: apex, STUB_STACK: "exists" });
    expect(r.status, r.out).not.toBe(0);
    expect(r.stderr).toContain("APEX_DOMAIN starts or ends with whitespace");
    expect(r.stderr).toContain("Remove the whitespace");
    expect(r.out).not.toContain(apex);
    expect(r.calls, "neither aws nor sam may run").toEqual([]);
    for (const valid of ["example.com", "ExAmPlE.NeT"]) {
      const control = runDeploy({ ALLOWED_ORIGINS: `https://${valid.toLowerCase()}`, APEX_DOMAIN: valid, STUB_STACK: "exists" });
      expect(control.status, control.out).toBe(0);
      expect(overrides(samDeploy(control.calls))).toContain(`SiteApex=${valid.toLowerCase()}`);
    }
  });
}

test("no preview-* entry: warns, names the entry to add, and still deploys (#524)", () => {
  const r = runDeploy({ ALLOWED_ORIGINS: "https://example.test", APEX_DOMAIN: APEX, STUB_STACK: "exists" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain(PREVIEW_WARNING);
  expect(r.out).toContain(`https://preview-*.${APEX}`);
  expect(r.out).toContain("PREVIEW_SIGN_IN=disabled");
  expect(samDeploy(r.calls), "sam deploy must run").toBeDefined();
});

for (const origins of [`https://example.test,https://preview-*.${APEX}`, `https://example.test,https://*.${APEX}`]) {
  test(`${origins}: no preview warning, and the apex reaches the stack as SiteApex`, () => {
    const r = runDeploy({ ALLOWED_ORIGINS: origins, APEX_DOMAIN: APEX, STUB_STACK: "exists" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain(PREVIEW_WARNING);
    const params = overrides(samDeploy(r.calls));
    expect(params).toContain(`AllowedOrigins=${origins}`);
    expect(params).toContain(`SiteApex=${APEX}`);
  });
}

test("APEX_DOMAIN unset: SiteApex is not passed, so the stack keeps (or defaults) its own", () => {
  const r = runDeploy({ ALLOWED_ORIGINS: "https://example.test", STUB_STACK: "exists" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).toContain(PREVIEW_WARNING);
  expect(overrides(samDeploy(r.calls)).some((p) => p.startsWith("SiteApex"))).toBe(false);
});

test("PREVIEW_SIGN_IN=disabled with no preview entry: no warning, says so, deploys", () => {
  const r = runDeploy({ ALLOWED_ORIGINS: "https://example.test", APEX_DOMAIN: APEX, PREVIEW_SIGN_IN: "disabled", STUB_STACK: "exists" });
  expect(r.status, r.out).toBe(0);
  expect(r.out).not.toContain(PREVIEW_WARNING);
  expect(r.out).toContain("Preview sign-in: disabled");
  expect(samDeploy(r.calls)).toBeDefined();
});

for (const [label, extra, message] of [
  [
    "PREVIEW_SIGN_IN=disabled beside a preview entry",
    { ALLOWED_ORIGINS: `https://example.test,https://preview-*.${APEX}`, PREVIEW_SIGN_IN: "disabled" },
    "PREVIEW_SIGN_IN=disabled, but ALLOWED_ORIGINS lists a preview entry",
  ],
  ["an unknown PREVIEW_SIGN_IN value", { ALLOWED_ORIGINS: "https://example.test", PREVIEW_SIGN_IN: "off" }, "PREVIEW_SIGN_IN must be"],
]) {
  test(`${label}: refused before any aws or sam call`, () => {
    const r = runDeploy({ ...extra, APEX_DOMAIN: APEX, STUB_STACK: "exists" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(message);
    expect(r.calls).toEqual([]);
  });
}
