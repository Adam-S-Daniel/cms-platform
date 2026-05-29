// @lane: local — patches the rendered _site/admin/config.yml and execs scripts/patch-preview-config.sh
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// Locks the prod ↔ preview config delta produced by
// `scripts/patch-preview-config.sh`. The script runs three sed
// substitutions on a Decap CMS config YAML to repoint a preview
// deployment at its own subdomain and PR branch:
//
//   1. site_url:    → preview host
//   2. display_url: → preview host
//   3.   branch:    → PR head branch (within the `backend:` block)
//
// Anything else changing means either the script grew an unintended
// side effect or a config edit collided with one of the targeted
// patterns. Either failure mode is invisible in CI today: the patch
// runs at deploy time, not in tests, so drift would only surface as
// a broken preview environment. This spec snapshots the contract so
// we catch the drift in the PR that introduces it.
//
// Catches the drift class where someone adds a field like
// `media_folder: "..."` that accidentally matches one of the regexes,
// or where a future contributor adds a fourth substitution to the
// patch script without updating the allowlist below.
//
// Pure-Node spec (no browser): just file I/O, exec, and string diff.
// Skipped on Windows because the patch script is bash + sed -i.

// SITE_ROOT-aware resolution. The patch input is the RENDERED Decap config
// the gem's render hook emits to `<site>/_site/admin/config.yml` during the
// local-lane build (there's no hand-authored source `admin/config.yml`); the
// patch SCRIPT (scripts/patch-preview-config.sh) is a PLATFORM artifact —
// it's run by the platform's deploy-preview workflow, not shipped to a
// consuming site. So the realistic fix asserts the delta against the
// rendered config, and the spec self-skips when either the rendered config
// isn't built (preview/prod lanes) or the patch script isn't present (a
// consumer that doesn't ship `scripts/`).
const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || REPO_ROOT;
const PATCH_SCRIPT = path.join(REPO_ROOT, "scripts/patch-preview-config.sh");
const RENDERED_CONFIG = path.join(SITE_ROOT, "_site", "admin", "config.yml");

// Fixture values — what the script would substitute into a real
// preview deploy. Concrete strings make the spec reproducible without
// pulling environment state in.
const FIXTURE_PR_NUMBER = "999";
const FIXTURE_BRANCH = "cms/draft-test";
const FIXTURE_HOST = "preview-pr999.adamdaniel.ai";
const FIXTURE_PREVIEW_URL = `https://${FIXTURE_HOST}`;

// The single rendered Decap config the patch script would substitute into a
// real preview deploy. The former local/test config variants are dropped:
// config-test.yml is platform-only test scaffolding (never rendered, and it
// has no `  branch:` field anyway) and config-local.yml only matters to the
// local-backend decap-server — neither is the prod config the
// deploy-preview workflow actually patches. The allowed-delta check accepts
// "fewer than three changes, but every change is in the set."
const CONFIGS = [RENDERED_CONFIG];

// A line is allowed to change if and only if its NEW form looks like
// the output of one of the three sed substitutions. Matching the
// post-substitution shape (not just the key) guards against cases
// where the script's regex matches an unintended line that happens
// to share the same key prefix.
function isAllowedNewLine(line) {
  if (line === `site_url: ${FIXTURE_PREVIEW_URL}`) return true;
  if (line === `display_url: ${FIXTURE_PREVIEW_URL}`) return true;
  // The branch regex captures `(  branch:)` (two-space indent) and
  // emits `\1 ${BRANCH}`. The two-space indent puts it inside the
  // top-level `backend:` block.
  if (line === `  branch: ${FIXTURE_BRANCH}`) return true;
  return false;
}

function runPatch(targetFile) {
  execFileSync(
    "bash",
    [PATCH_SCRIPT, targetFile, FIXTURE_PR_NUMBER, FIXTURE_BRANCH, FIXTURE_HOST],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function diffLines(originalText, patchedText) {
  const originalLines = originalText.split(/\r?\n/);
  const patchedLines = patchedText.split(/\r?\n/);
  // Sanity: the patch script only does in-place substitutions, so
  // line counts should match. A length mismatch is itself drift —
  // surface it explicitly with a hint at where the divergence began.
  if (originalLines.length !== patchedLines.length) {
    const firstDivergence = Math.min(originalLines.length, patchedLines.length);
    return {
      lengthMismatch: true,
      originalLength: originalLines.length,
      patchedLength: patchedLines.length,
      changes: [
        {
          lineNumber: firstDivergence + 1,
          oldLine: originalLines[firstDivergence] ?? "<EOF>",
          newLine: patchedLines[firstDivergence] ?? "<EOF>",
        },
      ],
    };
  }
  const changes = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i] !== patchedLines[i]) {
      changes.push({
        lineNumber: i + 1,
        oldLine: originalLines[i],
        newLine: patchedLines[i],
      });
    }
  }
  return { lengthMismatch: false, changes };
}

