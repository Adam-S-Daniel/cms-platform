/*
 * Shared YAML helpers for the workflow-lint test suite.
 *
 * Backed by the `yaml` parser (eemeli) so every lint sees the workflow
 * GitHub Actions actually evaluates — anchors and aliases resolved,
 * structure real — instead of a hand-rolled indentation scanner that
 * silently mis-reads an aliased value. GitHub enabled YAML anchors in
 * workflows on 2025-09-18, so `&anchor` / `*alias` are now legal here and
 * a line-based scanner would split on the wrong boundaries. The Document
 * API additionally gives us source ranges (for byte-identical drift
 * guards and run-block line numbers) and comments (for the dependabot
 * allow-list lint) — things a structure-only parse drops.
 *
 * Every helper takes the raw YAML text, so both `readWorkflow(name)` and
 * a path read via `listWorkflows()` feed them the same way.
 */
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const WORKFLOW_DIR = path.resolve(__dirname, "..", ".github", "workflows");

function workflowPath(name) {
  return path.join(WORKFLOW_DIR, name);
}

function readWorkflow(name) {
  return fs.readFileSync(workflowPath(name), "utf8");
}

function listWorkflows() {
  return fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(WORKFLOW_DIR, f));
}

// Parse YAML text → plain JS object with anchors/aliases fully resolved.
// Use for any structural assertion (jobs, steps, on, permissions, …).
function parseYaml(text) {
  return YAML.parse(text);
}

// 1-based source line containing byte offset `off`.
function lineOf(text, off) {
  return text.slice(0, off).split("\n").length;
}

// Exact source text of a job-level `key:` sub-block — e.g. a loop job's
// `concurrency:` block: the key line plus the value and any inner comment
// between them. Used by the byte-identical drift guard that keeps the
// three prod-loop lanes from desynchronising. Located via the parser's
// node ranges (key start → value end), so it is independent of
// indentation and unaffected by anchors. "" when the job or key is
// absent.
function jobSubBlock(text, jobName, key) {
  const doc = YAML.parseDocument(text);
  const jobsPair = ((doc.contents && doc.contents.items) || []).find(
    (p) => String(p.key.value) === "jobs",
  );
  const jobsMap = jobsPair && jobsPair.value;
  if (!jobsMap || !jobsMap.items) return "";
  const jobPair = jobsMap.items.find((p) => String(p.key.value) === jobName);
  const jobMap = jobPair && jobPair.value;
  if (!jobMap || !jobMap.items) return "";
  const sub = jobMap.items.find((p) => String(p.key.value) === key);
  if (!sub || !sub.value || !sub.value.range) return "";
  return text.slice(sub.key.range[0], sub.value.range[2]).trim();
}

// Every job under `jobs:` as { name, value, comment }. `value` is the
// fully-resolved job object (from parse, so aliases are expanded);
// `comment` is the comment block immediately above the job head (the
// dependabot allow-list lint reads it). Returns [] when there are none.
function jobs(text) {
  const root = YAML.parse(text) || {};
  const jobsObj = (root && root.jobs) || {};
  const doc = YAML.parseDocument(text);
  const jobsPair = ((doc.contents && doc.contents.items) || []).find(
    (p) => String(p.key.value) === "jobs",
  );
  const commentByName = {};
  if (jobsPair && jobsPair.value && jobsPair.value.items) {
    for (const jp of jobsPair.value.items) {
      commentByName[String(jp.key.value)] = [
        jp.key.commentBefore,
        jp.value && jp.value.commentBefore,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
  return Object.keys(jobsObj).map((name) => ({
    name,
    value: jobsObj[name],
    comment: commentByName[name] || "",
  }));
}

// Every `run:` script in the workflow as { script, line }, where `line`
// is the 1-based file line of the script's first body line. Driven by
// the parser, so it finds every run regardless of scalar style (`|`,
// `>`, plain) and is unaffected by anchors.
function runScripts(text) {
  const doc = YAML.parseDocument(text);
  const out = [];
  YAML.visit(doc, {
    Pair(_, pair) {
      const v = pair.value;
      if (pair.key && pair.key.value === "run" && v && typeof v.value === "string" && v.range) {
        const isBlock = v.type === "BLOCK_LITERAL" || v.type === "BLOCK_FOLDED";
        out.push({ script: v.value, line: lineOf(text, v.range[0]) + (isBlock ? 1 : 0) });
      }
    },
  });
  return out;
}

// Every scalar string value reachable in `obj` (recursive). Content
// searches — expressions inside `if:`, JS inside `github-script`, shell
// inside `run:` — run against these instead of grepping raw file text,
// so an aliased value is still seen and a commented-out line never
// matches a token it only mentions in prose.
function allStrings(obj) {
  const out = [];
  (function walk(v) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(obj);
  return out;
}

// Event names declared by a workflow's `on:` value (string | array |
// map all normalise to a name list).
function events(onValue) {
  if (onValue == null) return [];
  if (typeof onValue === "string") return [onValue];
  if (Array.isArray(onValue)) return onValue.map(String);
  return Object.keys(onValue);
}

module.exports = {
  WORKFLOW_DIR,
  workflowPath,
  readWorkflow,
  listWorkflows,
  parseYaml,
  lineOf,
  jobSubBlock,
  jobs,
  runScripts,
  allStrings,
  events,
};
