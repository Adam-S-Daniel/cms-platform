#!/usr/bin/env node
/*
 * Playwright image-version drift guard (#1723 Cat 4).
 *
 * Every Playwright job in this repo runs inside the prebaked ci-runner
 * image, whose browser builds come from its base layer:
 *   .github/ci-runner/Dockerfile → ARG PLAYWRIGHT_IMAGE_TAG=vX.Y.Z-noble
 *                                 → FROM mcr.microsoft.com/playwright:${...}
 * The runtime client comes from `npm ci` → package-lock.json's resolved
 * `@playwright/test`. If those two versions disagree, the baked browser
 * revision (e.g. chromium_headless_shell-1223) won't match the build the
 * client expects → every spec dies at `browserType.launch` with
 * "Executable doesn't exist at /ms-playwright/...".
 *
 * The previous guard (inline in e2e-tests.yml's `select` job) scanned
 * only `.github/workflows/*.yml` — but NO workflow references the raw
 * `mcr.microsoft.com/playwright:vX` image anymore (they all use the
 * prebaked ci-runner image), so it had ZERO real targets. The actual
 * browser pin — the Dockerfile ARG — went UNCHECKED, so a lockfile bump
 * that rebuilt the image (the lockhash includes package-lock.json) with
 * a stale base produced exactly the launch failure above and the guard
 * stayed green. This script closes that blind spot: it scans the
 * ci-runner Dockerfile AND every workflow, and fails on ANY tag that
 * disagrees with the lockfile — so a `@playwright/test` bump can't merge
 * without the matching base-image bump.
 *
 * Pure Node (fs/path only) so the `select` job runs it with stock Node,
 * no npm ci. Unit-tested via e2e/playwright-image-drift.test.js.
 */
const fs = require("node:fs");
const path = require("node:path");

// Resolved @playwright/test version npm actually installs. `version` in
// `packages["node_modules/@playwright/test"]` is the locked exact
// version (package.json's `dependencies` may be a range like ^1.59.0).
function expectedPlaywrightVersion(repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const entry = (lock.packages || {})["node_modules/@playwright/test"];
  if (!entry || !entry.version) {
    throw new Error(
      "Could not resolve @playwright/test version from package-lock.json " +
        "(packages['node_modules/@playwright/test'].version missing).",
    );
  }
  return entry.version;
}

// A literal `mcr.microsoft.com/playwright:vX.Y.Z[-flavor]` image ref
// (workflows that pin the raw image directly) ...
// eslint-disable-next-line security/detect-unsafe-regex -- linear, anchored to a fixed literal prefix; no nested quantifiers (false positive)
const IMAGE_TAG_RE = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-[a-z0-9]+)?/g;
// ... and the ci-runner Dockerfile's base pin: `PLAYWRIGHT_IMAGE_TAG=vX.Y.Z[-flavor]`
// (ARG default or a build-arg override anywhere). This is THE pin the
// old guard missed (#1723 Cat 4).
// eslint-disable-next-line security/detect-unsafe-regex -- linear, anchored to a fixed literal prefix; no nested quantifiers (false positive)
const ARG_TAG_RE = /PLAYWRIGHT_IMAGE_TAG[=:]\s*["']?v(\d+\.\d+\.\d+)(?:-[a-z0-9]+)?/g;

// Every version-bearing Playwright tag in a file, from BOTH patterns.
function scanFileForTags(absPath) {
  const text = fs.readFileSync(absPath, "utf8");
  const out = [];
  for (const re of [IMAGE_TAG_RE, ARG_TAG_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) out.push({ version: m[1], raw: m[0] });
  }
  return out;
}

// The files that pin a Playwright browser version and MUST track the
// lockfile: the ci-runner Dockerfile (the real one) + every workflow.
function sourcesToScan(repoRoot) {
  const files = [path.join(repoRoot, ".github", "ci-runner", "Dockerfile")];
  const wfDir = path.join(repoRoot, ".github", "workflows");
  if (fs.existsSync(wfDir)) {
    for (const f of fs.readdirSync(wfDir).sort()) {
      if (f.endsWith(".yml") || f.endsWith(".yaml")) files.push(path.join(wfDir, f));
    }
  }
  return files.filter((f) => fs.existsSync(f));
}

// Returns { expected, mismatches: [{file, raw, found, expected}] }.
function findDriftMismatches(repoRoot) {
  const expected = expectedPlaywrightVersion(repoRoot);
  const mismatches = [];
  for (const abs of sourcesToScan(repoRoot)) {
    for (const { version, raw } of scanFileForTags(abs)) {
      if (version !== expected) {
        mismatches.push({ file: path.relative(repoRoot, abs), raw, found: version, expected });
      }
    }
  }
  return { expected, mismatches };
}

module.exports = {
  expectedPlaywrightVersion,
  scanFileForTags,
  sourcesToScan,
  findDriftMismatches,
};

if (require.main === module) {
  const repoRoot = process.cwd();
  let result;
  try {
    result = findDriftMismatches(repoRoot);
  } catch (e) {
    console.error(`::error::playwright-image-drift guard could not run: ${e && e.message}`);
    process.exit(1);
  }
  const { expected, mismatches } = result;
  console.log(`Lockfile @playwright/test version: ${expected}`);
  if (mismatches.length === 0) {
    console.log("All Playwright image tags (ci-runner Dockerfile + workflows) match the lockfile.");
    process.exit(0);
  }
  for (const mm of mismatches) {
    console.error(
      `::error file=${mm.file}::Playwright image tag '${mm.raw}' disagrees with package-lock.json's '${mm.expected}'.`,
    );
  }
  console.error("");
  console.error(`${mismatches.length} Playwright image tag(s) disagree with the lockfile.`);
  console.error(`Lockfile says: ${expected}`);
  console.error("To fix, bump every pin to match. Most importantly the ci-runner base image:");
  console.error("");
  console.error(`    .github/ci-runner/Dockerfile: ARG PLAYWRIGHT_IMAGE_TAG=v${expected}-noble`);
  console.error(
    `    sed -i 's|mcr.microsoft.com/playwright:v[^"[:space:]]*-noble|mcr.microsoft.com/playwright:v${expected}-noble|g' .github/workflows/*.yml`,
  );
  console.error("");
  console.error(
    `Then re-commit. The base image must exist: docker pull mcr.microsoft.com/playwright:v${expected}-noble`,
  );
  process.exit(1);
}
