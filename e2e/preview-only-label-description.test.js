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
 * Scope: `.github/workflows/*.yml` and composite `action.yml` files under `.github/actions/`
 * (github-script bodies and `run:` steps). Label creation handlers must
 * report unexpected failures or rethrow them; silent catches fail the lint.
 * That covers a try/catch and every promise form (review of #571): `.catch`
 * with a function literal or an identifier the script binds once to a
 * function, a `.catch` after `.finally()`, `.then(…, onRejected)`, a promise
 * held in a variable and `.catch`ed or awaited later, `Promise.all` and
 * friends, and `Promise.allSettled`, whose results must be bound and reported
 * on. A callback that cannot be resolved, or a promise that flows somewhere
 * this cannot follow (an argument, an array, a function's return), fails
 * closed. A handler's console.log/error/warn and
 * core.warning/info/notice/error/setFailed/setOutput may also emit only the
 * HTTP status and a bounded type, as may a newly thrown error (direct
 * rethrows of an unreassigned caught binding are preserved): arguments are
 * checked against the caught error's bindings (and locals derived from them),
 * so message,
 * response and body access fail. Simple local aliases, assignments, member
 * assignments and array push/unshift/splice propagate taint to a fixed point.
 * This is conservative across branches, order and alias types, and safe
 * reassignment does not clear taint; arbitrary mutators, dynamic sink methods,
 * function calls and aliases through nested object properties are not followed.
 * Not followed: a function that awaits the
 * call and propagates, whose callers swallow it (every handler here is
 * top-level).
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
      if (node.id) add(node.id.name, node.type === "FunctionDeclaration" ? { other: true, fn: node } : { other: true });
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

// A nested function is a separate execution boundary: defining a callback
// inside a try does not make that try protect calls made by the callback.
const FUNCTION_NODES = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];
function protectedTry(ancestors) {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const node = ancestors[i];
    if (FUNCTION_NODES.includes(node.type)) return null;
    if (node.type === "TryStatement" && node.handler && ancestors[i + 1] === node.block) return node;
  }
  return null;
}

// What a failure handler may log: the HTTP status and a bounded type, never
// the error's message, response or body (a handler once printed whatever an
// API error carried; AGENTS.md "Sanitize error output"). `tainted` names the
// error binding and every local derived from it that is not itself bounded.
// A property chain on a tainted name is allowed only when it ends in
// `.status`, the one field of an error that is a number.
const STATUS_CHAINS = ["status", "response.status", "reason.status", "reason.response.status"];

// The ways `node` can expose a tainted value, as short descriptions.
function leakedRefs(node, tainted, out = []) {
  if (!node) return out;
  const each = (nodes) => nodes.forEach((n) => leakedRefs(n, tainted, out));
  switch (node.type) {
    case "Literal":
    case "TemplateElement":
      return out;
    case "Identifier":
      if (tainted.has(node.name)) out.push(node.name);
      return out;
    case "ChainExpression":
      return leakedRefs(node.expression, tainted, out);
    case "MemberExpression": {
      const segments = [];
      let root = node;
      while (root.type === "MemberExpression") {
        segments.unshift(root.computed ? staticString(root.property) : root.property.name);
        root = root.object;
      }
      if (root.type === "Identifier" && tainted.has(root.name)) {
        if (!STATUS_CHAINS.includes(segments.join("."))) out.push(`${root.name}.${segments.map((s) => s ?? "[…]").join(".")}`);
        return out;
      }
      leakedRefs(node.object, tainted, out);
      if (node.computed) leakedRefs(node.property, tainted, out);
      return out;
    }
    case "CallExpression":
      // `Number(x)` is a number or NaN, whatever x was.
      if (node.callee.type === "Identifier" && node.callee.name === "Number") return out;
      leakedRefs(node.callee, tainted, out);
      each(node.arguments);
      return out;
    case "NewExpression":
      // A wrapped error exposes its arguments, with the same bounded rules
      // as a report call; a conditional's test is not constructor output.
      each(node.arguments);
      return out;
    case "LogicalExpression":
      // `e && x` yields `e` itself only when it is falsy, never an error object.
      if (node.operator === "&&" && node.left.type === "Identifier" && tainted.has(node.left.name)) {
        return leakedRefs(node.right, tainted, out);
      }
      each([node.left, node.right]);
      return out;
    case "ConditionalExpression":
      // The test only chooses; its value never reaches the result.
      each([node.consequent, node.alternate]);
      return out;
    case "BinaryExpression":
      // Comparisons give a boolean and arithmetic a number; only `+` can carry text.
      if (node.operator === "+") each([node.left, node.right]);
      return out;
    case "UnaryExpression":
      return out;
    case "TemplateLiteral":
    case "SequenceExpression":
      each(node.expressions);
      return out;
    case "ArrayExpression":
      each(node.elements);
      return out;
    case "SpreadElement":
      return leakedRefs(node.argument, tainted, out);
    case "ObjectExpression":
      for (const p of node.properties) {
        if (p.type === "SpreadElement") leakedRefs(p.argument, tainted, out);
        else {
          if (p.computed) leakedRefs(p.key, tainted, out);
          leakedRefs(p.value, tainted, out);
        }
      }
      return out;
    default:
      // A shape this does not model: any mention of a tainted name counts.
      walk.full(node, (n) => {
        if (n.type === "Identifier" && tainted.has(n.name)) out.push(n.name);
      });
      return out;
  }
}

