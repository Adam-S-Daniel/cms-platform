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

// Carve-outs that stay NON-salient even where a broad salient pattern
// (e.g. `_data/`) would otherwise match. Synced tool vendor bumps are
// CMS-content-like: the pixel/text delta IS the intent of the change,
// already reviewed in the tool's source repo (its PR + the site preview
// mirror), so the site-side gate must not re-review them. A tool-sync PR
// touches exactly `assets/tools/<slug>/` + its provenance record under
// `_data/tool_sources/` — both listed here. A MIXED diff (tool bump +
// a template edit) is still salient via the template file, and that run
// will then also surface the tool page's delta — desired, since a human
// is reviewing that PR anyway.
//
// The carve-out is for UPDATES to an existing tool only. A brand-NEW tool
// can't ride it into production unreviewed: its required `_tools/<slug>.md`
// collection entry is salient (below), so the first PR that adds a tool
// page always runs the regression build — where the _site scan + prod-404
// detection score the new page "new" and route it through manual review.
const NON_SALIENT_OVERRIDES = [/^_data\/tool_sources\//, /^assets\/tools\//];

// Files whose changes CAN shift rendered output, plus the regression
// pipeline's own tooling. Anything NOT matched here (CMS content, media
// uploads, docs, infra, other tooling) is non-salient.
const SALIENT_PATTERNS = [
  /^_layouts\//,
  /^_includes\//,
  /^_plugins\//,
  /^_data\//,
  // Tools collection entries (site-owned on consumers that have one; inert
  // elsewhere). Salient — unlike CMS content — because adding an entry
  // creates a public /tools/ page, and it's the one path a NEW tool must
  // touch that a tool-sync update never does (see NON_SALIENT_OVERRIDES
  // above). A CMS edit to an entry that already exists is the exception:
  // see isCmsToolEdit below (cms-platform#1044).
  /^_tools\//,
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
  return (files || []).some((f) => {
    const p = String(f).trim();
    if (NON_SALIENT_OVERRIDES.some((re) => re.test(p))) return false;
    return SALIENT_PATTERNS.some((re) => re.test(p));
  });
}

// cms-platform#1044: a Decap edit to a tool entry that ALREADY exists on the
// base branch is CMS content like any other collection: its pixel and text
// delta (a new title, description or body) is the intent of the edit. The
// `_tools/` rule above exists so a NEW tool cannot reach production
// unreviewed, and an added, deleted or renamed entry (`--no-renames` lists a
// rename as D + A) still is one. Two front-matter fields keep the review even
// on an edit, because they change what the page IS rather than what it says:
// `slug` moves the page to a new URL (the tools permalink is
// /tools/:slug/, and Jekyll takes :slug from front matter), and `embed_src`
// swaps the app the page embeds.
const TOOL_ENTRY = /^_tools\/[^/]+\.md$/;
const TOOL_REVIEW_FIELDS = ["slug", "embed_src"];

// Jekyll front matter: a leading `---` line, YAML, then a `---` or `...`
// line. Returns the parsed mapping, or null when there is none or it does not
// parse to a mapping (the caller treats null as "keep the review").
function parseFrontMatter(text, YAML) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && (l === "---" || l === "..."));
  if (end < 0) return null;
  let doc;
  try {
    doc = YAML.parse(lines.slice(1, end).join("\n"));
  } catch {
    return null;
  }
  return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
}

