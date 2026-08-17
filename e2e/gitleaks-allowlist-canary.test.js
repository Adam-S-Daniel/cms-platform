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
// THE PAIR INVARIANT, also locked below — the rule-scoped half of the same
// hazard #260 is about. An allowlist can blind ONE RULE at a path instead of
// removing the file — `[[rules.allowlists]].paths`, the singular
// `[rules.allowlist].paths`, a global `[[allowlists]]` with `targetRules`, or a
// global `regexes` entry with `regexTarget = "match"`. The file then STILL
// reports: measured on 8.30.1, a plant with `github-pat` blinded comes back
// under `generic-api-key`. So the canary compares (file, RuleID) PAIRS, never
// files — teaching it to COLLECT those entries while still comparing files was
// built and measured, and it still printed OK over a live blind spot. The loss
// is total for the blinded class: a bare `ghp_` token in prose vanishes
// entirely, because `generic-api-key` never matched it.
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

// HOUSE RULE: reason about the probe's STRUCTURE with a parser, never a regex.
// The probe is PYTHON, so e2e/spec-ast.js (acorn) cannot read it — python's own
// `ast` is the right instrument, and `python3` is already a hard dependency of
// this always-run lane (the "valid python" test below spawns it).
const FACTS_PY = `
import ast, json, sys

tree = ast.parse(sys.stdin.read())

def strings(node):
    return [e.value for e in getattr(node, "elts", [])
            if isinstance(e, ast.Constant) and isinstance(e.value, str)]

def named(name):
    for n in tree.body:
        if isinstance(n, ast.FunctionDef) and n.name == name:
            return n
    return None

seen_add = []
scan = named("scan")
for n in (ast.walk(scan) if scan else []):
    if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)):
        continue
    if n.func.attr != "add" or not isinstance(n.func.value, ast.Name):
        continue
    if n.func.value.id != "seen":
        continue
    arg = n.args[0] if n.args else None
    seen_add.append({"type": type(arg).__name__,
                     "len": len(arg.elts) if isinstance(arg, ast.Tuple) else None})

argv = []
for n in ast.walk(tree):
    if not (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)):
        continue
    if n.func.attr != "run" or not isinstance(n.func.value, ast.Name):
        continue
    if n.func.value.id != "subprocess" or not n.args:
        continue
    if not isinstance(n.args[0], ast.List):
        continue
    consts = strings(n.args[0])
    if consts[:1] == ["gitleaks"]:
        argv.append(consts)

json.dump({
    "funcs": [n.name for n in tree.body if isinstance(n, ast.FunctionDef)],
    "called": sorted({n.func.id for n in ast.walk(tree)
                      if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}),
    "seenAdd": seen_add,
    "gitleaksArgv": argv,
}, sys.stdout)
`;

