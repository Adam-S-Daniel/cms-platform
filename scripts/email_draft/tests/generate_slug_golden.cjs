#!/usr/bin/env node
// Regenerates tests/fixtures/decap_slug_golden.json and ../diacritics_map.json from the REAL
// Decap code installed under e2e/node_modules (the version theme/admin loads), so the Python
// port in draft.py is checked against Decap itself rather than a hand-written table.
//
//   cd e2e && npm ci && node ../scripts/email_draft/tests/generate_slug_golden.cjs
//
// Decap ships these modules as ESM whose bare `lodash/x` imports Node's ESM resolver refuses,
// so each file's import lines are rewritten to require() calls and the module is evaluated in
// a vm context. Nothing else in the source is changed.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO = path.resolve(__dirname, "..", "..", "..");
const NM = path.join(REPO, "e2e", "node_modules");
const nmRequire = require("node:module").createRequire(path.join(NM, "noop.js"));

function loadEsm(rel) {
  let src = fs.readFileSync(path.join(NM, rel), "utf8");
  src = src.replace(/^import \{([^}]+)\} from '([^']+)';$/gm, "const {$1} = __req('$2');");
  src = src.replace(/^import (\w+) from '([^']+)';$/gm, "const $1 = __def(__req('$2'));");
  src = src.replace(/^export (function|const) (\w+)/gm, "__exports.$2 = $2; $1 $2");
  // Hoisting: functions declared with `function` are hoisted; consts are not, so the
  // assignment above would read a TDZ binding. Re-export every name at the end instead.
  const names = [...src.matchAll(/__exports\.(\w+) = \1; /g)].map((m) => m[1]);
  src = src.replace(/__exports\.(\w+) = \1; /g, "");
  src += "\n" + names.map((n) => `__exports.${n} = ${n};`).join("\n");
  const sandbox = {
    __req: nmRequire,
    __def: (m) => (m && m.__esModule && "default" in m ? m.default : m),
    __exports: {},
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: rel });
  return sandbox.__exports;
}

const url = loadEsm("decap-cms-core/dist/esm/lib/urlHelper.js");
const tpl = loadEsm("decap-cms-lib-widgets/dist/esm/stringTemplate.js");
const formattersSrc = fs.readFileSync(path.join(NM, "decap-cms-core/dist/esm/lib/formatters.js"), "utf8");
const prepareSrc = /export function prepareSlug\([\s\S]*?\n}/.exec(formattersSrc)[0];
const prepareSlug = vm.runInNewContext(`(${prepareSrc.replace(/^export /, "")})`);
const { Map } = nmRequire("immutable");

const SLUG = { encoding: "ascii", clean_accents: true, sanitize_replacement: "-" };
const TEMPLATE = "{{year}}-{{month}}-{{day}}-{{slug | truncate(80, '-')}}";
const process = (v) => url.sanitizeSlug(prepareSlug(String(v)), SLUG);
const date = new Date(Date.UTC(2026, 10, 6, 12, 0, 0));

const INPUTS = [
  "Hello World",
  "  Leading and trailing  ",
  "ZZ Exploratory test — delete me",
  "“Quoted” isn’t 🚀 Café naïve",
  "Don't stop: it's 3.14 o'clock!",
  "Ünïcödé Ærøskøbing straße Łódź",
  "İstanbul ΟΔΟΣ 日本語のタイトル",
  "a/b\\c?d*e<f>g|h\"i:j",
  "con",
  "lpt1.txt",
  "Trailing dots...",
  "under_score and ~tilde",
  "x".repeat(80),
  "x".repeat(81),
  "x".repeat(82),
  "word ".repeat(30),
  "A ".repeat(40) + "Z",
  "🚀".repeat(45),
  "é".repeat(85),
  "é".repeat(50),
  "Café".repeat(25),
  "Ⅻ roman numeral",
  "tab\tand\nnewline",
  "MiXeD CaSe 123",
  "--dashes--everywhere--",
  "ﬁ ligature and ﬀ",
  "Ǆ titlecase ǅ",
];

const cases = INPUTS.map((input) => [
  input,
  tpl.compileStringTemplate(TEMPLATE, date, input, Map(), process),
]);

const out = {
  generated_by: "scripts/email_draft/tests/generate_slug_golden.cjs",
  decap_cms: nmRequire("decap-cms/package.json").version,
  decap_cms_core: nmRequire("decap-cms-core/package.json").version,
  template: TEMPLATE,
  slug: SLUG,
  date_utc: "2026-11-06",
  cases,
};
fs.writeFileSync(
  path.join(__dirname, "fixtures", "decap_slug_golden.json"),
  JSON.stringify(out, null, 2) + "\n",
);
const dmap = nmRequire("diacritics").diacriticsMap;
const sorted = Object.fromEntries(Object.keys(dmap).sort().map((k) => [k, dmap[k]]));
fs.writeFileSync(
  path.join(__dirname, "..", "diacritics_map.json"),
  JSON.stringify(
    { generated_by: out.generated_by, source: "diacritics@" + nmRequire("diacritics/package.json").version, map: sorted },
    null,
    0,
  ) + "\n",
);
console.log(`wrote ${cases.length} cases`);
