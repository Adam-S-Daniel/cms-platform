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
 * Precision rule (adam-agentskills' scripts/check_skills.py, widened by #408 to
 * code spans): only a token inside a fenced block, an indented code block or
 * a backtick span can FAIL the build. A path-shaped word in plain prose is
 * LISTED, never failed: prose mentions another repo's file, an example, or a
 * path being explained as gone far more often than it asserts "this exists".
 *
 * Every function here is pure over (text, tree) so the unit tests in the
 * spec can drive it with a fixture SKILL.md and a synthetic tree.
 */
const { execFileSync } = require("node:child_process");
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
// Not preceded by a path or word character: `reconcile-caller-secrets.js` is
// a file name, not the `secrets` context.
const CONTEXT_NAME_RE = /(?<![\w./-])(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
// A bare UPPER_SNAKE span is a secret / variable citation (so it can FAIL)
// only where its context marks it as one: a `$X`, `${X}`, `process.env.X` or
// `X=value` span; a span that OPENS a list item, a table cell or a heading
// (a definition-style list or a name table: the name is what the line is
// about); or a heading, table header or sentence that says secret, variable,
// env, knob, credential or token. A mid-sentence mention with none of those
// (a status literal such as `IN_PROGRESS`, an error code) is LISTED, never
// failed.
const LABEL_RE = /\b(?:secrets?|variables?|vars?|env|environment|knobs?|credentials?|tokens?)\b/i;
const CFN_NAME_RE = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/;
const DOLLAR_SPAN_RE = /^\$\{?([A-Z][A-Z0-9_]*)\}?$/;
const ENV_SPAN_RE = /^process\.env\.([A-Z][A-Z0-9_]*)$/;
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
 *   { kind: "span" | "fence", text, line, ctx, opens }   (line is 1-based in the FILE;
 *   ctx is the label text around it, see LABEL_RE; opens is true for a
 *   span that opens a list item, table cell or heading)
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
  // The block an inline token sits in: "item" (the first paragraph of a list
  // item), "cell", "heading" or "para". A span that opens an item, a cell or
  // a heading is what that line defines.
  let prev = null;
  let blockKind = null;
  // What labels a span: the nearest heading above it, the header row of the
  // table it sits in, and its own block (paragraph, list item, table cell).
  let heading = "";
  let headingNext = false;
  let tableHeader = "";
  let inThead = false;
  const lineOf = (token, needle) => {
    const [start, end] = token.map || lastMap;
    for (let i = start; i < Math.max(end, start + 1) && i < lines.length; i++) {
      if (lines[i].includes(needle)) return i + 1 + offset;
    }
    return start + 1 + offset;
  };
  for (const token of md.parse(body, {})) {
    if (token.map) lastMap = token.map;
    if (token.type === "heading_open") blockKind = "heading";
    else if (token.type === "td_open" || token.type === "th_open") blockKind = "cell";
    else if (token.type === "paragraph_open") blockKind = prev && prev.type === "list_item_open" ? "item" : "para";
    prev = token;
    if (token.type === "heading_open") headingNext = true;
    else if (token.type === "table_open" || token.type === "table_close") tableHeader = "";
    else if (token.type === "thead_open") inThead = true;
    else if (token.type === "thead_close") inThead = false;
    else if (token.type === "inline") {
      if (headingNext) heading = token.content;
      headingNext = false;
      if (inThead) tableHeader += ` ${token.content}`;
    }
    const ctx = `${heading}\n${tableHeader}\n${token.content || ""}`;
    if (token.type === "fence" || token.type === "code_block") {
      const first = (token.map ? token.map[0] : 0) + (token.type === "fence" ? 2 : 1);
      token.content.split("\n").forEach((line, i) => {
        if (line.trim()) regions.push({ kind: "fence", text: line, line: first + i + offset, ctx });
      });
    } else if (token.type === "inline") {
      const children = token.children || [];
      const first = children.find((c) => !(c.type === "text" && !c.content.trim()));
      for (const child of children) {
        if (child.type === "code_inline") {
          const opens = child === first && ["item", "cell", "heading"].includes(blockKind);
          regions.push({ kind: "span", text: child.content, line: lineOf(token, child.content), ctx, opens });
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
 *             (`marked: false` when nothing around it says secret/variable)
 *   cfn       (CFN_SKILLS only) a CloudFormation parameter, resource,
 *             output or property name
 * Each carries the first line it was cited on. `prose` lists path-shaped
 * words outside any code region (reported, never failed).
 */
function extractCitations(text, { skill } = {}) {
  const { regions, prose } = codeRegions(text);
  const seen = new Map();
  const add = (kind, value, line, via, marked = true) => {
    const key = `${kind}\u0000${value}`;
    const prior = seen.get(key);
    if (!prior) seen.set(key, { kind, value, line, via, marked });
    else prior.marked = prior.marked || marked;
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
      // `NAME`, `NAME=value`, `$NAME`, `${NAME}` or `process.env.NAME`: the
      // whole span is one identifier. Only the last four syntaxes (and a
      // labeling context) say it is a secret or variable.
      const t = region.text.trim();
      if (!/\s/.test(t)) {
        const dollar = DOLLAR_SPAN_RE.exec(t) || ENV_SPAN_RE.exec(t);
        const ident = dollar ? dollar[1] : t.split("=")[0];
        if (ENV_NAME_RE.test(ident)) {
          add("name", ident, region.line, region.kind, !!dollar || t.includes("=") || region.opens || LABEL_RE.test(region.ctx));
        }
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
 *   workflows            Set of workflow file basenames, for a BARE `<x>.yml`
 *                        (.github/workflows + examples/site/.github/workflows;
 *                        a prefixed path goes through exists() instead)
 *   contextNames         Set of `secrets.X` / `vars.X` a workflow reads
 *   envNames             Set of names a workflow or script reads or sets
 *   cfnNames             Set of identifiers the CloudFormation templates define
 */
function resolveCitation(c, tree) {
  switch (c.kind) {
    case "path": {
      const rel = c.value.replace(/\/$/, "");
      // A `.github/workflows/<x>` path names the PLATFORM file: the example
      // caller of the same name must not vouch for it (a rename or deletion
      // of the reusable would otherwise leave the lint green). Only a bare
      // `<x>.yml` (kind "workflow") may be satisfied by either directory.
      if (tree.exists(rel)) return null;
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
  const listedNames = [];
  for (const c of citations) {
    const reason = resolveCitation(c, tree);
    // A bare UPPER_SNAKE name nothing marks as a secret or variable is listed,
    // never failed (see LABEL_RE).
    const listedOnly = c.kind === "name" && !c.marked && reason !== null;
    if (listedOnly) listedNames.push({ kind: c.kind, value: c.value, line: c.line });
    const entry = allowByValue.get(c.value);
    if (entry) {
      used.add(c.value);
      if (listedOnly) {
        failures.push({
          line: c.line,
          kind: c.kind,
          value: c.value,
          stale: true,
          reason:
            `unneeded allowlist: ${c.value} is not cited as a secret or variable in ${skill}/SKILL.md ` +
            `(a bare UPPER_SNAKE name outside a secret/variable context is listed only), so its ` +
            `skills/.freshness-allow.yml entry must be removed`,
        });
      } else if (reason === null) {
        failures.push({
          line: c.line,
          kind: c.kind,
          value: c.value,
          stale: true,
          reason:
            `stale allowlist: ${c.value} resolves in this tree again, so its ` +
            `skills/.freshness-allow.yml entry must be removed`,
        });
      } else {
        allowed.push(c);
      }
      continue;
    }
    if (reason !== null && !listedOnly) failures.push({ line: c.line, kind: c.kind, value: c.value, reason });
  }
  for (const entry of allow) {
    if (!used.has(entry.citation)) {
      failures.push({
        line: 0,
        kind: "allowlist",
        value: entry.citation,
        stale: true,
        reason: `skills/.freshness-allow.yml allows ${entry.citation} for ${skill}, which no longer cites it in a code region; remove the entry`,
      });
    }
    if (entry.marker && !text.includes(entry.marker)) {
      failures.push({
        line: 0,
        kind: "allowlist",
        value: entry.citation,
        stale: true,
        reason: `skills/.freshness-allow.yml marker for ${entry.citation} (${JSON.stringify(entry.marker)}) is not in ${skill}/SKILL.md`,
      });
    }
  }
  const unresolvedProse = [...prose.filter((p) => resolveCitation(p, tree) !== null), ...listedNames];
  return { checked: citations.length, citations, failures, allowed, prose: unresolvedProse };
}

/*
 * A ready-to-paste `allow:` stanza for one failure, with the two fields only a
 * human can write left as placeholders. null for a failure an allowlist
 * cannot answer: a stale entry is fixed by removing it.
 */
function allowlistStanza(skill, failure) {
  if (failure.kind === "allowlist" || failure.stale) return null;
  return YAML.stringify(
    [
      {
        skill,
        citation: failure.value,
        reason: "<why it is deliberately absent from this tree: removed, consumer-side, an external literal>",
        marker: "<exact SKILL.md text that marks the citation historical or consumer-side>",
      },
    ],
    { lineWidth: 0 },
  ).trimEnd();
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
// The real tree: the tracked files of the checkout, read once. No network.
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
// Env access written as a call or an index in Ruby, Python and C-family code.
const ENV_ACCESS_RES = [
  /\bENV(?:\.fetch\(\s*|\[\s*)["']([A-Z][A-Z0-9_]*)["']/g, // ruby
  /os\.environ(?:\.get\(\s*|\[\s*)["']([A-Z][A-Z0-9_]*)["']/g, // python
  /getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
];
// `${{ ... }}`: the only place a workflow string is an expression.
const EXPRESSION_RE = /\$\{\{([\s\S]*?)\}\}/g;
const EXPR_ENV_RE = /\benv\.([A-Za-z_][A-Za-z0-9_]*)/g;
// Bracket syntax: secrets['X'], vars["X"], env['X'].
const EXPR_BRACKET_RE = /(?<![\w./-])(secrets|vars|env)\[\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*\]/g;

// Remove `#` comments from shell, Ruby or Python source: whole-line and
// trailing ones (a `#` that starts a word outside a quoted string on its
// line), plus Ruby's `=begin` ... `=end` blocks. Quote state is tracked per
// line, so a `#` inside a quoted string is kept; a string that spans lines is
// only approximated, and a docstring or heredoc body is still source text.
function stripHashComments(src, { ruby = false } = {}) {
  const kept = [];
  let inBlock = false;
  for (const line of src.split("\n")) {
    if (ruby) {
      if (inBlock) {
        if (/^=end\b/.test(line)) inBlock = false;
        continue;
      }
      if (/^=begin\b/.test(line)) {
        inBlock = true;
        continue;
      }
    }
    let quote = null;
    let end = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = null;
      } else if (ch === "\\") {
        i++;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        end = i;
        break;
      }
    }
    kept.push(line.slice(0, end));
  }
  return kept.join("\n");
}

// Names a shell, Ruby or Python source reads, comments excluded: `$X`,
// `${X}`, `ENV["X"]`, `os.environ["X"]`, `getenv("X")`.
function scriptReads(src, { ruby = false } = {}) {
  const clean = stripHashComments(src, { ruby });
  const names = new Set();
  for (const re of [SHELL_VAR_RE, ...ENV_ACCESS_RES]) for (const m of clean.matchAll(re)) names.add(m[1]);
  return { clean, names };
}

// Names a workflow reads: secrets.X / vars.X / env.X inside `${{ }}` (or an
// `if:` value, which is an expression without them), every `env:` key at any
// level, every declared workflow_call secret, `$X` in a run: block and
// process.env.X in a github-script `script:`. Parsed with `yaml`; prose such
// as `name:` and `description:`, and comments, never count.
function workflowNames(parsed, into) {
  const addContext = (expr) => {
    for (const m of expr.matchAll(CONTEXT_NAME_RE)) {
      into.contextNames.add(`${m[1]}.${m[2]}`);
      into.envNames.add(m[2]);
    }
    for (const m of expr.matchAll(EXPR_ENV_RE)) into.envNames.add(m[1]);
    for (const m of expr.matchAll(EXPR_BRACKET_RE)) {
      if (m[1] === "env") {
        into.envNames.add(m[3]);
      } else {
        into.contextNames.add(`${m[1]}.${m[3]}`);
        into.envNames.add(m[3]);
      }
    }
  };
  for (const { keys, value } of leaves(parsed)) {
    const key = keys[keys.length - 1];
    if (key === "if") addContext(value);
    for (const m of value.matchAll(EXPRESSION_RE)) addContext(m[1]);
    if (key === "run") {
      for (const n of scriptReads(value).names) into.envNames.add(n);
    } else if (key === "script") {
      let ids = null;
      try {
        // actions/github-script bodies run inside an async function.
        // A `${{ }}` is expanded by Actions before the script runs, so it is
        // not JS yet: swap each for a neutral expression to parse the rest.
        const js = value.replace(EXPRESSION_RE, "0");
        ids = jsAnalyze(`(async function () {\n${js}\n})`, "script:");
      } catch {
        for (const n of scriptReads(value).names) into.envNames.add(n);
      }
      if (ids) for (const n of ids.envNames) into.envNames.add(n);
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

const isProcessEnv = (n) =>
  n &&
  n.type === "MemberExpression" &&
  n.object.type === "Identifier" &&
  n.object.name === "process" &&
  ((!n.computed && n.property.type === "Identifier" && n.property.name === "env") ||
    (n.computed && n.property.type === "Literal" && n.property.value === "env"));

// What a JS source says, from its acorn AST, so a comment or a string literal
// never counts:
//   identifiers  every Identifier, including non-computed member and property
//                names (`window.CMS_SITE_ORIGIN`, `const SPEC_RULES`)
//   envNames     `process.env.X`, `process.env["X"]` and `const { X } = process.env`
function jsAnalyze(src, file) {
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
  const identifiers = new Set();
  const envNames = new Set();
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node && typeof node === "object") {
      if (node.type === "Identifier") identifiers.add(node.name);
      if (node.type === "MemberExpression" && isProcessEnv(node.object)) {
        if (!node.computed && node.property.type === "Identifier") envNames.add(node.property.name);
        else if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
          envNames.add(node.property.value);
        }
      }
      if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && isProcessEnv(node.init)) {
        for (const prop of node.id.properties) {
          if (prop.type !== "Property") continue;
          if (!prop.computed && prop.key.type === "Identifier") envNames.add(prop.key.name);
          else if (prop.key.type === "Literal" && typeof prop.key.value === "string") envNames.add(prop.key.value);
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (k !== "loc" && v && typeof v === "object") stack.push(v);
      }
    }
  }
  return { identifiers, envNames };
}

// Shell, Ruby and Python get no parser here; an UPPER_SNAKE word in what is
// left after the comments are stripped is the leaf-token approximation (a
// docstring or string literal still counts as source text).
function scriptWords(clean) {
  const names = new Set();
  for (const m of clean.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) names.add(m[0]);
  return names;
}

// The tracked files of a git checkout rooted exactly at `root`, or null when
// `root` is not one (a synthetic tree in a temp directory). `git ls-files`, so
// an untracked or gitignored local file (infrastructure/site-params.env, which
// a skill tells people to create) never counts: the lint then reads the same
// tree locally and in CI. Argument arrays only, no shell string.
function trackedFiles(root) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    if (git("rev-parse", "--show-prefix").trim() !== "") return null;
    return git("ls-files", "-z")
      .split("\0")
      .filter(Boolean)
      .filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg)))
      .filter((f) => {
        try {
          return fs.statSync(path.join(root, f)).isFile();
        } catch {
          return false; // tracked but deleted in the working tree
        }
      });
  } catch {
    return null;
  }
}

function loadTree(root) {
  const files = trackedFiles(root) || walk(root);
  const fileSet = new Set(files);
  const dirSet = new Set();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  const tree = {
    exists: (rel) => fileSet.has(rel) || dirSet.has(rel),
    basenames: new Set(files.map((f) => f.split("/").pop())),
    // Basenames over BOTH workflow directories, for a bare `<x>.yml`; a
    // `.github/workflows/<x>` path is resolved through exists() instead.
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
    if (/\.[cm]?js$/.test(f)) {
      const { identifiers, envNames } = jsAnalyze(src, f);
      for (const n of envNames) tree.envNames.add(n);
      for (const n of identifiers) tree.codeNames.add(n);
    } else {
      const { clean, names } = scriptReads(src, { ruby: f.endsWith(".rb") });
      for (const n of names) tree.envNames.add(n);
      for (const n of scriptWords(clean)) tree.codeNames.add(n);
    }
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
  allowlistStanza,
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
