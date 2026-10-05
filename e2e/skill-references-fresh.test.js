// @lane: local — pure-fs lint (no browser, no build, no network) over this
// repo's skills/*/SKILL.md and the tree they cite.
//
// cms-platform#408. A reference-heavy skill (aws-bootstrap,
// preview-environments, consumer-repo-provisioning, …) fails by going STALE:
// a workflow renamed, a secret retired, a template output moved. An A/B eval
// measures nothing useful there (skills-evals' DESIGN.md non-coverage table),
// so the instrument is this lint, in the repo where the cited things live.
//
// For every skills/<name>/SKILL.md it extracts, from code spans, fenced and
// indented code blocks only (adam-agentskills' check_skills.py precision rule —
// prose mentions are LISTED, never failed):
//   path      `scripts/x.sh`, `.github/workflows/y.yml`, … → exists here (a
//             `.github/workflows/<x>` is the PLATFORM file: the same-named
//             example caller under examples/site/ does not stand in for it)
//   workflow  a bare `<name>.yml` → a workflow under .github/workflows/ or
//             examples/site/.github/workflows/, or some file of that name
//   file      a bare `<name>.js|sh|rb|py` → some file of that name
//   name      `secrets.X` / `vars.X` / a bare `UPPER_SNAKE` → read by a
//             workflow (parsed with `yaml`: secrets./vars./env. inside `${{ }}`
//             or an `if:`, env: keys, workflow_call secrets, $X in run:) or a
//             script (JS through acorn: process.env.X; shell, Ruby and Python
//             with their `#` comments and Ruby =begin/=end blocks stripped), or
//             used as a code identifier. A name only a COMMENT or workflow
//             prose (name:, description:) mentions is flagged. A string
//             literal or docstring in shell/Ruby/Python still counts as
//             source text. A bare UPPER_SNAKE span fails only where its
//             context marks it a secret or variable (`$X`, `${X}`,
//             `process.env.X`, `X=v`, or a heading, table header or sentence
//             saying secret/variable/env/token); a status literal such as
//             IN_PROGRESS is listed, never failed
//   cfn       (aws-bootstrap) a parameter / resource / output / property name
//             in infrastructure/*/template.yaml (parsed with `yaml`)
// The tree is `git ls-files` (the walk only outside a git checkout), so a
// gitignored local file such as infrastructure/site-params.env never counts
// and the lint reads the same tree locally and in CI; a new file must be
// `git add`-ed before a skill may cite it.
// The rules live in e2e/skill-references-rules.js.
//
// A citation that is deliberately absent — removed and documented as removed,
// consumer-side, an AWS literal — goes in skills/.freshness-allow.yml with a
// reason and a marker line; an entry whose citation resolves again, is no
// longer cited, or whose marker is gone FAILS (stale allowlist).
//
// Registered in playwright.config.js PLATFORM_META_SPECS: it reads skills/ and
// the platform's own workflows and templates, none of which a consumer ships.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const {
  allowlistStanza,
  checkSkill,
  extractCitations,
  loadTree,
  parseAllowlist,
} = require("./skill-references-rules");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const ALLOW_FILE = path.join(SKILLS_DIR, ".freshness-allow.yml");

const CONSUMER = !!process.env.SITE_ROOT;
const SKIP_REASON =
  "SITE_ROOT is set (CONSUMER lane) — a consumer ships no skills/ and none of the " +
  "platform workflows or templates they cite. Runs in self-ci.yml's node-unit-lints lane.";

// The skills #408 names first. Each must yield checked citations, or the
// lint has silently stopped extracting from the files it exists for.
const REFERENCE_HEAVY = ["aws-bootstrap", "preview-environments", "consumer-repo-provisioning"];

