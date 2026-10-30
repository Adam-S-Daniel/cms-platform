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
//   3. platform-bump moves Gemfile.lock's pins TEXTUALLY (CUR->LATEST plus
//      OLD_SHA->NEW_SHA); CUR is read from platform.lock's `platform_ref:`, so
//      it is v-prefixed ("v0.1.79") and can never match the bare "0.1.4". Since
//      the release after v0.1.167 the pin rewrite it fetches at the NEW release
//      (scripts/rewrite-platform-pins.js) then re-resolves the lock with
//      `bundle lock --update cms-platform-theme --conservative`, which would
//      carry a version change into a consumer on a bump; the freeze stays so a
//      lock that moved any other way cannot disagree.
//
// Facts (1) is consumer-side and unreadable from here. Facts (2) and (3) live
// in this repo, so this lint pins where (3)'s Bundler run lives — the pin
// rewrite, never platform-bump.yml, which a consumer runs at the release it is
// LEAVING — plus the frozen value itself, so any change trips a test whose
// message explains the coupling.
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
        "Both consumers' Gemfile.lock record it (twice each: GIT specs: + CHECKSUMS) and their CI\n" +
        "installs in bundler DEPLOYMENT/frozen mode, so a lock that disagrees fails GemNotFound on\n" +
        "adamdaniel.ai AND jodidaniel.com. platform-bump's relock (rewrite-platform-pins.js) would\n" +
        "move both occurrences on a bump; check both consumers' locks follow before changing it.\n" +
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

  test("platform-bump.yml runs no Bundler itself: the relock lives in the pin rewrite it fetches", () => {
    // A consumer runs the platform-bump.yml of the release it is LEAVING, so a
    // `bundle lock` added there would reach no bump until the release after it.
    // The relock lives in scripts/rewrite-platform-pins.js, fetched at the
    // release the bump moves TO. Fail LOUD if either half moves, so the freeze
    // reasoning above is revisited instead of rotting silently.
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
      "platform-bump.yml now runs bundler. A consumer runs the platform-bump.yml of the release " +
        "it is leaving, so the relock belongs in scripts/rewrite-platform-pins.js (fetched at the " +
        "new release). Move it there, or update the gemspec header and this lint together.",
    ).toBe(false);
    const { relockCommands } = require("../scripts/rewrite-platform-pins.js");
    expect(
      relockCommands("4.0.10").map(([cmd, args]) => [cmd, ...args].join(" ")),
      "the pin rewrite must re-resolve only the theme gem, conservatively, with the lock's own Bundler",
    ).toEqual([
      "gem install bundler --version 4.0.10 --no-document",
      "bundle _4.0.10_ lock --update cms-platform-theme --conservative",
    ]);

    // CUR is the consumer's previous platform_ref, which is v-prefixed — the
    // reason a literal CUR->LATEST replace can never touch the bare version.
    expect(
      /CUR=\$\(sed[^\n]*platform_ref/.test(scripts),
      "platform-bump.yml no longer derives CUR from platform.lock's platform_ref. The freeze " +
        "reasoning assumes CUR is a v-prefixed ref that cannot match the bare gemspec version.",
    ).toBe(true);
  });
});
