// @lane: local — pure-fs lint. The theme gemspec's version is DELIBERATELY
// frozen, and this locks the three facts that make freezing correct.
//
// The value looks stale — `spec.version = "0.1.4"` while the platform is 75+
// releases past v0.1.4 — and a well-meaning tidy-up would break BOTH
// production consumers' CI at `bundle install`. Investigated 2026-08-10:
//
//   1. Each consumer's Gemfile.lock records the version TWICE (the GIT block's
//      `specs:` and again under CHECKSUMS) as `cms-platform-theme (0.1.4)`.
//   2. Consumer CI installs gems in DEPLOYMENT (frozen) mode — ruby/setup-ruby
//      sets `bundle config deployment true` whenever a lockfile exists, and
//      both consumers commit Gemfile.lock. Frozen bundler materializes a
//      git-source spec by [name, VERSION] and refuses to rewrite the lock, so a
//      gemspec version disagreeing with the lock is a hard GemNotFound.
//   3. platform-bump.yml cannot repair it: it rewrites Gemfile.lock TEXTUALLY
//      (literal CUR->LATEST plus OLD_SHA->NEW_SHA) and never runs bundler. CUR
//      is read from platform.lock's `platform_ref:`, so it is v-prefixed
//      ("v0.1.79") and can never match the bare "0.1.4".
//
// Facts (1) is consumer-side and unreadable from here. Facts (2) and (3) live
// in this repo, so this lint pins (3) — the one that would silently invalidate
// the freeze if platform-bump ever grew a `bundle lock` — plus the frozen value
// itself, so any change trips a test whose message explains the coupling.
//
// PLATFORM-INTERNAL: reads theme/ + .github/workflows/, neither of which exists
// on a consumer, so it is registered in PLATFORM_META_SPECS.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { readWorkflow, runScripts } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const GEMSPEC = path.join(REPO_ROOT, "theme", "cms-platform-theme.gemspec");

// The frozen value. Changing it here is not enough — see the header.
const FROZEN_VERSION = "0.1.4";

function gemspecSource() {
  return fs.readFileSync(GEMSPEC, "utf8");
}

test.describe("theme gemspec version is deliberately frozen", () => {
  test(`spec.version is pinned at ${FROZEN_VERSION}`, () => {
    const m = gemspecSource().match(/^\s*spec\.version\s*=\s*"([^"]+)"/m);
    expect(m, "theme/cms-platform-theme.gemspec must declare spec.version").not.toBeNull();
    expect(
      m[1],
      `spec.version is FROZEN at ${FROZEN_VERSION} on purpose — it is NOT stale.\n` +
        "Both consumers' Gemfile.lock record it (twice each: GIT specs: + CHECKSUMS), their CI\n" +
        "installs in bundler DEPLOYMENT/frozen mode, and platform-bump.yml rewrites the lock\n" +
        "textually with a v-prefixed ref so it can never update the bare version. Bumping this\n" +
        "alone makes `bundle install` fail GemNotFound on adamdaniel.ai AND jodidaniel.com.\n" +
        "To change it: move the version AND both lockfile occurrences in BOTH consumers in the\n" +
        "same change, and teach platform-bump.yml to do so (or to run `bundle lock`).\n" +
        "See the gemspec header comment.",
    ).toBe(FROZEN_VERSION);
  });

  test("the freeze is explained in the gemspec itself, not just here", () => {
    // A bare frozen constant invites the exact tidy-up this guards against, so
    // the reason has to be readable at the point of temptation.
    const src = gemspecSource();
    expect(src, "the gemspec must say WHY the version is frozen").toMatch(/DELIBERATELY FROZEN/);
    expect(src, "the gemspec comment must name the frozen-bundler mechanism").toMatch(
      /deployment|frozen/i,
    );
    expect(src, "the gemspec comment must point at this lint").toMatch(
      /gemspec-version-frozen\.test\.js/,
    );
  });

  test("platform-bump.yml still cannot update the locked version (the freeze's precondition)", () => {
    // If platform-bump ever learns to re-resolve the lockfile, the freeze stops
    // being necessary and this whole invariant should be revisited — so fail
    // LOUD rather than let the reasoning rot silently.
    // runScripts takes the raw workflow TEXT and returns {script, line}
    // objects — join the `script` fields, not the objects. (Joining the objects
    // yields "[object Object]", which made the two assertions below pass
    // against a 15-character string: a verifier that silently verified nothing.
    // Caught only because this lint was proven red-first.)
    const text = readWorkflow("platform-bump.yml");
    const scripts = runScripts(text)
      .map((r) => r.script)
      .join("\n");
    expect(
      scripts.length,
      "runScripts returned no shell for platform-bump.yml — the two assertions below would " +
        "vacuously pass. Check readWorkflow/runScripts usage before trusting this lint.",
    ).toBeGreaterThan(500);

    expect(
      /bundle\s+(install|lock|update)/.test(scripts),
      "platform-bump.yml now runs bundler. The gemspec version freeze exists BECAUSE it could " +
        "not re-resolve Gemfile.lock. Re-check whether the freeze is still needed, then update " +
        "the gemspec header and this lint together.",
    ).toBe(false);

    // CUR is the consumer's previous platform_ref, which is v-prefixed — the
    // reason a literal CUR->LATEST replace can never touch the bare version.
    expect(
      /CUR=\$\(sed[^\n]*platform_ref/.test(scripts),
      "platform-bump.yml no longer derives CUR from platform.lock's platform_ref. The freeze " +
        "reasoning assumes CUR is a v-prefixed ref that cannot match the bare gemspec version.",
    ).toBe(true);
  });
});
