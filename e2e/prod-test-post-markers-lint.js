/*
 * AST analysis behind e2e/prod-test-post-markers.test.js (#531).
 *
 * A `@lane: real` spec that opens a posts new-entry form publishes a post on a
 * live site, so it must call `markEphemeralTestPost(page, { title })`
 * (e2e/cms-editor-ui.js) before the next Save. This module finds every place a
 * source file could open such a form and whether the marker call precedes the
 * next Save.
 *
 * It parses with acorn (never a regex scan of source: a route is routinely a
 * template literal around a variable, `${PROD_ADMIN}#/collections/posts/new`)
 * and FAILS CLOSED. A lint that only looked at `goto("...")` arguments was
 * blind to a URL held in a variable or constant, `goto(urls.newPost)`,
 * `page["goto"](u)`, a click on `a[href="#/collections/posts/new"]`, a
 * `location.hash` assignment and a helper in another module. So:
 *
 *   - EVERY string, template, `+` concatenation and `[...].join()` in the file
 *     is resolved (constants one level deep, interpolations folded in) and
 *     matched against the new-entry route; a `${…}` collection segment counts
 *     as possibly `posts`.
 *   - A route held in a binding is a creation site at each USE of the binding.
 *   - A function that contains such a route, here or in any module the spec
 *     requires transitively, makes every call to it a creation site.
 *   - A `goto(...)` whose argument cannot be resolved to a static route is
 *     reported, to be allowlisted with a reason or fixed.
 *   - A marker call counts only with a `title`, and not inside a branch that
 *     can never run (`if (false)`, `false && mark()`).
 *   - A raw `getByRole("button", { name: /save/i }).click()` is a Save.
 */
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { parse } = require("./spec-ast");

const MARK = "markEphemeralTestPost";
const SAVE_CALLS = new Set(["saveEntry", "publishViaUi"]);
const HOLE = "${…}";
// The posts new-entry route, or one whose collection is a hole that may be it.
const NEW_ROUTE = /collections\/(?:posts|\$\{…\})\/new\b/;
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
// Wrappers a route can sit in between its string and the binding it initializes.
const TRANSPARENT = new Set([
  "Property",
  "ObjectExpression",
  "ArrayExpression",
  "TemplateLiteral",
  "BinaryExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "SpreadElement",
  "ChainExpression",
  "CallExpression",
]);

// ── per-file index ───────────────────────────────────────────────────────
function index(src) {
  const ast = parse(src);
  const nodes = []; // { node, ancestors } for every node, source order
  const consts = new Map(); // name -> [init nodes] for `const` bindings
  const anyDecls = new Map(); // name -> [declarator nodes] for any binding kind
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    nodes.push({ node, ancestors: ancestors.slice(0, -1) });
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier" || !d.init) continue;
        if (!anyDecls.has(d.id.name)) anyDecls.set(d.id.name, []);
        anyDecls.get(d.id.name).push(d);
        if (node.kind === "const") {
          if (!consts.has(d.id.name)) consts.set(d.id.name, []);
          consts.get(d.id.name).push(d.init);
        }
      }
    }
  });
  nodes.sort((a, b) => a.node.start - b.node.start);
  return { src, ast, nodes, consts, anyDecls };
}

// Static string for a node, constants one level deep (the chain is capped so a
// cycle cannot loop). Anything unknown becomes HOLE; a node with nothing
// static at all returns null.
function resolve(ix, node, depth = 0) {
  if (!node) return null;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? node.value : null;
    case "TemplateLiteral": {
      let out = "";
      node.quasis.forEach((q, i) => {
        out += q.value.cooked != null ? q.value.cooked : q.value.raw;
        if (i < node.expressions.length) out += resolve(ix, node.expressions[i], depth + 1) ?? HOLE;
      });
      return out;
    }
    case "BinaryExpression": {
      if (node.operator !== "+") return null;
      const l = resolve(ix, node.left, depth + 1);
      const r = resolve(ix, node.right, depth + 1);
      if (l == null && r == null) return null;
      return (l ?? HOLE) + (r ?? HOLE);
    }
    case "Identifier": {
      const inits = ix.consts.get(node.name);
      if (!inits || inits.length !== 1 || depth >= 3) return null;
      return resolve(ix, inits[0], depth + 1);
    }
    case "CallExpression": {
      const c = node.callee;
      if (c.type !== "MemberExpression" || c.computed || c.property.name !== "join") return null;
      if (c.object.type !== "ArrayExpression") return null;
      const sep = node.arguments.length ? resolve(ix, node.arguments[0], depth + 1) : ",";
      if (sep == null) return null;
      return c.object.elements.map((e) => resolve(ix, e, depth + 1) ?? HOLE).join(sep);
    }
    default:
      return null;
  }
}

