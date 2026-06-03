// Salience decision for the visual-regression pipeline.
//
// A PR is "salient" — worth building + screenshotting — only when its diff
// can shift RENDERED output (templates, includes, plugins, data, the admin
// shell, site styling) or change the regression pipeline's own tooling. CMS
// content (the collections in admin/config.base.yml + media uploads) is
// NON-salient: pixel diffs there are the intent of the edit, not a
// regression. Docs / infra / unrelated tooling are non-salient too.
//
// This is the SINGLE SOURCE OF TRUTH for that decision:
//   - the reusable visual-regression workflow's `detect` job pipes the PR's
//     changed file paths through this module (stdin → "true"/"false");
//   - the content-skip lint (visual-regression-content-skip.test.js) imports
//     it to lock the invariant.
// It previously lived as the caller's `on.pull_request.paths` filter; it
// moved here so the workflow can ALWAYS trigger and the required
// `approve-regression` check always reports a status (a path-filtered
// workflow that never fires would deadlock a required check).

// Files whose changes CAN shift rendered output, plus the regression
// pipeline's own tooling. Anything NOT matched here (CMS content, media
// uploads, docs, infra, other tooling) is non-salient.
const SALIENT_PATTERNS = [
  /^_layouts\//,
  /^_includes\//,
  /^_plugins\//,
  /^_data\//,
  /^admin\//,
  /^assets\/css\//,
  /^assets\/js\//,
  /^assets\/images\/logo\.svg$/,
  /^_config\.yml$/,
  /^Gemfile$/,
  /^Gemfile\.lock$/,
  /^index\.html$/,
  /^404\.html$/,
  /^robots\.txt$/,
  /^preview\.md$/,
  // The regression pipeline's own tooling (the workflow + platform e2e/).
  /^\.github\/workflows\/visual-regression\.yml$/,
  /^e2e\/detect-changed-pages\.js$/,
  /^e2e\/compute-visual-diffs\.js$/,
  /^e2e\/visual-regression-salient\.js$/,
  /^e2e\/generate-video\.sh$/,
  /^e2e\/regression-video\.spec\.js$/,
  /^e2e\/playwright\.regression\.config\.js$/,
];

// True when ANY changed file can shift rendered output. An empty list (no
// changed files / could not diff) is non-salient — nothing to compare.
function isSalient(files) {
  return (files || []).some((f) => SALIENT_PATTERNS.some((re) => re.test(String(f).trim())));
}

module.exports = { SALIENT_PATTERNS, isSalient };

// CLI: read newline-delimited changed paths from stdin, print "true"/"false".
// Used by the reusable workflow's `detect` job:
//   git diff --name-only "origin/$BASE...HEAD" | node visual-regression-salient.js
if (require.main === module) {
  const fs = require("node:fs");
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  const files = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  process.stdout.write(isSalient(files) ? "true" : "false");
}
