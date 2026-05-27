// @lane: local — pure-fs grep over spec files; no browser, no network
/*
 * Regression test: spec files must not gate skip logic on
 * `matchMedia(... forced-colors ...)`.
 *
 * matchMedia()'s `forced-colors` query is unreliable under Playwright's
 * media-emulation stack — it can return the wrong value when the
 * project is configured with `forcedColors: 'active'`. The correct
 * pattern is `testInfo.project.use.forcedColors === 'active'` (read
 * the project config directly). (Audit chat-finding #11.)
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const SPEC_DIR = path.resolve(__dirname);
const FORCED_COLORS_RE = /matchMedia\s*\([^)]*forced-colors/;

function stripComments(line) {
  return line.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "");
}

const offenders = [];
for (const f of fs.readdirSync(SPEC_DIR)) {
  if (!f.endsWith(".spec.js")) continue;
  fs.readFileSync(path.join(SPEC_DIR, f), "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (FORCED_COLORS_RE.test(stripComments(line))) {
        offenders.push({ file: f, line: i + 1, text: line.trim() });
      }
    });
}

test("no spec uses matchMedia('forced-colors') for skip logic", () => {
  expect(
    offenders,
    "Spec files must not gate skip logic on matchMedia('forced-colors') — " +
      "use testInfo.project.use.forcedColors instead. Offenders:\n" +
      offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
  ).toEqual([]);
});