// Truthiness of a node when it is a constant, else undefined.
function constTruth(ix, node, depth = 0) {
  if (!node || depth > 3) return undefined;
  switch (node.type) {
    case "Literal":
      return node.regex ? true : Boolean(node.value);
    case "TemplateLiteral": {
      const s = resolve(ix, node);
      return s != null && !s.includes(HOLE) ? s.length > 0 : undefined;
    }
    case "Identifier": {
      if (node.name === "undefined") return false;
      const inits = ix.consts.get(node.name);
      return inits && inits.length === 1 ? constTruth(ix, inits[0], depth + 1) : undefined;
    }
    case "UnaryExpression": {
      if (node.operator === "void") return false;
      if (node.operator !== "!") return undefined;
      const v = constTruth(ix, node.argument, depth + 1);
      return v === undefined ? undefined : !v;
    }
    case "LogicalExpression": {
      const l = constTruth(ix, node.left, depth + 1);
      const r = constTruth(ix, node.right, depth + 1);
      if (node.operator === "&&") {
        if (l === false || r === false) return false;
        return l === true && r === true ? true : undefined;
      }
      if (node.operator === "||") {
        if (l === true || r === true) return true;
        return l === false && r === false ? false : undefined;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// Can `node` (whose enclosing nodes are `ancestors`, outermost first) never run?
function isDead(ix, node, ancestors) {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === "IfStatement" || a.type === "ConditionalExpression") {
      const t = constTruth(ix, a.test);
      if (child === a.consequent && t === false) return true;
      if (child === a.alternate && t === true) return true;
    } else if (a.type === "LogicalExpression" && child === a.right) {
      const l = constTruth(ix, a.left);
      if (a.operator === "&&" && l === false) return true;
      if (a.operator === "||" && l === true) return true;
    } else if (a.type === "WhileStatement" || a.type === "ForStatement") {
      if (child === a.body && a.test && constTruth(ix, a.test) === false) return true;
    }
    child = a;
  }
  return false;
}

// The called name, seeing through `page["goto"]` and `page.goto.call(page, …)`.
// For `.call`/`.apply` the returned args are the callee's own arguments.
function calleeInfo(ix, call) {
  const c = call.callee;
  const memberName = (m) => {
    if (m.type !== "MemberExpression") return null;
    if (!m.computed) return m.property.name || null;
    const s = resolve(ix, m.property);
    return s != null && !s.includes(HOLE) ? s : "<computed>";
  };
  if (c.type === "Identifier") return { tail: c.name, args: call.arguments };
  const tail = memberName(c);
  if (tail === "call" || tail === "apply") {
    const inner = memberName(c.object);
    if (inner) {
      return { tail: inner, args: tail === "call" ? call.arguments.slice(1) : [null] };
    }
  }
  return { tail, args: call.arguments };
}

// A raw `getByRole("button", { name: …save… }).click()` in the callee chain.
function isRawSaveClick(ix, call, info) {
  if (info.tail !== "click") return false;
  let n = call.callee;
  while (n) {
    if (n.type === "MemberExpression") n = n.object;
    else if (n.type === "CallExpression") {
      const inner = calleeInfo(ix, n);
      if (inner.tail === "getByRole" && resolve(ix, inner.args[0]) === "button") {
        const opts = inner.args[1];
        const prop =
          opts &&
          opts.type === "ObjectExpression" &&
          opts.properties.find((p) => p.key && (p.key.name === "name" || p.key.value === "name"));
        if (!prop) return false;
        const v = prop.value;
        if (v && v.regex) return /save/i.test(v.regex.pattern);
        const s = resolve(ix, v);
        return s == null || /save/i.test(s); // a name we cannot read: assume Save
      }
      n = n.callee;
    } else if (n.type === "ChainExpression") n = n.expression;
    else if (n.type === "AwaitExpression") n = n.argument;
    else return false;
  }
  return false;
}

// Does `call` carry a real title: `markEphemeralTestPost(page, { title })`?
function hasTitle(ix, call) {
  const opts = call.arguments[1];
  if (!opts || opts.type !== "ObjectExpression") return false;
  const prop = opts.properties.find(
    (p) => p.type === "Property" && !p.computed && p.key && (p.key.name === "title" || p.key.value === "title"),
  );
  if (!prop) return false;
  const v = prop.value;
  if (v.type === "Identifier" && v.name === "undefined") return false;
  if (v.type === "Literal" && (v.value === null || v.value === "")) return false;
  return true;
}

function nearestNamedFunction(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (!FUNCTION_TYPES.has(a.type)) continue;
    const name = functionName(a, ancestors.slice(0, i));
    if (name) return { fn: a, name };
  }
  return null;
}

function functionName(fn, ancestors) {
  if (fn.id && fn.id.name) return fn.id.name;
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return null;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent.type === "Property" && !parent.computed && parent.key) return parent.key.name || parent.key.value || null;
  if (parent.type === "MethodDefinition" && parent.key) return parent.key.name || null;
  if (parent.type === "AssignmentExpression") {
    const l = parent.left;
    if (l.type === "Identifier") return l.name;
    if (l.type === "MemberExpression" && !l.computed) return l.property.name;
  }
  return null;
}

