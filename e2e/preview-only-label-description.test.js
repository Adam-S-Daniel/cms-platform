// @lane: local — PURE-FS lint: parses every platform workflow's github-script createLabel calls (yaml + acorn)
/*
 * #532: the `cms/preview-only` label promised that its content would be
 * "dropped" from the parent branch when that branch merged to main. Nothing
 * does that. A preview-only PR merges into the feature branch it was opened
 * against (auto-merge-when-ready's preview-only path, cms-automerge-nudge.yml),
 * so the edit becomes part of that branch and reaches main, and production,
 * when the branch merges — unless someone removes it by hand first. The label
 * now says so.
 *
 * The old wording was also never shown to anyone. GitHub rejects a label
 * description over 100 characters with a 422, the call sits in a
 * `try { … } catch (_) {}`, and the label was then created implicitly by
 * addLabels with no description and the default grey. Both consumers'
 * `cms/preview-only` labels carry exactly that (description null, color
 * ededed, read 2026-10-03), while `cms/draft` and `cms/ready`, created by the
 * same step with short descriptions, carry theirs. So every createLabel
 * description in the platform's workflows is held to GitHub's limit here.
 *
 * Structure is read with parsers, never regex (AGENTS.md): the workflow with
 * the `yaml` package via workflow-yaml-utils.js, each github-script body with
 * acorn, and only the object literal actually passed to `createLabel` is
 * inspected.
 *
 * The lint is fail-closed: a shape it cannot evaluate is a failure, never a
 * silent pass. That covers an unparseable script body, a description or name
 * that is not a static string (a template literal with an expression
 * included; a `const` bound once to a static string is resolved),
 * `createLabel(opts)` with anything but an object literal, a
 * spread or computed key in that literal, a computed callee
 * (`issues["createLabel"](…)`), and `createLabel` reached any other way (an
 * alias or destructuring). The last is caught by counting acorn's
 * `createLabel` tokens: every one must be the property of an evaluated call.
 * A name imported from a platform script (`const { X } = require(path.join(
 * process.env.GITHUB_WORKSPACE, '.cms-platform', 'scripts', '<file>'))`) is
 * resolved by parsing that script for `const X = "<static>"` in its
 * module.exports; any other binding, or one bound more than once, fails.
 *
 * Other ways to create a label also fail closed (review of #558, round 2):
 * in a github-script body, `<anything>.request(route, …)` with a route that
 * is not a static string, or a `POST …/labels` route that is not the
 * expected cms/preview-only creation; `eval` or `Function` anywhere; and in
 * every workflow `run:` step, `gh label create` or `gh api …/labels` that
 * names cms/preview-only or takes the name from a variable (a lexical shell
 * token check: shell has no parser here).
 *
 * Scope: `.github/workflows/*.yml` (github-script bodies and `run:` steps).
 * Repo scripts that create OTHER labels (scripts/gate-approval-issue.js's
 * CI-health label, the audits) are out of scope; the last test enforces that
 * claim by failing if any file under scripts/ that creates a label also
 * names cms/preview-only (and any non-JS file there that names it at all).
 */
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");
const { listWorkflows, githubScriptBlocks, runScripts } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");

// https://docs.github.com/en/rest/issues/labels#create-a-label
const GITHUB_LABEL_DESCRIPTION_MAX = 100;
const PREVIEW_ONLY = "cms/preview-only";
const METHOD = "createLabel";
const PREVIEW_ONLY_DESCRIPTION =
  "CMS edit on a feature-branch preview; reaches main when that branch merges, unless removed by hand";
// A REST route that creates a label: POST /repos/{owner}/{repo}/labels.
const LABEL_CREATE_ROUTE = /^\s*POST\s+\S*\/labels\/?\s*$/i;

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "script",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  locations: true,
};

// The string a node always evaluates to, or undefined when it is not fixed:
// a string literal, a template literal with no expressions, or a `+` of
// those. Anything else (an identifier, a `${…}`, a call) is undefined.
function staticString(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join("");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = staticString(node.left);
    const r = staticString(node.right);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  return undefined;
}

