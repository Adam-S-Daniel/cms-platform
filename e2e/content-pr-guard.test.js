// @lane: local — pure-fs unit + wiring lint for the content PR conformance guard.
//
// Goal: PRs that touch CMS-managed content paths but were NOT created by
// Decap must fail the already-required `editorial / validate-content`
// check, with a clear PR comment explaining the restriction and the
// escape hatch (the `content-guard/override` label). No new required
// check, no ruleset change.
//
// This file covers two layers:
//   1. UNIT — scripts/content-pr-guard.js's pure decision logic, driven
//      directly with synthetic PR/file/YAML fixtures. The Decap branch
//      prefix is derived from e2e/cms-fixture-pr.js's FIXTURE_BRANCH_PREFIX
//      exactly as cms-editorial-workflow.yml's guard step does, so a
//      change to that constant can't silently desync the two.
//   2. WIRING — cms-editorial-workflow.yml actually calls the module the
//      way the unit tests assume: workflow_call inputs exist with the
//      right defaults, validate-content still has NO `concurrency` key
//      (#1815), the platform-module checkout + github-script steps are
//      present, action pins match the rest of the file byte-for-byte, and
//      the override label name is NOT duplicated as a literal in the
//      workflow (it must come from the module, not be re-typed).
const { test, expect } = require("./base");
const { readWorkflow, parseYaml, jobs } = require("./workflow-yaml-utils");
const {
  COMMENT_MARKER,
  OVERRIDE_LABEL,
  DECAP_BODY_MARKER,
  seamContentDirs,
  isDecapShaped,
  evaluateContentGuard,
} = require("../scripts/content-pr-guard.js");
const { FIXTURE_BRANCH_PREFIX } = require("./cms-fixture-pr.js");
const fs = require("node:fs");
const path = require("node:path");

// Derived exactly as the workflow's "Content PR conformance guard" step
// derives it — the lockstep proof.
const DECAP_BRANCH_PREFIX = `${FIXTURE_BRANCH_PREFIX.split("/")[0]}/`;

const ADMIN_URL = "https://example.test/admin/";

function pr({ ref = "feature/some-branch", body = "", labels = [], sha = "abc1234" } = {}) {
  return { number: 42, head: { ref, sha }, body, labels };
}

