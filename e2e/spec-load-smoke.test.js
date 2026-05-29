// @lane: local — module-load smoke for every spec file; pure-Node, no network
/*
 * Regression test: catch the PR #29 disaster class — a spec file that
 * does I/O at module scope on a path that doesn't exist in CI.
 * (Audit finding #3.)
 *
 * Approach: a static lint that flags two module-scope (depth-0) I/O
 * patterns; anything inside a function body or a test() callback is fine
 * (those don't run at require-time):
 *
 *   (a) STRING-LITERAL path: `fs.readFileSync("…")` / `fs.readdirSync("…")`
 *       against a literal path that doesn't exist on disk.
 *
 *   (b) IDENTIFIER path: `fs.readFileSync(IDENT)` / `fs.readdirSync(IDENT)`
 *       where the argument is a bare identifier (e.g. `POSTS_DIR`). This
 *       catches the cms-preview-url.spec.js class — a module-scope read of
 *       a `path.join(...)`-derived constant that resolves to a directory
 *       absent in the bare platform repo (no `_posts/`), which ENOENT-
 *       aborts Playwright's WHOLE collection. We can't resolve an
 *       identifier's runtime value statically, so we require the read to
 *       be GUARDED on the same line by an `fs.existsSync(...)` check (the
 *       `existsSync(X) ? readdirSync(X) : []` pattern). An unguarded
 *       depth-0 identifier read is the offence.
 *
 * Why static rather than running `playwright test --list`:
 * Playwright's `testDir: "./e2e"` picks this very file up, so a
 * dynamic load smoke that shells out to playwright would recurse
 * forever (this test → playwright --list → discovers this test → …).
 * The static lint hits the same failure mode without the recursion.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const SPEC_DIR = path.resolve(__dirname);
const ROOT = path.resolve(__dirname, "..");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

// Yield only depth-0 (module-scope) lines. Tracks brace/paren/bracket
// depth across the source, which is good enough for this lint —
// require() / imports / top-level constants land at depth 0; everything
// inside a function body or test() block is below.
function topLevelLines(src) {
  const lines = stripComments(src).split("\n");
  const out = [];
  let depth = 0;
  for (const line of lines) {
    if (depth === 0) out.push(line);
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
  }
  return out;
}

const FS_LITERAL_RE = /\bfs\.read(?:File|dir)Sync\(\s*["'`]([^"'`]+)["'`]/g;

// An `fs.read{File,dir}Sync(` whose first argument is a BARE IDENTIFIER
// (a JS name, optionally dotted/member like `obj.dir`) — i.e. NOT a
// string literal and NOT a nested call. `\s*` after `fs` spans newlines,
// so the multiline `fs\n  .readdirSync(POSTS_DIR)` form (the exact shape
// the cms-preview-url.spec.js `_posts/` read had) is caught too. We can't
// resolve the identifier's runtime value statically, so a depth-0 read of
// one is an offence UNLESS it is GUARDED (see GUARD_SIGNAL_RE) or sits in
// a function/arrow definition that doesn't execute at require-time.
const FS_IDENTIFIER_RE = /\bfs\s*\.\s*read(?:File|dir)Sync\(\s*([A-Za-z_$][\w$.]*)\s*[),]/g;

// Guard / non-execution signals that make a depth-0 identifier read safe.
// All must appear BEFORE the read within the surrounding statement (a
// `=>` or `?` that appears AFTER the read — e.g. a chained
// `.filter((f) => …)` — is NOT a guard, so we only scan the text leading
// up to the match):
//   - existsSync(...)            — an explicit existence check, e.g.
//                                  `existsSync(X) ? readdirSync(X) : []`.
//   - a ternary `?`              — a precomputed-boolean guard such as
//                                  `guideExists ? parseSections(read(X)) : []`.
//   - `=>` or `function`         — the read sits in a (nested) function
//                                  body declared here, so it runs lazily,
//                                  not at module load (`const read = (p)
//                                  => fs.readFileSync(p, …)`).
const GUARD_SIGNAL_RE = /existsSync\s*\(|\?|=>|\bfunction\b/;

const specs = fs
  .readdirSync(SPEC_DIR)
  .filter((f) => /\.spec\.js$/.test(f))
  .map((f) => path.join(SPEC_DIR, f));

for (const spec of specs) {
  test(`module-scope I/O in ${path.basename(spec)} reads only existing paths`, () => {
    const offenders = [];
    const topLines = topLevelLines(fs.readFileSync(spec, "utf8"));

    // (a) string-literal path that doesn't exist on disk — per-line so the
    // reported offender quotes the exact source line.
    for (const line of topLines) {
      let m;
      FS_LITERAL_RE.lastIndex = 0;
      while ((m = FS_LITERAL_RE.exec(line)) !== null) {
        const literal = m[1];
        const candidates = [
          path.isAbsolute(literal) ? literal : path.resolve(SPEC_DIR, literal),
          path.resolve(ROOT, literal),
        ];
        if (!candidates.some((p) => fs.existsSync(p))) {
          offenders.push({ line: line.trim(), literal });
        }
      }
    }

    // (b) identifier-path read with no guard. Scanned against the JOINED
    // depth-0 text (not per-line) so the multiline `fs\n.readdirSync(IDENT)`
    // form is detected. The identifier's value is opaque to a static lint,
    // so an UNGUARDED depth-0 read can ENOENT-abort Playwright's whole
    // collection if the path is absent in some checkout (the
    // cms-preview-url.spec.js / `_posts/` class). A guard signal in a
    // window around the match (the surrounding statement) clears it.
    const joined = topLines.join("\n");
    let mi;
    FS_IDENTIFIER_RE.lastIndex = 0;
    while ((mi = FS_IDENTIFIER_RE.exec(joined)) !== null) {
      const ident = mi[1];
      // Scan only the text leading up to the read within its statement —
      // a guard (`existsSync`, `?`, `=>`, `function`) is meaningful only
      // when it precedes the read. Bound the look-back at the previous
      // statement boundary (`;` or `{`/`}`) so a guard on an UNRELATED
      // earlier statement can't mask this read.
      const stmtStart = Math.max(
        joined.lastIndexOf(";", mi.index),
        joined.lastIndexOf("{", mi.index),
        joined.lastIndexOf("}", mi.index),
      );
      const before = joined.slice(stmtStart + 1, mi.index);
      if (!GUARD_SIGNAL_RE.test(before)) {
        const lineText = joined
          .slice(joined.lastIndexOf("\n", mi.index) + 1, joined.indexOf("\n", mi.index) + 1 || undefined)
          .trim();
        offenders.push({
          line: lineText || mi[0].trim(),
          literal: `${ident} (unguarded identifier path — wrap in existsSync(${ident}) ? … : [])`,
        });
      }
    }

    expect(
      offenders,
      `${path.basename(spec)} has module-scope I/O on a missing/unguarded path. ` +
        `Lazy-load inside a test() body, or guard with fs.existsSync(...). Offenders:\n` +
        offenders.map((o) => `  ${o.literal}  in: ${o.line}`).join("\n"),
    ).toEqual([]);
  });
}