// Every name a pattern binds (`a`, `{ a, b: c }`, `[d, ...e]`, `f = 1`).
function patternNames(node, out = []) {
  if (!node) return out;
  if (node.type === "Identifier") out.push(node.name);
  else if (node.type === "ObjectPattern") {
    for (const p of node.properties) patternNames(p.type === "RestElement" ? p.argument : p.value, out);
  } else if (node.type === "ArrayPattern") node.elements.forEach((e) => patternNames(e, out));
  else if (node.type === "AssignmentPattern") patternNames(node.left, out);
  else if (node.type === "RestElement") patternNames(node.argument, out);
  return out;
}

// name → every place the script binds it: { declarator, kind } for a
// variable, { other: true } for a parameter, function, class or catch.
function bindings(ast) {
  const seen = new Map();
  const add = (name, entry) => seen.set(name, [...(seen.get(name) || []), entry]);
  walk.full(ast, (node) => {
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) for (const n of patternNames(d.id)) add(n, { declarator: d, kind: node.kind });
    } else if (/Function/.test(node.type)) {
      for (const param of node.params) for (const n of patternNames(param)) add(n, { other: true });
      if (node.id) add(node.id.name, { other: true });
    } else if (node.type === "CatchClause" && node.param) {
      for (const n of patternNames(node.param)) add(n, { other: true });
    } else if (/^Class/.test(node.type) && node.id) {
      add(node.id.name, { other: true });
    }
  });
  return seen;
}

// The repo file a github-script `require(...)` loads from the platform
// checkout: `path.join(process.env.GITHUB_WORKSPACE, '.cms-platform', …static)`.
function platformRequirePath(init) {
  if (!init || init.type !== "CallExpression" || init.callee.type !== "Identifier" || init.callee.name !== "require") return null;
  const [arg] = init.arguments;
  if (!arg || arg.type !== "CallExpression" || init.arguments.length !== 1) return null;
  const c = arg.callee;
  if (c.type !== "MemberExpression" || c.computed || c.object.name !== "path" || c.property.name !== "join") return null;
  const [ws, root, ...rest] = arg.arguments;
  const isWorkspace =
    ws && ws.type === "MemberExpression" && !ws.computed && ws.property.name === "GITHUB_WORKSPACE" &&
    ws.object.type === "MemberExpression" && !ws.object.computed &&
    ws.object.object.name === "process" && ws.object.property.name === "env";
  if (!isWorkspace || staticString(root) !== ".cms-platform") return null;
  const parts = rest.map(staticString);
  if (!parts.length || parts.some((x) => x === undefined)) return null;
  return path.join(REPO_ROOT, ...parts);
}

// `const KEY = "<static>"` at the top of a CommonJS module, when KEY is
// also in its `module.exports = { … }`; else undefined.
function moduleExportString(file, key) {
  if (!fs.existsSync(file)) return undefined;
  const ast = acorn.parse(fs.readFileSync(file, "utf8"), PARSE_OPTIONS);
  let value;
  let exported = false;
  for (const stmt of ast.body) {
    if (stmt.type === "VariableDeclaration" && stmt.kind === "const") {
      for (const d of stmt.declarations) if (d.id.type === "Identifier" && d.id.name === key) value = staticString(d.init);
    }
    const e = stmt.type === "ExpressionStatement" && stmt.expression;
    if (
      e && e.type === "AssignmentExpression" && e.left.type === "MemberExpression" &&
      e.left.object.name === "module" && e.left.property.name === "exports" && e.right.type === "ObjectExpression"
    ) {
      exported = e.right.properties.some(
        (p) => p.type === "Property" && !p.computed && p.key.name === key && p.value.type === "Identifier" && p.value.name === key,
      );
    }
  }
  return exported ? value : undefined;
}

// Evaluates a name or description node to a string, or undefined. An
// identifier resolves only when the script binds it exactly once, by
// `const`, to a static string or to a platform script's exported constant.
function resolver(ast) {
  const bound = bindings(ast);
  return function value(node) {
    if (!node || node.type !== "Identifier") return staticString(node);
    const entries = bound.get(node.name) || [];
    if (entries.length !== 1 || entries[0].other || entries[0].kind !== "const") return undefined;
    const d = entries[0].declarator;
    if (d.id.type === "Identifier") return staticString(d.init);
    if (d.id.type !== "ObjectPattern") return undefined;
    const prop = d.id.properties.find(
      (p) => p.type === "Property" && !p.computed && p.value.type === "Identifier" && p.value.name === node.name,
    );
    const file = platformRequirePath(d.init);
    if (!prop || !file) return undefined;
    return moduleExportString(file, prop.key.name);
  };
}

