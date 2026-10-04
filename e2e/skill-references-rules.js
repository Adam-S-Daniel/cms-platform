/*
 * The rules behind e2e/skill-references-fresh.test.js (cms-platform#408):
 * extract what a skills/<name>/SKILL.md cites, and decide whether each
 * citation still exists where the skill says it does.
 *
 * Structure is parsed, never scanned: the SKILL.md body goes through
 * `markdown-it` (fences, indented code blocks, code spans and tables are
 * the tokenizer's call, not a line regex's), and the workflows and
 * CloudFormation templates go through `yaml`. Regex appears only at the
 * leaves — "is this one token shaped like a path / a secret name" — which
 * is a lexical question about a string the parser already isolated.
 *
 * Precision rule (agentskills' scripts/check_skills.py, widened by #408 to
 * code spans): only a token inside a fenced block, an indented code block or
 * a backtick span can FAIL the build. A path-shaped word in plain prose is
 * LISTED, never failed: prose mentions another repo's file, an example, or a
 * path being explained as gone far more often than it asserts "this exists".
 *
 * Every function here is pure over (text, tree) so the unit tests in the
 * spec can drive it with a fixture SKILL.md and a synthetic tree.
 */
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const MarkdownIt = require("markdown-it");
const YAML = require("yaml");

// Top-level directories of THIS repo. A slash-bearing token is a repo-path
// citation only when it is anchored at one of these: `admin/config.yml`,
// `_site/admin` and `_posts/` are consumer or build paths, and guessing at
// them is exactly the false-positive class the precision rule exists for.
const REPO_ROOTS = [
  ".claude-plugin",
  ".githooks",
  ".github",
  "docs",
  "e2e",
  "examples",
  "infrastructure",
  "oauth-proxy",
  "scaffold",
  "scripts",
  "skills",
  "theme",
];

// How a consumer or a sparse checkout spells a path into this repo. Each is
// stripped before the path is resolved against this tree.
const PLATFORM_PREFIXES = ["./", ".cms-platform/", "cms-platform/", "<cms-platform>/"];

// Characters that make a token a pattern or a placeholder rather than one
// concrete file: globs, `<n>`, `{N}`, `${VAR}`, `…`.
const PLACEHOLDER_RE = /[<>{}*$…?\[\]|]/;

// Leaf token shapes.
const PATH_CHARS_RE = /^[A-Za-z0-9._\-/]+$/;
const BARE_WORKFLOW_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;
const BARE_CODE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|sh|rb|py)$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const CONTEXT_NAME_RE = /\b(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const CFN_NAME_RE = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/;
const CFN_SUB_RE = /\$\{([A-Za-z][A-Za-z0-9]*)\}/g;

// Skills whose CloudFormation identifiers are checked against the templates.
// #408 names aws-bootstrap; other skills use `${ApexDomain}`-style
// placeholders that are deliberately NOT template parameters.
const CFN_SKILLS = new Set(["aws-bootstrap"]);

const md = new MarkdownIt();

// Split off a leading `---` frontmatter block. markdown-it has no
// frontmatter rule, so it would read the block as a setext heading; which
// line is a fence is a lexical question (as in plugin-manifests.test.js).
function splitFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return { body: text, offset: 0 };
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close === -1) return { body: text, offset: 0 };
  return { body: lines.slice(close + 1).join("\n"), offset: close + 1 };
}