// ── shared facts: route strings, calls, creator functions ─────────────────
function routeNodes(ix) {
  const out = [];
  for (const { node, ancestors } of ix.nodes) {
    const stringish =
      (node.type === "Literal" && typeof node.value === "string") ||
      node.type === "TemplateLiteral" ||
      (node.type === "BinaryExpression" && node.operator === "+") ||
      (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.name === "join");
    if (!stringish) continue;
    const parent = ancestors[ancestors.length - 1];
    // Only the outermost piece of a concatenation / template: its folded value
    // already contains the inner pieces.
    if (parent && ((parent.type === "BinaryExpression" && parent.operator === "+") || parent.type === "TemplateLiteral")) continue;
    const value = resolve(ix, node);
    if (value != null && NEW_ROUTE.test(value)) out.push({ node, ancestors, value });
  }
  return out;
}

function callFacts(ix) {
  const calls = [];
  for (const { node, ancestors } of ix.nodes) {
    if (node.type !== "CallExpression") continue;
    const info = calleeInfo(ix, node);
    calls.push({ node, ancestors, tail: info.tail, args: info.args, start: node.start, line: node.loc.start.line, info });
  }
  return calls;
}

// Named functions that open a posts new-entry form: they contain such a route,
// or call another such function (to a fixed point), or are in `external`.
function creatorFunctions(ix, calls, routes, external = new Set()) {
  const fns = [];
  for (const { node, ancestors } of ix.nodes) {
    if (!FUNCTION_TYPES.has(node.type)) continue;
    const name = functionName(node, ancestors);
    if (name) fns.push({ node, name });
  }
  const contains = (fn, n) => n.start >= fn.node.start && n.end <= fn.node.end;
  const creators = new Set();
  for (const fn of fns) if (routes.some((r) => contains(fn, r.node))) creators.add(fn.name);
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of fns) {
      if (creators.has(fn.name)) continue;
      if (calls.some((c) => contains(fn, c.node) && (creators.has(c.tail) || external.has(c.tail)))) {
        creators.add(fn.name);
        changed = true;
      }
    }
  }
  return creators;
}

// Names of functions, across the helper modules' sources, that open a posts
// form. Run to a fixed point over ALL the sources, so a wrapper in one module
// around a creator in another is a creator too.
function helperCreators(sources) {
  const parsed = sources.map((src) => {
    const ix = index(src);
    return { ix, calls: callFacts(ix), routes: routeNodes(ix) };
  });
  const names = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const { ix, calls, routes } of parsed) {
      for (const name of creatorFunctions(ix, calls, routes, names)) {
        if (!names.has(name)) {
          names.add(name);
          changed = true;
        }
      }
    }
  }
  return names;
}

// Source of every module a spec requires, transitively (relative requires).
function requiredModuleSources(specPath) {
  const seen = new Map();
  const queue = [path.resolve(specPath)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    seen.set(file, src);
    const ix = index(src);
    for (const { node } of ix.nodes) {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "require") continue;
      const spec = node.arguments[0];
      const target = spec && spec.type === "Literal" ? spec.value : null;
      if (typeof target !== "string" || !target.startsWith(".")) continue;
      const resolved = require.resolve(path.resolve(path.dirname(file), target));
      if (resolved.endsWith(".js")) queue.push(resolved);
    }
  }
  seen.delete(path.resolve(specPath));
  return [...seen.values()];
}