// The `{ name, description }` object a label is created with, evaluated, or
// a problem string.
function labelFields(arg, value, what) {
  if (!arg || arg.type !== "ObjectExpression") return `${what} must be called with one object literal`;
  const fields = {};
  for (const p of arg.properties) {
    if (p.type !== "Property" || p.computed) return `${what} argument has a spread or computed key`;
    fields[p.key.type === "Identifier" ? p.key.name : String(p.key.value)] = p.value;
  }
  const name = value(fields.name);
  const description = value(fields.description);
  if (name === undefined) return `${what} name must be a static string`;
  if (description === undefined) return `${what} description must be a static string`;
  return { name, description };
}

// Every label creation in one github-script body, as
// { calls: [{ where, name, description }], problems: [string] }. A call is
// only reported when every part this lint checks was evaluated; anything
// else is a problem.
function analyzeScript(src, where) {
  const calls = [];
  const problems = [];
  let ast;
  try {
    ast = acorn.parse(src, PARSE_OPTIONS);
  } catch (e) {
    return { calls, problems: [`${where}: cannot parse github-script body: ${e.message}`] };
  }
  const value = resolver(ast);
  const evaluated = { [METHOD]: 0, request: 0 };
  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee;
      if (callee.type !== "MemberExpression") return;
      const at = `${where}+${node.loc.start.line}`;
      if (callee.computed) {
        const key = staticString(callee.property);
        if (key === undefined) problems.push(`${at}: computed callee this lint cannot resolve`);
        else if (key === METHOD || key === "request") problems.push(`${at}: computed ${key} callee; call it as .${key}(…)`);
        return;
      }
      if (callee.property.name === "request") {
        evaluated.request++;
        const route = staticString(node.arguments[0]);
        if (route === undefined) {
          problems.push(`${at}: request() route must be a string literal`);
          return;
        }
        if (!LABEL_CREATE_ROUTE.test(route)) return;
        const got = labelFields(node.arguments[1], value, "request(POST …/labels)");
        if (typeof got === "string") problems.push(`${at}: ${got}`);
        else if (got.name !== PREVIEW_ONLY || got.description !== PREVIEW_ONLY_DESCRIPTION) {
          problems.push(`${at}: request(POST …/labels) creates a label other than the expected ${PREVIEW_ONLY}; use ${METHOD}`);
        } else calls.push({ where: at, ...got });
        return;
      }
      if (callee.property.name !== METHOD) return;
      evaluated[METHOD]++;
      if (node.arguments.length !== 1) {
        problems.push(`${at}: ${METHOD} must be called with one object literal`);
        return;
      }
      const got = labelFields(node.arguments[0], value, METHOD);
      if (typeof got === "string") problems.push(`${at}: ${got}`);
      else calls.push({ where: at, ...got });
    },
  });
  // Lexical: acorn's own tokens, so comments never count. Each `createLabel`
  // or `request` name or string token must be the property of a call
  // evaluated above, and `eval` / `Function` may not appear at all.
  const tokens = { [METHOD]: 0, request: 0 };
  for (const tok of acorn.tokenizer(src, PARSE_OPTIONS)) {
    if (!["name", "string", "template"].includes(tok.type.label)) continue;
    if (tok.value in tokens) tokens[tok.value]++;
    if (tok.type.label === "name" && (tok.value === "eval" || tok.value === "Function")) {
      problems.push(`${where}+${tok.loc.start.line}: ${tok.value} is not allowed in a github-script body`);
    }
  }
  for (const k of Object.keys(tokens)) {
    if (tokens[k] !== evaluated[k]) {
      problems.push(
        `${where}: ${tokens[k]} ${k} token(s) but ${evaluated[k]} evaluated call(s); ` +
          `${k} is reached in a shape this lint cannot evaluate (alias, destructuring, computed key)`,
      );
    }
  }
  return { calls, problems };
}

