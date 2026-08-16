// @lane: local — pure-fs lint + behavioural test of the secrets-scan allowlist
// canary. No network.
//
// PLATFORM-INTERNAL: reads .github/workflows/secrets-scan.yml (a reusable
// DEFINITION); a consumer ships only a thin caller. Registered in
// playwright.config.js PLATFORM_META_SPECS.
//
// WHAT IS BEING GUARDED (issue #260)
//
// A `paths` entry in a gitleaks allowlist is NOT a finding filter — it makes
// gitleaks skip the file ENTIRELY, before any rule runs. Measured on the pinned
// 8.30.1 against this repo's own config: the three fixture `paths` entries
// removed 29,326 bytes (four files) from every scan while suppressing nothing —
// with the default ruleset and no `paths` at all, those files produce zero
// findings. A real credential pasted into any of them would not have been
// reported, in a public repo.
//
// Narrowing such an entry does not work: `regexTarget = "secret"` is ACCEPTED
// but only names the allowlist's DEFAULT target, so it narrows nothing, and
// gitleaks SILENTLY IGNORES unknown TOML keys, so a `condition = "AND"` added
// to scope it is dropped without warning. A config can look correct, load
// cleanly, and change nothing — which is exactly why this is measured rather
// than reviewed.
//
// THE METHODOLOGY TRAP, locked below: gitleaks auto-loads `.gitleaks.toml` FROM
// THE SCAN TARGET, so a "no config" control silently loads the config under
// test. Every scan the canary runs must pass `--config` explicitly, and the
// bare control config must live OUTSIDE the scanned tree. The first measurement
// in #260 was invalid for precisely this reason.
//
// The behavioural half runs the EXACT python the workflow ships (extracted from
// the step's heredoc), so it cannot drift from the deployed check. It needs the
// gitleaks binary; the pure-fs structural assertions always run, and self-CI's
// node-unit-lints lane has no gitleaks, so the behavioural tests skip there and
// exercise fully wherever the binary is present.
const { test, expect } = require("./base");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const WORKFLOW = "secrets-scan.yml";
const CANARY_STEP = "Allowlist canary";

// Parse the workflow (real YAML parser — anchors/aliases resolved) and return
// its scan-job steps.
function steps() {
  const doc = parseYaml(readWorkflow(WORKFLOW));
  return ((doc && doc.jobs && doc.jobs.scan && doc.jobs.scan.steps) || []).map((s) => ({
    name: String(s.name || ""),
    run: String(s.run || ""),
  }));
}

function canaryStep() {
  return steps().find((s) => s.name === CANARY_STEP);
}

// The python body between the `<<'PYEOF'` heredoc markers. The delimiter is a
// lexical token inside an already-parsed shell string, not code structure, so
// locating it by marker is appropriate here.
function probeSource() {
  const step = canaryStep();
  if (!step) return null;
  const open = step.run.indexOf("<<'PYEOF'\n");
  if (open < 0) return null;
  const body = step.run.slice(open + "<<'PYEOF'\n".length);
  const close = body.lastIndexOf("\nPYEOF");
  return close < 0 ? null : body.slice(0, close);
}

function hasBinary(bin) {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_GITLEAKS = hasBinary("gitleaks");

// ── fixture plumbing ──────────────────────────────────────────────────────────

// A throwaway git repo: the canary materialises allowlist patterns against
// `git ls-files`, so the probe needs real tracked paths. Staged-only is enough
// (no commit, hence no committer identity required).
function fixtureRepo(files, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  if (config !== null && config !== undefined) {
    fs.writeFileSync(path.join(dir, ".gitleaks.toml"), config);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

// Run the shipped probe against a fixture workspace. `extraEnv` is applied last
// so a test can shadow PATH (see blindGitleaksDir).
function runProbe(workspace, extraEnv = {}) {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "canary-probe-")), "probe.py");
  fs.writeFileSync(script, `${probeSource()}\n`);
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "canary-temp-"));
  const res = require("node:child_process").spawnSync("python3", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      ...extraEnv,
    },
  });
  return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

// A directory holding a `gitleaks` that reports NOTHING, whatever it is asked to
// scan. Prepended to PATH, it simulates the ONE condition the probe's own
// self-check exists for: gitleaks' default ruleset no longer matching the shape
// of the credential the canary plants. No caller config can produce that state
// (the bare control scan runs the `useDefault` config written to $RUNNER_TEMP,
// which the caller cannot influence), so the binary is what has to be replaced.
function blindGitleaksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-stub-"));
  const bin = path.join(dir, "gitleaks");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