function formatUnexpectedDelta(label, change) {
  return [
    `Unexpected line changed in ${label} at line ${change.lineNumber}:`,
    `- ${change.oldLine}`,
    `+ ${change.newLine}`,
    "",
    "Allowed substitutions are:",
    `  site_url: ${FIXTURE_PREVIEW_URL}`,
    `  display_url: ${FIXTURE_PREVIEW_URL}`,
    `    branch: ${FIXTURE_BRANCH}  (with two leading spaces, inside backend:)`,
    "",
    "If this drift is intentional, update both scripts/patch-preview-config.sh",
    "and e2e/cms-config-preview-delta.spec.js together.",
  ].join("\n");
}

test.describe("scripts/patch-preview-config.sh delta lock", () => {
  test.skip(os.platform() === "win32", "patch-preview-config.sh requires bash + GNU sed");
  // Self-skip when the patch SCRIPT isn't present (a consumer that doesn't
  // ship `scripts/`) or the RENDERED config isn't built (preview/prod lanes
  // that crawl deployed surfaces and never build `_site`). Mirrors the
  // sitemap.spec self-skip so neither case ENOENT-fails the suite.
  test.skip(
    !fs.existsSync(PATCH_SCRIPT),
    `${PATCH_SCRIPT} not present — patch-preview-config.sh is a platform deploy artifact; the delta lock only runs in the platform tree`,
  );
  test.skip(
    !fs.existsSync(RENDERED_CONFIG),
    `${RENDERED_CONFIG} not built (run the local Jekyll build + render-decap-config.rb) — rendered-config delta lock only runs in the local lane`,
  );

  test.describe.configure({ mode: "serial" });

  for (const sourcePath of CONFIGS) {
    const relPath = path.relative(SITE_ROOT, sourcePath);
    let tempfile = null;

    test(`${relPath}: only site_url, display_url, and backend.branch differ after patching`, () => {
      const originalText = fs.readFileSync(sourcePath, "utf8");

      // Copy to a unique tempfile so concurrent test runs (or a
      // forgotten cleanup) can't poison each other.
      const suffix = crypto.randomBytes(8).toString("hex");
      tempfile = path.join(
        os.tmpdir(),
        `cms-config-preview-delta-${path.basename(sourcePath)}-${suffix}`,
      );
      fs.writeFileSync(tempfile, originalText);

      runPatch(tempfile);
      const patchedText = fs.readFileSync(tempfile, "utf8");

      const diff = diffLines(originalText, patchedText);
      expect(
        diff.lengthMismatch,
        `${relPath}: line count changed after patch (original=${diff.originalLength} patched=${diff.patchedLength}). The patch script should only do in-place substitutions.`,
      ).toBe(false);

      // Every change must match one of the three allowed substitutions.
      for (const change of diff.changes) {
        expect(isAllowedNewLine(change.newLine), formatUnexpectedDelta(relPath, change)).toBe(true);
      }

      // Sanity floor: the patch must actually do *something* on every
      // config — site_url and display_url exist in all three. If they
      // didn't change, the regex stopped matching and previews would
      // silently keep prod URLs. (config-test.yml lacks `  branch:`,
      // so the third substitution is allowed to no-op.)
      const changedNewLines = diff.changes.map((c) => c.newLine);
      expect(
        changedNewLines,
        `${relPath}: site_url substitution did not fire — preview deploys would inherit prod URL.`,
      ).toContain(`site_url: ${FIXTURE_PREVIEW_URL}`);
      expect(
        changedNewLines,
        `${relPath}: display_url substitution did not fire — "Open Production Site" button would point at prod.`,
      ).toContain(`display_url: ${FIXTURE_PREVIEW_URL}`);
    });

    test.afterEach(() => {
      if (tempfile) {
        fs.rmSync(tempfile, { force: true });
        tempfile = null;
      }
    });
  }
});
