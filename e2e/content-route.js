// Route decision for a consumer pull request: `content` or `full`.
//
// A post, a page, an upload or a data file saved from the CMS cannot change
// the theme, the admin shell or a workflow, so running the browser matrix and
// the site verifier's self-tests against it tests machinery the change did
// not touch. It also turns every brittle or content-sensitive test into a
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
//   * any changed path can shift rendered output beyond its own entry
//     (visual-regression-salient.js: `_tools/`, `_data/` outside a CMS file
//     collection, layouts, config, ...);
//   * a CMS file collection (`file: _data/x.yml`) is added or deleted rather
//     than edited, or is the site's publish gate (`cms.site_gate.path`, the
//     switch that takes a site live), or the gate cannot be read.
//
// The definition of "CMS-managed content" is scripts/content-pr-guard.js's
// (base collections + the site's seam), and "can shift rendered output" is
// visual-regression-salient.js's. No third list lives here. The seam and
// `_config.yml` are read from the BASE commit, so a pull request cannot widen
// its own route.
"use strict";

const {
  BASE_CONTENT_DIRS,
  seamContentDirs,
  seamContentFiles,
} = require("../scripts/content-pr-guard");
const { isSalient, parseNulStatus } = require("./visual-regression-salient");

const SEAM_PATH = "admin/collections.site.yml";
const CONFIG_PATH = "_config.yml";

// The path of the site's publish gate, from `_config.yml`'s
// `cms.site_gate.path`:
//   { known: true, path: "<file>" }   the site declares a gate
//   { known: true, path: null }       the site declares none
//   { known: false }                  it cannot be told (no parser, no
//                                     config, a config that does not parse)
// `known: false` must never read as "no gate".
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
  if (typeof gate.path !== "string" || gate.path.trim() === "") return { known: false };
  return { known: true, path: gate.path.trim() };
}

// The CMS file collections whose EDIT is ordinary content: every seam
// `file:` except the publish gate. Empty when the gate cannot be told, so a
// caller that cannot read the config exempts nothing.
function cmsDataFiles({ seamYamlText = null, configYamlText = null, YAML = null } = {}) {
  const files = seamContentFiles(seamYamlText);
  if (files.length === 0) return [];
  const gate = siteGatePath(configYamlText, YAML);
  if (!gate.known) return [];
  return files.filter((f) => f !== gate.path);
}

// A path as it may be printed in a job log: JSON-quoted, so a newline in a
// file name cannot start a line (and so cannot forge a workflow command).
function show(p) {
  return JSON.stringify(String(p));
}

// Decide the route for `git diff --name-status --no-renames` records
// ({ status, path }). Returns { route, reason }; `reason` is one short
// sentence for the job log and names at most one path.
function routeChange(
  records,
  { fromCms = false, seamYamlText = null, configYamlText = null, YAML = null } = {},
) {
  const full = (reason) => ({ route: "full", reason });
  if (!fromCms) return full("not a same-repository cms/ branch");
  if (!Array.isArray(records) || records.length === 0) return full("no changed files to classify");

  const contentDirs = [...BASE_CONTENT_DIRS, ...seamContentDirs(seamYamlText)];
  const seamFiles = seamContentFiles(seamYamlText);
  const dataFiles = cmsDataFiles({ seamYamlText, configYamlText, YAML });

  for (const { status, path: p } of records) {
    if (typeof p !== "string" || p === "") return full("a changed path could not be read");
    if (seamFiles.includes(p)) {
      if (status !== "M") return full(`a CMS file collection was added or removed: ${show(p)}`);
      if (!dataFiles.includes(p)) return full(`the site's publish gate, or a file that cannot be told apart from it: ${show(p)}`);
      continue;
    }
    if (!contentDirs.some((d) => p.startsWith(d))) return full(`outside CMS-managed content: ${show(p)}`);
    if (isSalient([p])) return full(`can shift rendered output beyond its own entry: ${show(p)}`);
  }
  return { route: "content", reason: `all ${records.length} changed path(s) are CMS-managed content` };
}

module.exports = { SEAM_PATH, CONFIG_PATH, siteGatePath, cmsDataFiles, routeChange };

function loadYaml() {
  try {
    return require("yaml");
  } catch {
    return null;
  }
}

// `git show <rev>:<path>` as text, or null. argv, never a shell string.
function gitShow(rev, p) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("git", ["show", `${rev}:${p}`], { encoding: "utf8", maxBuffer: 8 << 20 });
  return r.status === 0 ? r.stdout : null;
}

// CLI: read `git diff --name-status -z --no-renames <base> HEAD` on stdin,
// print `content` or `full` on stdout and the reason on stderr.
//   ... | ROUTE_FROM_CMS=true node content-route.js --base-rev "$BASE_REV"
// ROUTE_FROM_CMS is "true" only for a same-repository `cms/` branch. Always
// exits 0 and always prints a route: anything unreadable is `full`, because
// the only thing a wrong `full` costs is time.
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
      const records = parseNulStatus(fs.readFileSync(0, "utf8"));
      result = routeChange(records, {
        fromCms: process.env.ROUTE_FROM_CMS === "true",
        seamYamlText: gitShow(baseRev, SEAM_PATH),
        configYamlText: gitShow(baseRev, CONFIG_PATH),
        YAML: loadYaml(),
      });
    }
  } catch (err) {
    result = { route: "full", reason: `the classifier failed (${err && err.name ? err.name : "error"})` };
  }
  process.stderr.write(`route=${result.route}: ${result.reason}\n`);
  process.stdout.write(result.route);
}
