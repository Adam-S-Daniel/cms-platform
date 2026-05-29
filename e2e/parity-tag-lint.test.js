// @lane: local — pure-fs static lint of @parity tags across spec files
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// G3 — `@parity` static lint.
//
// Every spec tagged `@parity` runs under the cross-target matrix
// (`TARGET=local|preview|prod`). When the matrix points at prod,
// any filesystem mutation, shell exec, or local-backend call would either
// fail (path doesn't exist) or — worse — actually write to prod / leak
// state. To keep the matrix safe, this static lint scans every
// `e2e/*.spec.js`, finds the ones that mention `@parity` in a `describe`
// or `test` title, and refuses to let them ship if they call any of:
//
//   - `fs.writeFileSync(` / `fs.appendFileSync(` / `fs.rmSync(`
//   - `execFileSync(` / `execSync(` / `.spawn(` / `spawnSync(`
//   - `decap-server` (string literal that names the local backend)
//
// Each match prints the file + line so the violation is easy to fix.
//
// Escape hatch: a spec that *is* TARGET-aware and explicitly gates a
// mutation behind `if (IS_LOCAL)` (e.g. `e2e/draft-isolation.spec.js`'s
// `beforeAll` writeFileSync) can mark each gated line with a trailing
// or preceding `// @parity-lint-allow: <reason>` comment. The lint
// skips matches whose surrounding context (same line or the line
// immediately above) carries that token.

const E2E_DIR = __dirname;

// Each rule is a regex that matches the call shape. Comments and string
// literals stay in the scan — over-broad matches can be silenced with
// the `@parity-lint-allow` escape hatch on a per-line basis.
const FORBIDDEN_PATTERNS = [
  /\bfs\.writeFileSync\s*\(/,
  /\bfs\.appendFileSync\s*\(/,
  /\bfs\.rmSync\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bexecSync\s*\(/,
  /\bspawnSync\s*\(/,
  /\.spawn\s*\(/,
  /\bdecap-server\b/,
];

const ESCAPE_HATCH = /@parity-lint-allow\b/;
// Strip line comments so a mention inside a `// describes the @parity
// model` doesn't trip the lint. Block comments are matched separately.
const STRIP_LINE_COMMENT = /\/\/.*$/;
const STRIP_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

function isParitySpec(source) {
  // Match `@parity` only inside `test(...)` or `test.describe(...)` titles.
  // A free-form prose `@parity` mention in a comment doesn't auto-promote
  // a spec into the parity matrix.
  return /\b(test|describe)(?:\s*\.\s*\w+)?\s*\(\s*(["'`])[^"'`]*@parity[^"'`]*\2/.test(source);
}

function findViolations(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  if (!isParitySpec(source)) return [];

  // Scrub block comments first so multi-line `/* ... fs.writeFileSync ... */`
  // doesn't trip a rule. Line comments are handled per-line below so we
  // can still emit accurate line numbers.
  const scrubbed = source.replace(STRIP_BLOCK_COMMENT, (match) => match.replace(/[^\n]/g, " "));
  const lines = scrubbed.split("\n");
  const rawLines = source.split("\n");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const codeOnly = lines[i].replace(STRIP_LINE_COMMENT, "");
    const rawLine = rawLines[i] || "";
    const prevLine = rawLines[i - 1] || "";
    // Per-line escape hatch: same-line trailing comment OR a `// @parity-
    // lint-allow` line directly above. Either is enough.
    const allowed = ESCAPE_HATCH.test(rawLine) || ESCAPE_HATCH.test(prevLine);
    if (allowed) continue;
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(codeOnly)) {
        violations.push({
          line: i + 1,
          source: rawLines[i].trim(),
          pattern: re.source,
        });
      }
    }
  }
  return violations;
}

test.describe("@parity static lint", () => {
  test("@parity-tagged specs contain no mutation calls", () => {
    const specFiles = fs
      .readdirSync(E2E_DIR)
      .filter((name) => /\.spec\.js$/.test(name))
      .map((name) => path.join(E2E_DIR, name));

    const offenders = [];
    for (const filePath of specFiles) {
      const violations = findViolations(filePath);
      if (violations.length > 0) {
        offenders.push({ filePath, violations });
      }
    }

    if (offenders.length === 0) return;

    const lines = ["@parity-tagged specs must be read-only:"];
    for (const { filePath, violations } of offenders) {
      const rel = path.relative(path.join(__dirname, ".."), filePath);
      for (const v of violations) {
        lines.push(`  ${rel}:${v.line}  matches /${v.pattern}/`);
        lines.push(`    > ${v.source}`);
      }
    }
    lines.push("");
    lines.push("Either remove the @parity tag, refactor the mutation into a non-spec helper,");
    lines.push("or annotate the line with `// @parity-lint-allow: <reason>` if it is");
    lines.push("explicitly gated behind a TARGET=local check.");
    expect(offenders, lines.join("\n")).toEqual([]);
  });
});
