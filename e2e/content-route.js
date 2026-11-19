// Route decision for a consumer pull request: `content` or `full`.
//
// A post, a page, an upload or a data file saved from the CMS does not touch
// the theme's files, the admin shell's files or a workflow, so running the
// browser matrix and the site verifier's self-tests against it tests
// machinery the change did not touch. It also turns every brittle or content-sensitive test into a
// blocked publish (adamdaniel.ai PR 5001: a post with featured-image alt text
// failed eight e2e projects and never went live). A pull request routed
// `content` is gated by the checks that are ABOUT the content: the content
// guard, the secrets scan, the site's own post-build verifier, the preview
// probes. Everything else routes `full` and runs the whole suite as before.
//
// `content` is the narrow answer and every doubt resolves to `full`:
//   * the pull request is not a same-repository `cms/` branch;
//   * the diff is empty or could not be read;
//   * any changed path is outside the site's CMS-managed content;
//   * any change is not a plain add, edit or delete of a regular file (a
//     symlink, a submodule, an executable bit, a type change);
//   * a file in a collection folder is not a Markdown entry, or an upload is
//     not a plain media file (`pages/home.html`, `uploads/sw.js`, an `.svg`);
//   * any changed path can shift rendered output beyond its own entry
//     (visual-regression-salient.js: `_tools/`, layouts, config, ...);
//   * a CMS file collection (`file: _data/x.yml`) is added or deleted rather
//     than edited, is not a data file under `_data/` (a seam may point one at
//     `_config.yml`), or is the site's publish gate (`cms.site_gate.path`,
//     the switch that takes a site live), or the gate cannot be read.
//
// WHAT THIS DOES NOT CHECK. An entry's front matter: a page may set
// `permalink:` or `layout:` to anything its collection's CMS fields allow.
// So "content cannot change the machinery" is a statement about FILES, not
// about every URL a page can claim; the site's post-build verifier, which
// runs on every pull request of a site that has one, is the guard for what
// the built site ends up serving. Base
// collections a site has switched off (`cms.base_collections`) still count
// as content here, as they do in content-pr-guard.js.
//
// The definition of "CMS-managed content" is scripts/content-pr-guard.js's
// (base collections + the site's seam), and "can shift rendered output" is
// visual-regression-salient.js's. No third list lives here. The seam and
// `_config.yml` are read from the BASE commit, so a pull request cannot widen
// its own route.
"use strict";

const {
  BASE_CONTENT_DIRS,
  JEKYLL_NON_CONTENT_DIRS,
  seamContentDirs,
  seamContentFiles,
} = require("../scripts/content-pr-guard");
const { isSalient } = require("./visual-regression-salient");
const { loadTrustedYaml } = require("./trusted-yaml");

const SEAM_PATH = "admin/collections.site.yml";
const CONFIG_PATH = "_config.yml";

// The media folder among content-pr-guard's base directories. Everything else
// there, and every seam folder, holds collection ENTRIES.
const UPLOADS_DIR = "assets/images/uploads/";

// What an entry and an upload may be. A content directory is not proof of
// content: `pages/home.html`, `assets/images/uploads/sw.js` or an `.svg` with
// a script in it are files a browser or Jekyll executes. Anything not listed
// routes `full`; the only cost is time.
const ENTRY_FILE = /\.(md|markdown)$/;
const UPLOAD_FILE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|pdf|mp4|webm|mov|mp3|m4a|wav|ogg)$/i;

// A seam `folder:` this rule accepts: one top-level underscore directory that
// is not Jekyll machinery and not `_data/`. content-pr-guard reads the seam
// with a line regex, which also matches a `folder:` inside a hint or a block
// scalar; a value like `.github` or `assets/css` must not become content.
const SEAM_FOLDER = /^_[A-Za-z0-9][A-Za-z0-9_-]*\/$/;

// A CMS data file this rule accepts, written in normal form: under `_data/`,
// no `.`/`..`/empty segments, a data extension. A file collection pointed at
// `_config.yml` is a documented Decap pattern and is NOT ordinary content.
const DATA_FILE = /^_data\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(yml|yaml|json)$/;

const REGULAR_FILE = "100644";

function seamFolders(seamYamlText) {
  return seamContentDirs(seamYamlText).filter(
    (d) => SEAM_FOLDER.test(d) && !JEKYLL_NON_CONTENT_DIRS.includes(d) && d !== "_data/",
  );
}