// Trim the punctuation a word picks up from the code or sentence around it.
function trimWord(word) {
  return word.replace(/^[\s"'`(,;:=]+/, "").replace(/[\s"'`),;:.]+$/, "");
}

/*
 * Every code region of a SKILL.md, in document order:
 *   { kind: "span" | "fence", text, line }   (line is 1-based in the FILE)
 * plus `prose`: the plain-text words with their lines, for the listed-only
 * prose mentions.
 */
function codeRegions(text) {
  const { body, offset } = splitFrontmatter(text);
  const lines = body.split("\n");
  const regions = [];
  const prose = [];
  // A table cell's inline token carries no `map`; the enclosing row's does,
  // so fall back to the last block token that had one.
  let lastMap = [0, 1];
  const lineOf = (token, needle) => {
    const [start, end] = token.map || lastMap;
    for (let i = start; i < Math.max(end, start + 1) && i < lines.length; i++) {
      if (lines[i].includes(needle)) return i + 1 + offset;
    }
    return start + 1 + offset;
  };
  for (const token of md.parse(body, {})) {
    if (token.map) lastMap = token.map;
    if (token.type === "fence" || token.type === "code_block") {
      const first = (token.map ? token.map[0] : 0) + (token.type === "fence" ? 2 : 1);
      token.content.split("\n").forEach((line, i) => {
        if (line.trim()) regions.push({ kind: "fence", text: line, line: first + i + offset });
      });
    } else if (token.type === "inline") {
      for (const child of token.children || []) {
        if (child.type === "code_inline") {
          regions.push({ kind: "span", text: child.content, line: lineOf(token, child.content) });
        } else if (child.type === "text") {
          for (const word of child.content.split(/\s+/)) {
            const w = trimWord(word);
            if (w) prose.push({ text: w, line: lineOf(token, word) });
          }
        }
      }
    }
  }
  return { regions, prose };
}

// The repo-relative path a word cites, or null when it is not an anchored,
// concrete path into this repo.
function repoPath(word) {
  let w = trimWord(word);
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const prefix of PLATFORM_PREFIXES) {
      if (w.startsWith(prefix)) {
        w = w.slice(prefix.length);
        stripped = true;
      }
    }
  }
  if (!w.includes("/") || PLACEHOLDER_RE.test(w) || !PATH_CHARS_RE.test(w)) return null;
  const root = w.split("/")[0];
  if (!REPO_ROOTS.includes(root)) return null;
  if (w.includes("//") || w.split("/").includes("..")) return null;
  return w;
}

/*
 * The citations one SKILL.md makes, deduplicated by (kind, value):
 *   path      a concrete path anchored at a REPO_ROOTS directory
 *   workflow  a bare `<name>.yml` / `<name>.yaml`
 *   file      a bare `<name>.js|sh|rb|py` (a spec, a script)
 *   name      a secret / variable / env name: `secrets.X`, `vars.X`, or a
 *             backtick span that is exactly one UPPER_SNAKE identifier
 *   cfn       (CFN_SKILLS only) a CloudFormation parameter, resource,
 *             output or property name
 * Each carries the first line it was cited on. `prose` lists path-shaped
 * words outside any code region (reported, never failed).
 */
function extractCitations(text, { skill } = {}) {
  const { regions, prose } = codeRegions(text);
  const seen = new Map();
  const add = (kind, value, line, via) => {
    const key = `${kind}\u0000${value}`;
    if (!seen.has(key)) seen.set(key, { kind, value, line, via });
  };

  for (const region of regions) {
    const words = region.text.split(/\s+/).filter(Boolean);
    for (const word of words) {
      const p = repoPath(word);
      if (p) add("path", p, region.line, region.kind);
      const w = trimWord(word);
      if (BARE_WORKFLOW_RE.test(w)) add("workflow", w, region.line, region.kind);
      else if (BARE_CODE_FILE_RE.test(w)) add("file", w, region.line, region.kind);
    }
    for (const m of region.text.matchAll(CONTEXT_NAME_RE)) {
      add("name", `${m[1]}.${m[2]}`, region.line, region.kind);
    }
    if (region.kind === "span") {
      // `NAME` or `NAME=value`: the whole span is one identifier.
      const ident = region.text.trim().split("=")[0];
      if (ENV_NAME_RE.test(ident) && !/\s/.test(region.text.trim())) {
        add("name", ident, region.line, region.kind);
      }
      if (CFN_SKILLS.has(skill)) {
        const key = region.text.trim().split(":")[0];
        if (CFN_NAME_RE.test(key)) add("cfn", key, region.line, region.kind);
        for (const m of region.text.matchAll(CFN_SUB_RE)) {
          if (CFN_NAME_RE.test(m[1])) add("cfn", m[1], region.line, region.kind);
        }
      }
    }
  }

  const proseOnly = [];
  const cited = new Set([...seen.values()].map((c) => c.value));
  for (const word of prose) {
    const p = repoPath(word.text);
    if (p && !cited.has(p)) proseOnly.push({ kind: "path", value: p, line: word.line });
  }
  return { citations: [...seen.values()], prose: proseOnly };
}

