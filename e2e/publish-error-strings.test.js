// @lane: local — PURE-FS code-shape lint (NO Jekyll build, NO browser).
//
// #386 — `publishViaUi()` must be able to RECOGNISE the toolbar's two
// silent publish-failure outcomes, and that recognition must not go stale
// against the copy it's actually reading.
//
// ── The incident ─────────────────────────────────────────────────────────
// theme/admin/publish-button.js's `doPublish()` renders one of two error
// notes into the state-bar slot and RETURNS WITHOUT THROWING when a publish
// cannot be armed: (a) `!prNumber || !token` → "This could not be published
// right now. …", or (b) a non-2xx labels POST → "The website did not accept
// the publish just now (…). …". `publishViaUi()` in e2e/cms-editor-ui.js
// used to click the confirmation and return, unable to tell either from a
// real success — which is how a silent (a) on an entry UPDATE cost 34
// minutes of an unrelated deploy-lane timeout before the real cause showed
// at all (adamdaniel.ai run 33573287045, cms-platform#386).
//
// The fix keeps two lowercase SUBSTRINGS of the shim's own text as local
// constants in cms-editor-ui.js (PUBLISH_NOT_READY_TEXT /
// PUBLISH_REJECTED_TEXT) and checks the slot against them after confirming.
// That is a NEW seam between two files that don't otherwise share code, and
// a seam with no verifier is exactly what let the pin-comment convention
// (AGENTS.md) and the #382 Status-selector convention both drift out of
// true before anyone wrote a lint for either. This is that lint.
//
// ── Why a lint, and why an AST one ─────────────────────────────────────
// The question is a CODE-SHAPE one — "does publishViaUi's function BODY
// reference this exact substring" and "does publish-button.js's doPublish()
// still render text containing it" — not a lexical one, so it parses (the
// house AST rule; a regex over the whole file would also match either
// substring sitting in a comment, which proves nothing about whether the
// code still checks for it).
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");
const { subtreeStrings, stringValue } = require("./spec-ast");

const REPO_ROOT = path.join(__dirname, "..");
const HELPER_PATH = path.join(__dirname, "cms-editor-ui.js");
const SHIM_PATH = path.join(REPO_ROOT, "theme", "admin", "publish-button.js");

// The two substrings publishViaUi checks for — kept here as the lint's OWN
// copy (not required from cms-editor-ui.js: a require would run the module,
// and this lint's whole point is to notice if that file's copy drifted).
const MARKERS = ["could not be published right now", "did not accept the publish just now"];

function parse(src) {
  try {
    return acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
  }
}

// The named top-level function's own AST node (FunctionDeclaration, exact
// name match), or null. Walks the WHOLE tree so a function nested inside an
// IIFE (publish-button.js's shape) is still found.
function findFunction(ast, name) {
  let found = null;
  walk.full(ast, (node) => {
    if (found) return;
    if (node.type === "FunctionDeclaration" && node.id && node.id.name === name) {
      found = node;
    }
  });
  return found;
}

// Top-level `const NAME = <string-ish>;` declarations in `ast`'s Program
// body, as Map<name, string>. PROGRAM-LEVEL only — cms-editor-ui.js keeps
// its two markers as module-scope constants (PUBLISH_NOT_READY_TEXT /
// PUBLISH_REJECTED_TEXT) rather than duplicating the literal inline inside
// publishViaUi(), so a function-subtree-only string scan would miss them
// entirely; this is what lets a reference-through-a-constant count as
// "referencing the marker" just as much as an inline literal does.
function topLevelStringConsts(ast) {
  const map = new Map();
  for (const stmt of ast.body) {
    if (stmt.type !== "VariableDeclaration" || stmt.kind !== "const") continue;
    for (const decl of stmt.declarations) {
      if (!decl.id || decl.id.type !== "Identifier" || !decl.init) continue;
      const s = stringValue(decl.init);
      if (s != null) map.set(decl.id.name, s);
    }
  }
  return map;
}

