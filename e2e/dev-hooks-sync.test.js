// @lane: local — pure-fs lint of the dev-hooks centralization (issue #116).
// Platform-internal (reads examples/site + scripts + the reusable), so it's
// registered in playwright.config.js PLATFORM_META_SPECS and testIgnore'd on
// consumer lanes.
//
// Locks the dev-hooks-sync delivery contract: the platform centralizes the
// secrets-scan + lint-staged pre-commit guards and propagates them to every
// consumer via a skills-sync-style reusable + the canonical examples/site set +
// the scaffolder. The THREE places that name the canonical guard files — the
// dev-hooks-sync reusable's FILES list, scaffold/create-site.js's seed list, and
// the files themselves — must stay in lockstep, or a consumer would receive a
// partial / stale guard set. Also asserts the canonical chain no longer carries
// the skills-mirror guard removed in adamdaniel#2007-P7.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const ROOT = path.join(__dirname, "..");
const REUSABLE = path.join(ROOT, ".github", "workflows", "dev-hooks-sync.yml");
const CALLER = path.join(ROOT, "examples", "site", ".github", "workflows", "dev-hooks-sync.yml");
const SCAFFOLDER = path.join(ROOT, "scaffold", "create-site.js");

// The canonical guard-file set (the contract).
const CANONICAL = [
  "scripts/secrets-scan.sh",
  "scripts/lint-staged.sh",
  "scripts/setup-hooks.sh",
  ".githooks/pre-commit",
  ".gitconfig-fragment",
];
const PATH_RE = /(scripts\/[a-z-]+\.sh|\.githooks\/pre-commit|\.gitconfig-fragment)/g;

// Pull the file paths out of a bash `MARKER( ... )` or js `MARKER[ ... ]` block.
function pathsInBlock(text, marker) {
  const m = text.match(new RegExp(marker + "[\\s\\S]*?[\\)\\]]"));
  return m ? [...m[0].matchAll(PATH_RE)].map((x) => x[1]) : [];
}

test.describe("dev-hooks centralization (#116)", () => {
  test("all canonical guard files exist in the platform repo", () => {
    for (const f of CANONICAL) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} missing`).toBe(true);
    }
  });

  test("the reusable syncs EXACTLY the canonical guard files", () => {
    const listed = pathsInBlock(fs.readFileSync(REUSABLE, "utf8"), "FILES=\\(");
    expect(new Set(listed)).toEqual(new Set(CANONICAL));
  });

  test("the scaffolder seeds EXACTLY the canonical guard files (lockstep with the reusable)", () => {
    const listed = pathsInBlock(fs.readFileSync(SCAFFOLDER, "utf8"), "for \\(const f of \\[");
    expect(new Set(listed)).toEqual(new Set(CANONICAL));
  });

  test("the scaffolder wires the guards via a SessionStart running setup-hooks.sh", () => {
    const text = fs.readFileSync(SCAFFOLDER, "utf8");
    expect(text).toMatch(/SessionStart/);
    expect(text).toMatch(/setup-hooks\.sh/);
    expect(text).toMatch(/\.claude\/settings\.json/);
  });

  test("setup-hooks.sh prepares web-session shells: UTF-8 locale via CLAUDE_ENV_FILE", () => {
    // Claude Code web sessions start with no locale (US-ASCII), which crashes
    // `bundle exec jekyll build` in the theme gem's Decap render hook on UTF-8
    // site files. setup-hooks.sh already runs from every consumer's
    // SessionStart hook, so the guarded LANG append lives there and flows to
    // consumers via dev-hooks-sync (supersedes adamdaniel.ai#2542's
    // site-local hook). A refactor that drops the block would silently
    // re-break every consumer's web-session Jekyll builds.
    const text = fs.readFileSync(path.join(ROOT, "scripts", "setup-hooks.sh"), "utf8");
    expect(text, "must append to CLAUDE_ENV_FILE only when set (web-only)").toContain(
      "CLAUDE_ENV_FILE:-",
    );
    expect(text, "must export a UTF-8 LANG, preserving any pre-set value").toContain(
      'export LANG="${LANG:-C.UTF-8}"',
    );
    expect(text, "must be idempotent — guard on an existing export line").toContain(
      "grep -qs '^export LANG='",
    );
  });

  test("the canonical caller exists, calls the reusable, and rides CMS_PLATFORM_PAT", () => {
    const text = fs.readFileSync(CALLER, "utf8");
    expect(text).toMatch(/uses:\s*Adam-S-Daniel\/cms-platform\/\.github\/workflows\/dev-hooks-sync\.yml@/);
    expect(text).toMatch(/CMS_PLATFORM_PAT/);
  });

  test("the canonical pre-commit chain has secrets-scan + lint-staged and NOT the skills-mirror guard (P7)", () => {
    const frag = fs.readFileSync(path.join(ROOT, ".gitconfig-fragment"), "utf8");
    const pre = fs.readFileSync(path.join(ROOT, ".githooks", "pre-commit"), "utf8");
    for (const g of ["secrets-scan.sh", "lint-staged.sh"]) {
      expect(frag, `.gitconfig-fragment missing ${g}`).toContain(g);
      expect(pre, `.githooks/pre-commit missing ${g}`).toContain(g);
    }
    expect(frag).not.toContain("verify-skills-mirror");
    expect(pre).not.toContain("verify-skills-mirror");
  });
});
