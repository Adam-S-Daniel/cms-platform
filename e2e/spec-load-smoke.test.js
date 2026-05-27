// @lane: local — module-load smoke for every spec file; pure-Node, no network
/*
 * Regression test: catch the PR #29 disaster class — a spec file that
 * does I/O at module scope on a path that doesn't exist in CI.
 * (Audit finding #3.)
 *
 * Approach: a static lint that flags top-level (depth-0)
 * `fs.readFileSync(LITERAL)` / `fs.readdirSync(LITERAL)` calls against
 * a literal path that doesn't exist on disk. Anything inside a
 * function body or a test() callback is fine — those don't run at
 * require-time.
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

const specs = fs
  .readdirSync(SPEC_DIR)
  .filter((f) => /\.spec\.js$/.test(f))
  .map((f) => path.join(SPEC_DIR, f));

for (const spec of specs) {
  test(`module-scope I/O in ${path.basename(spec)} reads only existing paths`, () => {
    const offenders = [];
    for (const line of topLevelLines(fs.readFileSync(spec, "utf8"))) {
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
    expect(
      offenders,
      `${path.basename(spec)} has module-scope I/O on a missing path. ` +
        `Lazy-load inside a test() body instead. Offenders:\n` +
        offenders.map((o) => `  ${o.literal}  in: ${o.line}`).join("\n"),
    ).toEqual([]);
  });
}