// Module-level function names, the names actually called, the shape of the
// `seen.add(...)` argument inside scan(), and every gitleaks argv — as facts,
// not text.
function probeFacts() {
  const res = require("node:child_process").spawnSync("python3", ["-c", FACTS_PY], {
    input: probeSource(),
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`probe fact extraction failed:\n${res.stderr}`);
  return JSON.parse(res.stdout);
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

// ── rule-scoped allowlists ────────────────────────────────────────────────────
// Each of these removes ONE RULE from a file instead of the file from the scan,
// and every one of them printed `OK` before the (file, RuleID) comparison
// landed. Fixture rule ids MUST be REAL default ids: measured, a `[[rules]]` id
// that matches no rule makes gitleaks fail the config LOAD, so a typo would fail
// a test for a reason unrelated to what it asserts.
const PER_RULE_PLURAL = `[extend]
useDefault = true

[[rules]]
id = "github-pat"
[[rules.allowlists]]
paths = ['''oauth-proxy/test_lambda\\.py''']
`;
const PER_RULE_SINGULAR = `[extend]
useDefault = true

[[rules]]
id = "github-pat"
[rules.allowlist]
paths = ['''oauth-proxy/test_lambda\\.py''']
`;
const PER_RULE_DIRECTORY = `[extend]
useDefault = true

[[rules]]
id = "github-pat"
[[rules.allowlists]]
paths = ['''oauth-proxy/''']
`;
const PER_RULE_BOTH = `[extend]
useDefault = true

[[rules]]
id = "github-pat"
[[rules.allowlists]]
paths = ['''oauth-proxy/''']

[[rules]]
id = "generic-api-key"
[[rules.allowlists]]
paths = ['''oauth-proxy/''']
`;
const PER_RULE_UNRELATED = `[extend]
useDefault = true

[[rules]]
id = "aws-access-token"
[[rules.allowlists]]
paths = ['''oauth-proxy/''']
`;
const PER_RULE_LATENT = `[extend]
useDefault = true

[[rules]]
id = "github-pat"
[[rules.allowlists]]
paths = ['''scripts/nonexistent-file\\.js''']
`;
// A GLOBAL block that names `targetRules` — the construct the canary already
// claimed to cover, blinding one rule at a path while the file still reports.
const GLOBAL_TARGET_RULES = `[extend]
useDefault = true

[[allowlists]]
targetRules = ["github-pat"]
paths = ['''oauth-proxy/test_lambda\\.py''']
`;
// A GLOBAL `regexes` entry narrow enough to look responsible and broad enough to
// swallow one rule's match everywhere — i.e. what the old failure message's own
// remedy advice produces if taken too literally.
const GLOBAL_MATCH_REGEXES = `[extend]
useDefault = true
[allowlist]
regexTarget = "match"
regexes = ['''^ghp_[A-Za-z0-9]{36}$''']
`;
// Loads-nowhere: `[[rules]]` with an id no rule has is fatal to gitleaks.
const UNLOADABLE = `[extend]
useDefault = true

[[rules]]
id = "githbu-pat"
[[rules.allowlists]]
paths = ['''oauth-proxy/''']
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
    //
    // Every argv is checked, not "the one argv": the old detector regex-scanned
    // the python and asserted a count of exactly 1, so it broke on a second scan
    // and on an argv longer than its character bound.
    const argvs = probeFacts().gitleaksArgv;
    expect(argvs.length, "found no gitleaks argv in the probe — detector broken").toBeGreaterThan(
      0,
    );
    for (const argv of argvs) {
      expect(argv, "gitleaks argv omits --config").toContain("--config");
    }
  });

  test("the probe collects PER-RULE allowlists, not just global ones", () => {
    // A `[[rules.allowlists]]` / `[rules.allowlist]` `paths` entry removes ONE
    // rule from a file. The shipped check collected only global blocks, so it
    // planted nothing at such a path and reported "0 at allowlisted path(s)" —
    // blind by OMISSION, printing OK over a live blind spot.
    const facts = probeFacts();
    expect(facts.funcs, "probe lost its per-rule allowlist collector").toContain("rule_allowlists");
    expect(facts.called, "rule_allowlists is defined but never called").toContain(
      "rule_allowlists",
    );
  });

  test("the blind-spot comparison is over (file, RuleID) PAIRS, not files", () => {
    // THE load-bearing half — and, on a lane with no gitleaks binary, the only
    // automated defence there is. Measured: collecting the per-rule entries
    // while still comparing FILES *still prints OK*, because a plant whose
    // `github-pat` is blinded comes straight back under `generic-api-key`, so
    // the file is in the report either way. Do not weaken this as "redundant
    // with the behavioural tests" — those skip wherever gitleaks is absent.
    const adds = probeFacts().seenAdd;
    expect(adds.length, "found no `seen.add(...)` inside scan() — detector broken").toBe(1);
    expect(adds[0].type, "scan() records bare files, not (file, RuleID) pairs").toBe("Tuple");
    expect(adds[0].len, "the recorded pair must carry exactly the file and the RuleID").toBe(2);
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

  // ── rule-scoped blind spots ────────────────────────────────────────────────
  // The shipped check passed every one of the failing cases below. Measured on
  // 8.30.1, and load-bearing for all of them: with `github-pat` blinded at a
  // path, the plant is STILL reported there — by `generic-api-key` — so nothing
  // short of a (file, RuleID) comparison can see the loss.

  test("FAILS on a per-rule `[[rules.allowlists]]` paths entry", () => {
    const repo = fixtureRepo(FIXTURE_FILES, PER_RULE_PLURAL);
    const { code, out } = runProbe(repo);
    expect(code, `canary passed a per-rule paths entry:\n${out}`).toBe(1);
    expect(out).toContain("rule 'github-pat' reports nothing at oauth-proxy/test_lambda.py");
    // The message must name the entry AND the rule, so the reader can judge the
    // blast radius in seconds rather than reading it as a whole-file exclusion.
    expect(out, "the failure must name the per-rule entry it came from").toContain("per-rule");
    expect(out, "a rule-scoped blind spot is not a whole-file one").not.toContain(
      "skipped ENTIRELY",
    );
  });

  test("FAILS on the singular `[rules.allowlist]` spelling too", () => {
    // Half the bypass: measured, both spellings silence the rule identically.
    const repo = fixtureRepo(FIXTURE_FILES, PER_RULE_SINGULAR);
    const { code, out } = runProbe(repo);
    expect(code, `canary passed the singular per-rule spelling:\n${out}`).toBe(1);
    expect(out).toContain("rule 'github-pat' reports nothing at oauth-proxy/test_lambda.py");
  });

  test("FAILS on an id-only rule stanza covering a whole directory", () => {
    // The minimal real-world shape: three lines, no regex restated, attached to
    // an INHERITED default rule, blinding it across a directory.
    const repo = fixtureRepo(FIXTURE_FILES, PER_RULE_DIRECTORY);
    const { code, out } = runProbe(repo);
    expect(code, `canary passed an id-only directory-wide entry:\n${out}`).toBe(1);
    expect(out).toContain("rule 'github-pat' reports nothing at oauth-proxy/test_lambda.py");
    expect(out, "the entry, not just the rule, must be named").toContain("'oauth-proxy/'");
  });

  test("FAILS, as a WHOLE-FILE blind spot, when every rule that sees the plant is blinded", () => {
    // Measured: with both rules blinded the file produces ZERO findings, so the
    // whole-file wording is the true one here — claiming "other rules still
    // scan this file" would be a false statement in the canary's own output.
    //
    // This case alone is NOT sufficient coverage: the file vanishes entirely, so
    // even a file-level comparison catches it. The three tests above are what
    // discriminate the fix from the naive one.
    const repo = fixtureRepo(FIXTURE_FILES, PER_RULE_BOTH);
    const { code, out } = runProbe(repo);
    expect(code, `canary passed two entries blinding every rule:\n${out}`).toBe(1);
    expect(out).toContain("oauth-proxy/test_lambda.py is skipped ENTIRELY");
    expect(out, "no rule reports this file — do not claim others still scan it").not.toContain(
      "Other rules still scan",
    );
  });

  test("PASSES, with a not-measurable note, on an entry for an unrelated rule", () => {
    // The false-positive bound. gitleaks DEDUPES: the bare baseline attributes
    // the plant to exactly one rule, so an entry on any other rule cannot be
    // measured here — and says so instead of guessing.
    const repo = fixtureRepo(FIXTURE_FILES, PER_RULE_UNRELATED);
    const { code, out } = runProbe(repo);
    expect(code, `canary failed an entry on a rule the plant never triggers:\n${out}`).toBe(0);
    expect(out).toContain("NOT measurable by this check");
    expect(out, "the note must name the rule it could not measure").toContain("aws-access-token");
    expect(out, "an unmeasurable entry is not a blind spot").not.toContain("allowlist blind spot");
  });

  test("PASSES on a per-rule entry that matches no tracked file", () => {
    // Mirrors the latent-global contract above: an entry that covers nothing
    // today must not red anyone's CI. It activates when a matching file appears.
    const repo = fixtureRepo(FIXTURE_FILES, PER_RULE_LATENT);
    const { code, out } = runProbe(repo);
    expect(code, `canary failed on a latent per-rule entry:\n${out}`).toBe(0);
    expect(out).toContain("allowlist canary: OK");
  });

  test("FAILS on a GLOBAL `[[allowlists]]` that names `targetRules`", () => {
    // Not a per-rule block at all — a global one, i.e. squarely inside the scope
    // this check already claimed to cover, and it passed anyway. `targetRules`
    // is load-validated (a bogus id is fatal), so it is a first-class construct.
    const repo = fixtureRepo(FIXTURE_FILES, GLOBAL_TARGET_RULES);
    const { code, out } = runProbe(repo);
    expect(code, `canary passed a global targetRules entry:\n${out}`).toBe(1);
    expect(out).toContain("rule 'github-pat' reports nothing at oauth-proxy/test_lambda.py");
    expect(out, "the failure must name the construct that caused it").toContain("targetRules");
    expect(out, "the file is still scanned by other rules").not.toContain("skipped ENTIRELY");
  });

  test('FAILS on a global `regexTarget = "match"` entry that blinds one rule', () => {
    // Also global, and produced by following the old failure message's own
    // advice too literally: the entry matches the credential SHAPE, so it
    // silences `github-pat` everywhere — including the control path — while
    // `generic-api-key` keeps reporting the same files.
    const repo = fixtureRepo(FIXTURE_FILES, GLOBAL_MATCH_REGEXES);
    const { code, out } = runProbe(repo);
    expect(code, `canary passed a match-target regexes entry:\n${out}`).toBe(1);
    expect(out).toContain(
      "rule 'github-pat' reports nothing at __gitleaks_canary_control__/control.txt",
    );
    expect(out, "the control file is still scanned by other rules").not.toContain(
      "skipped ENTIRELY",
    );
    // The remedy must not be the thing they already did.
    expect(out, "advice must not tell a regexTarget author to add regexTarget").toContain(
      "literal text",
    );
  });

  test("PASSES, with a warning, on a config gitleaks cannot LOAD", () => {
    // Same contract as the unparseable-TOML case: one broken config must not
    // become two confusing failures. Measured, an unloadable config writes NO
    // report and exits non-zero — which the old code read as "nothing reported
    // anywhere", i.e. a blind spot at the control path, sending the reader to
    // hunt an allowlist that was never the problem.
    const repo = fixtureRepo(FIXTURE_FILES, UNLOADABLE);
    const { code, out } = runProbe(repo);
    expect(code, `canary hard-failed on a config gitleaks cannot load:\n${out}`).toBe(0);
    expect(out).toContain("::warning::");
    expect(out).toContain("could not load");
    expect(out, "a config-load failure is not an allowlist blind spot").not.toContain(
      "allowlist blind spot",
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
