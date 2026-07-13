// @lane: local — pure-fs lint of the skills-sync repo-local carve-out.
// Platform-internal (reads the reusable workflow DEFINITION + skills/README.md),
// so it's registered in playwright.config.js PLATFORM_META_SPECS and
// testIgnore'd on consumer lanes.
//
// Locks the repo-local opt-out contract: the down-sync is platform-authoritative
// (rsync --delete, so a skill removed from the platform is removed from the
// site), but a site-owned skill marked with a `.repo-local` file must be
// preserved — excluded from BOTH the transfer and the --delete sweep. Without
// this, an unconditional `rsync --delete` clobbers repo-specific skills like
// adamdaniel.ai's `embeddable-tool-pages` on every sync.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const ROOT = path.join(__dirname, "..");
const REUSABLE = path.join(ROOT, ".github", "workflows", "skills-sync.yml");
const README = path.join(ROOT, "skills", "README.md");

test.describe("skills-sync repo-local carve-out", () => {
  test("the reusable still --delete's (platform-authoritative removals preserved)", () => {
    const text = fs.readFileSync(REUSABLE, "utf8");
    expect(text, "must keep rsync --delete so platform removals propagate").toMatch(
      /rsync\s+-a\s+--delete\b/,
    );
  });

  test("the reusable discovers `.repo-local` markers and excludes them", () => {
    const text = fs.readFileSync(REUSABLE, "utf8");
    // Discovers the marker one level into the skills dir…
    expect(text, "must find `.repo-local` marker files under DEST").toMatch(
      /find\s+"\$DEST".*-name\s+\.repo-local/,
    );
    // …and turns each into an anchored rsync exclude of that skill dir.
    expect(text, "must build an anchored --exclude=/<name>/ per marked skill").toMatch(
      /--exclude=\/\$\{name\}\//,
    );
    // The excludes must actually reach the rsync invocation.
    expect(text, "the rsync call must consume the built excludes array").toMatch(
      /rsync\s+-a\s+--delete\s+\$\{excludes\[@\]\+"\$\{excludes\[@\]\}"\}/,
    );
    // …and the rsync COMMAND must NOT pass --delete-excluded, which would defeat
    // the protection. Scope to the invocation line so a mention in a nearby
    // comment doesn't trip this.
    const rsyncCmd = text.split("\n").find((l) => /^\s*rsync\s/.test(l)) || "";
    expect(rsyncCmd, "found an rsync invocation to check").toMatch(/rsync\s/);
    expect(rsyncCmd, "--delete-excluded would delete the protected skills").not.toContain(
      "--delete-excluded",
    );
  });

  test("drift detection is untracked-aware (git status --porcelain, not git diff --quiet)", () => {
    // rsync brings NEW platform skills in as UNTRACKED files. `git diff --quiet`
    // ignores untracked paths, so an additive-only sync (the common case now
    // that repo-local skills aren't deleted to force a tracked change) would be
    // silently dropped. The "already in sync" gate must therefore test
    // `git status --porcelain`, which sees untracked files too.
    const text = fs.readFileSync(REUSABLE, "utf8");
    expect(text, "the sync must have an 'already in sync' early-exit").toMatch(/already in sync/);
    // The drift gate must consult untracked-aware `git status --porcelain`…
    expect(text, "drift gate must use untracked-aware git status --porcelain").toMatch(
      /-z "\$\(git status --porcelain -- "\$DEST"\)"/,
    );
    // …and must NOT gate on `git diff --quiet`, which is blind to untracked adds.
    expect(text, "drift gate must not rely on untracked-blind git diff --quiet").not.toContain(
      "git diff --quiet",
    );
  });

  test("the canonical README documents the `.repo-local` opt-out", () => {
    const text = fs.readFileSync(README, "utf8");
    expect(text).toContain(".repo-local");
    expect(text.toLowerCase()).toContain("repo-local skills");
  });
});