// Lexical shell check for one `run:` script: a `gh label create` or a
// `gh api …/labels` command that names cms/preview-only or takes its name
// from a variable. Backslash-newline continuations are joined first.
function analyzeRun(script, where) {
  const problems = [];
  const lines = script.replace(/\\\r?\n/g, " ").split(/\r?\n|;|&&|\|\|/);
  lines.forEach((line, i) => {
    const words = line.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ""));
    for (let j = 0; j + 1 < words.length; j++) {
      if (words[j] !== "gh") continue;
      const at = `${where} command ${i + 1}`;
      if (words[j + 1] === "label" && words[j + 2] === "create") {
        const name = words[j + 3] || "";
        if (name === PREVIEW_ONLY || name.includes("$") || line.includes(PREVIEW_ONLY)) {
          problems.push(`${at}: gh label create names ${PREVIEW_ONLY} or a variable`);
        }
      } else if (words[j + 1] === "api" && words.slice(j + 2).some((w) => /\/labels\/?$/.test(w))) {
        const names = words.slice(j + 2).filter((w) => /^name=/.test(w)).map((w) => w.slice(5));
        if (line.includes(PREVIEW_ONLY) || names.some((n) => n.includes("$"))) {
          problems.push(`${at}: gh api …/labels names ${PREVIEW_ONLY} or a variable`);
        }
      }
    }
  });
  return problems;
}

// Every description over GitHub's limit, as problem strings.
function lengthProblems(calls) {
  return calls
    .filter((c) => c.description.length > GITHUB_LABEL_DESCRIPTION_MAX)
    .map(
      (c) =>
        `${c.where} ${c.name}: GitHub rejects a description over ${GITHUB_LABEL_DESCRIPTION_MAX} characters ` +
        `(${c.description.length})`,
    );
}

// Every createLabel call in every github-script step of every platform
// workflow.
function createLabelCalls() {
  const calls = [];
  const problems = [];
  for (const file of listWorkflows()) {
    const text = fs.readFileSync(file, "utf8");
    for (const block of githubScriptBlocks(text)) {
      const got = analyzeScript(block.script, `${path.basename(file)}:${block.line}`);
      calls.push(...got.calls);
      problems.push(...got.problems);
    }
    for (const run of runScripts(text)) problems.push(...analyzeRun(run.script, `${path.basename(file)}:${run.line}`));
  }
  return { calls, problems };
}

test.describe("createLabel descriptions (#532)", () => {
  test("every label description a workflow creates fits GitHub's 100-character limit", () => {
    const { calls, problems } = createLabelCalls();
    expect(problems, "shapes this lint cannot evaluate").toEqual([]);
    expect(calls.length, "found no createLabel calls; the parse is broken").toBeGreaterThan(3);
    expect(lengthProblems(calls)).toEqual([]);
  });

  test("the limit is GitHub's 100: a 100-character description passes, 101 fails", () => {
    const at = (n) => [{ where: "t", name: "cms/x", description: "x".repeat(n) }];
    expect(lengthProblems(at(100))).toEqual([]);
    expect(lengthProblems(at(101))).toHaveLength(1);
  });

  test("cms/preview-only says the edit reaches main with its branch, and promises no automatic drop", () => {
    const calls = createLabelCalls().calls.filter((c) => c.name === PREVIEW_ONLY);
    expect(calls.map((c) => c.where.split(":")[0])).toEqual(["cms-editorial-workflow.yml"]);
    const [{ description }] = calls;
    expect(description).toBe(PREVIEW_ONLY_DESCRIPTION);
    expect(description).not.toMatch(/\b(drop|dropped|excluded|discarded)\b/i);
  });
});

// The override label's name is imported from scripts/content-pr-guard.js;
// the lint resolves it from that module rather than trusting the identifier.
test("a label name imported from a platform script is resolved from that script", () => {
  const names = createLabelCalls().calls.map((c) => c.name);
  expect(names).toContain("content-guard/override");
});

// Review of #558, S3: each shape the lint cannot evaluate must fail it.
const IMPORT =
  "const { OVERRIDE_LABEL } = require(path.join(process.env.GITHUB_WORKSPACE, '.cms-platform', 'scripts', 'content-pr-guard.js'));";