/*
 * Resolve one citation against a tree. Returns null when it is live, or a
 * one-line reason when it is stale. The tree is:
 *   exists(rel)          a repo-relative file or directory exists
 *   basenames            Set of every file basename in the tree
 *   workflows            Set of workflow file basenames (.github/workflows +
 *                        examples/site/.github/workflows)
 *   contextNames         Set of `secrets.X` / `vars.X` a workflow reads
 *   envNames             Set of names a workflow or script reads or sets
 *   cfnNames             Set of identifiers the CloudFormation templates define
 */
function resolveCitation(c, tree) {
  switch (c.kind) {
    case "path": {
      const rel = c.value.replace(/\/$/, "");
      if (tree.exists(rel)) return null;
      // A `.github/workflows/<x>.yml` named from a consumer's point of view
      // lives here as the canonical thin caller.
      if (rel.startsWith(".github/workflows/") && tree.exists(`examples/site/${rel}`)) return null;
      return `${c.value} does not exist in this tree`;
    }
    case "workflow":
      if (tree.workflows.has(c.value)) return null;
      // A bare `.yml` that is not a workflow but a real file elsewhere
      // (config.base.yml, _config.yml, repo-settings.yml) is a file citation.
      if (tree.basenames.has(c.value)) return null;
      return `${c.value} is neither a workflow under .github/workflows/ or examples/site/.github/workflows/ nor any file in this tree`;
    case "file":
      if (tree.basenames.has(c.value)) return null;
      return `no file named ${c.value} exists anywhere in this tree`;
    case "name": {
      const m = /^(secrets|vars)\.(.+)$/.exec(c.value);
      if (m) {
        if (tree.contextNames.has(c.value)) return null;
        return `no workflow in this tree reads \${{ ${c.value} }}`;
      }
      if (tree.envNames.has(c.value) || (tree.codeNames && tree.codeNames.has(c.value))) return null;
      return (
        `no workflow or script in this tree reads ${c.value} (as secrets.${c.value}, ` +
        `vars.${c.value}, an env: key, $${c.value} / process.env.${c.value}) or uses it as a code identifier`
      );
    }
    case "cfn":
      if (tree.cfnNames.has(c.value)) return null;
      return `${c.value} is not a parameter, condition, resource, output or property in infrastructure/*/template.yaml`;
    default:
      return `unknown citation kind ${c.kind}`;
  }
}

/*
 * Check one skill. `allow` is that skill's allowlist entries. Returns
 *   { checked, failures: [{line, kind, value, reason}], allowed, prose }
 * An allowlist entry fails when its citation is live again (stale
 * allowlist), when the skill no longer cites it, or when its `marker` line
 * is gone from the SKILL.md.
 */
function checkSkill(text, tree, { skill, allow = [] } = {}) {
  const { citations, prose } = extractCitations(text, { skill });
  const failures = [];
  const allowed = [];
  const allowByValue = new Map(allow.map((a) => [a.citation, a]));
  const used = new Set();
  for (const c of citations) {
    const reason = resolveCitation(c, tree);
    const entry = allowByValue.get(c.value);
    if (entry) {
      used.add(c.value);
      if (reason === null) {
        failures.push({
          line: c.line,
          kind: c.kind,
          value: c.value,
          reason:
            `stale allowlist: ${c.value} resolves in this tree again, so its ` +
            `skills/.freshness-allow.yml entry must be removed`,
        });
      } else {
        allowed.push(c);
      }
      continue;
    }
    if (reason !== null) failures.push({ line: c.line, kind: c.kind, value: c.value, reason });
  }
  for (const entry of allow) {
    if (!used.has(entry.citation)) {
      failures.push({
        line: 0,
        kind: "allowlist",
        value: entry.citation,
        reason: `skills/.freshness-allow.yml allows ${entry.citation} for ${skill}, which no longer cites it in a code region; remove the entry`,
      });
    }
    if (entry.marker && !text.includes(entry.marker)) {
      failures.push({
        line: 0,
        kind: "allowlist",
        value: entry.citation,
        reason: `skills/.freshness-allow.yml marker for ${entry.citation} (${JSON.stringify(entry.marker)}) is not in ${skill}/SKILL.md`,
      });
    }
  }
  const unresolvedProse = prose.filter((p) => resolveCitation(p, tree) !== null);
  return { checked: citations.length, citations, failures, allowed, prose: unresolvedProse };
}