test.describe("content-pr-guard unit — decision logic", () => {
  test("non-cms branch + _posts change fails, with a complete comment", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: "claude/some-fix", body: "manual edit" }),
      changedFiles: ["_posts/2026-01-01-hello.md", "README.md"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });

    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("non-decap-content-change");
    expect(result.contentFiles).toEqual(["_posts/2026-01-01-hello.md"]);
    expect(result.commentBody.startsWith(COMMENT_MARKER)).toBe(true);
    expect(result.commentBody).toContain("_posts/2026-01-01-hello.md");
    expect(result.commentBody).toContain(ADMIN_URL);
    expect(result.commentBody).toContain(OVERRIDE_LABEL);
  });

  test("cms/-prefixed head branch passes as decap-shaped", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: `${DECAP_BRANCH_PREFIX}posts/hello`, body: "" }),
      changedFiles: ["_posts/2026-01-01-hello.md"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("decap-shaped");
  });

  test("Decap body-marker-only PR passes as decap-shaped", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: "some-random-branch", body: `${DECAP_BODY_MARKER}\n\nrest of body` }),
      changedFiles: ["_posts/2026-01-01-hello.md"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("decap-shaped");
  });

  test("decap-cms/draft label passes as decap-shaped", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: "some-random-branch", body: "", labels: [{ name: "decap-cms/draft" }] }),
      changedFiles: ["_posts/2026-01-01-hello.md"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("decap-shaped");
  });

  test("content-guard/override label passes with reason override", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: "some-random-branch", body: "", labels: [{ name: OVERRIDE_LABEL }] }),
      changedFiles: ["_posts/2026-01-01-hello.md"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("override");
  });

  test("a non-content diff passes regardless of provenance", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: "claude/some-fix", body: "" }),
      changedFiles: ["README.md", "scripts/foo.js"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("no-content-changes");
    expect(result.contentFiles).toEqual([]);
  });

  test("uploaded media path counts as content", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: "claude/some-fix" }),
      changedFiles: ["assets/images/uploads/photo.png"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("fail");
    expect(result.contentFiles).toEqual(["assets/images/uploads/photo.png"]);
  });

  test("a site's seam-derived collection folder is flagged as content", () => {
    const seamYamlText = [
      "  - name: notes",
      "    label: Notes",
      "    folder: _notes",
      "    fields:",
      "      - { name: title, label: Title, widget: string, required: true }",
      "",
    ].join("\n");
    expect(seamContentDirs(seamYamlText)).toEqual(["_notes/"]);

    const result = evaluateContentGuard({
      pr: pr({ ref: "claude/some-fix" }),
      changedFiles: ["_notes/a.md"],
      seamYamlText,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("fail");
    expect(result.contentFiles).toEqual(["_notes/a.md"]);
  });

  test("seamContentDirs returns [] for null/empty input", () => {
    expect(seamContentDirs(null)).toEqual([]);
    expect(seamContentDirs("")).toEqual([]);
  });

  test("extraContentDirs is honored", () => {
    const result = evaluateContentGuard({
      pr: pr({ ref: "claude/some-fix" }),
      changedFiles: ["docs/x.md"],
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      extraContentDirs: ["docs/"],
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("fail");
    expect(result.contentFiles).toEqual(["docs/x.md"]);
  });

  test("file list caps at 20 with a '+N more' suffix", () => {
    const changedFiles = Array.from({ length: 25 }, (_, i) => `_posts/post-${i}.md`);
    const result = evaluateContentGuard({
      pr: pr({ ref: "claude/some-fix" }),
      changedFiles,
      seamYamlText: null,
      decapBranchPrefix: DECAP_BRANCH_PREFIX,
      adminUrl: ADMIN_URL,
    });
    expect(result.verdict).toBe("fail");
    expect(result.contentFiles.length).toBe(25);
    for (let i = 0; i < 20; i++) {
      expect(result.commentBody).toContain(`_posts/post-${i}.md`);
    }
    for (let i = 20; i < 25; i++) {
      expect(result.commentBody).not.toContain(`\`_posts/post-${i}.md\``);
    }
    expect(result.commentBody).toMatch(/\+5 more/);
  });

  test("isDecapShaped mirrors the label-non-decap-prs.yml triad", () => {
    expect(isDecapShaped(pr({ ref: `${DECAP_BRANCH_PREFIX}posts/x` }), DECAP_BRANCH_PREFIX)).toBe(true);
    expect(isDecapShaped(pr({ body: DECAP_BODY_MARKER }), DECAP_BRANCH_PREFIX)).toBe(true);
    expect(
      isDecapShaped(pr({ labels: [{ name: "decap-cms/pending_review" }] }), DECAP_BRANCH_PREFIX),
    ).toBe(true);
    expect(isDecapShaped(pr({ ref: "claude/x", body: "" }), DECAP_BRANCH_PREFIX)).toBe(false);
  });
});

test.describe("content-pr-guard wiring — cms-editorial-workflow.yml", () => {
  const raw = readWorkflow("cms-editorial-workflow.yml");
  const parsed = parseYaml(raw);

  test("workflow_call declares platform_repo/platform_ref with the expected defaults", () => {
    const inputs = parsed.on.workflow_call.inputs;
    expect(inputs).toBeTruthy();
    expect(inputs.platform_repo.type).toBe("string");
    expect(inputs.platform_repo.default).toBe("Adam-S-Daniel/cms-platform");
    expect(inputs.platform_ref.type).toBe("string");
    expect(inputs.platform_ref.default).toBe("main");
  });

  test("validate-content has NO concurrency key (#1815 invariant)", () => {
    const job = jobs(raw).find((j) => j.name === "validate-content");
    expect(job).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(job.value, "concurrency")).toBe(false);
  });

  test("validate-content checks out the platform module into .cms-platform", () => {
    const job = jobs(raw).find((j) => j.name === "validate-content");
    const step = (job.value.steps || []).find(
      (s) => s.with && s.with.repository === "${{ inputs.platform_repo }}",
    );
    expect(step).toBeTruthy();
    expect(step.with.ref).toBe("${{ inputs.platform_ref }}");
    expect(step.with.path).toBe(".cms-platform");
  });

  test("validate-content has a github-script step requiring content-pr-guard.js and cms-fixture-pr.js", () => {
    const job = jobs(raw).find((j) => j.name === "validate-content");
    const step = (job.value.steps || []).find(
      (s) =>
        s.uses &&
        s.uses.startsWith("actions/github-script@") &&
        s.with &&
        typeof s.with.script === "string" &&
        s.with.script.includes("content-pr-guard.js"),
    );
    expect(step).toBeTruthy();
    expect(step.with.script).toContain("cms-fixture-pr.js");
    expect(step.with.script).toContain("evaluateContentGuard");
  });

  test("the guard's action pins are byte-identical to the rest of the file", () => {
    const usesLines = [...raw.matchAll(/^\s*uses:\s*(actions\/(?:checkout|github-script)@\S+(?:\s+#.*)?)\s*$/gm)].map(
      (m) => m[1].trim(),
    );
    const checkoutPins = new Set(usesLines.filter((u) => u.startsWith("actions/checkout@")));
    const scriptPins = new Set(usesLines.filter((u) => u.startsWith("actions/github-script@")));
    expect(checkoutPins.size).toBe(1);
    expect(scriptPins.size).toBe(1);
  });

  test("the raw workflow text does not hardcode the override label literal", () => {
    // Forces the label name to be sourced from scripts/content-pr-guard.js
    // (via the destructured OVERRIDE_LABEL) rather than re-typed, so the
    // two can never drift.
    expect(raw).not.toContain("content-guard/override");
  });
});

test.describe("content-pr-guard wiring — example caller", () => {
  test("examples/site pins platform_ref to match its uses: ref", () => {
    const callerPath = path.resolve(
      __dirname,
      "..",
      "examples",
      "site",
      ".github",
      "workflows",
      "cms-editorial-workflow.yml",
    );
    const raw = fs.readFileSync(callerPath, "utf8");
    const parsed = parseYaml(raw);
    const job = parsed.jobs.editorial;
    const usesMatch = job.uses.match(/@([^@]+)$/);
    expect(usesMatch).toBeTruthy();
    const pinnedRef = usesMatch[1];
    expect(job.with).toBeTruthy();
    expect(job.with.platform_ref).toBe(pinnedRef);
  });
});