test.describe("createLabel lint is fail-closed", () => {
  test("an imported constant resolves to the platform script's value", () => {
    const got = analyzeScript(
      `${IMPORT}\nawait github.rest.issues.createLabel({ name: OVERRIDE_LABEL, description: 'd' });`,
      "t",
    );
    expect(got.problems).toEqual([]);
    expect(got.calls.map((c) => c.name)).toEqual(["content-guard/override"]);
  });

  test("request() creating cms/preview-only with the expected description counts as its creation", () => {
    const got = analyzeScript(
      `await github.request('POST /repos/{owner}/{repo}/labels', { name: 'cms/preview-only', description: '${PREVIEW_ONLY_DESCRIPTION}' });\n` +
        "await github.request('GET /repos/{owner}/{repo}/labels');",
      "t",
    );
    expect(got.problems).toEqual([]);
    expect(got.calls.map((c) => c.name)).toEqual([PREVIEW_ONLY]);
  });

  const ok = `await github.rest.issues.createLabel({ owner: o, repo: r, name: 'cms/x', color: 'ededed', description: 'Fine' });`;

  test("an evaluable call is reported with its static name and description", () => {
    const tpl = "await github.rest.issues.createLabel({ name: `cms/y`, description: 'a' + `b` });";
    const bound = "const LABEL = 'cms/z'; await github.rest.issues.createLabel({ name: LABEL, description: 'c' });";
    const got = analyzeScript(`// createLabel in a comment does not count\n${ok}\n${tpl}\n${bound}`, "t");
    expect(got.problems).toEqual([]);
    expect(got.calls.map((c) => [c.name, c.description])).toEqual([
      ["cms/x", "Fine"],
      ["cms/y", "ab"],
      ["cms/z", "c"],
    ]);
    const shadowed = analyzeScript(
      "const L = 'cms/x'; function f() { const L = 'cms/y'; } await github.rest.issues.createLabel({ name: L, description: 'd' });",
      "t",
    );
    expect(shadowed.problems.join("\n"), "a const declared twice is not resolved").toMatch(/name must be a static string/);
  });

  const SHAPES = [
    ["a template literal with an expression", "await github.rest.issues.createLabel({ name: 'cms/x', description: `CMS ${what}` });", /description must be a static string/],
    ["a variable argument", "const opts = { name: 'cms/x', description: 'd' }; await github.rest.issues.createLabel(opts);", /must be called with one object literal/],
    ["a computed callee", "await github.rest.issues['createLabel']({ name: 'cms/x', description: 'd' });", /computed createLabel callee/],
    ["a computed callee built from parts", "await github.rest.issues['create' + 'Label']({ name: 'cms/x', description: 'd' });", /computed createLabel callee/],
    ["an unresolvable computed callee", "await github.rest.issues[method]({ name: 'cms/x', description: 'd' });", /computed callee this lint cannot resolve/],
    ["a spread into the argument", "await github.rest.issues.createLabel({ ...base, name: 'cms/x', description: 'd' });", /spread or computed key/],
    ["a name that is not static", "await github.rest.issues.createLabel({ name: `cms/${kind}`, description: 'd' });", /name must be a static string/],
    ["a name read off an object", "await github.rest.issues.createLabel({ name: cfg.label, description: 'd' });", /name must be a static string/],
    ["no description", "await github.rest.issues.createLabel({ name: 'cms/x' });", /description must be a static string/],
    ["a destructured alias", "const { createLabel } = github.rest.issues; await createLabel({ name: 'cms/x', description: 'd' });", /shape this lint cannot evaluate/],
    ["an unparseable body", "await github.rest.issues.createLabel({ name: 'cms/x', ", /cannot parse/],
    ["a name bound with let", "let L = 'cms/x'; await github.rest.issues.createLabel({ name: L, description: 'd' });", /name must be a static string/],
    // The allowlist this replaced was keyed on the identifier alone.
    ["a local OVERRIDE_LABEL shadowing nothing", "let OVERRIDE_LABEL = 'cms/preview-only'; await github.rest.issues.createLabel({ name: OVERRIDE_LABEL, description: 'd' });", /name must be a static string/],
    [
      "an imported name also bound as a parameter",
      `${IMPORT}\nfunction f(OVERRIDE_LABEL) {}\nawait github.rest.issues.createLabel({ name: OVERRIDE_LABEL, description: 'd' });`,
      /name must be a static string/,
    ],
    [
      "a name imported from some other module",
      `${IMPORT.replace("content-pr-guard.js", "no-such-module.js")}\nawait github.rest.issues.createLabel({ name: OVERRIDE_LABEL, description: 'd' });`,
      /name must be a static string/,
    ],
    [
      "a name required from the consumer's own checkout, not the platform's",
      `${IMPORT.replace("'.cms-platform', ", "'site', ")}\nawait github.rest.issues.createLabel({ name: OVERRIDE_LABEL, description: 'd' });`,
      /name must be a static string/,
    ],
    [
      "a name required from outside the platform checkout",
      "const { OVERRIDE_LABEL } = require('./content-pr-guard.js');\nawait github.rest.issues.createLabel({ name: OVERRIDE_LABEL, description: 'd' });",
      /name must be a static string/,
    ],
    ["request() with a variable route", "await github.request(route, { name: 'cms/x', description: 'd' });", /route must be a string literal/],
    ["octokit.request() creating another label", "await octokit.request('POST /repos/{owner}/{repo}/labels', { name: 'cms/x', description: 'd' });", /other than the expected/],
    ["request() creating cms/preview-only with another description", "await github.request('POST /repos/{owner}/{repo}/labels', { name: 'cms/preview-only', description: 'drop it' });", /other than the expected/],
    ["request() with a non-literal body", "await github.request('POST /repos/{owner}/{repo}/labels', body);", /must be called with one object literal/],
    ["a destructured request", "const { request } = github; await request('POST /repos/{owner}/{repo}/labels', { name: 'cms/x', description: 'd' });", /request is reached in a shape/],
    ["eval", "eval(\"github.rest.issues.create\" + \"Label({})\");", /eval is not allowed/],
    ["new Function", "await new Function('github', src)(github);", /Function is not allowed/],
  ];
  for (const [shape, src, message] of SHAPES) {
    test(`fails on ${shape}`, () => {
      const got = analyzeScript(`${ok}\n${src}`, "t");
      expect(got.problems.join("\n")).toMatch(message);
    });
  }
});

