// @lane: local — pure-fs lint of deploy workflow YAML; no browser, no network
/*
 * Regression test: the `commit.json` step in deploy-{preview,production}
 * must read the timestamp from `git log` against HEAD (or a derived
 * refstring), not from `${{ github.sha }}`.
 *
 * On `pull_request` events, `github.sha` is a synthetic merge commit
 * created by GitHub — it isn't fetched into shallow clones, so
 * `git log -1 --format=%cI ${{ github.sha }}` fails with `bad object`.
 * (Audit chat-finding #7.)
 *
 * Also locks the `platform_repo` / `platform_ref` fields added to
 * commit.json (sourced from the site's `platform.lock`, read tolerantly —
 * a missing file or missing key must produce an empty string, never fail
 * the step/script) across all three writers (this file's two workflows +
 * scripts/write-commit-json.sh), and the admin shells' platform-release
 * pill gate that treats an empty string as "absent".
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readWorkflow, runScripts } = require("./workflow-yaml-utils");

const REPO_ROOT = path.join(__dirname, "..");

// Every `run:` script that writes the deployed-build pill's commit.json
// — pulled from the parsed workflow, so it sees the script GitHub
// actually runs regardless of YAML shape.
function commitJsonScripts(yaml) {
  return runScripts(yaml)
    .map((r) => r.script)
    .filter((s) => s.includes("commit.json"));
}

// Drop shell comment lines so a `# … github.sha …` explainer inside the
// script never counts as an offender.
function stripComments(script) {
  return script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

// Substitute `${VAR}` tokens in a shell-heredoc JSON template with sample
// values (bash does this at runtime; we do it here to prove the emitted
// JSON stays valid whether platform_repo/platform_ref are populated or
// empty — the "absent" case).
function renderTemplate(line, vars) {
  let out = line;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split("${" + k + "}").join(v);
  }
  return out;
}

const FILLED_PLATFORM_FIELDS = {
  PLATFORM_REPO: "Adam-S-Daniel/cms-platform",
  PLATFORM_REF: "v0.1.61",
};
const EMPTY_PLATFORM_FIELDS = { PLATFORM_REPO: "", PLATFORM_REF: "" };

for (const wf of ["deploy-preview.yml", "deploy-production.yml"]) {
  const yaml = readWorkflow(wf);
  const steps = commitJsonScripts(yaml);
  const baseVars =
    wf === "deploy-preview.yml"
      ? { SHA: "abc1234", ISO: "2026-07-10T12:00:00-04:00", HEAD_REF: "main" }
      : { SHA: "abc1234", ISO: "2026-07-10T12:00:00-04:00" };

  test(`${wf} writes commit.json`, () => {
    expect(
      steps.length,
      `Expected a commit.json step in ${wf} — the deployed-build pill ` +
        `in admin/index.html depends on it.`,
    ).toBeGreaterThan(0);
  });

  steps.forEach((step, i) => {
    test(`${wf} commit.json step #${i + 1} uses HEAD, not github.sha`, () => {
      const code = stripComments(step);
      expect(code).toMatch(/git log\b/);
      const offenders = code
        .split("\n")
        .filter((l) => /git log\b/.test(l) && /\$\{\{\s*github\.sha\s*\}\}/.test(l));
      expect(
        offenders,
        `git log in ${wf} must use HEAD or github.event.pull_request.head.sha, ` +
          `not \${{ github.sha }} (synthetic merge commit, not in shallow ` +
          `clones).`,
      ).toEqual([]);
    });

    test(`${wf} commit.json step #${i + 1} reads platform_repo/platform_ref from platform.lock, tolerantly`, () => {
      expect(
        step,
        "must read the site's platform.lock for the platform-release pill",
      ).toMatch(/platform\.lock/);
      expect(step).toMatch(/PLATFORM_REPO=.*grep.*\^platform_repo:/);
      expect(step).toMatch(/PLATFORM_REF=.*grep.*\^platform_ref:/);
      // The read must never fail the step (missing file / missing key).
      const platformLines = step
        .split("\n")
        .filter((l) => /PLATFORM_REPO=|PLATFORM_REF=/.test(l));
      expect(platformLines.length).toBeGreaterThan(0);
      for (const line of platformLines) {
        expect(
          line,
          `${wf}: "${line.trim()}" must end in "|| true" so a missing ` +
            "platform.lock / missing key can never fail this step",
        ).toMatch(/\|\|\s*true\s*$/);
      }
    });

    test(`${wf} commit.json step #${i + 1} emits valid JSON with platform fields present or empty`, () => {
      const m = step.match(/\{\s*"sha".*"platform_ref":\s*"\$\{PLATFORM_REF\}"\s*\}/);
      expect(m, `${wf}: couldn't find the commit.json JSON template line`).toBeTruthy();
      const line = m[0];

      const filled = renderTemplate(line, { ...baseVars, ...FILLED_PLATFORM_FIELDS });
      expect(() => JSON.parse(filled)).not.toThrow();
      const filledJson = JSON.parse(filled);
      expect(filledJson.platform_repo).toBe(FILLED_PLATFORM_FIELDS.PLATFORM_REPO);
      expect(filledJson.platform_ref).toBe(FILLED_PLATFORM_FIELDS.PLATFORM_REF);

      const empty = renderTemplate(line, { ...baseVars, ...EMPTY_PLATFORM_FIELDS });
      expect(() => JSON.parse(empty)).not.toThrow();
      const emptyJson = JSON.parse(empty);
      expect(emptyJson.platform_repo).toBe("");
      expect(emptyJson.platform_ref).toBe("");
    });
  });
}

test.describe("scripts/write-commit-json.sh: platform_repo/platform_ref", () => {
  const scriptPath = path.join(REPO_ROOT, "scripts", "write-commit-json.sh");
  const src = fs.readFileSync(scriptPath, "utf8");

  test("reads platform_repo/platform_ref from platform.lock, tolerantly", () => {
    expect(src).toMatch(/platform\.lock/);
    expect(src).toMatch(/PLATFORM_REPO=.*grep.*\^platform_repo:/);
    expect(src).toMatch(/PLATFORM_REF=.*grep.*\^platform_ref:/);
    const platformLines = src.split("\n").filter((l) => /PLATFORM_REPO=|PLATFORM_REF=/.test(l));
    expect(platformLines.length).toBeGreaterThan(0);
    for (const line of platformLines) {
      expect(
        line,
        `"${line.trim()}" must end in "|| true" so a missing platform.lock / ` +
          "missing key can never fail the script (set -euo pipefail is active)",
      ).toMatch(/\|\|\s*true\s*$/);
    }
  });

  test("JSON stays valid with platform fields present or empty", () => {
    const m = src.match(/JSON="\{.*\}"/);
    expect(m, "couldn't find the JSON=\"...\" template line").toBeTruthy();
    // Strip the JSON="..." wrapper and the shell backslash-escapes around
    // the inner quotes (\" → ") to get the raw JSON-with-${VAR}-tokens text.
    const inner = m[0].slice(6, -1).replace(/\\"/g, '"');
    const baseVars = { SHA: "abc1234", ISO: "2026-07-10T12:00:00-04:00", BRANCH: "main" };

    const filled = renderTemplate(inner, { ...baseVars, ...FILLED_PLATFORM_FIELDS });
    expect(() => JSON.parse(filled)).not.toThrow();
    expect(JSON.parse(filled).platform_ref).toBe(FILLED_PLATFORM_FIELDS.PLATFORM_REF);

    const empty = renderTemplate(inner, { ...baseVars, ...EMPTY_PLATFORM_FIELDS });
    expect(() => JSON.parse(empty)).not.toThrow();
    expect(JSON.parse(empty).platform_repo).toBe("");
  });
});

// Extract the platform-pill construction block from an admin shell's
// inline commit-pill script: from the `if (c.platform_repo` gate to the
// `.catch(` that closes the enclosing fetch().then() chain.
function platformPillBlock(src) {
  const start = src.indexOf("if (c.platform_repo");
  if (start === -1) return "";
  const end = src.indexOf(".catch(", start);
  return src.slice(start, end === -1 ? src.length : end);
}

test.describe("admin shells: platform-release pill gated on platform_repo + platform_ref", () => {
  for (const shell of ["theme/admin/index.html", "theme/admin/index-local.html"]) {
    test(`${shell}: pill only renders when BOTH fields are non-empty, dynamic value escaped`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, shell), "utf8");
      expect(src, `${shell} must create the platform pill`).toContain("cms-platform-pill");
      const block = platformPillBlock(src);
      expect(block, `${shell}: platform-pill construction block not found`).not.toBe("");
      expect(
        block,
        "must gate on BOTH fields — an empty string from commit.json must count as absent",
      ).toContain("if (c.platform_repo && c.platform_ref)");
      expect(
        block,
        "deployment metadata, same exclusion reason as the commit pill",
      ).toMatch(/data-visreg-ignore/);
      expect(block, "opens the cms-platform release on GitHub").toMatch(/\/releases\/tag\//);
      expect(
        block,
        "the dynamic platform_ref value must go through the escape helper",
      ).toContain("escapeHTML(c.platform_ref)");
    });
  }

  test("both shells define an escapeHTML helper reachable by the platform-pill code", () => {
    for (const shell of ["theme/admin/index.html", "theme/admin/index-local.html"]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, shell), "utf8");
      expect(src, `${shell} must define escapeHTML`).toMatch(/function escapeHTML\(s\)/);
    }
  });
});