function skillNames() {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

function format(skill, failures) {
  const lines = failures.map(
    (f) => `  skills/${skill}/SKILL.md${f.line ? `:${f.line}` : ""} [${f.kind}] ${f.reason}`,
  );
  // A ready-to-paste stanza for each failure the allowlist could answer.
  const stanzas = failures.map((f) => allowlistStanza(skill, f)).filter(Boolean);
  if (stanzas.length) {
    lines.push(
      "  If the citation is deliberately absent, paste under `allow:` in skills/.freshness-allow.yml " +
        "and fill in the reason and marker:",
      ...stanzas.map((x) => x.replace(/^/gm, "    ")),
    );
  }
  return lines.join("\n");
}

test.describe("skill references are fresh (#408)", () => {
  test.skip(CONSUMER, SKIP_REASON);

  let tree;
  let allow;
  test.beforeAll(() => {
    tree = loadTree(ROOT);
    allow = parseAllowlist(fs.readFileSync(ALLOW_FILE, "utf8"));
  });

  test("skills/.freshness-allow.yml is well-formed and names real skills", () => {
    expect(allow.errors, "skills/.freshness-allow.yml entry errors").toEqual([]);
    const known = new Set(skillNames());
    const unknown = [...allow.bySkill.keys()].filter((s) => !known.has(s));
    expect(unknown, "allowlist entries for skills that do not exist").toEqual([]);
  });

  test("the extractor is not vacuous on the reference-heavy skills", () => {
    const counts = {};
    for (const skill of REFERENCE_HEAVY) {
      const text = fs.readFileSync(path.join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      counts[skill] = extractCitations(text, { skill }).citations.length;
    }
    for (const skill of REFERENCE_HEAVY) {
      expect(counts[skill], `${skill}: citations extracted (${JSON.stringify(counts)})`).toBeGreaterThan(0);
    }
  });

  for (const skill of skillNames()) {
    test(`skills/${skill}/SKILL.md: every cited path, workflow, name resolves`, () => {
      const text = fs.readFileSync(path.join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      const result = checkSkill(text, tree, { skill, allow: allow.bySkill.get(skill) || [] });
      const kinds = {};
      for (const c of result.citations) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
      // The per-skill count is the proof this check is not vacuous; prose
      // mentions that do not resolve are listed, never failed.
      console.log(
        `[skill-references] ${skill}: ${result.checked} checked ${JSON.stringify(kinds)}, ` +
          `${result.allowed.length} allowlisted, ${result.prose.length} prose-only unresolved`,
      );
      for (const p of result.prose) {
        console.log(`[skill-references]   prose (listed only) ${skill}/SKILL.md:${p.line} ${p.value}`);
      }
      expect(
        result.failures,
        `stale references in skills/${skill}/SKILL.md — fix the citation, or allowlist it in ` +
          `skills/.freshness-allow.yml with a reason and a marker line:\n${format(skill, result.failures)}`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Unit tests over a fixture SKILL.md and a synthetic tree (red first, #408).
// ---------------------------------------------------------------------------

const FIXTURE = [
  "---",
  "name: fixture",
  "description: a fixture skill",
  "---",
  "",
  "# Fixture",
  "",
  "Run `scripts/real.sh` first.",
  "",
  "```bash",
  "bash scripts/gone.sh",
  "```",
  "",
  "In prose, scripts/also-gone.sh is merely mentioned.",
  "",
  "Set the variable `NOBODY_READS_THIS` and `vars.LIVE_VAR` and `secrets.LIVE_SECRET`.",
  "",
  "The `OLD_PAT` token — REMOVED in v9 (kept for older pins).",
  "",
  "The secret `LIVE_SECRET` was allowlisted once, but is read again.",
  "",
  "The `deploy.yml` workflow and `examples/site/.github/workflows/caller.yml` run it.",
  "",
].join("\n");

function syntheticTree(over = {}) {
  const { files: extra, ...rest } = over;
  const files = new Set(
    extra || ["scripts/real.sh", ".github/workflows/deploy.yml", "examples/site/.github/workflows/caller.yml"],
  );
  const workflows = [...files].filter((f) => /^(?:examples\/site\/)?\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  return {
    exists: (rel) => files.has(rel) || [...files].some((f) => f.startsWith(`${rel}/`)),
    basenames: new Set([...files].map((f) => f.split("/").pop())),
    workflows: new Set(workflows.map((f) => f.split("/").pop())),
    contextNames: new Set(["vars.LIVE_VAR", "secrets.LIVE_SECRET"]),
    envNames: new Set(["LIVE_VAR", "LIVE_SECRET"]),
    codeNames: new Set(),
    cfnNames: new Set(["ResourcePrefix"]),
    ...rest,
  };
}

const ALLOW = [
  { skill: "fixture", citation: "OLD_PAT", reason: "removed in v9", marker: "REMOVED in v9" },
  { skill: "fixture", citation: "LIVE_SECRET", reason: "was removed", marker: "was allowlisted once" },
];

test.describe("skill-references rules (fixture)", () => {
  const run = (allow = ALLOW, tree = syntheticTree(), text = FIXTURE) =>
    checkSkill(text, tree, { skill: "fixture", allow });
  const failed = (r) => r.failures.map((f) => f.value);

  test("a cited path that exists passes", () => {
    expect(failed(run())).not.toContain("scripts/real.sh");
  });

  test("a missing path inside a fenced block fails, with its file line", () => {
    const f = run().failures.find((x) => x.value === "scripts/gone.sh");
    expect(f, "scripts/gone.sh in a fence must fail").toBeTruthy();
    expect(f.line).toBe(11);
  });

  test("a missing path in prose is listed, not failed", () => {
    const r = run();
    expect(failed(r)).not.toContain("scripts/also-gone.sh");
    expect(r.prose.map((p) => p.value)).toContain("scripts/also-gone.sh");
  });

  test("a secret or variable nothing reads fails; read ones pass", () => {
    const f = failed(run());
    expect(f).toContain("NOBODY_READS_THIS");
    expect(f).not.toContain("vars.LIVE_VAR");
    expect(f).not.toContain("secrets.LIVE_SECRET");
  });

  test("an allowlisted historical citation passes", () => {
    const r = run();
    expect(failed(r)).not.toContain("OLD_PAT");
    expect(r.allowed.map((c) => c.value)).toContain("OLD_PAT");
  });

  test("an allowlisted citation that resolves again fails as a stale allowlist", () => {
    const f = run().failures.find((x) => x.value === "LIVE_SECRET");
    expect(f && f.reason).toMatch(/stale allowlist/);
  });

  test("an allowlist entry whose marker line is gone fails", () => {
    const r = run([{ ...ALLOW[0], marker: "no such line" }]);
    expect(r.failures.some((x) => x.value === "OLD_PAT" && /marker/.test(x.reason))).toBe(true);
  });

  test("an allowlist entry the skill no longer cites fails", () => {
    const r = run([...ALLOW, { skill: "fixture", citation: "NEVER_CITED", reason: "x", marker: "Fixture" }]);
    expect(r.failures.some((x) => x.value === "NEVER_CITED")).toBe(true);
  });

  test("workflow names resolve under .github/workflows or examples/site", () => {
    const r = run();
    expect(failed(r)).not.toContain("deploy.yml");
    expect(failed(r)).not.toContain("examples/site/.github/workflows/caller.yml");
    const gone = run(ALLOW, syntheticTree({ workflows: new Set(), basenames: new Set() }));
    expect(failed(gone)).toContain("deploy.yml");
  });

  test("a `.github/workflows/` citation must be the platform file; a bare name may be an example caller (S1)", () => {
    const text = "Run `.github/workflows/deploy-preview.yml`, or just `deploy-preview.yml`.\n";
    const exampleOnly = syntheticTree({ files: ["examples/site/.github/workflows/deploy-preview.yml"] });
    const r = checkSkill(text, exampleOnly, { skill: "s" });
    expect(failed(r)).toEqual([".github/workflows/deploy-preview.yml"]);
    const both = syntheticTree({
      files: [".github/workflows/deploy-preview.yml", "examples/site/.github/workflows/deploy-preview.yml"],
    });
    expect(failed(checkSkill(text, both, { skill: "s" }))).toEqual([]);
  });

  test("a status literal in prose is listed, not failed, and needs no allowlist entry (N3)", () => {
    const text = "# T\n\nThe rollup shows `IN_PROGRESS`, so wait.\n";
    const r = checkSkill(text, syntheticTree(), { skill: "s" });
    expect(failed(r)).toEqual([]);
    expect(r.prose.map((p) => p.value)).toContain("IN_PROGRESS");
  });

  test("an allowlist entry for a name that is not cited as a secret or variable fails as unneeded (N3)", () => {
    const text = "# T\n\nThe rollup shows `IN_PROGRESS`, so wait.\n";
    const allow = [{ skill: "s", citation: "IN_PROGRESS", reason: "status", marker: "The rollup shows" }];
    const r = checkSkill(text, syntheticTree(), { skill: "s", allow });
    expect(r.failures.map((f) => f.reason).join("\n")).toMatch(/not cited as a secret or variable/);
  });

  test("a bare name is a secret or variable citation when its context marks it as one (N3)", () => {
    const text = [
      "# T",
      "",
      "Export `$ENV_DOLLAR_GONE`, `${ENV_BRACE_GONE}`, `process.env.ENV_NODE_GONE` and `ENV_ASSIGN_GONE=1`.",
      "",
      "| Secret name | Where |",
      "|---|---|",
      "| `TABLE_SECRET_GONE` | repo |",
      "",
      "Plain prose mentions `UNMARKED_NAME_GONE` only.",
      "",
      "## Repository variables",
      "",
      "- `HEADING_VAR_GONE` is opt-in.",
      "",
    ].join("\n");
    const r = checkSkill(text, syntheticTree(), { skill: "s" });
    expect(failed(r).sort()).toEqual(
      ["ENV_ASSIGN_GONE", "ENV_BRACE_GONE", "ENV_DOLLAR_GONE", "ENV_NODE_GONE", "HEADING_VAR_GONE", "TABLE_SECRET_GONE"].sort(),
    );
    expect(r.prose.map((p) => p.value)).toContain("UNMARKED_NAME_GONE");
  });

  test("a bare name that opens a list item, a table cell or a heading is a checked citation (R2-1)", () => {
    const text = [
      "# T",
      "",
      "- `LIST_OPENER_GONE` — what it does",
      "- Wait while the rollup shows `MID_SENTENCE_STATUS`, then retry.",
      "",
      "| Name | Purpose |",
      "|---|---|",
      "| `CELL_OPENER_GONE` | does a thing |",
      "| plain | see `CELL_MID_STATUS` |",
      "",
      "## `HEADING_OPENER_GONE` — gone",
      "",
    ].join("\n");
    const r = checkSkill(text, syntheticTree(), { skill: "s" });
    expect(failed(r).sort()).toEqual(["CELL_OPENER_GONE", "HEADING_OPENER_GONE", "LIST_OPENER_GONE"]);
    expect(r.prose.map((p) => p.value).sort()).toEqual(["CELL_MID_STATUS", "MID_SENTENCE_STATUS"]);
  });

  test("the failure message carries a ready-to-paste allowlist stanza (N1)", () => {
    const f = { kind: "path", value: "scripts/gone.sh", line: 3, reason: "x" };
    const stanza = allowlistStanza("fixture", f);
    const [entry] = YAML.parse(stanza);
    expect(Object.keys(entry)).toEqual(["skill", "citation", "reason", "marker"]);
    expect(entry.skill).toBe("fixture");
    expect(entry.citation).toBe("scripts/gone.sh");
    expect(stanza).toMatch(/^- skill: fixture$/m);
    // A stale-allowlist failure is answered by removing the entry, not adding one.
    expect(allowlistStanza("fixture", { kind: "allowlist", value: "X_Y", line: 0, reason: "r" })).toBeNull();
    expect(format("fixture", [f])).toContain("citation: scripts/gone.sh");
  });

  test("CloudFormation names are checked for aws-bootstrap only", () => {
    const text = "Use `ResourcePrefix` and `${ResourcePrefix}-x` but not `MissingOutput`.\n";
    const r = checkSkill(text, syntheticTree(), { skill: "aws-bootstrap" });
    expect(failed(r)).toEqual(["MissingOutput"]);
    expect(checkSkill(text, syntheticTree(), { skill: "other" }).checked).toBe(0);
  });

  test("a citation in a table cell reports its row's line", () => {
    const text = "# T\n\n| a | b |\n|---|---|\n| x | y |\n| `scripts/gone.sh` | z |\n";
    const f = checkSkill(text, syntheticTree(), { skill: "t" }).failures;
    expect(f.map((x) => `${x.value}:${x.line}`)).toEqual(["scripts/gone.sh:6"]);
  });

  test("the allowlist parser rejects an entry without a reason or marker", () => {
    const { errors } = parseAllowlist("allow:\n  - skill: s\n    citation: X_Y\n");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("loadTree reads names from parsed workflows, not from comments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-refs-"));
    try {
      fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".github/workflows/w.yml"),
        [
          "# COMMENT_ONLY_PAT is mentioned here and read nowhere",
          "on: { workflow_call: { secrets: { app_key: { required: false } } } }",
          "jobs:",
          "  j:",
          "    runs-on: ubuntu-latest",
          "    env: { FROM_ENV_KEY: x }",
          "    steps:",
          "      - run: echo \"$FROM_RUN ${{ secrets.FROM_SECRET }} ${{ vars.FROM_VAR }}\"",
          "",
        ].join("\n"),
      );
      fs.mkdirSync(path.join(dir, "infrastructure/stack"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "infrastructure/stack/template.yaml"),
        "Parameters:\n  Prefix: { Type: String }\nResources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: !Sub '${Prefix}-b'\nOutputs:\n  BucketOut: { Value: !Ref Bucket }\n",
      );
      const t = loadTree(dir);
      for (const n of ["FROM_ENV_KEY", "FROM_RUN", "FROM_SECRET", "FROM_VAR", "app_key"]) {
        expect(t.envNames.has(n), n).toBe(true);
      }
      expect(t.contextNames.has("secrets.FROM_SECRET")).toBe(true);
      expect(t.contextNames.has("vars.FROM_VAR")).toBe(true);
      expect(t.envNames.has("COMMENT_ONLY_PAT")).toBe(false);
      expect(t.workflows.has("w.yml")).toBe(true);
      for (const n of ["Prefix", "Bucket", "BucketName", "BucketOut"]) expect(t.cfnNames.has(n), n).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadTree over real files: comments never count (S2), the two workflow
// directories stay distinct (S1), untracked files never count (S3).
// ---------------------------------------------------------------------------

function withTree(files, fn, { git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-refs-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    if (git) {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["add", "--", "."], { cwd: dir });
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.describe("loadTree (synthetic trees)", () => {
  const SCRIPTS = {
    "scripts/a.js": [
      "// process.env.JS_LINE_COMMENT is documented here",
      "/* process.env.JS_BLOCK_COMMENT and JS_BLOCK_IDENT */",
      "const a = process.env.JS_REAL; const b = process.env['JS_BRACKET']; const { JS_DESTRUCT } = process.env;",
      "const text = 'process.env.JS_IN_STRING';",
      "",
    ].join("\n"),
    "scripts/b.sh": [
      "#!/usr/bin/env bash",
      "# $SH_WHOLE_LINE and SH_WHOLE_WORD",
      'echo "$SH_REAL" # trailing $SH_TRAILING and SH_TRAILING_WORD',
      'echo "# kept $SH_QUOTED_HASH"',
      "echo ${#SH_LENGTH_OF}",
      "",
    ].join("\n"),
    "scripts/c.rb": [
      "=begin",
      'ENV["RB_BLOCK"] and RB_BLOCK_WORD',
      "=end",
      'x = ENV["RB_REAL"] # ENV["RB_TRAILING"]',
      "",
    ].join("\n"),
    "scripts/d.py": 'import os\nx = os.environ["PY_REAL"]  # os.environ["PY_TRAILING"]\n# os.environ["PY_WHOLE"]\n',
    ".github/workflows/w.yml": [
      "name: Deploys using secrets.WF_NAME_PROSE and env.WF_NAME_ENV_PROSE",
      "on:",
      "  workflow_call:",
      "    inputs:",
      "      x: { description: 'reads vars.WF_DESC_PROSE', type: string }",
      "jobs:",
      "  j:",
      "    name: job text with secrets.WF_JOBNAME_PROSE",
      "    runs-on: ubuntu-latest",
      "    if: vars.WF_IF_BARE != ''",
      "    steps:",
      "      - name: step text with secrets.WF_STEPNAME_PROSE",
      "        run: |",
      "          # echo $WF_RUN_WHOLE_COMMENT",
      "          echo hi $WF_RUN_REAL # echo $WF_RUN_TRAILING",
      "          echo 'secrets.WF_ECHO_PROSE'",
      "      - uses: actions/github-script@x",
      "        with:",
      "          script: |",
      "            // process.env.WF_SCRIPT_COMMENT",
      "            const v = process.env.WF_SCRIPT_REAL;",
      "      - run: echo ${{ secrets.WF_EXPR_SECRET }} ${{ env.WF_EXPR_ENV }}",
      "",
    ].join("\n"),
  };
  const load = (fn) => withTree(SCRIPTS, (dir) => fn(loadTree(dir)));
  const reads = (t, name) => t.envNames.has(name) || t.contextNames.has(name) || t.codeNames.has(name);

  test("a JS line comment never counts as a read (S2)", () =>
    load((t) => {
      expect(reads(t, "JS_LINE_COMMENT")).toBe(false);
      expect(t.envNames.has("JS_REAL")).toBe(true);
      expect(t.envNames.has("JS_BRACKET")).toBe(true);
      expect(t.envNames.has("JS_DESTRUCT")).toBe(true);
    }));

  test("a JS block comment and a string literal never count as a read (S2)", () =>
    load((t) => {
      expect(reads(t, "JS_BLOCK_COMMENT")).toBe(false);
      expect(reads(t, "JS_BLOCK_IDENT")).toBe(false);
      expect(reads(t, "JS_IN_STRING")).toBe(false);
    }));

  test("a shell whole-line comment never counts as a read (S2)", () =>
    load((t) => {
      expect(reads(t, "SH_WHOLE_LINE")).toBe(false);
      expect(reads(t, "SH_WHOLE_WORD")).toBe(false);
      expect(t.envNames.has("SH_REAL")).toBe(true);
    }));

  test("a shell trailing comment never counts, a # inside quotes does not start one (S2)", () =>
    load((t) => {
      expect(reads(t, "SH_TRAILING")).toBe(false);
      expect(reads(t, "SH_TRAILING_WORD")).toBe(false);
      expect(t.envNames.has("SH_QUOTED_HASH")).toBe(true);
      expect(t.envNames.has("SH_REAL")).toBe(true);
    }));

  test("Ruby =begin/=end blocks and Python # comments never count (S2)", () =>
    load((t) => {
      for (const n of ["RB_BLOCK", "RB_BLOCK_WORD", "RB_TRAILING", "PY_TRAILING", "PY_WHOLE"]) {
        expect(reads(t, n), n).toBe(false);
      }
      expect(t.envNames.has("RB_REAL")).toBe(true);
      expect(t.envNames.has("PY_REAL")).toBe(true);
    }));

  test("workflow prose (name:, description:, echo text) never counts, expressions and env do (S2)", () =>
    load((t) => {
      for (const n of [
        "WF_NAME_PROSE",
        "WF_NAME_ENV_PROSE",
        "WF_DESC_PROSE",
        "WF_JOBNAME_PROSE",
        "WF_STEPNAME_PROSE",
        "WF_ECHO_PROSE",
        "WF_RUN_WHOLE_COMMENT",
        "WF_RUN_TRAILING",
        "WF_SCRIPT_COMMENT",
      ]) {
        expect(reads(t, n) || t.contextNames.has(`secrets.${n}`) || t.contextNames.has(`vars.${n}`), n).toBe(false);
      }
      expect(t.contextNames.has("secrets.WF_EXPR_SECRET")).toBe(true);
      expect(t.envNames.has("WF_EXPR_ENV")).toBe(true);
      expect(t.contextNames.has("vars.WF_IF_BARE")).toBe(true);
      expect(t.envNames.has("WF_RUN_REAL")).toBe(true);
      expect(t.envNames.has("WF_SCRIPT_REAL")).toBe(true);
    }));

  test("an examples/site workflow does not stand in for the platform's (S1)", () =>
    withTree({ "examples/site/.github/workflows/x.yml": "on: push\njobs: {}\n" }, (dir) => {
      const t = loadTree(dir);
      expect(t.exists(".github/workflows/x.yml")).toBe(false);
      expect(t.exists("examples/site/.github/workflows/x.yml")).toBe(true);
      expect(t.workflows.has("x.yml")).toBe(true);
    }));

  test("untracked and gitignored files never count in a git checkout (S3)", () => {
    const files = {
      ".gitignore": "*.env\n",
      "scripts/tracked.sh": "echo $TRACKED_READ\n",
      "infrastructure/site-params.env": "IGNORED_KNOB=1\n",
    };
    withTree(
      files,
      (dir) => {
        fs.writeFileSync(path.join(dir, "scripts/untracked.sh"), "echo $UNTRACKED_READ\n");
        const t = loadTree(dir);
        expect(t.exists("scripts/tracked.sh")).toBe(true);
        expect(t.envNames.has("TRACKED_READ")).toBe(true);
        expect(t.exists("infrastructure/site-params.env")).toBe(false);
        expect(t.envNames.has("IGNORED_KNOB")).toBe(false);
        expect(t.exists("scripts/untracked.sh")).toBe(false);
        expect(t.basenames.has("untracked.sh")).toBe(false);
        expect(t.envNames.has("UNTRACKED_READ")).toBe(false);
      },
      { git: true },
    );
  });

  test("outside a git checkout the working tree is walked (S3 fallback)", () =>
    withTree({ "infrastructure/site-params.env": "WALKED_KNOB=1\n" }, (dir) => {
      const t = loadTree(dir);
      expect(t.exists("infrastructure/site-params.env")).toBe(true);
      expect(t.envNames.has("WALKED_KNOB")).toBe(true);
    }));

  test("a github-script body containing ${{ }} still yields its process.env reads (R2-2)", () =>
    withTree(
      {
        ".github/workflows/t.yml": [
          "on: push",
          "jobs:",
          "  j:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/github-script@x",
          "        with:",
          "          script: |",
          "            const msg = `deploy ${{ secrets.TPL_SECRET }} now`;",
          "            const v = process.env.TPL_AFTER_READ;",
          "      - uses: actions/github-script@x",
          "        with:",
          "          script: |",
          "            const x = ${{ vars.BARE_VAR }};",
          "            // process.env.BARE_COMMENT_ONLY",
          "            const v = process.env.BARE_AFTER_READ;",
          "",
        ].join("\n"),
      },
      (dir) => {
        const t = loadTree(dir);
        expect(t.envNames.has("TPL_AFTER_READ")).toBe(true);
        expect(t.envNames.has("BARE_AFTER_READ")).toBe(true);
        expect(t.envNames.has("BARE_COMMENT_ONLY")).toBe(false);
        expect(t.contextNames.has("secrets.TPL_SECRET")).toBe(true);
        expect(t.contextNames.has("vars.BARE_VAR")).toBe(true);
      },
    ));

  test("secrets['X'], vars[\"X\"] and env['X'] bracket syntax in an expression is a read (R2-3)", () =>
    withTree(
      {
        ".github/workflows/b.yml": [
          "on: push",
          "jobs:",
          "  j:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo ${{ secrets['BRACKET_SECRET'] }} ${{ vars[\"BRACKET_VAR\"] }} ${{ env['BRACKET_ENV'] }}",
          "",
        ].join("\n"),
      },
      (dir) => {
        const t = loadTree(dir);
        expect(t.contextNames.has("secrets.BRACKET_SECRET")).toBe(true);
        expect(t.contextNames.has("vars.BRACKET_VAR")).toBe(true);
        expect(t.envNames.has("BRACKET_ENV")).toBe(true);
      },
    ));
});