// Review of #558, round 2: `run:` steps can create the label with the gh CLI.
test.describe("run: steps may not create cms/preview-only with gh", () => {
  const RUNS = [
    ["gh label create naming it", 'gh label create cms/preview-only --color f5a623 --description "x"'],
    ["gh label create quoted", "gh label create 'cms/preview-only' --force"],
    ["gh label create from a variable", 'gh label create "$LABEL" --color ededed'],
    ["gh label create across a continuation", 'gh label \\\n  create "$LABEL"'],
    ["gh api POST naming it", 'gh api -X POST repos/o/r/labels -f name=cms/preview-only -f description=x'],
    ["gh api with a variable name", 'gh api "repos/$GITHUB_REPOSITORY/labels" -f "name=$LABEL"'],
    ["after another command", 'echo hi && gh label create cms/preview-only'],
  ];
  for (const [shape, script] of RUNS) {
    test(`fails on ${shape}`, () => {
      expect(analyzeRun(script, "t")).toHaveLength(1);
    });
  }

  test("other labels, and reading labels, pass", () => {
    expect(analyzeRun("gh label create cms/draft --color 1a2a5e\ngh api repos/o/r/labels --jq '.[].name'", "t")).toEqual([]);
  });
});

// The scope claim in the header, enforced: repo scripts that create labels
// must not create cms/preview-only, which only the workflow lint covers.
function scriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : scriptFiles(full);
    return [full];
  });
}

// A label-creating call in a repo script: createLabel(…), or any call one of
// whose arguments is a route string ending in `/labels`.
function scriptCreatesLabel(ast) {
  let creates = false;
  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee;
      const name = c.type === "Identifier" ? c.name : c.type === "MemberExpression" && !c.computed ? c.property.name : null;
      if (name === METHOD) creates = true;
      for (const a of node.arguments) {
        const text =
          a.type === "TemplateLiteral" ? a.quasis.map((q) => q.value.cooked).join("{}") : staticString(a);
        if (typeof text === "string" && /\/labels\/?$/.test(text.replace(/^\s*[A-Z]+\s+/, ""))) creates = true;
      }
    },
  });
  return creates;
}

function namesPreviewOnly(ast) {
  let found = false;
  walk.full(ast, (node) => {
    if (node.type === "Literal" && node.value === PREVIEW_ONLY) found = true;
    if (node.type === "TemplateElement" && String(node.value.cooked).includes(PREVIEW_ONLY)) found = true;
  });
  return found;
}

