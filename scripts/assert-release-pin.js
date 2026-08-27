#!/usr/bin/env node
/*
 * Refuse a consumer's platform pin that is a PRERELEASE.
 *
 * `release.yml` can cut `vX.Y.Z-rc.N` as a GitHub prerelease so a platform fix
 * can be validated on ONE consumer PR before it reaches production. That is
 * deliberately pinnable: a stacked branch sets `platform_ref: v0.1.89-rc.1` and
 * its preview builds against the RC. What must NOT happen is that pin riding
 * into the consumer's DEFAULT branch, where it becomes what production builds
 * and deploys from — an RC is a validation tag, not a release.
 *
 * Nothing stopped that before. `platform-bump` can't introduce one (it resolves
 * `releases/latest`, which excludes prereleases), but a hand-pinned validation
 * branch is exactly how an RC gets into a repo in the first place, and merging
 * that branch was a single click away from shipping it.
 *
 * SCOPE is the caller's, not this script's. This reads one key and answers one
 * question. The thin caller's `on: pull_request: branches:` decides WHICH
 * merges are guarded — the canonical caller targets the default branch, so an
 * RC stays pinnable everywhere else. Same division of labour as
 * platform-pin-consistency.yml.
 *
 * Deliberately NOT in scope: a `platform_ref` that is a sha or a branch name.
 * Those are also not releases, but they are not what this guard was asked for,
 * and failing them would change the failure mode for setups nobody has audited.
 * `check-platform-pin-consistency.js` already forces every OTHER reference to
 * agree with whatever `platform.lock` says.
 *
 *   node scripts/assert-release-pin.js [--root DIR] [--lock REL]
 *
 * Exit codes are three-valued ON PURPOSE, so a caller can tell "ran, found a
 * prerelease" apart from "could not run" — a guard that cannot read its input
 * must never look like a pass:
 *   0  ran, the pin is not a prerelease
 *   1  ran, the pin IS a prerelease (printed)
 *   2  could not run (no platform.lock, unparseable, no platform_ref)
 */

const fs = require("node:fs");
const path = require("node:path");

// Same resolution as check-platform-pin-consistency.js, so the two guards read
// the same file in the same lane without a second convention.
function argOf(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ROOT = path.resolve(argOf("root", process.cwd()));
const LOCK_REL = argOf("lock", "platform.lock");
const LOCK_PATH = path.join(ROOT, LOCK_REL);

// A semver prerelease: the hyphen-introduced identifier after MAJOR.MINOR.PATCH.
// `v0.1.89-rc.1` matches; `v0.1.89` does not. Anchored at both ends so a version
// merely CONTAINING a hyphen later in a longer string cannot masquerade as one.
const PRERELEASE_PIN = /^v\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;

function cannotRun(msg) {
  process.stderr.write(`assert-release-pin: ${msg}\n`);
  process.exit(2);
}

// The real YAML parser, never a line regex (AGENTS.md: no regex config
// scraping).
//
// The candidate list is DELIBERATELY identical to
// check-platform-pin-consistency.js's loadYaml(), because the two guards run in
// the same lane off the same single `npm install --no-save yaml`. That install
// lands in the CONSUMER workspace (the cwd), not beside this script under
// `.cms-platform/scripts/`, so plain `require("yaml")` — the script's own
// node_modules chain — does not find it and the guard would exit 2 on every
// real run. If one list changes, change both.
function loadYaml() {
  const candidates = [
    undefined, // standard node resolution (script's own node_modules chain)
    path.resolve(__dirname, "..", "e2e", "node_modules"),
    path.resolve(__dirname, "..", "node_modules"),
    path.resolve(process.cwd(), "e2e", "node_modules"),
    path.resolve(process.cwd(), "node_modules"),
  ];
  for (const base of candidates) {
    try {
      const resolved = base ? require.resolve("yaml", { paths: [base] }) : require.resolve("yaml");
      return require(resolved);
    } catch {
      /* try next */
    }
  }
  return cannotRun(
    "cannot resolve the `yaml` parser. Install it (e.g. `npm install --no-save yaml`) before running this guard.",
  );
}

let raw;
try {
  raw = fs.readFileSync(LOCK_PATH, "utf8");
} catch {
  cannotRun(`no ${LOCK_REL} at ${LOCK_PATH} — a consuming repo must carry it.`);
}

let doc;
try {
  doc = loadYaml().parse(raw);
} catch (e) {
  cannotRun(`${LOCK_REL} is not parseable YAML: ${e.message}`);
}

if (!doc || typeof doc !== "object") {
  cannotRun(`${LOCK_REL} is empty or not a mapping; expected a 'platform_ref:' key.`);
}

const ref = typeof doc.platform_ref === "string" ? doc.platform_ref.trim() : "";
if (!ref) {
  cannotRun(`${LOCK_REL} has no 'platform_ref:' value.`);
}

if (PRERELEASE_PIN.test(ref)) {
  process.stdout.write(
    `assert-release-pin: FAIL — ${LOCK_REL} pins platform_ref '${ref}', a PRERELEASE.\n\n` +
      `A prerelease is a validation tag: pin it on a stacked branch to exercise a platform\n` +
      `fix on that branch's preview, never on the branch production builds from. Merging it\n` +
      `here would make '${ref}' what every production deploy resolves.\n\n` +
      `To unblock, re-pin every platform reference to the RELEASE this candidate became\n` +
      `(platform.lock platform_ref, the Gemfile gem tag, Gemfile.lock tag + revision, and\n` +
      `every uses:@ pin and with: platform_ref: input under .github/workflows/) — they must\n` +
      `all move together or the single-version guard fails instead. If that release is not\n` +
      `cut yet, cut it first; this branch is not mergeable until then.\n`,
  );
  process.exit(1);
}

process.stdout.write(`assert-release-pin: OK — platform_ref '${ref}' is not a prerelease.\n`);
process.exit(0);