// The names in a handler that can carry the caught error: its parameters
// (except a destructured `status`) and, to a fixed point, every local whose
// initializer, assignment or modeled array mutation exposes one. Simple
// identifier aliases share mutation taint in both directions. This is a
// conservative fixed point, not execution-order or interprocedural analysis.
function taintedNames(handler) {
  const tainted = new Set();
  for (const param of handler.type === "CatchClause" ? [handler.param] : handler.params) {
    if (param && param.type === "ObjectPattern") {
      for (const p of param.properties) {
        const bounded = p.type === "Property" && !p.computed && p.key.name === "status" && p.value.type === "Identifier";
        if (!bounded) patternNames(p.type === "RestElement" ? p.argument : p.value).forEach((n) => tainted.add(n));
      }
    } else patternNames(param).forEach((n) => tainted.add(n));
  }
  const flows = [];
  const aliases = [];
  const targetNames = (target) => {
    while (target.type === "MemberExpression") target = target.object;
    return patternNames(target);
  };
  walk.full(handler.body, (n) => {
    let target, source;
    if (n.type === "VariableDeclarator" && n.init) [target, source] = [n.id, n.init];
    else if (n.type === "AssignmentExpression") [target, source] = [n.left, n.right];
    if (target) {
      flows.push([targetNames(target), source]);
      if (target.type === "Identifier" && source.type === "Identifier") aliases.push([target.name, source.name]);
    }
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const c = n.callee;
      const method = c.computed ? staticString(c.property) : c.property.name;
      if (["push", "unshift", "splice"].includes(method)) {
        // All splice arguments are conservative: indices are normally bounded.
        for (const arg of n.arguments) flows.push([targetNames(c.object), arg]);
      }
    }
  });
  for (let changed = true; changed; ) {
    changed = false;
    for (const [target, source] of flows) {
      const names = target.filter((n) => !tainted.has(n));
      if (names.length && leakedRefs(source, tainted).length) {
        names.forEach((n) => tainted.add(n));
        changed = true;
      }
    }
    for (const pair of aliases) {
      if (pair.some((n) => tainted.has(n))) for (const name of pair) {
        if (!tainted.has(name)) { tainted.add(name); changed = true; }
      }
    }
  }
  return tainted;
}

// Whether `body` reports (throws, or calls core.warning/error/setFailed) and
// every output sink's arguments, as { reports, leaks: [string] }. Lower-level
// logging and setOutput are checked but do not satisfy failure reporting. A nested
// function is not counted unless `intoFunctions`: an uncalled function that
// reports swallows the failure just as an empty handler does.
function scanReports(body, tainted, intoFunctions, rethrowNames = new Set()) {
  let reports = false;
  const leaks = [];
  const visitors = {
    ThrowStatement(node, state, visit) {
      reports = true;
      // Preserve direct propagation of the unreassigned caught error. A derived
      // local or constructed error is output and must obey the bounded policy.
      if (!(node.argument.type === "Identifier" && rethrowNames.has(node.argument.name))) {
        const refs = leakedRefs(node.argument, tainted);
        if (refs.length) leaks.push(`line ${node.loc.start.line}: throw exposes ${[...new Set(refs)].join(", ")}`);
      }
      walk.base.ThrowStatement(node, state, visit);
    },
    CallExpression(node, state, visit) {
      const c = node.callee;
      const method = c.type === "MemberExpression" && (c.computed ? staticString(c.property) : c.property.name);
      if (c.type === "MemberExpression" && c.object.type === "Identifier" &&
          ((c.object.name === "core" && ["warning", "error", "setFailed", "setOutput", "info", "notice"].includes(method)) ||
           (c.object.name === "console" && ["log", "error", "warn"].includes(method)))) {
        if (c.object.name === "core" && ["warning", "error", "setFailed"].includes(method)) reports = true;
        const refs = node.arguments.flatMap((a) => leakedRefs(a, tainted));
        if (refs.length) leaks.push(`line ${node.loc.start.line}: ${c.object.name}.${method}() logs ${[...new Set(refs)].join(", ")}`);
      }
      walk.base.CallExpression(node, state, visit);
    },
  };
  if (!intoFunctions) for (const type of FUNCTION_NODES) visitors[type] = () => {};
  walk.recursive(body, null, visitors);
  return { reports, leaks };
}

const LEAK = "createLabel failure handler logs more than the HTTP status and a bounded type";
const UNRESOLVED = "createLabel failure handler cannot be resolved to a function in this script";
const UNFOLLOWED = "createLabel promise flows somewhere this lint cannot follow";

// Problems with one failure handler (a catch clause, or a promise callback
// function): none when it reports and logs only the status and a bounded type.
function handlerProblems(handler) {
  const params = handler.type === "CatchClause" ? [handler.param] : handler.params;
  const rethrowNames = new Set(params.filter((p) => p && p.type === "Identifier").map((p) => p.name));
  // The spelling still names a parameter after replacement, but no longer
  // necessarily holds the original error. Member writes preserve the binding.
  walk.full(handler.body, (node) => {
    const target = node.type === "AssignmentExpression" ? node.left :
      node.type === "UpdateExpression" ? node.argument :
      node.type === "VariableDeclarator" && node.init ? node.id : null;
    for (const name of patternNames(target)) rethrowNames.delete(name);
  });
  const { reports, leaks } = scanReports(handler.body, taintedNames(handler), false, rethrowNames);
  if (leaks.length) return leaks.map((l) => `${LEAK} (${l}); never log its message, response or body`);
  return reports ? [] : ["createLabel failure is silently caught"];
}

// The function a `.catch` / `.then` rejection callback names: a function
// expression itself, or an identifier the script binds exactly once to a
// function declaration or to a function-valued `const`/`let`/`var`. Else null.
function resolveCallback(node, ctx) {
  if (node && FUNCTION_NODES.includes(node.type)) return node;
  if (!node || node.type !== "Identifier") return null;
  const entries = ctx.bound.get(node.name) || [];
  if (entries.length !== 1) return null;
  if (entries[0].fn) return entries[0].fn;
  const init = entries[0].declarator && entries[0].declarator.id.type === "Identifier" && entries[0].declarator.init;
  return init && FUNCTION_NODES.includes(init.type) ? init : null;
}

function callbackProblems(node, ctx) {
  const fn = resolveCallback(node, ctx);
  return fn ? handlerProblems(fn) : [UNRESOLVED];
}

const isNullish = (n) => !n || (n.type === "Literal" && n.raw === "null") || (n.type === "Identifier" && n.name === "undefined");
const isPromiseStatic = (call) =>
  call && call.type === "CallExpression" && call.callee.type === "MemberExpression" && !call.callee.computed &&
  call.callee.object.type === "Identifier" && call.callee.object.name === "Promise";

// Every Identifier reference to `name` in the script, as ancestor paths
// ending at it (declarations and assignment targets are patterns, not
// references).
function referencesTo(ctx, name) {
  const found = [];
  walk.ancestor(ctx.ast, {
    Identifier(node, _state, ancestors) {
      if (node.name === name) found.push(ancestors.slice());
    },
  });
  return found;
}