function scriptScopeProblems(files) {
  const problems = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    if (!/\.(c|m)?js$/.test(file)) {
      if (text.includes(PREVIEW_ONLY)) problems.push(`${rel}: names ${PREVIEW_ONLY} in a file this lint cannot parse`);
      continue;
    }
    let ast;
    try {
      ast = acorn.parse(text.replace(/^#!.*/, ""), { ...PARSE_OPTIONS, sourceType: /\.mjs$/.test(file) ? "module" : "script" });
    } catch (e) {
      if (text.includes(PREVIEW_ONLY)) problems.push(`${rel}: cannot parse, and names ${PREVIEW_ONLY}`);
      continue;
    }
    if (scriptCreatesLabel(ast) && namesPreviewOnly(ast)) {
      problems.push(`${rel}: creates a label and names ${PREVIEW_ONLY}; move that creation into the workflow lint's scope`);
    }
  }
  return problems;
}

test.describe("repo scripts stay out of the preview-only label's creation", () => {
  test("no file under scripts/ creates a label and names cms/preview-only", () => {
    const files = scriptFiles(path.join(REPO_ROOT, "scripts"));
    expect(files.some((f) => f.endsWith("gate-approval-issue.js")), "scripts/ was not walked").toBe(true);
    expect(scriptScopeProblems(files)).toEqual([]);
  });

  test("a script that creates the label is caught, by createLabel or by a /labels route", () => {
    const S = path.join(require("node:os").tmpdir(), `scope-${process.pid}`);
    fs.mkdirSync(S, { recursive: true });
    try {
      const write = (name, body) => {
        fs.writeFileSync(path.join(S, name), body);
        return path.join(S, name);
      };
      const files = [
        write("a.js", "octokit.rest.issues.createLabel({ owner, repo, name: 'cms/preview-only' });"),
        write("b.js", "const L = 'cms/preview-only';\ngh(`repos/${repo}/labels`, { fields: [`name=${L}`] });"),
        write("c.sh", "gh label create cms/preview-only"),
        write("ok.js", "gh(`repos/${repo}/labels`, { fields: ['name=ci-health'] });"),
      ];
      expect(scriptScopeProblems(files).map((p) => path.basename(p.split(":")[0]))).toEqual(["a.js", "b.js", "c.sh"]);
    } finally {
      fs.rmSync(S, { recursive: true, force: true });
    }
  });
});

// Review of #558, N1: the preview-only createLabel failure used to vanish in
// `catch (_) {}`. Runs the real github-script step with a scripted client.
test.describe("cms/preview-only label creation reports failures by status code only", () => {
  function step() {
    const file = listWorkflows().find((f) => path.basename(f) === "cms-editorial-workflow.yml");
    const blocks = githubScriptBlocks(fs.readFileSync(file, "utf8")).filter((b) =>
      analyzeScript(b.script, "x").calls.some((c) => c.name === PREVIEW_ONLY),
    );
    expect(blocks).toHaveLength(1);
    return blocks[0].script;
  }

  async function run(previewOnlyError) {
    const warnings = [];
    const added = [];
    const github = {
      rest: {
        issues: {
          createLabel: async ({ name }) => {
            if (name === PREVIEW_ONLY && previewOnlyError) throw previewOnlyError;
          },
          addLabels: async ({ labels }) => added.push(...labels),
        },
      },
    };
    const context = {
      repo: { owner: "owner", repo: "repo" },
      payload: { pull_request: { number: 7, base: { ref: "feature/x" } } },
    };
    const core = { warning: (m) => warnings.push(String(m)) };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("github", "context", "core", step())(github, context, core);
    return { warnings, added };
  }

  const BODY = "body-text-that-must-not-be-logged";

  test("already_exists is silent", async () => {
    const err = Object.assign(new Error(BODY), {
      status: 422,
      response: { data: { message: BODY, errors: [{ resource: "Label", code: "already_exists", field: "name" }] } },
    });
    const { warnings, added } = await run(err);
    expect(warnings).toEqual([]);
    expect(added).toEqual(["cms/draft", PREVIEW_ONLY]);
  });

  test("a validation 422 warns with the status code and nothing from the body", async () => {
    const err = Object.assign(new Error(BODY), {
      status: 422,
      response: { data: { message: BODY, errors: [{ resource: "Label", code: "invalid", field: "description" }] } },
    });
    const { warnings, added } = await run(err);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 422");
    expect(warnings[0]).not.toContain(BODY);
    expect(added).toEqual(["cms/draft", PREVIEW_ONLY]);
  });

  test("a server error warns with its status code", async () => {
    const { warnings } = await run(Object.assign(new Error(BODY), { status: 500 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 500");
    expect(warnings[0]).not.toContain(BODY);
  });

  test("no error, no warning", async () => {
    expect((await run(null)).warnings).toEqual([]);
  });
});