// True when `before` -> `after` keeps every review field. Anything it cannot
// read (no front matter, a parse error, no YAML parser) returns false, so the
// entry stays salient: this check can only ever REMOVE a review it is sure of.
function toolEditKeepsReviewFields(before, after, YAML) {
  if (!YAML) return false;
  const a = parseFrontMatter(before, YAML);
  const b = parseFrontMatter(after, YAML);
  if (!a || !b) return false;
  return TOOL_REVIEW_FIELDS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

// Salience over `git diff --name-status --no-renames` records
// ({ status, path }). Same as isSalient, except that on a pull request from
// the CMS a MODIFIED tool entry is skipped when `readBlobs(path)` shows its
// review fields unchanged, and a MODIFIED CMS file collection named in
// `cmsFiles` is skipped (isCmsFileEdit below). `readBlobs` returns
// { before, after } text, or null when either side cannot be read.
function isSalientChange(
  records,
  { fromCms = false, readBlobs = () => null, YAML = null, cmsFiles = [] } = {},
) {
  return (records || []).some(({ status, path: p }) => {
    if (!isSalient([p])) return false;
    if (isCmsFileEdit({ status, path: p }, { fromCms, cmsFiles })) return false;
    return !isCmsToolEdit({ status, path: p }, { fromCms, readBlobs, YAML });
  });
}

// A Decap FILE collection (`file: _data/about.yml` in the site's seam) is CMS
// content like a folder collection's entry: the pixel and text delta of an
// edit is its intent. It lives under `_data/`, which is salient above because
// a data file nobody edits through the CMS can reshape any page, so without
// this every edit to such a section parked on the manual review with no
// error in `/admin` (jodidaniel.com PR 348). `cmsFiles` is the caller's list
// of those files, read from the BASE commit and already WITHOUT the site's
// publish gate (content-route.js's cmsDataFiles): taking a site live keeps
// its review. Only a MODIFIED file from the CMS skips; an added or deleted
// one changes what the site is made of.
function isCmsFileEdit({ status, path: p }, { fromCms, cmsFiles }) {
  return Boolean(fromCms) && status === "M" && (cmsFiles || []).includes(p);
}

function isCmsToolEdit({ status, path: p }, { fromCms, readBlobs, YAML }) {
  if (!fromCms || status !== "M" || !TOOL_ENTRY.test(p)) return false;
  const blobs = readBlobs(p);
  if (!blobs) return false;
  return toolEditKeepsReviewFields(blobs.before, blobs.after, YAML);
}

// Split git's `-z` output into paths. Each path is NUL-terminated and carried
// VERBATIM: no quoting, no octal escapes, and spaces, quotes and newlines are
// part of the name. Without `-z`, git's default `core.quotepath` turns
// `_layouts/café.html` into `"_layouts/caf\303\251.html"` — leading quote
// included — so no `^_layouts/` rule matches it (cms-platform#539).
function parseNulPaths(raw) {
  return String(raw)
    .split("\0")
    .filter((p) => p.length > 0);
}

// Split `git diff --name-status -z --no-renames` output into records. Each
// record is a status field then a path, both NUL-terminated. With
// `--no-renames` no record carries a second path. A trailing odd field means
// truncated input: throw rather than guess.
function parseNulStatus(raw) {
  const fields = parseNulPaths(raw);
  if (fields.length % 2 !== 0) {
    throw new Error("name-status input has an odd number of fields");
  }
  const records = [];
  for (let i = 0; i < fields.length; i += 2) {
    records.push({ status: fields[i], path: fields[i + 1] });
  }
  return records;
}

module.exports = {
  NON_SALIENT_OVERRIDES,
  SALIENT_PATTERNS,
  TOOL_REVIEW_FIELDS,
  isSalient,
  isSalientChange,
  parseFrontMatter,
  parseNulPaths,
  parseNulStatus,
};

// The YAML parser, or null when it is not installed (the `detect` job
// installs it only when a tool entry or a `_data/` file changed). Null keeps
// every review.
function loadYaml() {
  try {
    return require("yaml");
  } catch {
    return null;
  }
}

// `git show <rev>:<path>` as text, or null. argv, never a shell string: a
// path may hold any character git allows.
function gitShow(rev, p) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("git", ["show", `${rev}:${p}`], { encoding: "utf8", maxBuffer: 8 << 20 });
  return r.status === 0 ? r.stdout : null;
}

// CLI: read changed paths from stdin, print "true"/"false". Used by the
// reusable workflow's `detect` job with NUL-delimited name-status input:
//   git diff --name-status -z --no-renames "origin/$BASE...HEAD" \
//     | node visual-regression-salient.js --status --base-rev "$MERGE_BASE"
// with VR_FROM_CMS=true when the pull request is a same-repository `cms/`
// branch. `--base-rev` is the commit the entry is compared against (the merge
// base); the PR side is HEAD. `-z` alone reads NUL-delimited paths with no
// status, and no flag reads newline-delimited paths (the old contract),
// which cannot represent a quoted, non-ASCII or newline-containing name.
if (require.main === module) {
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const nul = args.some((a) => a === "-z" || a === "--null");
  const withStatus = args.includes("--status");
  const baseIdx = args.indexOf("--base-rev");
  const baseRev = baseIdx >= 0 ? args[baseIdx + 1] : "";
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  if (withStatus) {
    const fromCms = process.env.VR_FROM_CMS === "true" && Boolean(baseRev);
    const readBlobs = (p) => {
      const before = gitShow(baseRev, p);
      const after = gitShow("HEAD", p);
      return before === null || after === null ? null : { before, after };
    };
    const YAML = loadYaml();
    // Required here, not at the top: content-route.js requires this module.
    const { SEAM_PATH, CONFIG_PATH, cmsDataFiles } = require("./content-route");
    const cmsFiles = fromCms
      ? cmsDataFiles({
          seamYamlText: gitShow(baseRev, SEAM_PATH),
          configYamlText: gitShow(baseRev, CONFIG_PATH),
          YAML,
        })
      : [];
    const salient = isSalientChange(parseNulStatus(raw), { fromCms, readBlobs, YAML, cmsFiles });
    process.stdout.write(salient ? "true" : "false");
    process.exit(0);
  }
  const files = nul
    ? parseNulPaths(raw)
    : raw
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
  process.stdout.write(isSalient(files) ? "true" : "false");
}