// A promise held in a variable: every use of that variable is followed.
function heldProblems(name, ctx, seen) {
  if (seen.has(name)) return [];
  seen.add(name);
  const entries = ctx.bound.get(name) || [];
  if (entries.length !== 1 || entries[0].other) return [`${UNFOLLOWED} (a variable bound more than once or as a parameter)`];
  return referencesTo(ctx, name).flatMap((path) => followPromise(path, ctx, seen));
}

// `await Promise.allSettled([...])` never rejects, so its results must be
// inspected: bound to a variable some statement of which reports.
function settledProblems(path, ctx) {
  const wrapped = path[path.length - 2] && path[path.length - 2].type === "AwaitExpression";
  const at = wrapped ? path.slice(0, -1) : path;
  const node = at[at.length - 1];
  const parent = at[at.length - 2];
  const ignored = "createLabel failures are swallowed by Promise.allSettled and its results are never checked for rejection";
  if (!parent || parent.type === "ExpressionStatement") return [ignored];
  if (parent.type === "VariableDeclarator" && parent.init === node && parent.id.type === "Identifier") {
    const refs = referencesTo(ctx, parent.id.name);
    const leaks = [];
    const inspected = refs.map((ref) => {
      const stmt = ref.findLast((n) => /(Statement|Declaration)$/.test(n.type) && n.type !== "BlockStatement");
      const tainted = new Set([parent.id.name]);
      walk.full(stmt, (n) => {
        if (n.type === "VariableDeclarator") patternNames(n.id).forEach((x) => tainted.add(x));
        else if (/Function/.test(n.type)) n.params.forEach((p) => patternNames(p).forEach((x) => tainted.add(x)));
        else if (/^For(In|Of)Statement$/.test(n.type) && n.left.type === "VariableDeclaration") {
          n.left.declarations.forEach((d) => patternNames(d.id).forEach((x) => tainted.add(x)));
        }
      });
      const got = scanReports(stmt, tainted, true);
      leaks.push(...got.leaks);
      return got.reports && !got.leaks.length;
    }).some(Boolean);
    if (leaks.length) return leaks.map((l) => `${LEAK} (${l}); never log its message, response or body`);
    return inspected ? [] : [ignored];
  }
  const grand = at[at.length - 3];
  const isThen = parent.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.name === "then";
  if (isThen && grand && grand.type === "CallExpression" && grand.callee === parent) {
    const fn = resolveCallback(grand.arguments[0], ctx);
    const got = fn && scanReports(fn.body, taintedNames(fn), false);
    if (got && got.leaks.length) return got.leaks.map((l) => `${LEAK} (${l}); never log its message, response or body`);
    return got && got.reports ? [] : [ignored];
  }
  return [`${UNFOLLOWED} (Promise.allSettled result)`];
}

// What happens to a rejection of the promise `path` ends at, following the
// chain a consumer builds: the first `.catch` (or `.then`'s second argument)
// consumes it and must report; `.finally`, a bare `.then`, `Promise.all` and
// friends pass it on; `await` rethrows it into an enclosing try. Anything
// this cannot follow fails closed.
function followPromise(path, ctx, seen = new Set()) {
  const node = path[path.length - 1];
  const parent = path[path.length - 2];
  const grand = path[path.length - 3];
  const up = (n) => path.slice(0, path.length - n);
  switch (parent && parent.type) {
    case "MemberExpression": {
      const method = parent.computed ? staticString(parent.property) : parent.property.name;
      const call = grand && grand.type === "CallExpression" && grand.callee === parent && grand.arguments;
      if (parent.object !== node || method === undefined || !call || call.some((a) => a.type === "SpreadElement")) return [UNFOLLOWED];
      if (method === "catch") return isNullish(call[0]) ? followPromise(up(2), ctx, seen) : callbackProblems(call[0], ctx);
      if (method === "then") return isNullish(call[1]) ? followPromise(up(2), ctx, seen) : callbackProblems(call[1], ctx);
      if (method === "finally") return followPromise(up(2), ctx, seen);
      return [`${UNFOLLOWED} (.${method}())`];
    }
    case "AwaitExpression": {
      const stmt = protectedTry(path);
      return stmt ? handlerProblems(stmt.handler) : [];
    }
    case "ExpressionStatement":
      return [];
    case "ReturnStatement":
      // Returned out of a function, it reaches callers this lint does not see.
      return path.some((n) => FUNCTION_NODES.includes(n.type)) ? [UNFOLLOWED] : [];
    case "UnaryExpression":
      return parent.operator === "void" ? [] : [UNFOLLOWED];
    case "LogicalExpression":
      return followPromise(up(1), ctx, seen);
    case "ConditionalExpression":
      return parent.test === node ? [UNFOLLOWED] : followPromise(up(1), ctx, seen);
    case "SequenceExpression":
      return parent.expressions[parent.expressions.length - 1] === node ? followPromise(up(1), ctx, seen) : [];
    case "ArrayExpression": {
      if (!isPromiseStatic(grand) || grand.arguments[0] !== parent) return [`${UNFOLLOWED} (an array)`];
      const method = grand.callee.property.name;
      if (method === "allSettled") return settledProblems(up(2), ctx);
      return ["all", "race", "any"].includes(method) ? followPromise(up(2), ctx, seen) : [UNFOLLOWED];
    }
    case "VariableDeclarator":
      return parent.init === node && parent.id.type === "Identifier" ? heldProblems(parent.id.name, ctx, seen) : [UNFOLLOWED];
    case "AssignmentExpression":
      return parent.operator === "=" && parent.right === node && parent.left.type === "Identifier"
        ? heldProblems(parent.left.name, ctx, seen)
        : [UNFOLLOWED];
    default:
      return [UNFOLLOWED];
  }
}

