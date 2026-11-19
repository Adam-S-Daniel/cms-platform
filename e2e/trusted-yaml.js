// The YAML parser, loaded from the ONE directory the job installed it into,
// or null.
//
// The classifiers that decide whether tests and reviews may be skipped
// (content-route.js, visual-regression-salient.js) run from the platform
// checkout at `<workspace>/.cms-platform`, and the workspace is the pull
// request's own tree. A bare `require("yaml")` walks UP the directory tree
// before it looks anywhere else, so it would load
// `<workspace>/node_modules/yaml` if the pull request commits one: code the
// pull request chose, running inside the classifier that judges it, free to
// print `content` or `false` and exit. `NODE_PATH` does not help; it is
// consulted last.
//
// So the parser is never resolved by name. The job installs it outside the
// workspace and names the package directory in CMS_PLATFORM_YAML_PACKAGE; this
// loads exactly that absolute path, and refuses one that is relative, inside
// the workspace, or not a YAML parser. Null means "no parser", which every
// caller treats as "cannot tell", never as an answer.
"use strict";

const path = require("node:path");

const YAML_PACKAGE_ENV = "CMS_PLATFORM_YAML_PACKAGE";

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function loadTrustedYaml(env = process.env) {
  const dir = env[YAML_PACKAGE_ENV];
  if (typeof dir !== "string" || dir === "" || !path.isAbsolute(dir)) return null;
  const resolved = path.resolve(dir);
  const workspace = env.GITHUB_WORKSPACE;
  if (typeof workspace === "string" && workspace !== "" && isInside(resolved, path.resolve(workspace))) {
    return null;
  }
  try {
    const mod = require(resolved);
    return mod && typeof mod.parse === "function" ? mod : null;
  } catch {
    return null;
  }
}

module.exports = { YAML_PACKAGE_ENV, loadTrustedYaml };