// ── the analysis ─────────────────────────────────────────────────────────
// Returns { sites, gotos, creators }:
//   sites   [{ line, saveLine, marked, note }] every place a posts form opens
//   gotos   [{ line, arg }]  every goto() whose target is not a static route
function analyze(src, { externalCreators = new Set() } = {}) {
  const ix = index(src);
  const calls = callFacts(ix);
  const routes = routeNodes(ix);
  const localCreators = creatorFunctions(ix, calls, routes, externalCreators);
  const allCreators = new Set([...localCreators, ...externalCreators]);
  const text = (n) => ix.src.slice(n.start, n.end).replace(/\s+/g, " ");

  // Creation sites: { start, line }.
  const sites = [];
  const refsTo = (name) =>
    ix.nodes.filter(({ node, ancestors }) => {
      if (node.type !== "Identifier" || node.name !== name) return false;
      const p = ancestors[ancestors.length - 1];
      if (!p) return true;
      if (p.type === "VariableDeclarator" && p.id === node) return false;
      if (p.type === "MemberExpression" && p.property === node && !p.computed) return false;
      if (p.type === "Property" && p.key === node && !p.computed && !p.shorthand) return false;
      return true;
    });

  const usedCreators = new Set();
  for (const c of calls) if (allCreators.has(c.tail) || c.tail === "collectionNewLink") usedCreators.add(c.tail);

  for (const r of routes) {
    // A route inside a local creator function is reported at that function's
    // call sites instead — unless nothing calls it, then at the route itself.
    const fn = nearestNamedFunction(r.ancestors);
    if (fn && localCreators.has(fn.name) && usedCreators.has(fn.name)) continue;
    // A route bound to a name is opened wherever the name is used.
    let holder = null;
    for (let i = r.ancestors.length - 1; i >= 0; i--) {
      const a = r.ancestors[i];
      if (a.type === "VariableDeclarator" && a.id.type === "Identifier") {
        holder = a.id.name;
        break;
      }
      if (!TRANSPARENT.has(a.type)) break;
    }
    const uses = holder ? refsTo(holder) : [];
    if (uses.length) for (const u of uses) sites.push({ start: u.node.start, line: u.node.loc.start.line });
    else sites.push({ start: r.node.start, line: r.node.loc.start.line });
  }
  for (const c of calls) {
    if (c.tail === "collectionNewLink") {
      const label = resolve(ix, c.args[1]);
      if (label == null || /post|\$\{…\}/i.test(label)) sites.push({ start: c.start, line: c.line });
    } else if (allCreators.has(c.tail)) {
      sites.push({ start: c.start, line: c.line });
    }
  }

  // goto() targets that are not a static route.
  const gotos = [];
  for (const c of calls) {
    if (c.tail !== "goto") continue;
    const arg = c.args[0];
    const s = arg && arg.type !== "SpreadElement" ? resolve(ix, arg) : null;
    if (s == null || (s.includes(HOLE) && !s.includes("#/"))) {
      gotos.push({ line: c.line, arg: arg ? text(arg) : "<none>" });
    }
  }
  // A goto that is aliased or destructured instead of called.
  for (const { node, ancestors } of ix.nodes) {
    if (node.type === "ObjectPattern") {
      for (const prop of node.properties) {
        const key = prop.key && !prop.computed ? prop.key.name || prop.key.value : null;
        if (key === "goto") gotos.push({ line: node.loc.start.line, arg: "<goto reference>" });
      }
      continue;
    }
    if (node.type !== "MemberExpression" || node.computed || node.property.name !== "goto") continue;
    const p = ancestors[ancestors.length - 1];
    const g = ancestors[ancestors.length - 2];
    const calledDirectly = p && p.type === "CallExpression" && p.callee === node;
    const viaCall =
      p && p.type === "MemberExpression" && ["call", "apply"].includes(p.property.name) && g && g.type === "CallExpression" && g.callee === p;
    if (!calledDirectly && !viaCall) gotos.push({ line: node.loc.start.line, arg: "<goto reference>" });
  }

  // Marker and Save calls.
  const saves = calls.filter((c) => SAVE_CALLS.has(c.tail) || isRawSaveClick(ix, c.node, c.info));
  const markers = calls.filter((c) => c.tail === MARK);
  const live = markers.filter((m) => !isDead(ix, m.node, m.ancestors) && hasTitle(ix, m.node));

  const results = [];
  const seen = new Set();
  sites.sort((a, b) => a.start - b.start);
  for (const site of sites) {
    if (seen.has(site.start)) continue;
    seen.add(site.start);
    const save = saves.find((s) => s.start > site.start);
    const end = save ? save.start : Infinity;
    const inWindow = (m) => m.start > site.start && m.start < end;
    const marked = live.some(inWindow);
    let note = "";
    if (!marked) {
      const near = markers.find(inWindow);
      if (near) note = isDead(ix, near.node, near.ancestors) ? "the marker call can never run" : "the marker call has no title";
    }
    results.push({ line: site.line, saveLine: save ? save.line : null, marked, note });
  }
  return { sites: results, gotos, creators: localCreators };
}

module.exports = { MARK, analyze, helperCreators, requiredModuleSources, index, calleeInfo, isDead, resolve };
