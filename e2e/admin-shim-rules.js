// Shared code-shape detectors for the theme/admin/ shims.
//
// Extracted so the #329 lint (admin-329-shims.test.js) and the publishing-UX
// phase 2-5 lint (admin-publishing-ux.test.js) drive ONE detector rather than
// two copies — the same reasoning that keeps e2e/pin-comment-rules.js single:
// two copies of a rule are two rules, and they drift.
//
// AST, never regex, per AGENTS.md's standing rule — and here the rule has
// already been paid for once. The first draft of the fixed-overlay check was
// `/position\s*:\s*fixed/` over the source, and it red-failed the very file it
// was written to bless, because that file's header comment EXPLAINS the
// fixed-overlay defect it exists to prevent. A lint that forbids naming the
// thing it forbids is a lint nobody can document around. Comments do not exist
// in an AST, by construction.
const acorn = require("acorn");
const walk = require("acorn-walk");

function parse(src) {
  try {
    return acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
  }
}

// Every place a source actually asks for `position: fixed`, as opposed to
// merely mentioning it. Covers the three shapes an admin shim could use: a
// `cssText`/style string carrying `position:fixed`, `el.style.position =
// "fixed"`, and `el.style.setProperty("position", "fixed")`.
function fixedPositionEvidence(src) {
  const ast = parse(src);
  const FIXED_IN_CSS = /position\s*:\s*fixed/i;
  const hits = [];
  const isFixed = (n) => n && n.type === "Literal" && String(n.value).toLowerCase() === "fixed";
  walk.simple(ast, {
    Literal(n) {
      if (typeof n.value === "string" && FIXED_IN_CSS.test(n.value)) hits.push(n.value.slice(0, 60));
    },
    TemplateLiteral(n) {
      for (const q of n.quasis) {
        const v = q.value.cooked || "";
        if (FIXED_IN_CSS.test(v)) hits.push(v.slice(0, 60));
      }
    },
    AssignmentExpression(n) {
      const l = n.left;
      if (
        l.type === "MemberExpression" &&
        !l.computed &&
        l.property.name === "position" &&
        isFixed(n.right)
      ) {
        hits.push('style.position = "fixed"');
      }
    },
    CallExpression(n) {
      const c = n.callee;
      if (
        c.type === "MemberExpression" &&
        !c.computed &&
        c.property.name === "setProperty" &&
        n.arguments.length >= 2 &&
        n.arguments[0].type === "Literal" &&
        String(n.arguments[0].value).toLowerCase() === "position" &&
        isFixed(n.arguments[1])
      ) {
        hits.push('setProperty("position", "fixed")');
      }
    },
  });
  return hits;
}

// True when the source contains `el.style.setProperty("display", "none", ...)`
// — the CSS-hide idiom native-preview-href.js established. Asking for the CALL
// rather than for the string "display:none" is what makes this a structural
// claim: a shim that merely documents the idiom in a comment does not pass.
function hasCssDisplayNoneHide(src) {
  const ast = parse(src);
  let found = false;
  walk.simple(ast, {
    CallExpression(n) {
      const c = n.callee;
      if (
        c.type === "MemberExpression" &&
        !c.computed &&
        c.property.name === "setProperty" &&
        n.arguments.length >= 2 &&
        n.arguments[0].type === "Literal" &&
        String(n.arguments[0].value).toLowerCase() === "display" &&
        n.arguments[1].type === "Literal" &&
        String(n.arguments[1].value).toLowerCase() === "none"
      ) {
        found = true;
      }
    },
  });
  return found;
}

// The receiver of every `X.removeChild(...)` call, as source text. A shim that
// hides a Decap-owned control must never remove one: React re-mounts what it
// owns and the resulting fight loop wedged the editor mid-flow at commit
// 503365a. Removing a node the SHIM ITSELF created is fine, so the lint asks
// WHICH object is being emptied rather than banning the method outright.
function removeChildReceivers(src) {
  const ast = parse(src);
  const out = [];
  walk.simple(ast, {
    CallExpression(n) {
      const c = n.callee;
      if (c.type === "MemberExpression" && !c.computed && c.property.name === "removeChild") {
        out.push(src.slice(c.object.start, c.object.end));
      }
    },
  });
  return out;
}

// Every string literal in the source, so a lint can assert that two literals
// which MUST stay in lockstep still do.
function stringLiterals(src) {
  const ast = parse(src);
  const out = [];
  walk.simple(ast, {
    Literal(n) {
      if (typeof n.value === "string") out.push(n.value);
    },
  });
  return out;
}

// Whether the source reads a given `<object>.<property>` member anywhere —
// e.g. `document.hidden`. A leaf-token grep would also match the words inside
// a comment explaining why the guard exists, which is the same trap the
// fixed-overlay check fell into.
function readsMember(src, objectName, propertyName) {
  const ast = parse(src);
  let found = false;
  walk.simple(ast, {
    MemberExpression(n) {
      if (
        !n.computed &&
        n.object.type === "Identifier" &&
        n.object.name === objectName &&
        n.property.name === propertyName
      ) {
        found = true;
      }
    },
  });
  return found;
}

// Whether the source has an `if (...) return;` (no value) whose test mentions
// the given identifier — the "inert unless configured" guard shape.
function hasBareReturnGuardOn(src, identifierName) {
  const ast = parse(src);
  let found = false;
  const testMentions = (node) => {
    let hit = false;
    walk.simple(node, {
      Identifier(n) {
        if (n.name === identifierName) hit = true;
      },
    });
    return hit;
  };
  const consequentBareReturns = (node) => {
    let hit = false;
    walk.simple(node, {
      ReturnStatement(n) {
        if (!n.argument) hit = true;
      },
    });
    return hit;
  };
  walk.simple(ast, {
    IfStatement(n) {
      if (testMentions(n.test) && consequentBareReturns(n.consequent)) found = true;
    },
  });
  return found;
}

module.exports = {
  fixedPositionEvidence,
  hasCssDisplayNoneHide,
  removeChildReceivers,
  stringLiterals,
  readsMember,
  hasBareReturnGuardOn,
};
