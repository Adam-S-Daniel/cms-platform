// @lane: local — pure-fs lint of the consumer workflow TEMPLATES; no network.
// Platform-internal (reads examples/site/.github/workflows), so it's registered
// in playwright.config.js PLATFORM_META_SPECS and testIgnore'd on consumer lanes.
//
// Locks the consumer-PAT consolidation (Adam directive 2026-06-05: "consolidate
// PAT variables by permissions"): the thin-caller templates may reference ONLY
// the two sanctioned, repo-agnostic PAT secrets —
//   - CMS_E2E_PAT      (Contents+PR+Actions, NO Workflows) — CMS automation, loops, reaper
//   - CMS_PLATFORM_PAT (Contents+PR+Workflows)             — anything that edits
//                                          .github/workflows/* (platform-bump +
//                                          dependabot-comment-sync)
// Both are FINE-GRAINED PATs (no classic PATs — Adam directive 2026-06-05).
// A third/legacy/per-repo name (e.g. the old ADAMDANIELAI_WORKFLOW_SHA_COMMENT_PAT
// or the generic WORKFLOW_SHA_COMMENT_PAT) reappearing in a template is the
// regression this guard catches — every consumer ends up with the SAME minimal
// secret set, and comment-sync (which needs Workflows: write) rides
// CMS_PLATFORM_PAT rather than a bespoke token.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const TEMPLATES = path.join(__dirname, "..", "examples", "site", ".github", "workflows");
const ALLOWED_PATS = new Set(["CMS_E2E_PAT", "CMS_PLATFORM_PAT"]);

// Every `secrets.<NAME>` reference whose NAME looks like a PAT (ends in _PAT or
// _TOKEN, or contains PAT), across all template files. Returns Map<name, files[]>.
function patSecretRefs() {
  const out = new Map();
  for (const f of fs.readdirSync(TEMPLATES)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = fs.readFileSync(path.join(TEMPLATES, f), "utf8");
    for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
      const name = m[1];
      if (!/PAT|_TOKEN$/.test(name) || name === "GITHUB_TOKEN") continue;
      if (!out.has(name)) out.set(name, []);
      if (!out.get(name).includes(f)) out.get(name).push(f);
    }
  }
  return out;
}

test.describe("consumer workflow templates: PAT-secret consolidation", () => {
  test("reference only the two sanctioned PATs (CMS_E2E_PAT / CMS_PLATFORM_PAT)", () => {
    const refs = patSecretRefs();
    const offenders = [...refs.entries()].filter(([name]) => !ALLOWED_PATS.has(name));
    expect(
      offenders,
      `template(s) reference a non-sanctioned PAT secret — consolidate onto CMS_E2E_PAT ` +
        `or CMS_PLATFORM_PAT:\n${offenders.map(([n, fs_]) => `  ${n} ← ${fs_.join(", ")}`).join("\n")}`,
    ).toEqual([]);
  });

  test("no legacy/per-repo PAT names survive in any template", () => {
    for (const f of fs.readdirSync(TEMPLATES)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const text = fs.readFileSync(path.join(TEMPLATES, f), "utf8");
      expect(text, `${f}: drop the per-repo ADAMDANIELAI_ PAT prefix`).not.toMatch(
        /ADAMDANIELAI_/,
      );
      expect(
        text,
        `${f}: the bare WORKFLOW_SHA_COMMENT_PAT was consolidated onto CMS_PLATFORM_PAT`,
      ).not.toMatch(/secrets\.WORKFLOW_SHA_COMMENT_PAT/);
    }
  });

  test("dependabot-comment-sync wires its workflow-editing PAT to CMS_PLATFORM_PAT", () => {
    const file = path.join(TEMPLATES, "dependabot-comment-sync.yml");
    const text = fs.readFileSync(file, "utf8");
    // It pushes into .github/workflows/* → needs Workflows: write → CMS_PLATFORM_PAT.
    expect(text).toMatch(/workflow_sha_comment_pat:\s*\$\{\{\s*secrets\.CMS_PLATFORM_PAT\s*\}\}/);
  });
});