/*
 * Parse skills/.freshness-allow.yml. Every entry needs skill, citation,
 * reason and marker (the SKILL.md text that marks the citation historical or
 * consumer-side). Returns { bySkill: Map<skill, entry[]>, errors: string[] }.
 */
function parseAllowlist(text) {
  const errors = [];
  const bySkill = new Map();
  const doc = YAML.parse(text);
  const entries = doc && Array.isArray(doc.allow) ? doc.allow : null;
  if (!entries) return { bySkill, errors: ["must be a mapping with an `allow:` list"] };
  entries.forEach((e, i) => {
    for (const field of ["skill", "citation", "reason", "marker"]) {
      if (!e || typeof e[field] !== "string" || !e[field].trim()) {
        errors.push(`allow[${i}] is missing a non-empty \`${field}\``);
        return;
      }
    }
    if (!bySkill.has(e.skill)) bySkill.set(e.skill, []);
    bySkill.get(e.skill).push(e);
  });
  return { bySkill, errors };
}

// ---------------------------------------------------------------------------
// The real tree: read once from the working tree. No network, no git.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "_site",
  ".bundle",
  ".jekyll-cache",
  "test-results",
  "playwright-report",
  "worktrees",
]);

function walk(root, dir = root, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, out);
    else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join("/"));
  }
  return out;
}

// Every string leaf of a parsed YAML value, with the key path that led to it.
function* leaves(node, keys = []) {
  if (typeof node === "string") yield { keys, value: node };
  else if (Array.isArray(node)) for (const v of node) yield* leaves(v, keys);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) yield* leaves(v, [...keys, k]);
  }
}

// Every mapping key anywhere in a parsed YAML value.
function* mappingKeys(node) {
  if (Array.isArray(node)) for (const v of node) yield* mappingKeys(v);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      yield k;
      yield* mappingKeys(v);
    }
  }
}

