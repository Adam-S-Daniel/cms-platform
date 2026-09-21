// @lane: local — pure-fs lint of the consumer workflow TEMPLATES; no network.
// Platform-internal (reads examples/site/.github/workflows), so it's registered
// in playwright.config.js PLATFORM_META_SPECS and testIgnore'd on consumer lanes.
//
// Locks the consumer-PAT consolidation (Adam directive 2026-06-05: "consolidate
// PAT variables by permissions"): the thin-caller templates may reference ONLY
// the two sanctioned, repo-agnostic PAT secrets —
//   - CMS_E2E_PAT      (Contents+PR+Actions, NO Workflows) — CMS automation, loops, reaper
//   - CMS_PLATFORM_PAT (Contents+PR+Workflows)             — anything that edits
//                                          .github/workflows/* (platform-bump,
//                                          dev-hooks-sync)
// Both are FINE-GRAINED PATs (no classic PATs — Adam directive 2026-06-05).
// A third/legacy/per-repo name (e.g. the old ADAMDANIELAI_WORKFLOW_SHA_COMMENT_PAT
// or the generic WORKFLOW_SHA_COMMENT_PAT) reappearing in a template is the
// regression this guard catches — every consumer ends up with the SAME minimal
// secret set, and anything needing Workflows: write rides CMS_PLATFORM_PAT
// rather than a bespoke token. (Those two legacy names were minted for
// dependabot-comment-sync, deleted with the pin-comment convention; the guard
// against their return outlives it.)
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const TEMPLATES = path.join(__dirname, "..", "examples", "site", ".github", "workflows");
const ALLOWED_PATS = new Set(["CMS_E2E_PAT", "CMS_PLATFORM_PAT"]);

// Secrets that end in `_TOKEN` (so the lexical detector below would otherwise
// catch them) but are NOT a GitHub PAT and so are outside this guard's scope
// entirely — the consolidation directive this file locks is about GitHub API
// auth, not every credential a template might reference. Each entry needs its
// own justification, same bar as a new ALLOWED_PAT would need.
//
//   MASTODON_ACCESS_TOKEN — cross-post.yml's (cms-platform#442) app token for
//   posting to a site's OWN Mastodon account (scope write:statuses only, see
//   docs/CROSS-POSTING.md). It authenticates Mastodon's API, never GitHub's,
//   so it has nothing to consolidate onto CMS_E2E_PAT/CMS_PLATFORM_PAT — both
//   of those are fine-grained GitHub PATs and neither can stand in for it.
const NON_PAT_SERVICE_TOKENS = new Set(["MASTODON_ACCESS_TOKEN"]);

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
      if (NON_PAT_SERVICE_TOKENS.has(name)) continue;
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
});
