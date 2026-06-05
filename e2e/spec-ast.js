/*
 * AST facts for the guard-registry lint (and any future code-shape lint).
 *
 * "AST always, not regex." A lint that reasons about CODE STRUCTURE — which
 * test() blocks exist, whether a guard call sits in a given scope, which
 * collection a `page.goto` navigates — MUST parse a real AST, never regex-scan
 * the source. Regex on source is brittle: it false-matches tokens inside
 * comments/strings, mis-reads across line breaks, and is blind to interpolation
 * (it was a regex that couldn't see `page.goto(`…#/collections/${CANARY.cmsCollection}`)`
 * — a VARIABLE collection name — which let the jodidaniel host-loop guard gap
 * ship). This mirrors `workflow-yaml-utils.js`, which parses workflow YAML with
 * the `yaml` parser for the same reason.
 *
 * `analyzeSpec(src)` parses once with acorn and returns a structured fact bag;
 * the detectors in base-collections-guard-registry.test.js consume facts, never
 * raw text. Template literals are reconstructed with a `${…}` placeholder for
 * each interpolation, so a dynamic collection route is preserved STRUCTURALLY
 * (`#/collections/${…}`) instead of vanishing.
 */
const acorn = require("acorn");
const walk = require("acorn-walk");

// Parse a spec source to an ESTree AST. Specs are CommonJS (require), but some
// may use modern syntax; try module mode first (permits import/export + the
// widest grammar), fall back to script mode.
function parse(src) {
  const opts = { ecmaVersion: "latest", locations: true };
  try {
    return acorn.parse(src, { ...opts, sourceType: "module" });
  } catch {
    return acorn.parse(src, { ...opts, sourceType: "script", allowReturnOutsideFunction: true });
  }
}

// Reconstruct a string-ish value from a Literal or TemplateLiteral. A
// TemplateLiteral's interpolations become the literal token "${…}" so a dynamic
// segment is visible structurally without resolving it. Returns null for any
// other node (so callers can tell "not a static-ish string" apart from "").
function stringValue(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    let out = "";
    node.quasis.forEach((q, i) => {
      out += q.value.cooked != null ? q.value.cooked : q.value.raw;
      if (i < node.expressions.length) out += "${…}";
    });
    return out;
  }
  // A `"a" + b` style concat: fold the static halves, placeholder the rest.
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = stringValue(node.left);
    const r = stringValue(node.right);
    if (l == null && r == null) return null;
    return (l == null ? "${…}" : l) + (r == null ? "${…}" : r);
  }
  return null;
}

// The dotted name of a callee, e.g. `page.goto` → "page.goto",
// `test.skip` → "test.skip", `guard` → "guard", `cap.keepsBaseCollection` →
// "cap.keepsBaseCollection". Returns the trailing property for deeper chains
// (`a.b.c()` → "a.b.c"). null for computed/other callees.
function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    const obj = calleeName(callee.object);
    const prop = callee.property && callee.property.name;
    if (!prop) return null;
    return obj ? `${obj}.${prop}` : prop;
  }
  return null;
}

// Last segment of a dotted callee name ("page.goto" → "goto").
function calleeTail(name) {
  return name == null ? null : name.split(".").pop();
}