const SHELL_VAR_RE = /\$\{?([A-Z][A-Z0-9_]*)/g;
const SCRIPT_ENV_RES = [
  /\$\{?([A-Z][A-Z0-9_]*)/g, // shell: $NAME, ${NAME}, ${NAME:-x}
  /process\.env\.([A-Z][A-Z0-9_]*)/g, // node
  /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\bENV(?:\.fetch\(\s*|\[\s*)["']([A-Z][A-Z0-9_]*)["']/g, // ruby
  /os\.environ(?:\.get\(\s*|\[\s*)["']([A-Z][A-Z0-9_]*)["']/g, // python
  /getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
];

// Names a workflow reads: secrets.X / vars.X / env.X in any expression,
// every `env:` key at any level, every declared workflow_call secret, and
// $X in a run: block. Parsed with `yaml`; the regexes run on leaf strings.
function workflowNames(parsed, into) {
  for (const { keys, value } of leaves(parsed)) {
    for (const m of value.matchAll(CONTEXT_NAME_RE)) {
      into.contextNames.add(`${m[1]}.${m[2]}`);
      into.envNames.add(m[2]);
    }
    for (const m of value.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) into.envNames.add(m[1]);
    if (keys[keys.length - 1] === "run" || keys[keys.length - 1] === "script") {
      for (const m of value.matchAll(SHELL_VAR_RE)) into.envNames.add(m[1]);
      for (const re of SCRIPT_ENV_RES) for (const m of value.matchAll(re)) into.envNames.add(m[1]);
    }
  }
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "env" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const name of Object.keys(v)) into.envNames.add(name);
      }
      if (k === "secrets" && v && typeof v === "object" && !Array.isArray(v)) {
        // on.workflow_call.secrets declarations and a caller's `secrets:` map.
        for (const name of Object.keys(v)) {
          into.envNames.add(name);
          into.contextNames.add(`secrets.${name}`);
        }
      }
      visit(v);
    }
  };
  visit(parsed);
}

const SCRIPT_EXT_RE = /\.(?:js|mjs|cjs|sh|bash|rb|py)$/;
const SCRIPT_ROOTS = ["scripts/", "infrastructure/", "scaffold/", "oauth-proxy/", "e2e/", ".githooks/", ".github/actions/", "theme/"];
// This lint's own files: a name they spell out must not vouch for itself.
const SELF_FILES = new Set(["e2e/skill-references-rules.js", "e2e/skill-references-fresh.test.js"]);

// Every Identifier in a JS AST (acorn), including non-computed member and
// property names, so `window.CMS_SITE_ORIGIN` and `const SPEC_RULES` count
// but a string literal or a comment never does.
function jsIdentifiers(src, file) {
  let ast;
  const opts = { ecmaVersion: "latest", allowHashBang: true, allowReturnOutsideFunction: true };
  try {
    ast = acorn.parse(src, { ...opts, sourceType: "script" });
  } catch {
    try {
      ast = acorn.parse(src, { ...opts, sourceType: "module" });
    } catch (err) {
      throw new Error(`${file}: acorn could not parse it (${err.message})`);
    }
  }
  const names = new Set();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node && typeof node === "object") {
      if (node.type === "Identifier") names.add(node.name);
      for (const [k, v] of Object.entries(node)) {
        if (k !== "loc" && v && typeof v === "object") stack.push(v);
      }
    }
  }
  return names;
}

// Shell, Ruby and Python get no parser here; an UPPER_SNAKE word on a line
// that is not a whole-line `#` comment is the leaf-token approximation.
function scriptWords(src) {
  const names = new Set();
  for (const line of src.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) names.add(m[0]);
  }
  return names;
}

function loadTree(root) {
  const files = walk(root);
  const fileSet = new Set(files);
  const dirSet = new Set();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  const tree = {
    exists: (rel) => fileSet.has(rel) || dirSet.has(rel),
    basenames: new Set(files.map((f) => f.split("/").pop())),
    workflows: new Set(),
    contextNames: new Set(),
    envNames: new Set(),
    codeNames: new Set(),
    cfnNames: new Set(),
  };

  const workflowFiles = files.filter(
    (f) =>
      /^(?:examples\/site\/)?\.github\/workflows\/[^/]+\.ya?ml$/.test(f) ||
      /^\.github\/actions\/[^/]+\/action\.ya?ml$/.test(f),
  );
  for (const f of workflowFiles) {
    if (f.includes("/workflows/")) tree.workflows.add(f.split("/").pop());
    workflowNames(YAML.parse(fs.readFileSync(path.join(root, f), "utf8"), { merge: true }), tree);
  }

  for (const f of files) {
    if (!SCRIPT_EXT_RE.test(f) || !SCRIPT_ROOTS.some((r) => f.startsWith(r))) continue;
    if (f.includes("/fixtures/") || SELF_FILES.has(f)) continue;
    const src = fs.readFileSync(path.join(root, f), "utf8");
    for (const re of SCRIPT_ENV_RES) for (const m of src.matchAll(re)) tree.envNames.add(m[1]);
    const words = /\.[cm]?js$/.test(f) ? jsIdentifiers(src, f) : scriptWords(src);
    for (const w of words) tree.codeNames.add(w);
  }
  // A scaffolder-written env file names the knobs deploy.sh reads.
  for (const f of files.filter((x) => /\.env$/.test(x) || /\.example\.env$/.test(x))) {
    for (const line of fs.readFileSync(path.join(root, f), "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
      if (m) tree.envNames.add(m[1]);
    }
  }

  for (const f of files.filter((x) => /^infrastructure\/[^/]+\/template\.ya?ml$/.test(x))) {
    // CloudFormation short-form tags (`!Sub`, `!Ref`, …) are not core YAML;
    // `yaml` resolves an unknown tag to its plain value and only warns, which
    // is all a key walk needs (preview-custom-error-response.test.js notes the
    // same). Only mapping KEYS are collected: parameter, condition, resource,
    // output and property names.
    const doc = YAML.parseDocument(fs.readFileSync(path.join(root, f), "utf8"), { logLevel: "silent" });
    if (doc.errors.length) throw new Error(`${f}: ${doc.errors[0].message}`);
    for (const k of mappingKeys(doc.toJS({ logLevel: "silent" }))) tree.cfnNames.add(k);
  }
  return tree;
}

module.exports = {
  CFN_SKILLS,
  REPO_ROOTS,
  checkSkill,
  codeRegions,
  extractCitations,
  loadTree,
  parseAllowlist,
  repoPath,
  resolveCitation,
};
