// @lane: local — pure-fs lint over two workflow files plus the reusable's step
// scripts lifted out of it and executed against fakes in scratch dirs. No
// browser, no network. Runs in self-ci.yml's node-unit-lints lane (picked up by
// exclusion).
//
// THE GAP (_agent-guidance#653): the fleet sync delivers the privacy comment
// scan script into both consumer sites' `.githooks/`, but not the workflow that
// runs it, because a consumer may carry only platform-dictated workflows. So it
// is a platform seam: `.github/workflows/site-privacy-comment-alert.yml`
// (reusable) + the dictated thin caller
// `examples/site/.github/workflows/privacy-comment-alert.yml`.
//
// WHAT THIS FILE PROVES
//   - the caller keeps the fleet's file name and the fleet template's four
//     comment events, passes exactly the two secrets by name, and publishes no
//     context a ruleset could confuse with another (`scan / scan` is the
//     secrets scan's);
//   - nothing a stranger can read differs between a match and a clean text: no
//     `if:` reads the scan RESULT, and the alert step prints the same on both
//     (executed against a fake `gh`, not pattern-matched);
//   - the scan step's word handling BEHAVES for every word the scan prints;
//   - the checkout is the caller's `.githooks`, credential-free, and the token
//     is narrowed to one repository and `actions: write`.
//
// PLATFORM-INTERNAL, registered in PLATFORM_META_SPECS: it reads this repo's
// own workflow definitions and the examples/site templates.
//
// Parses YAML through workflow-yaml-utils — never a line scan (house rule).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { parseYaml, readWorkflow, listWorkflows, events } = require("./workflow-yaml-utils");
const { reusableBasename, requiredContexts } = require("./required-context-cancellable-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const REUSABLE = "site-privacy-comment-alert.yml";
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const CALLER_PATH = path.join(EXAMPLES_DIR, "privacy-comment-alert.yml");
const MANIFEST_PATH = path.join(REPO_ROOT, "repo-settings.yml");

const CALLER_JOB = "privacy-comment-alert";
const WORK_JOB = "scan";
const SCAN_STEP = "Scan the event text for a denylisted term";
const ROUTE_STEP = "Check the self-alert route";
const MINT_STEP = "Mint a token for the alert repository";
const SEND_STEP = "Send the self-alert when the scan matched";
const SECRETS = {
  privacy_denylist: "${{ secrets.PRIVACY_DENYLIST }}",
  self_alert_app_private_key: "${{ secrets.SELF_ALERT_APP_PRIVATE_KEY }}",
};
// The fleet template's events (_agent-guidance
// templates/privacy-comment-alert/privacy-comment-alert.yml).
const EVENTS = {
  issue_comment: { types: ["created", "edited"] },
  issues: { types: ["opened", "edited"] },
  pull_request_review_comment: { types: ["created", "edited"] },
  pull_request_review: { types: ["submitted", "edited"] },
};

const reusable = () => parseYaml(readWorkflow(REUSABLE)) || {};
const caller = () => parseYaml(fs.readFileSync(CALLER_PATH, "utf8")) || {};
const steps = () => ((reusable().jobs || {})[WORK_JOB] || {}).steps || [];
const step = (name) => {
  const s = steps().find((x) => x.name === name);
  expect(s, `the ${WORK_JOB} job must carry the step ${JSON.stringify(name)}`).toBeTruthy();
  return s;
};

const SCRATCH_DIRS = [];
test.afterAll(() => {
  for (const dir of SCRATCH_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-privacy-comment-alert-"));
  SCRATCH_DIRS.push(dir);
  return dir;
}

// Run a step's `run:` script under bash as the runner would (`bash -e`), in
// `cwd`, with `env` on top of a minimal environment and `binDir` first on PATH.
function runScript(script, { cwd, env, binDir }) {
  const scriptPath = path.join(scratch(), "step.sh");
  fs.writeFileSync(scriptPath, script);
  const output = path.join(scratch(), "github_output");
  fs.writeFileSync(output, "");
  const r = spawnSync("bash", ["-e", scriptPath], {
    cwd,
    env: {
      PATH: binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH,
      GITHUB_OUTPUT: output,
      ...env,
    },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, output: fs.readFileSync(output, "utf8") };
}

test.describe("site-privacy-comment-alert — the reusable", () => {
  test("exists, is workflow_call-only, and takes exactly the two optional secrets", () => {
    expect(listWorkflows().map((f) => path.basename(f))).toContain(REUSABLE);
    const on = reusable().on || {};
    expect(Object.keys(on)).toEqual(["workflow_call"]);
    expect((on.workflow_call || {}).inputs).toBeUndefined();
    const secrets = (on.workflow_call || {}).secrets || {};
    expect(Object.keys(secrets).sort()).toEqual(Object.keys(SECRETS).sort());
    for (const s of Object.values(secrets)) expect(s.required).toBe(false);
    expect(reusable().permissions).toEqual({ contents: "read" });
    expect(Object.keys(reusable().jobs || {})).toEqual([WORK_JOB]);
  });

  test("checks out only the caller's .githooks, with no persisted credential", () => {
    const checkout = steps().find((s) => /^actions\/checkout@[0-9a-f]{40}$/.test(String(s.uses || "")));
    expect(checkout).toBeTruthy();
    expect(checkout.with || {}).toEqual({ "sparse-checkout": ".githooks", "persist-credentials": false });
    expect(checkout.with.ref, "the caller's own tree, never another ref").toBeUndefined();
  });

  test("no `if:` reads the scan RESULT, so the step graph is the same on a match and on clean", () => {
    for (const s of steps()) {
      expect(String(s.if || "")).not.toContain("outputs.result");
    }
    // The two gated steps depend only on "a trusted author's text was scanned"
    // and "the route is configured".
    for (const name of [MINT_STEP, SEND_STEP]) {
      expect(step(name).if).toBe("steps.scan.outputs.scanned == 'true' && steps.route.outputs.configured == 'true'");
    }
  });

  test("no step interpolates `${{ }}` into a run block", () => {
    for (const s of steps()) expect(String(s.run || "")).not.toContain("${{");
  });

  test("the scan gets the denylist secret, and the token is narrowed to one repo and actions: write", () => {
    expect(step(SCAN_STEP).env).toEqual({ PRIVACY_DENYLIST: "${{ secrets.privacy_denylist }}" });
    const mint = step(MINT_STEP);
    expect(String(mint.uses)).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
    expect(mint.with).toEqual({
      "client-id": "${{ vars.SELF_ALERT_APP_ID }}",
      "private-key": "${{ secrets.self_alert_app_private_key }}",
      owner: "${{ steps.route.outputs.owner }}",
      repositories: "${{ steps.route.outputs.name }}",
      "permission-actions": "write",
    });
  });
});

test.describe("site-privacy-comment-alert — the step scripts BEHAVE", () => {
  // A caller tree whose scan script prints FAKE_WORD (or exits non-zero).
  function treeSaying(word, exit = 0) {
    const cwd = scratch();
    fs.mkdirSync(path.join(cwd, ".githooks"));
    fs.writeFileSync(
      path.join(cwd, ".githooks", "privacy-comment-scan.py"),
      `import sys\nprint(${JSON.stringify(word)})\nsys.exit(${exit})\n`,
    );
    return cwd;
  }
  const scan = (word, exit) => runScript(String(step(SCAN_STEP).run), { cwd: treeSaying(word, exit), env: {} });

  test("match and clean set the same outputs but the result, and print the same line", () => {
    const m = scan("match");
    const c = scan("clean");
    expect(m.status).toBe(0);
    expect(c.status).toBe(0);
    expect(m.out).toBe(c.out);
    expect(m.output).toBe("scanned=true\nresult=match\n");
    expect(c.output).toBe("scanned=true\nresult=clean\n");
  });

  test("skipped and no-denylist scan nothing and succeed; anything else fails", () => {
    for (const word of ["skipped", "no-denylist"]) {
      const r = scan(word);
      expect(r.status, r.out).toBe(0);
      expect(r.output).toBe("");
    }
    expect(scan("what").status).toBe(1);
    expect(scan("clean", 1).status, "a crashing scan is an error, not a clean").toBe(1);
  });

  test("the alert step prints the same and exits 0 on a match and on clean, even when dispatch fails", () => {
    const bin = scratch();
    const calls = path.join(bin, "calls");
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n` +
        'if [[ "$*" == *dispatches* ]]; then echo "boom" >&2; exit 1; fi\necho main\n',
      { mode: 0o755 },
    );
    const env = (result) => ({
      GH_TOKEN: "t",
      SELF_ALERT_REPO: "example/alerts",
      SCAN_RESULT: result,
      GITHUB_SERVER_URL: "https://github.example.com",
      GITHUB_REPOSITORY: "example/site",
      GITHUB_RUN_ID: "1",
    });
    const send = String(step(SEND_STEP).run);
    const m = runScript(send, { cwd: scratch(), env: env("match"), binDir: bin });
    const matchCalls = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
    fs.rmSync(calls, { force: true });
    const c = runScript(send, { cwd: scratch(), env: env("clean"), binDir: bin });
    expect(m.status, m.out).toBe(0);
    expect(c.status, c.out).toBe(0);
    expect(m.out).toBe(c.out);
    expect(matchCalls).toContain("repos/example/alerts/actions/workflows/send-self-alert.yml/dispatches");
    expect(fs.existsSync(calls), "clean dispatches nothing").toBe(false);
  });

  test("the route step warns only on scanned text, whatever the result", () => {
    const route = String(step(ROUTE_STEP).run);
    const unconfigured = (scanned) =>
      runScript(route, {
        cwd: scratch(),
        env: { SELF_ALERT_APP_ID: "", SELF_ALERT_REPO: "", SELF_ALERT_APP_PRIVATE_KEY: "", SCANNED: scanned },
      });
    expect(unconfigured("true").out).toContain("::warning::");
    expect(unconfigured("").out).toBe("");
    const ok = runScript(route, {
      cwd: scratch(),
      env: { SELF_ALERT_APP_ID: "1", SELF_ALERT_REPO: "example/alerts", SELF_ALERT_APP_PRIVATE_KEY: "k", SCANNED: "" },
    });
    expect(ok.output).toBe("configured=true\nowner=example\nname=alerts\n");
    const bad = runScript(route, {
      cwd: scratch(),
      env: { SELF_ALERT_APP_ID: "1", SELF_ALERT_REPO: "example/../x y", SELF_ALERT_APP_PRIVATE_KEY: "k", SCANNED: "" },
    });
    expect(bad.output, "a malformed repository is not a route").toBe("");
  });
});

test.describe("site-privacy-comment-alert — the dictated thin caller", () => {
  test("keeps the fleet's file name and events, and calls the reusable on a release tag", () => {
    expect(fs.existsSync(CALLER_PATH)).toBe(true);
    const doc = caller();
    expect(events(doc.on).sort()).toEqual(Object.keys(EVENTS).sort());
    for (const [event, spec] of Object.entries(EVENTS)) expect(doc.on[event]).toEqual(spec);
    expect(doc.permissions).toEqual({ contents: "read" });
    const jobs = doc.jobs || {};
    expect(Object.keys(jobs)).toEqual([CALLER_JOB]);
    const job = jobs[CALLER_JOB];
    expect(reusableBasename(job.uses)).toBe(REUSABLE);
    expect(String(job.uses)).toMatch(
      /^Adam-S-Daniel\/cms-platform\/\.github\/workflows\/site-privacy-comment-alert\.yml@v\d+\.\d+\.\d+$/,
    );
    expect(job.with).toBeUndefined();
    expect(job.secrets, "named, never `secrets: inherit`").toEqual(SECRETS);
  });

  test("its context is required by nothing (it never reports on a pull request's head)", () => {
    const manifest = parseYaml(fs.readFileSync(MANIFEST_PATH, "utf8")) || {};
    const context = `${CALLER_JOB} / ${WORK_JOB}`;
    expect(requiredContexts(manifest, "consumer-main")).not.toContain(context);
  });
});
