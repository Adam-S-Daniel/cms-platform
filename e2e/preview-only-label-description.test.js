// @lane: local — PURE-FS lint: parses every platform workflow's github-script createLabel calls (yaml + acorn)
/*
 * #532: the `cms/preview-only` label promised that its content would be
 * "dropped" from the parent branch when that branch merged to main. Nothing
 * does that. A preview-only PR merges into the feature branch it was opened
 * against (auto-merge-when-ready's preview-only path, cms-automerge-nudge.yml),
 * so the edit becomes part of that branch and reaches main, and production,
 * when the branch merges — unless someone removes it by hand first. The label
 * now says so.
 *
 * The old wording was also never shown to anyone. GitHub rejects a label
 * description over 100 characters with a 422, the call sits in a
 * `try { … } catch (_) {}`, and the label was then created implicitly by
 * addLabels with no description and the default grey. Both consumers'
 * `cms/preview-only` labels carry exactly that (description null, color
 * ededed, read 2026-10-03), while `cms/draft` and `cms/ready`, created by the
 * same step with short descriptions, carry theirs. So every createLabel
 * description in the platform's workflows is held to GitHub's limit here.
 *
 * Structure is read with parsers, never regex (AGENTS.md): the workflow with
 * the `yaml` package via workflow-yaml-utils.js, each github-script body with
 * acorn, and only the object literal actually passed to `createLabel` is
 * inspected.
 */
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");
const { listWorkflows, githubScriptBlocks } = require("./workflow-yaml-utils");
const { stringValue } = require("./spec-ast");

// https://docs.github.com/en/rest/issues/labels#create-a-label
const GITHUB_LABEL_DESCRIPTION_MAX = 100;
const PREVIEW_ONLY = "cms/preview-only";

function parseScript(src) {
  return acorn.parse(src, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
}

function prop(objectNode, key) {
  const p = objectNode.properties.find(
    (x) => x.type === "Property" && !x.computed && (x.key.name === key || x.key.value === key),
  );
  return p ? p.value : null;
}

// Every `<anything>.createLabel({...})` call in every github-script step of
// every platform workflow, as { file, line, name, description }.
function createLabelCalls() {
  const out = [];
  for (const file of listWorkflows()) {
    const text = fs.readFileSync(file, "utf8");
    for (const block of githubScriptBlocks(text)) {
      let ast;
      try {
        ast = parseScript(block.script);
      } catch (e) {
        // A body this lint cannot parse might hide a createLabel call; the
        // lexical token check keeps an unparseable one from being skipped
        // silently.
        if (block.script.includes("createLabel")) {
          throw new Error(`${path.basename(file)}:${block.line}: cannot parse github-script body: ${e.message}`);
        }
        continue;
      }
      walk.simple(ast, {
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== "MemberExpression" || callee.computed) return;
          if (callee.property.name !== "createLabel") return;
          const arg = node.arguments[0];
          if (!arg || arg.type !== "ObjectExpression") return;
          const nameNode = prop(arg, "name");
          const descNode = prop(arg, "description");
          out.push({
            file: path.basename(file),
            name: nameNode && nameNode.type === "Identifier" ? `<${nameNode.name}>` : stringValue(nameNode),
            description: stringValue(descNode),
          });
        },
      });
    }
  }
  return out;
}

test.describe("createLabel descriptions (#532)", () => {
  test("every label description a workflow creates fits GitHub's 100-character limit", () => {
    const calls = createLabelCalls();
    expect(calls.length, "found no createLabel calls; the parse is broken").toBeGreaterThan(3);
    for (const c of calls) {
      expect(c.description, `${c.file} ${c.name}: description must be a static string`).toEqual(expect.any(String));
      expect(
        c.description.length,
        `${c.file} ${c.name}: GitHub rejects a description over ${GITHUB_LABEL_DESCRIPTION_MAX} characters, ` +
          "and the try/catch around createLabel hides the failure",
      ).toBeLessThanOrEqual(GITHUB_LABEL_DESCRIPTION_MAX);
    }
  });

  test("cms/preview-only says the edit reaches main with its branch, and promises no automatic drop", () => {
    const calls = createLabelCalls().filter((c) => c.name === PREVIEW_ONLY);
    expect(calls.map((c) => c.file)).toEqual(["cms-editorial-workflow.yml"]);
    const [{ description }] = calls;
    expect(description).toBe(
      "CMS edit on a feature-branch preview; reaches main when that branch merges, unless removed by hand",
    );
    expect(description).not.toMatch(/\b(drop|dropped|excluded|discarded)\b/i);
  });
});
