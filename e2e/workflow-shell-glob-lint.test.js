// @lane: local — pure-fs lint of workflow YAML; no browser, no network
/*
 * Regression test: every `for VAR in <glob>; do … done` loop inside a
 * workflow `run:` block must guard against an empty match, either via
 * `shopt -s nullglob` earlier in the same run block or a per-iteration
 * `[ -e "$VAR" ]` / `[[ -e "$VAR" ]]` existence check inside the body.
 *
 * Without one of those, an empty glob (e.g. `_posts/*.md` in a fresh
 * checkout with no posts) falls through to the literal pattern. The
 * loop body then runs once with `f="_posts/*.md"`, which triggers
 * confusing downstream errors. (Audit chat-finding #6.)
 *
 * Iterating over a quoted bash array (`for f in "${ARR[@]}"`) is exempt —
 * arrays already stay empty when nothing matched.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, runScripts } = require("./workflow-yaml-utils");

// Match `for VAR in REST; do`. REST is a glob iteration when it
// contains shell glob metacharacters and isn't a bash array expansion.
function isGlobIteration(forLine) {
  const m = forLine.match(/^\s*for\s+\w+\s+in\s+(.*?)\s*;?\s*do\s*$/);
  if (!m) return false;
  const target = m[1];
  if (/^"\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}"\s*$/.test(target)) return false;
  if (/^\$[A-Za-z_]/.test(target.trim())) return false;
  return /[*?]/.test(target) || /\[[^\]]+\]/.test(target);
}

// Slice the body between `do` and the matching `done` for the loop
// that starts at `startIdx` in `bodyLines`.
function loopBody(bodyLines, startIdx) {
  let depth = 0;
  const out = [];
  for (let k = startIdx; k < bodyLines.length; k++) {
    const l = bodyLines[k];
    if (/^\s*for\s+\w+\s+in\b/.test(l)) depth++;
    if (/^\s*done\b/.test(l)) {
      depth--;
      if (depth === 0) return out.join("\n");
    }
    if (k > startIdx) out.push(l);
  }
  return out.join("\n");
}

for (const file of listWorkflows()) {
  const yaml = fs.readFileSync(file, "utf8");
  for (const block of runScripts(yaml)) {
    const bodyLines = block.script.split("\n");
    for (let k = 0; k < bodyLines.length; k++) {
      const line = bodyLines[k];
      if (!/^\s*for\s+\w+\s+in\b/.test(line)) continue;
      if (!isGlobIteration(line)) continue;

      const before = bodyLines.slice(0, k).join("\n");
      const inner = loopBody(bodyLines, k);
      const safe = /shopt\s+-s\s+nullglob\b/.test(before) || /\[\[?\s+-[efd]\s+["']?\$/.test(inner);

      const label = `${path.basename(file)} :: line ${block.line + k} :: ` + line.trim();
      test(`shell glob loop is empty-safe (${label})`, () => {
        expect(
          safe,
          `Loop '${line.trim()}' in ${path.basename(file)} (run-block ` +
            `starting at line ${block.line}) needs either ` +
            `'shopt -s nullglob' earlier in the same run: block, or a ` +
            `'[ -e "$VAR" ]' guard inside the loop body — otherwise an ` +
            `empty glob falls through to the literal pattern.`,
        ).toBe(true);
      });
    }
  }
}