// `node` is a label creation: its failure must be reported or propagated,
// whether the call sits in a try, is chained, or is held in a variable.
function silentCatchProblems(node, ancestors, at, ctx) {
  const problems = [];
  const stmt = protectedTry(ancestors);
  if (stmt) problems.push(...handlerProblems(stmt.handler));
  problems.push(...followPromise(ancestors, ctx));
  return [...new Set(problems)].map((p) => `${at}: ${p}`);
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
  const ctx = { ast, bound: bindings(ast) };
  const evaluated = { [METHOD]: 0, request: 0 };
  walk.ancestor(ast, {
    CallExpression(node, ancestors) {
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
        problems.push(...silentCatchProblems(node, ancestors, at, ctx));
        const got = labelFields(node.arguments[1], value, "request(POST …/labels)");
        if (typeof got === "string") problems.push(`${at}: ${got}`);
        else if (got.name !== PREVIEW_ONLY || got.description !== PREVIEW_ONLY_DESCRIPTION) {
          problems.push(`${at}: request(POST …/labels) creates a label other than the expected ${PREVIEW_ONLY}; use ${METHOD}`);
        } else calls.push({ where: at, ...got });
        return;
      }
      if (callee.property.name !== METHOD) return;
      evaluated[METHOD]++;
      problems.push(...silentCatchProblems(node, ancestors, at, ctx));
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
    if (Object.hasOwn(tokens, tok.value)) tokens[tok.value]++;
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

// Workflows and composite actions both contain executable github-script
// steps. Keep discovery local to this lint rather than widening shared helpers.
function labelDefinitionFiles(root = REPO_ROOT) {
  const dir = path.join(root, ".github", "workflows");
  const workflows = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f));
  const actions = path.join(root, ".github", "actions");
  return [...workflows, ...(fs.existsSync(actions) ? scriptFiles(actions).filter((f) => /[/\\]action\.ya?ml$/.test(f)) : [])];
}

// Every createLabel call in every github-script step of every platform
// workflow or composite action.
function createLabelCalls(files = labelDefinitionFiles()) {
  const calls = [];
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const name = file.includes(`${path.sep}actions${path.sep}`) ? path.relative(REPO_ROOT, file) : path.basename(file);
    for (const block of githubScriptBlocks(text)) {
      const got = analyzeScript(block.script, `${name}:${block.line}`);
      calls.push(...got.calls);
      problems.push(...got.problems);
    }
    for (const run of runScripts(text)) problems.push(...analyzeRun(run.script, `${name}:${run.line}`));
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

  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    test(`ordinary ${name} tokens do not count as label creation`, () => {
      const got = analyzeScript(`${ok}\nconst text = value.${name}();`, "t");
      expect(got.problems).toEqual([]);
      expect(got.calls).toHaveLength(1);
    });
  }

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

test.describe("createLabel failures cannot disappear in a catch", () => {
  const create = "await github.rest.issues.createLabel({ name: 'cms/x', description: 'Fine' });";
  const SILENT = [
    ["empty catch", `try { ${create} } catch (e) {}`],
    ["comment-only catch", `try { ${create} } catch (e) { /* already exists */ }`],
    ["optional catch binding", `try { ${create} } catch {}`],
    ["return-only catch", `try { ${create} } catch (e) { return; }`],
    ["ignored error", `try { ${create} } catch (e) { void e; }`],
    ["unused binding", `try { ${create} } catch (e) { const ignored = e; }`],
    ["uncalled nested warning", `try { ${create} } catch (e) { function warn() { core.warning('failed'); } }`],
    ["uncalled nested rethrow", `try { ${create} } catch (e) { const rethrow = () => { throw e; }; }`],
    // Split quoted fixtures because the legacy silent-catch lint scans their text.
    ["empty promise catch", create.replace(";", "." + "catch(() => {});")],
    ["comment-only promise catch", create.replace(";", ".catch(function (e) { /* exists */ });")],
    ["silent expression callback", create.replace(";", "." + "catch(e => undefined);")],
  ];
  for (const [shape, script] of SILENT) {
    test(`rejects ${shape}`, () => {
      expect(analyzeScript(script, "t").problems.join("\n")).toMatch(/createLabel failure is silently caught/);
    });
  }

  const REPORTED = [
    ["warning", `try { ${create} } catch (e) { core.warning('failed'); }`],
    ["rethrow", `try { ${create} } catch (e) { throw e; }`],
    ["propagation", create],
    ["unrelated catch", `try { unrelated(); } catch {} ${create}`],
    ["nested callback unrelated to the try", `try { const work = async () => { ${create} }; } catch {}`],
    ["call in the catch body", `try { unrelated(); } catch { ${create} }`],
    ["call in the finally body", `try { unrelated(); } catch {} finally { ${create} }`],
    ["unrelated nested catch", `try { ${create} try { unrelated(); } catch {} } catch (e) { core.warning('failed'); }`],
    ["warning in promise catch", create.replace(";", ".catch(e => core.warning('failed'));")],
    ["rethrow in promise catch", create.replace(";", ".catch(e => { throw e; });")],
  ];
  for (const [shape, script] of REPORTED) {
    test(`allows ${shape}`, () => {
      expect(analyzeScript(script, "t").problems).toEqual([]);
    });
  }
});

// Promise forms beyond an inline silent `.catch` (review of #571): a callback named
// by an identifier, a `.catch` after `.finally()`, `.then(null, fn)`, a
// promise held in a variable, and `Promise.allSettled`. Each is silent unless
// its handler reports, and anything this cannot resolve fails closed.
test.describe("createLabel promise forms cannot hide a failure", () => {
  const call = "github.rest.issues.createLabel({ name: 'cms/x', description: 'Fine' })";
  const SILENT_MESSAGE = /createLabel failure is silently caught/;
  const REPORT = "e => core.warning(`Could not create the label (HTTP ${Number(e && e.status) || 'unknown'}).`)";
  // Spelled in two pieces so the text-scanning silent-catch lint does not read it.
  const EMPTY_FN = "() " + "=> {}";
  const NOOP_DECL = "function noop() {}\n";
  const NOOP_CONST = "const noop = () => {};\n";
  const REPORT_DECL = "function report(e) { core.warning(`Could not create the label (HTTP ${Number(e && e.status) || 'unknown'}).`); }\n";
  const REPORT_CONST = `const report = ${REPORT};\n`;

  const FLAGGED = [
    ["an identifier naming an empty function declaration", `${NOOP_DECL}await ${call}.catch(noop);`, SILENT_MESSAGE],
    ["an identifier naming a const empty arrow", `${NOOP_CONST}await ${call}.catch(noop);`, SILENT_MESSAGE],
    ["an identifier naming a const function expression with a comment-only body", `const noop = function () { /* exists */ };\nawait ${call}.catch(noop);`, SILENT_MESSAGE],
    ["an identifier bound twice", `${NOOP_DECL}var noop = ${REPORT};\nawait ${call}.catch(noop);`, /cannot be resolved/],
    ["an identifier that is not declared in the script", `await ${call}.catch(handle);`, /cannot be resolved/],
    ["an identifier reassigned by a parameter of the same name", `const noop = () => {};\nfunction f(noop) {}\nawait ${call}.catch(noop);`, /cannot be resolved/],
    ["a member callback", `await ${call}.catch(core.warning);`, /cannot be resolved/],
    ["a callback built by a call", `await ${call}.catch(makeHandler());`, /cannot be resolved/],
    ["a catch after finally", `await ${call}.finally(() => cleanup()).catch(${EMPTY_FN});`, SILENT_MESSAGE],
    ["a catch after finally, by identifier", `${NOOP_DECL}await ${call}.finally(() => cleanup()).catch(noop);`, SILENT_MESSAGE],
    ["then(null, silent)", `await ${call}.then(null, () => {});`, SILENT_MESSAGE],
    ["then(undefined, silent)", `await ${call}.then(undefined, () => undefined);`, SILENT_MESSAGE],
    ["then(onFulfilled, silent)", `await ${call}.then(() => ok(), () => {});`, SILENT_MESSAGE],
    ["then(null, identifier)", `${NOOP_DECL}await ${call}.then(null, noop);`, SILENT_MESSAGE],
    ["then(null, unresolvable)", `await ${call}.then(null, handle);`, /cannot be resolved/],
    ["a spread argument", `await ${call}.catch(...handlers);`, /cannot follow/],
    ["an unmodeled promise method", `await ${call}.tap(() => {});`, /cannot follow/],
    ["a promise held in a const, then caught silently", `const p = ${call};\nawait p.catch(${EMPTY_FN});`, SILENT_MESSAGE],
    ["a promise held in a const, caught by a silent identifier", `${NOOP_DECL}const p = ${call};\nawait p.catch(noop);`, SILENT_MESSAGE],
    ["a promise held in a let assigned later", `let p;\np = ${call};\nawait p.finally(() => {}).catch(${EMPTY_FN});`, SILENT_MESSAGE],
    ["a held promise awaited in a try with a silent catch", `const p = ${call};\ntry { await p; } catch {}`, SILENT_MESSAGE],
    ["a held promise copied to another variable", `const p = ${call};\nconst q = p;\nawait q.catch(${EMPTY_FN});`, SILENT_MESSAGE],
    ["a held promise handed to a function", `const p = ${call};\nawait track(p);`, /cannot follow/],
    ["a promise variable bound twice", `var p = ${call};\nvar p = other();\nawait p.catch(${EMPTY_FN});`, /cannot follow/],
    ["a promise returned from a function", `async function make() { return ${call}; }\nawait make().catch(${EMPTY_FN});`, /cannot follow/],
    ["a promise placed in an array", `const ps = [${call}];\nawait Promise.allSettled(ps);`, /cannot follow/],
    ["Promise.allSettled with ignored results", `await Promise.allSettled([${call}]);`, /Promise\.allSettled/],
    ["Promise.allSettled without await", `Promise.allSettled([${call}, other()]);`, /Promise\.allSettled/],
    ["Promise.allSettled with results never read", `const results = await Promise.allSettled([${call}]);`, /Promise\.allSettled/],
    ["Promise.allSettled with results read but never reported", `const results = await Promise.allSettled([${call}]);\nconst failed = results.filter((r) => r.status === 'rejected');`, /Promise\.allSettled/],
    ["Promise.allSettled with a silent then", `await Promise.allSettled([${call}]).then(() => {});`, /Promise\.allSettled/],
    ["Promise.allSettled destructured", `const [first] = await Promise.allSettled([${call}]);`, /cannot follow/],
    ["Promise.all caught silently", `await Promise.all([${call}, other()]).catch(${EMPTY_FN});`, SILENT_MESSAGE],
    ["Promise.race in a try with a silent catch", `try { await Promise.race([${call}]); } catch {}`, SILENT_MESSAGE],
    ["a silent catch behind a logical expression", `await (flag && ${call}.catch(${EMPTY_FN}));`, SILENT_MESSAGE],
  ];
  for (const [shape, script, message] of FLAGGED) {
    test(`rejects ${shape}`, () => {
      expect(analyzeScript(script, "t").problems.join("\n")).toMatch(message);
    });
  }

  const ALLOWED = [
    ["a callback identifier that reports (function declaration)", `${REPORT_DECL}await ${call}.catch(report);`],
    ["a callback identifier that reports (const arrow)", `${REPORT_CONST}await ${call}.catch(report);`],
    ["a catch after finally that reports", `await ${call}.finally(() => cleanup()).catch(${REPORT});`],
    ["a catch after finally, by identifier", `${REPORT_DECL}await ${call}.finally(() => cleanup()).catch(report);`],
    ["then(null, reporter)", `await ${call}.then(null, ${REPORT});`],
    ["then(onFulfilled, reporter identifier)", `${REPORT_DECL}await ${call}.then(() => ok(), report);`],
    ["a bare then and finally, which pass the rejection on", `await ${call}.then(() => ok()).finally(() => cleanup());`],
    ["a rethrowing identifier", `function rethrow(e) { throw e; }\nawait ${call}.catch(rethrow);`],
    ["a held promise caught by a reporter", `const p = ${call};\nawait p.catch(${REPORT});`],
    ["a held promise awaited with no try", `const p = ${call};\nawait p;`],
    ["a held promise awaited in a try that reports", `const p = ${call};\ntry { await p; } catch (e) { core.warning('failed'); }`],
    ["a held promise assigned later and reported", `let p;\np = ${call};\nawait p.catch(${REPORT});`],
    ["Promise.all with no catch", `await Promise.all([${call}, other()]);`],
    ["Promise.all caught by a reporter", `await Promise.all([${call}]).catch(${REPORT});`],
    ["a bare then on Promise.allSettled that reports", `await Promise.allSettled([${call}]).then((rs) => { for (const r of rs) if (r.status === 'rejected') core.warning('failed'); });`],
    [
      "Promise.allSettled whose results are looped and reported with a bounded status",
      `const results = await Promise.allSettled([${call}]);\n` +
        "for (const r of results) {\n  if (r.status === 'rejected') core.warning(`Could not create the label (HTTP ${Number(r.reason && r.reason.status) || 'unknown'}).`);\n}",
    ],
    [
      "Promise.allSettled whose results are reported by forEach",
      `const results = await Promise.allSettled([${call}]);\nresults.forEach((r) => { if (r.status === 'rejected') core.warning('failed'); });`,
    ],
    ["a floating call, whose rejection fails the step", `${call};`],
    ["void, whose rejection fails the step", `void ${call};`],
  ];
  for (const [shape, script] of ALLOWED) {
    test(`allows ${shape}`, () => {
      expect(analyzeScript(script, "t").problems).toEqual([]);
    });
  }
});

// A warning must log only the HTTP status and a bounded type (review of
// #571): `core.warning(e.message)` satisfied "reports" while printing
// whatever the API error carried.
test.describe("a createLabel failure handler logs only the status and a bounded type", () => {
  const create = "await github.rest.issues.createLabel({ name: 'cms/x', description: 'Fine' });";
  const inCatch = (body, param = "e") => `try { ${create} } catch (${param}) { ${body} }`;
  const LEAK_MESSAGE = /logs more than the HTTP status and a bounded type/;

  const LEAKS = [
    ["e.message", inCatch("core.warning(e.message);")],
    ["e.message in a template", inCatch("core.warning(`Could not create the label: ${e.message}`);")],
    ["e.message concatenated", inCatch("core.warning('failed: ' + e.message);")],
    ["a computed message key", inCatch("core.warning(e['message']);")],
    ["the whole error", inCatch("core.warning(e);")],
    ["the whole error in a template", inCatch("core.warning(`failed ${e}`);")],
    ["String(e)", inCatch("core.warning(String(e));")],
    ["e.toString()", inCatch("core.warning(e.toString());")],
    ["JSON.stringify(e)", inCatch("core.warning(JSON.stringify(e));")],
    ["e.response", inCatch("core.warning(`failed ${e.response}`);")],
    ["the response body", inCatch("core.warning(`failed ${e.response.data.message}`);")],
    ["a status-named field inside the body", inCatch("core.warning(`failed ${e.response.data.status}`);")],
    ["the error name, unbounded", inCatch("core.warning(`failed ${e.name}`);")],
    ["the error stack", inCatch("core.warning(e.stack);")],
    ["an optional-chain message", inCatch("core.warning(e?.message);")],
    ["a message copied to a variable", inCatch("const detail = e.message; core.warning(detail);")],
    ["a message copied through two variables", inCatch("const detail = e.message; const copy = detail; core.warning(`x ${copy}`);")],
    ["a message assigned later", inCatch("let detail; detail = e.message; core.warning(detail);")],
    ["a destructured message", inCatch("const { message } = e; core.warning(message);")],
    ["a destructured catch parameter", inCatch("core.warning(message);", "{ message }")],
    ["a message in an object argument", inCatch("core.warning('failed', { title: e.message });")],
    ["a message passed to core.error", inCatch("core.error(e.message);")],
    ["a message passed to core.setFailed", inCatch("core.setFailed(`failed ${e.message}`);")],
    ["a message in a reported alongside a clean warning", inCatch("core.warning('clean'); core.warning(e.message);")],
    ["a message in a promise callback", create.replace(";", ".catch(e => core.warning(e.message));")],
    ["a message in a promise callback body", create.replace(";", ".catch(function (err) { core.warning(`x ${err.message}`); });")],
    ["a message in a resolved identifier callback", `function report(e) { core.warning(e.message); }\n${create.replace(";", ".catch(report);")}`],
    ["a message in a then(null, fn) callback", create.replace(";", ".then(null, e => core.warning(e.message));")],
    [
      "a message in a Promise.allSettled report",
      "const results = await Promise.allSettled([github.rest.issues.createLabel({ name: 'cms/x', description: 'Fine' })]);\n" +
        "for (const r of results) { if (r.status === 'rejected') core.warning(`x ${r.reason.message}`); }",
    ],
  ];
  for (const [shape, script] of LEAKS) {
    test(`rejects ${shape}`, () => {
      expect(analyzeScript(script, "t").problems.join("\n")).toMatch(LEAK_MESSAGE);
    });
  }

  const BOUNDED = [
    ["the status", inCatch("core.warning(`failed (HTTP ${e.status})`);")],
    ["the status, as the real handlers write it", inCatch("core.warning(`failed (HTTP ${Number(e && e.status) || 'unknown'})`);")],
    ["a response status", inCatch("core.warning(`failed (HTTP ${e.response.status})`);")],
    ["a bounded type chosen by a conditional", inCatch("const type = e && e.name === 'HttpError' ? 'HttpError' : 'Error'; core.warning(`failed (${type})`);")],
    ["a bounded type inline", inCatch("core.warning(`failed (${e.name === 'HttpError' ? 'HttpError' : 'Error'})`);")],
    ["a status copied to a variable", inCatch("const status = Number(e && e.status) || 'unknown'; core.warning(`failed (HTTP ${status})`);")],
    ["a destructured status", inCatch("core.warning(`failed (HTTP ${status})`);", "{ status }")],
    ["a body read only to decide, not to log", inCatch("const errors = e && e.response && e.response.data && e.response.data.errors; const exists = e && e.status === 422 && Array.isArray(errors); if (!exists) core.warning('failed');")],
    ["a message used in a condition only", inCatch("if (e.message.includes('exists')) return; core.warning('failed');")],
    ["a string concatenated with outer values", inCatch("core.warning('Could not create ' + LABEL + ' (HTTP ' + Number(e.status) + ')');")],
    ["a message that only picks between fixed strings", inCatch("core.warning(e.message ? 'it has detail' : 'it has no detail');")],
    ["a numeric coercion of another field, which is a number or NaN", inCatch("core.warning(`failed (code ${Number(e.code)})`);")],
    ["a rethrow, which the step reports itself", inCatch("throw e;")],
    ["a promise callback with the status", create.replace(";", ".catch(e => core.warning(`failed (HTTP ${Number(e && e.status) || 'unknown'})`));")],
  ];
  for (const [shape, script] of BOUNDED) {
    test(`allows ${shape}`, () => {
      expect(analyzeScript(script, "t").problems).toEqual([]);
    });
  }
});

// Residual sinks and mutation flows from the independent review of #575.
test.describe("createLabel handler residual error leaks", () => {
  const create = "await github.rest.issues.createLabel({ name: 'cms/x', description: 'Fine' });";
  const inCatch = (body) => `try { ${create} } catch (e) { ${body} }`;
  const leak = /logs more than the HTTP status and a bounded type/;
  const sinks = ["console.log", "console.error", "console.warn", "core.setOutput", "core.info", "core.notice", "core.error", "core.setFailed"];
  const args = (sink, value) => sink === "core.setOutput" ? `'failure', ${value}` : value;

  for (const sink of sinks) {
    for (const value of ["e.message", "String(e)", "e.stack", "`failed ${e}`"]) {
      test(`rejects residual sink ${sink} with ${value}`, () => {
        expect(analyzeScript(inCatch(`core.warning('failed'); ${sink}(${args(sink, value)});`), "t").problems.join("\n")).toMatch(leak);
      });
    }
    test(`allows residual sink ${sink} with bounded status and type`, () => {
      const value = "`HTTP ${e.status}; ${e.name === 'HttpError' ? 'HttpError' : 'Error'}`";
      expect(analyzeScript(inCatch(`core.warning('failed'); ${sink}(${args(sink, value)});`), "t").problems).toEqual([]);
    });
  }
  for (const sink of ["console.log", "console.error", "console.warn", "core.setOutput", "core.info", "core.notice"]) {
    test(`does not treat ${sink} as a failure report`, () => {
      expect(analyzeScript(inCatch(`${sink}(${args(sink, "'fixed'")});`), "t").problems.join("\n")).toMatch(/silently caught/);
    });
  }
  for (const [sink, args] of [
    ["console['error']", "e.message"],
    ["core['setOutput']", "'failure', e.message"],
    ["core['warning']", "e.message"],
  ]) {
    test(`rejects residual computed sink ${sink}`, () => {
      expect(analyzeScript(inCatch(`core.warning('failed'); ${sink}(${args});`), "t").problems.join("\n")).toMatch(leak);
    });
    test(`allows residual computed sink ${sink} with bounded arguments`, () => {
      const bounded = sink === "core['setOutput']" ? "'failure', e.status" : "e.status";
      expect(analyzeScript(inCatch(`core.warning('failed'); ${sink}(${bounded});`), "t").problems).toEqual([]);
    });
  }
  test("counts residual computed core warning as a failure report", () => {
    expect(analyzeScript(inCatch("core['warning'](`HTTP ${e.status}`);"), "t").problems).toEqual([]);
  });
  for (const [shape, body] of [
    ["new Error message", "throw new Error(e.message);"],
    ["new Error template", "throw new Error(`failed ${e.message}`);"],
    ["new Error options", "throw new Error('failed', { cause: e });"],
    ["new Error local", "const wrapped = new Error(e.message); throw wrapped;"],
    ["message alias in new Error", "const m = e.message; throw new Error(m);"],
    ["replaced catch binding with new Error", "e = new Error(e.message); throw e;"],
    ["replaced catch binding with message", "e = e.message; throw e;"],
    ["initialized catch binding declaration", "var e = new Error(e.message); throw e;"],
    ["updated catch binding", "e++; throw e;"],
    ["console later argument", "core.warning('failed'); console.log('failed', e.message);"],
    ["array push", "const parts = []; parts.push(e.message); core.warning(parts.join(' '));"],
    ["array alias push", "const parts = []; const copy = parts; copy.push(e.message); core.warning(parts.join(' '));"],
    ["array unshift", "const parts = []; parts.unshift(e.message); core.warning(parts.join(' '));"],
    ["array splice", "const parts = []; parts.splice(0, 0, e.message); core.warning(parts.join(' '));"],
    ["array member assignment", "const parts = []; parts[0] = e.message; core.warning(parts.join(' '));"],
    ["object member assignment", "const detail = {}; detail.text = e.message; core.warning(detail.text);"],
    ["message compound assignment", "let msg = 'failed'; msg += e.message; core.warning(msg);"],
    ["message alias", "const m = e.message; core.warning(m);"],
  ]) {
    test(`rejects residual flow ${shape}`, () => {
      expect(analyzeScript(inCatch(body), "t").problems.join("\n")).toMatch(leak);
    });
  }
  for (const [shape, body] of [
    ["new Error status", "throw new Error(`HTTP ${e.status}`);"],
    ["new Error numeric coercion", "throw new Error(`code ${Number(e.code)}`);"],
    ["new Error fixed conditional", "throw new Error(e.message ? 'has detail' : 'no detail');"],
    ["new Error bounded local", "const wrapped = new Error(`HTTP ${e.status}`); throw wrapped;"],
    ["direct rethrow", "throw e;"],
    ["direct rethrow after unrelated assignment", "let count = 0; count += 1; throw e;"],
    ["direct rethrow after member assignment", "e.status = 500; throw e;"],
    ["uninitialized catch binding declaration", "var e; throw e;"],
    ["fixed warning after unrelated assignment", "let unrelated = 'fixed'; unrelated = 'other'; core.warning('failed');"],
    ["array push bounded status", "const parts = []; parts.push(e.status); core.warning(parts.join(' '));"],
    ["array alias push bounded type", "const parts = []; const copy = parts; copy.push(e.name === 'HttpError' ? 'HttpError' : 'Error'); core.warning(parts.join(' '));"],
    ["array unshift bounded status", "const parts = []; parts.unshift(e.status); core.warning(parts.join(' '));"],
    ["array splice bounded status", "const parts = []; parts.splice(0, 0, e.status); core.warning(parts.join(' '));"],
    ["array member assignment bounded status", "const parts = []; parts[0] = e.status; core.warning(parts.join(' '));"],
    ["object member assignment bounded type", "const detail = {}; detail.text = e.name === 'HttpError' ? 'HttpError' : 'Error'; core.warning(detail.text);"],
    ["compound assignment bounded status", "let msg = 'HTTP '; msg += e.status; core.warning(msg);"],
    ["bounded status alias", "const status = e.status; const copy = status; core.warning(copy);"],
  ]) {
    test(`allows residual flow ${shape}`, () => {
      expect(analyzeScript(inCatch(body), "t").problems).toEqual([]);
    });
  }
});

test("the repository lint discovers github-script label handlers in composite actions", () => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "label-action-"));
  try {
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    const dir = path.join(root, ".github", "actions", "labels");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "action.yml");
    fs.writeFileSync(file, `runs:
  using: composite
  steps:
    - uses: actions/github-script@0000000000000000000000000000000000000000
      with:
        script: |
          try {
            await github.rest.issues.createLabel({ name: 'cms/x', description: 'Fine' });
          } catch { /* already exists */ }
`);
    const files = labelDefinitionFiles(root);
    expect(files).toEqual([file]);
    const got = createLabelCalls(files);
    expect(got.calls).toHaveLength(1);
    expect(got.problems).toHaveLength(1);
    expect(got.problems[0]).toContain("action.yml");
    expect(got.problems[0]).toContain("createLabel failure is silently caught");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

