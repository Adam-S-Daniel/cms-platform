// @lane: local — pure-fs grep over test/script code; no browser, no network
// Lint: ban silent `.catch()` handlers in test/script code.
//
// Background — `e2e/detect-changed-pages.js` had `.catch(() => null)` on its
// git-history queries for months. That swallowed truncated-history errors
// in CI, where actions/checkout's default fetch-depth of 1 means the diff
// against `main` returns nothing useful. The PR #66 fix removed the silent
// catches so the workflow now fails loudly with the actual error.
//
// Rule: every `.catch(...)` arrow callback must contain at least one
// statement that isn't a bare `return falsy` — i.e. either it does work
// (logging, throwing, calling something), or it returns a non-falsy value
// (which is meaningful — Playwright's `.isVisible({ timeout }).catch(() => false)`
// is fine because the `false` flows back into a conditional). What we ban
// is `() => {}`, `() => null`, `() => undefined`, `() => {/* ... */}` —
// the "I know this can throw and I'm choosing to ignore it" pattern.
//
// Detection is regex-based; if a real instance trips a false positive,
// narrow the regex with a comment explaining why, or add a deliberate
// statement (e.g. `console.warn(...)`) to make the choice explicit.

const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const TARGET_DIRS = ["e2e", "scripts"];

function listJsFiles() {
  const files = [];
  for (const dir of TARGET_DIRS) {
    const full = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith(".js")) continue;
      const p = path.join(full, name);
      if (!fs.statSync(p).isFile()) continue;
      files.push(p);
    }
  }
  return files;
}

// Strip line and block comments before scanning so the lint's own examples
// (and prose in spec comments that quotes `.catch(() => null)`) don't trip
// it up. Preserve newline counts so reported line numbers stay correct.
function stripJsComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const a = src[i];
    const b = src[i + 1];
    if (a === "/" && b === "/") {
      // Line comment — replace with spaces up to newline.
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (a === "/" && b === "*") {
      // Block comment — replace with spaces, preserving newlines.
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
    } else if (a === '"' || a === "'" || a === "`") {
      // Skip string contents — they can contain `.catch(...)` substrings.
      const quote = a;
      out += a;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        // For template literals, ${...} can contain catches — keep them.
        out += src[i];
        i++;
      }
      if (i < src.length) {
        out += src[i];
        i++;
      }
    } else {
      out += a;
      i++;
    }
  }
  return out;
}

// Find every `.catch(` and capture the immediately-following arrow callback,
// if any. Returns offenders with file path + 1-based line.
function findSilentCatches(rawSrc, label) {
  const src = stripJsComments(rawSrc);
  const offenders = [];
  // The above pattern walk handles both expression-form and block-form
  // bodies by re-walking from `.catch(`.
  let i = 0;
  while (i < src.length) {
    const idx = src.indexOf(".catch(", i);
    if (idx === -1) break;
    // Find the end of the arrow's parameter list, then the `=>`, then the body.
    // Skip whitespace after `(`.
    let j = idx + ".catch(".length;
    while (j < src.length && /\s/.test(src[j])) j++;
    // Match `() | (a) | (a, b) | ident` for the parameter list.
    let paramOk = false;
    if (src[j] === "(") {
      // Walk to matching close paren.
      let depth = 1;
      j++;
      while (j < src.length && depth > 0) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
        j++;
      }
      paramOk = depth === 0;
    } else if (/[A-Za-z_$]/.test(src[j])) {
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      paramOk = true;
    }
    if (!paramOk) {
      i = idx + 1;
      continue;
    }
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== "=" || src[j + 1] !== ">") {
      // Not an inline arrow callback — could be `.catch(handler)`. Treat as
      // non-silent (the named handler is its own function, audit it there).
      i = idx + 1;
      continue;
    }
    j += 2;
    while (j < src.length && /\s/.test(src[j])) j++;
    // Body is either `{ ... }` (block) or an expression up to the matching
    // close paren of the .catch call.
    let body;
    if (src[j] === "{") {
      // Block — walk to matching brace.
      let depth = 1;
      const start = j + 1;
      j++;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      body = src.slice(start, j - 1);
    } else {
      // Expression — walk to matching close paren of .catch(.
      let depth = 1;
      const start = j;
      while (j < src.length && depth > 0) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      body = src.slice(start, j);
    }

    if (isSilent(body)) {
      const line = src.slice(0, idx).split("\n").length;
      offenders.push(`${label}:${line}: silent .catch(() => ${body.trim() || "{}"})`);
    }
    i = j;
  }
  return offenders;
}

function isSilent(body) {
  const stripped = body.trim();
  if (stripped === "") return true;
  // Block bodies that only `return null/undefined/void 0` or are empty.
  // We deliberately do NOT include `false` — `.catch(() => false)` is the
  // canonical Playwright pattern for `if (await foo.isVisible().catch(() => false))`,
  // where the boolean is consumed by the conditional. Returning `null` or
  // `undefined` is the silent-error pattern from PR #66.
  const FALSY = /^(?:return\s+)?(?:null|undefined|void\s+0)\s*;?\s*$/;
  if (FALSY.test(stripped)) return true;
  return false;
}

const FILES = listJsFiles();

test("found JS files to scan (sanity)", () => {
  expect(FILES.length).toBeGreaterThan(0);
});

test("no silent .catch handlers", () => {
  const offenders = [];
  for (const f of FILES) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(REPO_ROOT, f);
    offenders.push(...findSilentCatches(src, rel));
  }
  expect(offenders).toEqual([]);
});