# Write an empty report to --report-path, exit 0: "scanned, found nothing".
while [ $# -gt 0 ]; do
  case "$1" in
    --report-path) shift; printf '[]' > "$1" ;;
  esac
  shift
done
exit 0
`,
  );
  fs.chmodSync(bin, 0o755);
  return dir;
}

// A fixture file whose content is inert: the canary plants its OWN credential,
// so the fixture must not itself carry one (that would confuse pass/fail).
const FIXTURE_FILES = {
  "oauth-proxy/test_lambda.py": 'client_id = "test_client_id"\n',
};
const BLANKET = `[extend]
useDefault = true
[allowlist]
description = "fixture"
paths = ['''oauth-proxy/test_lambda\\.py''']
`;
const NARROWED = `[extend]
useDefault = true
[allowlist]
description = "fixture"
regexes = ['''test_client_(id|secret)''']
`;

// ── structural lints (always run) ─────────────────────────────────────────────

test.describe("secrets-scan allowlist canary: shape", () => {
  test("runs after gitleaks is installed and before the real scan", () => {
    const names = steps().map((s) => s.name);
    const canary = names.indexOf(CANARY_STEP);
    const install = names.indexOf("Install gitleaks");
    const scan = names.indexOf("Scan for secrets");
    expect(canary, `${WORKFLOW} has no "${CANARY_STEP}" step`).toBeGreaterThan(-1);
    expect(install, "no `Install gitleaks` step to order against").toBeGreaterThan(-1);
    expect(scan, "no `Scan for secrets` step to order against").toBeGreaterThan(-1);
    expect(canary, "canary must run after gitleaks is installed").toBeGreaterThan(install);
    expect(canary, "canary must run before the real scan, so a blind spot is").toBeLessThan(scan);
  });

  test("the probe body extracts and is valid python", () => {
    const src = probeSource();
    expect(src, "could not extract the `<<'PYEOF'` heredoc — keep the delimiter").toBeTruthy();
    const res = require("node:child_process").spawnSync(
      "python3",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
      { input: src, encoding: "utf8" },
    );
    expect(res.status, `probe body is not valid python:\n${res.stderr}`).toBe(0);
  });

  test("no ${{ }} interpolation in the canary run body", () => {
    // House rule: a rendered `run:` is echoed to a public log. The canary needs
    // only $RUNNER_TEMP / $GITHUB_WORKSPACE, which are plain env vars.
    const step = canaryStep();
    expect(step, `${WORKFLOW} has no "${CANARY_STEP}" step`).toBeTruthy();
    expect(step.run.match(/\$\{\{[^}]*\}\}/g) || [], "canary run body interpolates").toEqual([]);
  });

  test("every gitleaks invocation passes --config explicitly", () => {
    // THE #260 METHODOLOGY TRAP. gitleaks auto-loads .gitleaks.toml from the
    // scan target, so an invocation without --config silently loads the config
    // under test and the control measures nothing.
    const src = probeSource();
    const invocations = [...src.matchAll(/\[\s*"gitleaks"[\s\S]{0,600}?\]/g)].map((m) => m[0]);
    expect(invocations.length, "found no gitleaks argv in the probe — detector broken").toBe(1);
    for (const argv of invocations) {
      expect(argv, "gitleaks argv omits --config").toContain('"--config"');
    }
  });

  test("the bare control config is written outside the scanned tree", () => {
    // A config INSIDE the canary dir would be auto-discovered as that tree's
    // own .gitleaks.toml, re-introducing the trap the control exists to avoid.
    const src = probeSource();
    expect(src, "bare control config is not rooted at runner_temp").toContain(
      'bare = runner_temp / "gitleaks-canary-bare.toml"',
    );
    expect(src, "canary tree and bare config must not share a directory").toContain(
      'canary = runner_temp / "gitleaks-allowlist-canary"',
    );
  });
});

// ── behavioural proof (needs the gitleaks binary) ─────────────────────────────

test.describe("secrets-scan allowlist canary: behaviour", () => {
  test.skip(!HAVE_GITLEAKS, "gitleaks binary not on PATH — pure-fs lanes skip the live proof");

  test("FAILS on a config with a blanket `paths` entry", () => {
    const repo = fixtureRepo(FIXTURE_FILES, BLANKET);
    const { code, out } = runProbe(repo);
    expect(code, `canary passed a blanket paths entry:\n${out}`).toBe(1);
    expect(out).toContain("allowlist blind spot: oauth-proxy/test_lambda.py");
    // The message must name the entry to fix, not just the file.
    expect(out).toContain("paths entry");
  });

  test("PASSES on the same fixture with the entry narrowed to `regexes`", () => {
    const repo = fixtureRepo(FIXTURE_FILES, NARROWED);
    const { code, out } = runProbe(repo);
    expect(code, `canary failed a config with no path exclusions:\n${out}`).toBe(0);
    expect(out).toContain("allowlist canary: OK");
  });

  test("PASSES for a caller with no .gitleaks.toml at all", () => {
    // The reusable is consumed by sites that may ship no allowlist; the canary
    // must never fail them.
    const repo = fixtureRepo(FIXTURE_FILES, null);
    const { code, out } = runProbe(repo);
    expect(code, `canary failed a caller with no allowlist:\n${out}`).toBe(0);
    expect(out).toContain("no allowlist to canary");
  });

  test("PASSES, with a warning, on an unparseable .gitleaks.toml", () => {
    // The real scan step reports the config error; the canary must not turn one
    // broken config into two confusing failures.
    const repo = fixtureRepo(FIXTURE_FILES, "[allowlist\nthis is not toml = = =\n");
    const { code, out } = runProbe(repo);
    expect(code, `canary hard-failed on a malformed config:\n${out}`).toBe(0);
    expect(out).toContain("::warning::");
  });

  test("PASSES on a `paths` entry that matches no tracked file", () => {
    // Both consumer sites are in this state today: they inherited the platform's
    // entries but ship none of the matching files, so there is no LIVE blind
    // spot. A latent entry must not red their CI — it activates, and fails, the
    // moment a matching file appears.
    const latent = `[extend]
