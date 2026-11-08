// @lane: local — pure-fs lint (cms-platform#982). No HTML sink in the
// platform's browser code (innerHTML, outerHTML, insertAdjacentHTML,
// document.write, ...) receives a value that has not been through a declared
// HTML escaper. eslint-plugin-no-unsanitized does the parsing; its config,
// with the escaper list and the file set, is eslint.html-sinks.config.mjs
// beside this file. scripts/lint-staged.sh runs the same config on staged
// files at commit time; this spec is the CI gate, in node-unit-lints.
//
// A sink the plugin cannot follow but which is safe takes an inline
//   // eslint-disable-next-line no-unsanitized/property -- <why it is safe>
// and this spec fails on such a disable with no reason after the `--`.
//
// PLATFORM-INTERNAL: it lints the platform's theme/ and scaffold/ source,
// which a consumer does not have. Registered in PLATFORM_META_SPECS.
const { test, expect } = require("./base");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const parse5 = require("parse5");
const { ESLint } = require("eslint");

const REPO_ROOT = path.resolve(__dirname, "..");
const CONFIG = path.join(__dirname, "eslint.html-sinks.config.mjs");

function eslint() {
  return new ESLint({ cwd: REPO_ROOT, overrideConfigFile: CONFIG });
}

// Every <script> body without a src, in document order.
function inlineScripts(html) {
  const out = [];
  (function visit(node) {
    if (node.nodeName === "script" && !node.attrs.some((a) => a.name === "src")) {
      out.push(node.childNodes.map((c) => c.value || "").join(""));
    }
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  })(parse5.parse(html));
  return out;
}

// Each function declaration named like a declared escaper, with its file.
function escaperDefinitions(names, files) {
  const found = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    // Lexical prefilter only; the AST below decides what is a definition.
    if (!names.some((n) => text.includes(`function ${n}(`))) continue;
    const sources = rel.endsWith(".html") ? inlineScripts(text) : [text];
    for (const src of sources) {
      if (!names.some((n) => src.includes(`function ${n}(`))) continue;
      const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
      walk.simple(ast, {
        FunctionDeclaration(node) {
          if (names.includes(node.id.name)) {
            found.push({ rel, name: node.id.name, code: src.slice(node.start, node.end) });
          }
        },
      });
    }
  }
  return found;
}

function describe(result, message) {
  const rel = path.relative(REPO_ROOT, result.filePath);
  return `${rel}:${message.line}:${message.column} ${message.ruleId || "eslint"}: ${message.message}`;
}

test.describe("HTML sinks take escaped values only (#982)", () => {
  let results;

  test.beforeAll(async () => {
    results = await eslint().lintFiles(["theme", "scaffold"]);
  });

  test("the browser code it should cover is linted", () => {
    const linted = new Set(results.map((r) => path.relative(REPO_ROOT, r.filePath)));
    // One of each kind: an admin script, an admin HTML shell's inline script,
    // a reviews dashboard and a Liquid layout.
    for (const file of [
      "theme/admin/posts-list-enhance.js",
      "theme/admin/index.html",
      "theme/admin/reviews/index.html",
      "theme/_layouts/preview.html",
    ]) {
      expect(linted, `${file} is not in the lint's file set`).toContain(file);
    }
  });

  test("no unescaped value reaches an HTML sink", () => {
    const problems = results.flatMap((r) => r.messages.map((m) => describe(r, m)));
    expect(
      problems,
      "Escape the value with one of the escapers in e2e/eslint.html-sinks.config.mjs, " +
        "or, if it is safe for another reason, add an eslint-disable-next-line with a reason.",
    ).toEqual([]);
  });

  // A name on the escaper list is trusted at every sink, so each definition
  // must really encode all five characters: the quotes too, since these
  // helpers feed double- and single-quoted attributes as well as text.
  test("every declared escaper encodes & < > \" '", async () => {
    const { ESCAPERS } = await import(CONFIG);
    const files = results.map((r) => path.relative(REPO_ROOT, r.filePath));
    const defs = escaperDefinitions(ESCAPERS, files);
    expect(defs.length, "no escaper definitions found to check").toBeGreaterThan(0);
    const probe = `&<>"'`;
    const wrong = [];
    for (const def of defs) {
      const out = vm.runInNewContext(`(${def.code})(${JSON.stringify(probe)})`, {});
      if (/[<>"']/.test(out) || /&(?!(amp|lt|gt|quot|#39|#x27|apos);)/.test(out)) {
        wrong.push(`${def.rel}: ${def.name}(${JSON.stringify(probe)}) returned ${JSON.stringify(out)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every disabled sink says why it is safe", () => {
    const bare = results.flatMap((r) =>
      r.suppressedMessages
        .filter((m) => m.suppressions.some((s) => !(s.justification || "").trim()))
        .map((m) => describe(r, m)),
    );
    expect(bare, "add `-- <why it is safe>` to each of these disables").toEqual([]);
  });

  test("the config refuses a raw sink and accepts an escaped one", async () => {
    const lint = async (text, filePath) => {
      const [r] = await eslint().lintText(text, { filePath: path.join(REPO_ROOT, filePath) });
      return r.messages.map((m) => m.ruleId);
    };
    const raw = [
      "var x = location.hash;",
      "document.body.innerHTML = x;",
      "document.body.insertAdjacentHTML('beforeend', x);",
      "document.write(x);",
    ].join("\n");
    expect(await lint(raw, "theme/admin/probe.js")).toEqual([
      "no-unsanitized/property",
      "no-unsanitized/method",
      "no-unsanitized/method",
    ]);
    expect(
      await lint(`<script>document.body.innerHTML = location.hash;</script>`, "theme/admin/probe.html"),
    ).toEqual(["no-unsanitized/property"]);
    expect(
      await lint(
        "function esc(s) { return s; }\ndocument.body.innerHTML = '<b>' + esc(location.hash) + '</b>';",
        "theme/admin/probe.js",
      ),
    ).toEqual([]);
  });
});