// The path of the site's publish gate, from `_config.yml`'s
// `cms.site_gate.path`:
//   { known: true, path: "<file>" }   the site declares a gate
//   { known: true, path: null }       the site declares none
//   { known: false }                  it cannot be told (no parser, no
//                                     config, a config that does not parse,
//                                     a path not written in normal form)
// `known: false` must never read as "no gate". The path is compared as a
// string with the changed path, so `./_data/settings.yml` or
// `_data//settings.yml` would name the gate to the site and miss it here:
// anything but the normal form is "cannot tell".
function siteGatePath(configYamlText, YAML) {
  if (!YAML || typeof configYamlText !== "string") return { known: false };
  let doc;
  try {
    doc = YAML.parse(configYamlText);
  } catch {
    return { known: false };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { known: false };
  const cms = doc.cms;
  if (cms === undefined || cms === null) return { known: true, path: null };
  if (typeof cms !== "object" || Array.isArray(cms)) return { known: false };
  const gate = cms.site_gate;
  if (gate === undefined || gate === null) return { known: true, path: null };
  if (typeof gate !== "object" || Array.isArray(gate)) return { known: false };
  if (typeof gate.path !== "string" || !DATA_FILE.test(gate.path)) return { known: false };
  return { known: true, path: gate.path };
}

// The CMS file collections whose EDIT is ordinary content: every seam `file:`
// that is a data file in normal form, except the publish gate. Empty when the
// gate cannot be told, so a caller that cannot read the config exempts
// nothing.
//
// content-pr-guard's line regex also matches a `file:` inside a hint or a
// block scalar, so each candidate must ALSO be a real
// `collections[].files[].file` of the parsed seam. The parser is always
// there when this list can be non-empty: the gate check needs it too.
function cmsDataFiles({ seamYamlText = null, configYamlText = null, YAML = null } = {}) {
  const candidates = seamContentFiles(seamYamlText).filter((f) => DATA_FILE.test(f));
  if (candidates.length === 0) return [];
  const gate = siteGatePath(configYamlText, YAML);
  if (!gate.known) return [];
  const declared = seamFileCollections(seamYamlText, YAML);
  return candidates.filter((f) => declared.has(f) && f !== gate.path);
}

// Every `collections[].files[].file` of the parsed seam, as written. Empty
// when the seam does not parse or is not that shape.
function seamFileCollections(seamYamlText, YAML) {
  const out = new Set();
  if (!YAML || typeof seamYamlText !== "string") return out;
  let doc;
  try {
    doc = YAML.parse(seamYamlText);
  } catch {
    return out;
  }
  const collections = Array.isArray(doc) ? doc : doc && Array.isArray(doc.collections) ? doc.collections : [];
  for (const c of collections) {
    for (const f of (c && Array.isArray(c.files) ? c.files : [])) {
      if (f && typeof f.file === "string") out.add(f.file);
    }
  }
  return out;
}

// A path as it may be printed in a job log: JSON-quoted, so a newline in a
// file name cannot start a line (and so cannot forge a workflow command).
function show(p) {
  return JSON.stringify(String(p));
}

// Decide the route for `git diff --raw --no-renames` records
// ({ status, path, oldMode, newMode }). Returns { route, reason }; `reason` is
// one short sentence for the job log and names at most one path.
//
// Every record must be a plain add, edit or delete of a REGULAR file: a
// symlink (120000), a submodule (160000), an executable (100755) or a type
// change (`T`) inside a content directory is not something the CMS writes,
// and a record without modes cannot be told apart from one.
function routeChange(
  records,
  { fromCms = false, seamYamlText = null, configYamlText = null, YAML = null } = {},
) {
  const full = (reason) => ({ route: "full", reason });
  if (!fromCms) return full("not a same-repository cms/ branch");
  if (!Array.isArray(records) || records.length === 0) return full("no changed files to classify");

  const entryDirs = [...BASE_CONTENT_DIRS.filter((d) => d !== UPLOADS_DIR), ...seamFolders(seamYamlText)];
  const hasUploads = BASE_CONTENT_DIRS.includes(UPLOADS_DIR);
  const seamFiles = seamContentFiles(seamYamlText);
  const dataFiles = cmsDataFiles({ seamYamlText, configYamlText, YAML });

  for (const record of records) {
    const { status, path: p, oldMode, newMode } = record || {};
    if (typeof p !== "string" || p === "") return full("a changed path could not be read");
    const plain =
      (status === "A" && newMode === REGULAR_FILE) ||
      (status === "M" && oldMode === REGULAR_FILE && newMode === REGULAR_FILE) ||
      (status === "D" && oldMode === REGULAR_FILE);
    if (!plain) return full(`not a plain add, edit or delete of a regular file: ${show(p)}`);
    if (seamFiles.includes(p)) {
      if (status !== "M") return full(`a CMS file collection was added or removed: ${show(p)}`);
      if (!dataFiles.includes(p)) {
        return full(`not an ordinary CMS data file (the publish gate, outside _data/, or cannot be told): ${show(p)}`);
      }
      continue;
    }
    if (hasUploads && p.startsWith(UPLOADS_DIR)) {
      if (!UPLOAD_FILE.test(p)) return full(`an upload that is not a plain media file: ${show(p)}`);
    } else if (entryDirs.some((d) => p.startsWith(d))) {
      if (!ENTRY_FILE.test(p)) return full(`a file in a collection folder that is not a Markdown entry: ${show(p)}`);
    } else {
      return full(`outside CMS-managed content: ${show(p)}`);
    }
    if (isSalient([p])) return full(`can shift rendered output beyond its own entry: ${show(p)}`);
  }
  return { route: "content", reason: `all ${records.length} changed path(s) are CMS-managed content` };
}

// Split `git diff --raw -z --no-renames` output into records. Each record is
// a meta field (`:<old mode> <new mode> <old sha> <new sha> <status>`) then a
// path, both NUL-terminated. Anything else, or a trailing odd field, throws:
// truncated or unexpected input is never guessed at.
function parseNulRaw(raw) {
  const fields = String(raw)
    .split("\0")
    .filter((f) => f.length > 0);
  if (fields.length % 2 !== 0) throw new Error("raw diff input has an odd number of fields");
  const records = [];
  for (let i = 0; i < fields.length; i += 2) {
    const m = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(fields[i]);
    if (!m) throw new Error("raw diff input has a record this parser does not know");
    records.push({ oldMode: m[1], newMode: m[2], status: m[3], path: fields[i + 1] });
  }
  return records;
}

module.exports = {
  SEAM_PATH,
  CONFIG_PATH,
  siteGatePath,
  cmsDataFiles,
  seamFolders,
  routeChange,
  parseNulRaw,
};

// `git show <rev>:<path>` as text, or null. argv, never a shell string.
function gitShow(rev, p) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("git", ["show", `${rev}:${p}`], { encoding: "utf8", maxBuffer: 8 << 20 });
  return r.status === 0 ? r.stdout : null;
}