// Every string `fn`'s body could actually produce at runtime: its own
// literal/template/concat strings, PLUS the resolved value of any
// top-level `const` it references by Identifier — joined and lowercased
// into one blob so `.includes()` finds a marker regardless of which form
// (inline literal, split concat, or a shared constant) supplied it.
function resolvedStringBlob(ast, fn) {
  const consts = topLevelStringConsts(ast);
  const parts = subtreeStrings(fn);
  walk.full(fn, (n) => {
    if (n.type === "Identifier" && consts.has(n.name)) parts.push(consts.get(n.name));
  });
  return parts.join(" ").toLowerCase();
}

test.describe("#386 publishViaUi recognises the toolbar's silent failure text", () => {
  test("cms-editor-ui.js's publishViaUi references both marker substrings", () => {
    const src = fs.readFileSync(HELPER_PATH, "utf8");
    const ast = parse(src);
    const fn = findFunction(ast, "publishViaUi");
    expect(fn, "cms-editor-ui.js must still declare a top-level publishViaUi() function").toBeTruthy();
    const blob = resolvedStringBlob(ast, fn);
    for (const marker of MARKERS) {
      expect(
        blob.includes(marker),
        `publishViaUi() must check the publish-state slot for "${marker}" — without it, a ` +
          `silent doPublish() failure (theme/admin/publish-button.js) reads as a successful ` +
          `publish and the caller times out ~34 minutes later somewhere else entirely (#386)`,
      ).toBe(true);
    }
  });

  test("theme/admin/publish-button.js's doPublish() still renders both marker substrings", () => {
    const src = fs.readFileSync(SHIM_PATH, "utf8");
    const ast = parse(src);
    const fn = findFunction(ast, "doPublish");
    expect(fn, "publish-button.js must still declare a top-level doPublish() function").toBeTruthy();
    const blob = resolvedStringBlob(ast, fn);
    for (const marker of MARKERS) {
      expect(
        blob.includes(marker),
        `doPublish() must still render text containing "${marker}" — this is the STRING-EQUALITY ` +
          `half of the #386 fix: a cosmetic wording change here that drops one of these markers ` +
          `silently reopens the gap publishViaUi()'s check exists to close, with nothing red to ` +
          `say so`,
      ).toBe(true);
    }
  });

  // NEGATIVE CONTROL. Without this, deleting the markers from BOTH files at
  // once (or renaming doPublish/publishViaUi so findFunction returns null
  // silently) would leave every assertion above vacuously true-shaped —
  // `expect(fn, …).toBeTruthy()` still fails on a null fn, but prove the
  // detector's STRING match itself can fail, on a fixture the two real tests
  // never see.
  test("the detector actually fails on a function missing the markers (inline literal)", () => {
    const src = `
      function doPublish() {
        var lastError = "everything is fine, nothing to see here";
      }
    `;
    const ast = parse(src);
    const fn = findFunction(ast, "doPublish");
    expect(fn).toBeTruthy();
    const blob = resolvedStringBlob(ast, fn);
    for (const marker of MARKERS) {
      expect(blob.includes(marker)).toBe(false);
    }
  });

  // Same negative control for the CONST-RESOLUTION path specifically:
  // referencing a top-level constant that does NOT carry either marker must
  // not spuriously pass just because *some* constant got resolved.
  test("the detector actually fails when the referenced constant lacks the markers", () => {
    const src = `
      const SOME_OTHER_MESSAGE = "nothing to see here";
      async function publishViaUi(page) {
        if (slotText.includes(SOME_OTHER_MESSAGE)) throw new Error("nope");
      }
    `;
    const ast = parse(src);
    const fn = findFunction(ast, "publishViaUi");
    expect(fn).toBeTruthy();
    const blob = resolvedStringBlob(ast, fn);
    for (const marker of MARKERS) {
      expect(blob.includes(marker)).toBe(false);
    }
  });
});
