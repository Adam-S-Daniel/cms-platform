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
// indented code blocks only (agentskills' check_skills.py precision rule —
// prose mentions are LISTED, never failed):
//   path      `scripts/x.sh`, `.github/workflows/y.yml`, … → exists here
//             (a `.github/workflows/<x>` may live at examples/site/ instead)
//   workflow  a bare `<name>.yml` → a workflow under .github/workflows/ or
//             examples/site/.github/workflows/, or some file of that name
//   file      a bare `<name>.js|sh|rb|py` → some file of that name
//   name      `secrets.X` / `vars.X` / a bare `UPPER_SNAKE` → read by a
//             workflow (parsed with `yaml`: secrets./vars./env., env: keys,
//             workflow_call secrets, $X in run:) or a script, or used as a
//             code identifier (acorn for JS) — a knob only a COMMENT still
//             mentions is flagged
//   cfn       (aws-bootstrap) a parameter / resource / output / property name
//             in infrastructure/*/template.yaml (parsed with `yaml`)
// The rules live in e2e/skill-references-rules.js.
//
// A citation that is deliberately absent — removed and documented as removed,
// consumer-side, an AWS literal — goes in skills/.freshness-allow.yml with a
// reason and a marker line; an entry whose citation resolves again, is no
// longer cited, or whose marker is gone FAILS (stale allowlist).
//
// Registered in playwright.config.js PLATFORM_META_SPECS: it reads skills/ and
// the platform's own workflows and templates, none of which a consumer ships.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const {
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
  return failures
    .map((f) => `  skills/${skill}/SKILL.md${f.line ? `:${f.line}` : ""} [${f.kind}] ${f.reason}`)
    .join("\n");
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
  "Set `NOBODY_READS_THIS` and `vars.LIVE_VAR` and `secrets.LIVE_SECRET`.",
  "",
  "`OLD_PAT` — REMOVED in v9 (kept for older pins).",
  "",
  "`LIVE_SECRET` was allowlisted once, but is read again.",
  "",
  "The `deploy.yml` workflow and `examples/site/.github/workflows/caller.yml` run it.",
  "",
].join("\n");

function syntheticTree(over = {}) {
  const files = new Set(["scripts/real.sh", ".github/workflows/deploy.yml", "examples/site/.github/workflows/caller.yml"]);
  return {
    exists: (rel) => files.has(rel) || [...files].some((f) => f.startsWith(`${rel}/`)),
    basenames: new Set([...files].map((f) => f.split("/").pop())),
    workflows: new Set(["deploy.yml", "caller.yml"]),
    contextNames: new Set(["vars.LIVE_VAR", "secrets.LIVE_SECRET"]),
    envNames: new Set(["LIVE_VAR", "LIVE_SECRET"]),
    codeNames: new Set(),
    cfnNames: new Set(["ResourcePrefix"]),
    ...over,
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