// CLI: read `git diff --raw -z --no-renames --no-abbrev <base> HEAD` on stdin,
// print `content` or `full` on stdout and the reason on stderr.
//   ... | ROUTE_FROM_CMS=true node content-route.js --base-rev "$BASE_REV"
// ROUTE_FROM_CMS is "true" only for a same-repository `cms/` branch. The YAML
// parser comes from CMS_PLATFORM_YAML_PACKAGE and nowhere else
// (trusted-yaml.js). Always exits 0 and always prints a route: anything
// unreadable is `full`, because the only thing a wrong `full` costs is time.
if (require.main === module) {
  const fs = require("node:fs");
  let result;
  try {
    const args = process.argv.slice(2);
    const baseIdx = args.indexOf("--base-rev");
    const baseRev = baseIdx >= 0 ? args[baseIdx + 1] || "" : "";
    if (!baseRev) {
      result = { route: "full", reason: "no base revision given" };
    } else {
      const records = parseNulRaw(fs.readFileSync(0, "utf8"));
      result = routeChange(records, {
        fromCms: process.env.ROUTE_FROM_CMS === "true",
        seamYamlText: gitShow(baseRev, SEAM_PATH),
        configYamlText: gitShow(baseRev, CONFIG_PATH),
        YAML: loadTrustedYaml(),
      });
    }
  } catch (err) {
    result = { route: "full", reason: `the classifier failed (${err && err.name ? err.name : "error"})` };
  }
  process.stderr.write(`route=${result.route}: ${result.reason}\n`);
  process.stdout.write(result.route);
}