// Run the real protected createLabel bodies with a scripted client, without
// executing the rest of each step (imports, comments, or publishing work).
function labelCreationHandlers() {
  const handlers = [];
  for (const file of listWorkflows()) {
    for (const block of githubScriptBlocks(fs.readFileSync(file, "utf8"))) {
      const ast = acorn.parse(block.script, PARSE_OPTIONS);
      const value = resolver(ast);
      walk.ancestor(ast, {
        CallExpression(node, ancestors) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== METHOD) return;
          const stmt = protectedTry(ancestors);
          expect(stmt && stmt.handler, "createLabel must have a testable handler").toBeTruthy();
          const fields = labelFields(node.arguments[0], value, METHOD);
          handlers.push({
            id: `${path.basename(file)} ${fields.name}`,
            name: fields.name,
            script: block.script.slice(stmt.start, stmt.end),
          });
        },
      });
    }
  }
  return handlers;
}

async function runLabelCreation(handler, error) {
  const warnings = [];
  const created = [];
  const github = { rest: { issues: { createLabel: async (args) => {
    created.push(args);
    if (error) throw error;
  } } } };
  const core = { warning: (m) => warnings.push(String(m)) };
  const context = { repo: { owner: "owner", repo: "repo" } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("github", "context", "core", "owner", "repo", "OVERRIDE_LABEL", "LABEL", handler.script)(
    github, context, core, "owner", "repo", "content-guard/override", "not-decap-created",
  );
  expect(created).toHaveLength(1);
  expect(created[0].name).toBe(handler.name);
  return warnings;
}

const PRIVATE_ERROR_TEXT = "private-error-text";
const PRIVATE_ERROR_NAME = "private-error-name";
const CASES = [
  ["success", null, null],
  ["already_exists 422", { status: 422, response: { data: { errors: [{ code: "already_exists" }] } } }, null],
  ["validation 422", { status: 422, response: { data: { errors: [{ code: "invalid" }] } } }, "422"],
  ["forbidden 403", { status: 403 }, "403"],
  ["server 500", { status: 500, name: "HttpError" }, "500"],
  ["already_exists wrong status", { status: 500, response: { data: { errors: [{ code: "already_exists" }] } } }, "500"],
  ["missing status", {}, "unknown"],
  ["missing errors", { status: 422, response: { data: {} } }, "422"],
  ["malformed errors", { status: 422, response: { data: { errors: "already_exists" } } }, "422"],
  ["null error entries", { status: 422, response: { data: { errors: [null, { code: "invalid" }] } } }, "422"],
];

test.describe("all createLabel handlers report sanitized failures", () => {
  const handlers = labelCreationHandlers();
  test("all seven label creation handlers are exercised", () => {
    expect(handlers.map((h) => h.id)).toEqual([
      "cms-editorial-workflow.yml content-guard/override",
      "cms-editorial-workflow.yml cms/draft",
      "cms-editorial-workflow.yml cms/ready",
      "cms-editorial-workflow.yml cms/preview-only",
      "label-non-decap-prs.yml not-decap-created",
      "publish-scheduled-posts.yml cms/draft",
      "publish-scheduled-posts.yml cms/ready",
    ]);
  });
  for (const handler of handlers) {
    for (const [scenario, properties, status] of CASES) {
      test(`${handler.id}: ${scenario}`, async () => {
        const error = properties && Object.assign(new Error(PRIVATE_ERROR_TEXT), {
          name: PRIVATE_ERROR_NAME,
          response: { data: { message: PRIVATE_ERROR_TEXT } },
        }, properties);
        if (error) error.response = { data: { message: PRIVATE_ERROR_TEXT, ...(error.response && error.response.data) } };
        const warnings = await runLabelCreation(handler, error);
        if (status === null) {
          expect(warnings).toEqual([]);
        } else {
          expect(warnings).toHaveLength(1);
          const type = properties.name === "HttpError" ? "HttpError" : "Error";
          expect(warnings[0]).toContain(`(HTTP ${status}; ${type})`);
          expect(warnings[0]).toContain(`Could not create the ${handler.name} label`);
          expect(warnings[0]).not.toMatch(/private-error-text|private-error-name|undefined|NaN/);
        }
      });
    }
  }
});

// Preserve the whole-step check that warnings do not prevent labeling the PR.
test("label creation warnings still allow addLabels", async () => {
  const file = listWorkflows().find((f) => path.basename(f) === "cms-editorial-workflow.yml");
  const block = githubScriptBlocks(fs.readFileSync(file, "utf8")).find((b) =>
    analyzeScript(b.script, "t").calls.some((c) => c.name === PREVIEW_ONLY),
  );
  const added = [];
  const warnings = [];
  const github = { rest: { issues: {
    createLabel: async () => { throw Object.assign(new Error(PRIVATE_ERROR_TEXT), { status: 500 }); },
    addLabels: async ({ labels }) => added.push(...labels),
  } } };
  const context = {
    repo: { owner: "owner", repo: "repo" },
    payload: { pull_request: { number: 7, base: { ref: "feature/x" } } },
  };
  const core = { warning: (m) => warnings.push(String(m)) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("github", "context", "core", block.script)(github, context, core);
  expect(warnings).toHaveLength(3);
  expect(added).toEqual(["cms/draft", PREVIEW_ONLY]);
});
