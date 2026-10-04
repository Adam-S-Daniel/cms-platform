// @lane: local — parsed platform workflow steps executed with offline fixtures.
// Repository-controlled filenames and reconciler output must remain one log
// record, while classification, annotations, file contents, and status survive.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox } = require("./git-fixture");
const { findRunSteps, writeStubs, runStep } = require("./workflow-step-harness");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");
const HOSTILE = "bad%\r\n::error::injected\n";
const ESCAPED = "bad%25%0D%0A::error::injected%0A";
let sb;
test.afterEach(() => sb && sb.cleanup());

function fixture() {
  sb = createSandbox("workflow-command-log-");
  return sb.root;
}
function write(rel, text) {
  const file = path.join(sb.root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function step(file, name) {
  const found = findRunSteps(() => true).find((s) => s.workflow === file && s.step.name === name);
  expect(found, `${file}: ${name}`).toBeTruthy();
  return found.step;
}
function execute(file, name, stubs = {}, stepEnv = {}, fixtureEnv = {}) {
  const bin = writeStubs(path.join(sb.root, "bin"), stubs);
  const temp = path.join(sb.root, "tmp");
  fs.mkdirSync(temp, { recursive: true });
  return runStep(step(file, name), {
    cwd: sb.root,
    scratch: path.join(sb.root, "run"),
    env: { ...sb.env, TMPDIR: temp, PATH: `${bin}:${sb.env.PATH}`, ...fixtureEnv },
    stepEnv,
  });
}
function safe(output) {
  expect(output).not.toContain("\r");
  expect(output.split("\n").filter((line) => line.trimStart().startsWith("::error::injected"))).toEqual([]);
}

for (const valid of [false, true]) {
  test(`front matter filename diagnostics preserve validation status (valid=${valid})`, () => {
    fixture();
    write(`_posts/${HOSTILE}.md`, valid ? "title: Entry\ndate: 2026-01-01\n" : "body\n");
    const r = execute("cms-editorial-workflow.yml", "Validate front matter");
    expect(r.status, r.stderr).toBe(valid ? 0 : 1);
    safe(r.stdout + r.stderr);
    if (!valid) {
      expect(r.stdout.split("\n").filter((line) => line.startsWith("ERROR: "))).toEqual([
        `ERROR: _posts/${ESCAPED}.md is missing 'title' field`,
        `ERROR: _posts/${ESCAPED}.md is missing 'date' field`,
      ]);
      expect(r.stdout).toContain("Found 2 validation error(s).");
    }
  });
}

for (const rubyStatus of [0, 17]) {
  test(`theme spec group escapes the name and passes the original path to Ruby (exit=${rubyStatus})`, () => {
    fixture();
    const name = `theme/spec/${HOSTILE}_test.rb`;
    write(name, "fixture\n");
    const calls = path.join(sb.root, "ruby-calls");
    const r = execute("self-ci.yml", "Run theme specs", {
      ruby: `printf '%s\\0' "$1" > "$RUBY_CALL_LOG"\nexit ${rubyStatus}`,
    }, {}, { RUBY_CALL_LOG: calls });
    expect(r.status, r.stderr).toBe(rubyStatus ? 1 : 0);
    safe(r.stdout + r.stderr);
    expect(r.stdout.split("\n").filter((line) => line.startsWith("::group::"))).toEqual([
      `::group::ruby theme/spec/${ESCAPED}_test.rb`,
    ]);
    expect(fs.readFileSync(calls, "utf8")).toBe(`${name}\0`);
  });
}

test("content PR guard safely lists offending filenames and keeps the failure verdict", async () => {
  fixture();
  const wf = parseYaml(readWorkflow("cms-editorial-workflow.yml"));
  const guard = wf.jobs["validate-content"].steps.find((s) => s.name === "Content PR conformance guard");
  const info = [];
  const failed = [];
  const files = ["::error::x", `_posts/${HOSTILE}.md`];
  const req = (name) => {
    if (name === "path") return path;
    if (name === "fs") return { readFileSync: () => { throw new Error("fixture has no config"); } };
    if (name.endsWith("cms-fixture-pr.js")) return { FIXTURE_BRANCH_PREFIX: "cms/fixture/" };
    if (name.endsWith("content-pr-guard.js")) return {
      COMMENT_MARKER: "fixture-marker", OVERRIDE_LABEL: "override",
      evaluateContentGuard: () => ({ verdict: "fail", contentFiles: files, commentBody: "fixture" }),
    };
    throw new Error(`Unexpected require: ${name}`);
  };
  const pulls = { listFiles: async () => {} };
  const issues = { listComments: async () => {}, createLabel: async () => {}, createComment: async () => {} };
  const github = { rest: { pulls, issues }, paginate: async (method) => method === pulls.listFiles ? files.map((filename) => ({ filename })) : [] };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("require", "process", "github", "context", "core", guard.with.script)(
    req, { env: { GITHUB_WORKSPACE: sb.root } }, github,
    { repo: { owner: "fixture", repo: "site" }, payload: { pull_request: { number: 1, head: { sha: "abc" } } } },
    { info: (s) => info.push(s), setFailed: (s) => failed.push(s), warning: () => {} },
  );
  expect(info).toEqual([
    "content-pr-guard: non-Decap content change — offending file(s):",
    "  - ::error::x", `  - _posts/${ESCAPED}.md`,
  ]);
  expect(failed).toHaveLength(1);
  expect(failed[0]).toContain("touches 2 CMS-managed content file(s)");
  safe(info.join("\n"));
});

for (const [file, dir] of [["deploy-production.yml", "_site"], ["deploy-preview.yml", "_site_preview"]]) {
  test(`${file}: commit metadata display escapes CR and leaves the generated file unchanged`, () => {
    fixture();
    // An internal CR survives the reader's existing trim of line-end whitespace.
    write("platform.lock", "platform_repo: fixture%\r::error::injected/site\nplatform_ref: v1%\r::error::injected\n");
    const r = execute(file, "Write deploy-time commit metadata", {
      git: 'if [ "$1" = log ]; then printf "2026-01-01T00:00:00+00:00\\n"; else printf "abc\\n"; fi',
    }, file === "deploy-preview.yml" ? { HEAD_REF: "fixture", PR_HEAD_SHA: "abc" } : {});
    expect(r.status, r.stderr).toBe(0);
    const metadata = fs.readFileSync(path.join(sb.root, dir, "admin/commit.json"), "utf8");
    expect(metadata).toContain("fixture%\r::error::injected/site");
    expect(r.stdout).toBe(`Commit metadata diagnostic: ${metadata.trimEnd().replace(/%/g, "%25").replace(/\r/g, "%0D")}\n`);
    safe(r.stdout + r.stderr);
  });
}

for (const disposition of ["UPDATED", "MANUAL"]) {
  test(`platform bump escapes reconciler logs and retains raw ${disposition} disposition and PR notes`, () => {
    fixture();
    write(".github/workflows/cms-automerge-nudge.yml", "fixture\n");
    write("oauth-proxy/deploy.sh", "fixture\n");
    write("infrastructure/bootstrap/deploy.sh", "fixture\n");
    const ghLog = path.join(sb.root, "gh-calls.jsonl");
    const gh = path.join(sb.root, "gh");
    fs.writeFileSync(gh, `#!${process.execPath}\nconst fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'api') {
  const endpoint = a[1];
  if (endpoint.endsWith('/releases/latest')) process.stdout.write('v1.2.3\\n');
  else if (endpoint.includes('/git/refs/tags/')) process.stdout.write(a.includes('.object.type') ? 'commit\\n' : 'a'.repeat(40) + '\\n');
  else if (endpoint.includes('/contents/examples/site/.github/workflows?')) process.stdout.write('cms-automerge-nudge.yml\\n');
  else process.stdout.write(a.includes('.content') ? Buffer.from('fixture\\n').toString('base64') : 'fixture\\n');
} else if (a[0] === 'pr' && a[1] === 'view') process.stdout.write('100\\n');
`);
    fs.chmodSync(gh, 0o755);
    const secrets = `UPDATED ${HOSTILE}`;
    const context = `${disposition} ${HOSTILE}`;
    const r = execute("platform-bump.yml", "Bump every cms-platform reference to the latest release (atomic)", {
      gh: `exec "$FIXTURE_GH" "$@"`,
      npm: "exit 0",
      python3: `printf '%s' "$FIXTURE_CONTEXT"\nexit ${disposition === "MANUAL" ? 1 : 0}`,
      node: "printf '%s' \"$FIXTURE_CALLERS\"",
      git: 'if [ "$1" = diff ]; then exit 1; fi\nexit 0',
    }, { GH_TOKEN: "fixture", PLATFORM: "fixture/platform" }, {
      FIXTURE_GH: gh, GH_CALL_LOG: ghLog, FIXTURE_CONTEXT: context, FIXTURE_CALLERS: secrets,
      GITHUB_REPOSITORY: "fixture/site", GITHUB_REF_NAME: "main",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Context reconciliation diagnostic: ${disposition} ${ESCAPED.slice(0, -3)}\n`);
    expect(r.stdout).toContain(`Caller reconciliation diagnostic: UPDATED ${ESCAPED.slice(0, -3)}\n`);
    if (disposition === "MANUAL") expect(r.stdout).toContain(`::warning::could not reconcile required_contexts automatically — MANUAL ${ESCAPED.slice(0, -3)}\n`);
    safe(r.stdout + r.stderr);
    const calls = fs.readFileSync(ghLog, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    const create = calls.find((a) => a[0] === "pr" && a[1] === "create");
    expect(create).toBeTruthy();
    const body = create[create.indexOf("--body") + 1];
    // Command substitution strips the final LF; the parser still sees the
    // original UPDATED record and its original CR in the PR note.
    expect(body).toContain("bad%\r");
    expect(body).not.toContain("bad%25");
    expect(body).toContain(disposition === "MANUAL" ? "could NOT be reconciled automatically" : "Reconciled");
  });
}

test("front matter safely captures grep diagnostics for a dangling filename symlink", () => {
  fixture();
  fs.mkdirSync(path.join(sb.root, "_posts"));
  fs.symlinkSync("missing.md", path.join(sb.root, `_posts/${HOSTILE}.md`));
  const r = execute("cms-editorial-workflow.yml", "Validate front matter");
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toBe("");
  safe(r.stdout);
  expect(r.stdout.split("\n").filter((line) => line.startsWith("Front matter diagnostic: "))).toEqual([
    `Front matter diagnostic: grep: _posts/${ESCAPED}.md: No such file or directory`,
    `Front matter diagnostic: grep: _posts/${ESCAPED}.md: No such file or directory`,
  ]);
  expect(r.stdout).toContain("Found 2 validation error(s).");
});

for (const [name, prefix] of [
  ["Sweep stale `_e2e/canary-delete-*` fixtures left on main", "_e2e/canary-delete-"],
  ["Sweep stale ephemeral loop `_posts/` + upload orphans left on main", "_posts/2099-12-31-e2e-prod-mutate-"],
]) {
  for (const recent of [true, false]) {
    test(`${name}: escaped ${recent ? "skip" : "delete"} display keeps raw API path`, () => {
      fixture();
      const filename = `${prefix}bad%\r::error::injected.md`;
      const escaped = `${prefix}bad%25%0D::error::injected.md`;
      const callsLog = path.join(sb.root, "gh-calls.jsonl");
      const gh = path.join(sb.root, "gh");
      fs.writeFileSync(gh, `#!${process.execPath}\nconst fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'create') process.stdout.write('https://example.com/fixture/site/pull/100\\n');
else if (a[0] === 'api') {
  const endpoint = a[1];
  if (endpoint.endsWith('/contents/assets/images/uploads?ref=main')) process.stdout.write('');
  else if (endpoint.endsWith('/contents/_e2e?ref=main') || endpoint.endsWith('/contents/_posts?ref=main')) process.stdout.write(process.env.FIXTURE_PATH + '\\n');
  else if (endpoint.includes('/commits?path=')) process.stdout.write('fixture-last\\n');
  else if (!a.includes('DELETE')) process.stdout.write('abc\\n');
}
`);
      fs.chmodSync(gh, 0o755);
      const r = execute("sweep-stale-cms-prs.yml", name, {
        gh: 'exec "$FIXTURE_GH" "$@"',
        date: 'if [ "$2" = -d ]; then\n if [ "$3" = "6 hours ago" ]; then printf "100\\n"; else printf "%s\\n" "$FIXTURE_LAST_TS"; fi\nelse printf "7200\\n"; fi',
      }, { GH_TOKEN: "fixture", GH_REPO: "fixture/site", THRESHOLD_HOURS: "6" }, {
        FIXTURE_GH: gh, FIXTURE_PATH: filename, FIXTURE_LAST_TS: recent ? "200" : "0", GH_CALL_LOG: callsLog,
      });
      expect(r.status, r.stderr).toBe(0);
      safe(r.stdout + r.stderr);
      expect(r.stdout.split("\n")[0]).toBe(recent ? `skip ${escaped} — 116 min old` : `delete ${escaped} — 2h old`);
      const calls = fs.readFileSync(callsLog, "utf8").trim().split("\n").map((s) => JSON.parse(s));
      expect(calls.some((a) => a.includes(`/repos/fixture/site/commits?path=${filename}&per_page=1`))).toBe(true);
      const deletions = calls.filter((a) => a.includes("DELETE"));
      expect(deletions).toHaveLength(recent ? 0 : 1);
      if (!recent) expect(deletions[0]).toContain(`/repos/fixture/site/contents/${filename}`);
    });
  }
}