useDefault = true
[allowlist]
description = "fixture"
paths = ['''scripts/nonexistent-file\\.js''']
`;
    const repo = fixtureRepo(FIXTURE_FILES, latent);
    const { code, out } = runProbe(repo);
    expect(code, `canary failed on a latent (unmatched) paths entry:\n${out}`).toBe(0);
    expect(out).toContain("allowlist canary: OK");
  });

  test("a config that swallows the plant is a blind spot at the CONTROL path", () => {
    // An allowlist broad enough to swallow any ghp_ token blinds the caller's
    // scan everywhere — including the control plant, which no sane allowlist
    // would ever cover, and which is therefore the sharpest possible evidence.
    //
    // It does NOT blind the canary: the bare control scan runs the `useDefault`
    // config written to $RUNNER_TEMP, which a caller cannot influence. So the
    // verdict here must be the caller's blind spot, never "the canary broke" —
    // the paired self-check test below covers the other side of that fork.
    const swallow = `[extend]
useDefault = true
[allowlist]
description = "fixture"
regexes = ['''ghp_[A-Za-z0-9]{36}''']
`;
    const repo = fixtureRepo(FIXTURE_FILES, swallow);
    const { code, out } = runProbe(repo);
    expect(code, `a config swallowing every PAT should fail:\n${out}`).toBe(1);
    expect(out).toContain("allowlist blind spot: __gitleaks_canary_control__/control.txt");
    expect(out, "the blind spot must be attributed to the control path").toContain(
      "the control path",
    );
    expect(out, "the canary is healthy here — only the caller's config is blind").not.toContain(
      "canary is BROKEN",
    );
  });
});

// ── the canary's own self-check (stubbed binary, no real gitleaks needed) ─────

test.describe("secrets-scan allowlist canary: self-check", () => {
  test("blames ITSELF, not the caller, when the bare ruleset cannot see the plant", () => {
    // The probe's `CONTROL not in bare_found` branch exists so a canary whose
    // token shape has gone stale relative to gitleaks' rules can never be
    // reported as a caller's blind spot — that would send someone editing a
    // .gitleaks.toml which was never at fault, and would do it on the day the
    // check silently stopped proving anything.
    //
    // The caller config here is the GOOD one (NARROWED), so a false accusation
    // would be unambiguous: nothing about it is blind.
    const repo = fixtureRepo(FIXTURE_FILES, NARROWED);
    const stub = blindGitleaksDir();
    const { code, out } = runProbe(repo, {
      PATH: `${stub}${path.delimiter}${process.env.PATH}`,
    });
    expect(code, `a blind bare control scan must fail the canary:\n${out}`).toBe(1);
    expect(out).toContain("allowlist canary is BROKEN, not the config");
    // The whole point of the branch: it must stop BEFORE accusing the caller.
    expect(out, "a stale canary must never be reported as the caller's blind spot").not.toContain(
      "allowlist blind spot",
    );
  });
});
