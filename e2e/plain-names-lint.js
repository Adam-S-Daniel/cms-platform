/*
 * Plain-names lint: the word "media" must not appear as a standalone word in
 * anything a site owner reads in the website editor, so it cannot mean three
 * things at once (see "Words we use" in docs/ADMIN-DELIVERY.md).
 *
 * Rule: a visible string fails when /\bmedia\b/i matches it, unless the
 * string, with each ALLOWED phrase removed, no longer matches. The allowlist
 * is deliberately short:
 *   - "social media": the ordinary phrase for Facebook-style sites. It never
 *     names a collection or a page of the editor.
 *
 * Every check parses a real structure and returns a list of violation
 * strings (empty when clean); nothing here throws on a violation.
 *   checkCollectionsYaml(text)  YAML via `yaml`: every `label`,
 *                               `label_singular` and `hint` value, at any depth
 *   checkAdminHtml(html)        HTML via `parse5`: text nodes (not script or
 *                               style) and the title, aria-label, placeholder
 *                               and alt attributes
 *   checkScriptStrings(js)      JS via `acorn`: string literals and template
 *                               text that read as words. Identifier- and
 *                               URL-like literals (no whitespace, only
 *                               [a-z0-9_-./#:]) are ids, paths and class
 *                               names, not visible text, and are skipped.
 *
 * A site repo runs it on its own collections (platform checked out at
 * .cms-platform/, as the e2e harness does):
 *   const { checkCollectionsYaml } = require("./.cms-platform/e2e/plain-names-lint");
 *   const bad = checkCollectionsYaml(fs.readFileSync("admin/collections.site.yml", "utf8"));
 *   expect(bad, bad.join("\n")).toEqual([]);
 */
const YAML = require("yaml");
const acorn = require("acorn");
const walk = require("acorn-walk");

const ALLOWED_PHRASES = [/social media/gi];
const STANDALONE = /\bmedia\b/i;
const YAML_KEYS = new Set(["label", "label_singular", "hint"]);
const HTML_ATTRS = new Set(["aria-label", "title", "placeholder", "alt"]);

function ambiguous(str) {
  let s = String(str);
  for (const re of ALLOWED_PHRASES) s = s.replace(re, "");
  return STANDALONE.test(s);
}

function checkCollectionsYaml(text) {
  // Unquoted {{placeholders}} in the platform base config are flow maps to a
  // YAML parser; they carry no label, so a parse of the rest is what counts.
  const doc = YAML.parseDocument(text, { prettyErrors: false });
  const out = [];
  (function visit(node, trail) {
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${trail}[${i}]`));
    if (!node || typeof node !== "object") return;
    for (const [k, v] of node instanceof Map ? node : Object.entries(node)) {
      if (typeof k !== "string") continue;
      const here = `${trail}.${k}`;
      if (YAML_KEYS.has(k) && typeof v === "string" && ambiguous(v)) out.push(`${here}: ${JSON.stringify(v)}`);
      else visit(v, here);
    }
  })(doc.toJS({ maxAliasCount: -1, mapAsMap: true }), "$");
  return out;
}

async function checkAdminHtml(html, name = "html") {
  const { parse } = await import("parse5");
  const out = [];
  (function visit(node) {
    if (node.nodeName === "script" || node.nodeName === "style") return;
    if (node.nodeName === "#text" && ambiguous(node.value)) out.push(`${name}: text ${JSON.stringify(node.value.trim())}`);
    for (const a of node.attrs || []) {
      if (HTML_ATTRS.has(a.name) && ambiguous(a.value)) out.push(`${name}: ${a.name}=${JSON.stringify(a.value)}`);
    }
    for (const c of node.childNodes || []) visit(c);
    if (node.content) visit(node.content);
  })(parse(html));
  return out;
}

function checkScriptStrings(js, name = "script") {
  const out = [];
  const ast = acorn.parse(js, { ecmaVersion: "latest", sourceType: "script" });
  const consider = (value) => {
    if (typeof value !== "string" || /^[a-z0-9_\-./#:]*$/.test(value)) return;
    if (ambiguous(value)) out.push(`${name}: string ${JSON.stringify(value)}`);
  };
  walk.simple(ast, {
    Literal(n) {
      consider(n.value);
    },
    TemplateElement(n) {
      consider(n.value.cooked);
    },
  });
  return out;
}

module.exports = { ambiguous, checkCollectionsYaml, checkAdminHtml, checkScriptStrings };