function analyzeSpec(src) {
  const ast = parse(src);

  const facts = {
    ast,
    strings: [], // every static-ish string value (Literal / TemplateLiteral / concat)
    identifiers: new Set(), // every Identifier name referenced
    memberProps: new Set(), // every non-computed MemberExpression property (e.g. publicPath)
    regexes: [], // every regex literal's source pattern
    requires: new Set(), // module specifiers passed to require()
    calls: [], // { name, tail, args:[node], node }
    gotoArgs: [], // reconstructed string of the FIRST arg to every *.goto(...)
    getByRoleLinkNames: [], // regex source of name in getByRole("link",{name:/…/})
    topLevelTests: [], // { title, tags:[...], node } for column-0 test()/test.skip()/test.only()
  };

  walk.full(ast, (node) => {
    switch (node.type) {
      case "Identifier":
        facts.identifiers.add(node.name);
        break;
      case "MemberExpression":
        if (!node.computed && node.property && node.property.name) {
          facts.memberProps.add(node.property.name);
        }
        break;
      case "Literal":
        if (node.regex) facts.regexes.push(node.regex.pattern);
        else if (typeof node.value === "string") facts.strings.push(node.value);
        break;
      case "TemplateLiteral": {
        const s = stringValue(node);
        if (s != null) facts.strings.push(s);
        break;
      }
      case "CallExpression": {
        const name = calleeName(node.callee);
        const tail = calleeTail(name);
        facts.calls.push({ name, tail, args: node.arguments, node });
        if (tail === "goto") {
          const s = stringValue(node.arguments[0]);
          if (s != null) facts.gotoArgs.push(s);
        }
        if (name === "require") {
          const s = stringValue(node.arguments[0]);
          if (s != null) facts.requires.add(s);
        }
        if (tail === "getByRole") {
          const role = stringValue(node.arguments[0]);
          const opts = node.arguments[1];
          if (role === "link" && opts && opts.type === "ObjectExpression") {
            const nameProp = opts.properties.find(
              (p) => p.key && (p.key.name === "name" || p.key.value === "name"),
            );
            if (nameProp && nameProp.value && nameProp.value.regex) {
              facts.getByRoleLinkNames.push(nameProp.value.regex.pattern);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  });

  // Top-level test() / test.skip() / test.only() calls — i.e. ExpressionStatement
  // children of the Program whose call is `test(...)` or `test.<modifier>(...)`.
  // (describe()-nested tests are not Program-level, matching the old column-0
  // regex but robustly — indentation/formatting independent.)
  for (const stmt of ast.body) {
    if (stmt.type !== "ExpressionStatement" || !stmt.expression) continue;
    const call = stmt.expression;
    if (call.type !== "CallExpression") continue;
    const name = calleeName(call.callee);
    const isTest = name === "test" || /^test\.(skip|only)$/.test(name || "");
    if (!isTest) continue;
    const title = stringValue(call.arguments[0]);
    // Tags can be in an options object arg: { tag: "@x" | ["@x", …] }.
    const tags = [];
    for (const a of call.arguments) {
      if (a && a.type === "ObjectExpression") {
        const tagProp = a.properties.find((p) => p.key && (p.key.name === "tag" || p.key.value === "tag"));
        if (tagProp) {
          if (tagProp.value.type === "ArrayExpression") {
            tagProp.value.elements.forEach((e) => {
              const s = stringValue(e);
              if (s) tags.push(s);
            });
          } else {
            const s = stringValue(tagProp.value);
            if (s) tags.push(s);
          }
        }
      }
    }
    facts.topLevelTests.push({ title: title || "(unnamed)", tags, node: call });
  }

  return facts;
}

// Does any CallExpression in `node`'s subtree match `pred({name, tail, args})`?
function subtreeHasCall(node, pred) {
  let found = false;
  walk.full(node, (n) => {
    if (found) return;
    if (n.type === "CallExpression") {
      const name = calleeName(n.callee);
      if (pred({ name, tail: calleeTail(name), args: n.arguments, node: n })) found = true;
    }
  });
  return found;
}

// Every string value (Literal/Template/concat) anywhere in `node`'s subtree.
function subtreeStrings(node) {
  const out = [];
  walk.full(node, (n) => {
    if (n.type === "Literal" && typeof n.value === "string") out.push(n.value);
    else if (n.type === "TemplateLiteral") {
      const s = stringValue(n);
      if (s != null) out.push(s);
    }
  });
  return out;
}

module.exports = {
  parse,
  analyzeSpec,
  stringValue,
  calleeName,
  calleeTail,
  subtreeHasCall,
  subtreeStrings,
};
