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
 *
 * The lint is fail-closed: a shape it cannot evaluate is a failure, never a
 * silent pass. That covers an unparseable script body, a description or name
 * that is not a static string (a template literal with an expression
 * included; a `const` bound once to a static string is resolved),
 * `createLabel(opts)` with anything but an object literal, a
 * spread or computed key in that literal, a computed callee
 * (`issues["createLabel"](…)`), and `createLabel` reached any other way (an
 * alias or destructuring). The last is caught by counting acorn's
 * `createLabel` tokens: every one must be the property of an evaluated call.
 */
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");
const { listWorkflows, githubScriptBlocks } = require("./workflow-yaml-utils");

// https://docs.github.com/en/rest/issues/labels#create-a-label
const GITHUB_LABEL_DESCRIPTION_MAX = 100;
const PREVIEW_ONLY = "cms/preview-only";
const METHOD = "createLabel";

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "script",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
};

// The string a node always evaluates to, or undefined when it is not fixed:
// a string literal, a template literal with no expressions, or a `+` of
// those. Anything else (an identifier, a `${…}`, a call) is undefined.
function staticString(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join("");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const l = staticString(node.left);
    const r = staticString(node.right);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  return undefined;
}

// `const NAME = <static string>` bindings that nothing else in the script
// can shadow: a name declared, or taken as a parameter, more than once is
// left out, so resolving through it never guesses.
function constStrings(ast) {
  const seen = new Map();
  const note = (id, value) => {
    if (!id || id.type !== "Identifier") return;
    seen.set(id.name, seen.has(id.name) ? undefined : value);
  };
  walk.full(ast, (node) => {
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) note(d.id, node.kind === "const" ? staticString(d.init) : undefined);
    } else if (/Function/.test(node.type)) {
      for (const param of node.params) note(param, undefined);
      if (node.id) note(node.id, undefined);
    }
  });
  return seen;
}

// Every `createLabel` call in one github-script body, as
// { calls: [{ where, name, description }], problems: [string] }. A call is
// only reported when every part this lint checks was evaluated; anything
// else is a problem.
function analyzeScript(src, where) {
  const calls = [];
  const problems = [];
  let ast;
  try {
    ast = acorn.parse(src, PARSE_OPTIONS);
  } catch (e) {
    return { calls, problems: [`${where}: cannot parse github-script body: ${e.message}`] };
  }
  const consts = constStrings(ast);
  const value = (node) =>
    node && node.type === "Identifier" ? consts.get(node.name) : staticString(node);
  let evaluatedTokens = 0;
  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee;
      if (callee.type !== "MemberExpression") return;
      const at = `${where}+${node.loc ? node.loc.start.line : "?"}`;
      if (callee.computed) {
        const key = staticString(callee.property);
        if (key === undefined) problems.push(`${at}: computed callee this lint cannot resolve`);
        else if (key === METHOD) problems.push(`${at}: computed ${METHOD} callee; call it as .${METHOD}({…})`);
        return;
      }
      if (callee.property.name !== METHOD) return;
      evaluatedTokens++;
      const arg = node.arguments[0];
      if (node.arguments.length !== 1 || !arg || arg.type !== "ObjectExpression") {
        problems.push(`${at}: ${METHOD} must be called with one object literal`);
        return;
      }
      const fields = {};
      for (const p of arg.properties) {
        if (p.type !== "Property" || p.computed) {
          problems.push(`${at}: ${METHOD} argument has a spread or computed key`);
          return;
        }
        fields[p.key.type === "Identifier" ? p.key.name : String(p.key.value)] = p.value;
      }
      const name = value(fields.name);
      const description = value(fields.description);
      // A name held in an identifier this script cannot resolve (one
      // imported from a repo script) is kept as `<IDENT>`; the test below
      // holds those to a reviewed list, so a new one still fails.
      const opaqueName =
        name === undefined && fields.name && fields.name.type === "Identifier" ? `<${fields.name.name}>` : undefined;
      if (name === undefined && !opaqueName) problems.push(`${at}: ${METHOD} name must be a static string`);
      if (description === undefined) problems.push(`${at}: ${METHOD} description must be a static string`);
      if ((name !== undefined || opaqueName) && description !== undefined) {
        calls.push({ where: at, name: name !== undefined ? name : opaqueName, opaque: Boolean(opaqueName), description });
      }
    },
  });
  // Lexical: acorn's own tokens, so comments never count. Each `createLabel`
  // name or string token must be the property of a call evaluated above.
  let tokens = 0;
  for (const tok of acorn.tokenizer(src, PARSE_OPTIONS)) {
    if (["name", "string", "template"].includes(tok.type.label) && tok.value === METHOD) tokens++;
  }
  if (tokens !== evaluatedTokens) {
    problems.push(
      `${where}: ${tokens} ${METHOD} token(s) but ${evaluatedTokens} evaluated call(s); ` +
        `${METHOD} is reached in a shape this lint cannot evaluate (alias, destructuring, computed key)`,
    );
  }
  return { calls, problems };
}

// Every createLabel call in every github-script step of every platform
// workflow.
function createLabelCalls() {
  const calls = [];
  const problems = [];
  for (const file of listWorkflows()) {
    const text = fs.readFileSync(file, "utf8");
    for (const block of githubScriptBlocks(text)) {
      const got = analyzeScript(block.script, `${path.basename(file)}:${block.line}`);
      calls.push(...got.calls);
      problems.push(...got.problems);
    }
  }
  return { calls, problems };
}

test.describe("createLabel descriptions (#532)", () => {
  test("every label description a workflow creates fits GitHub's 100-character limit", () => {
    const { calls, problems } = createLabelCalls();
    expect(problems, "shapes this lint cannot evaluate").toEqual([]);
    expect(calls.length, "found no createLabel calls; the parse is broken").toBeGreaterThan(3);
    for (const c of calls) {
      expect(
        c.description.length,
        `${c.where} ${c.name}: GitHub rejects a description over ${GITHUB_LABEL_DESCRIPTION_MAX} characters, ` +
          "and the try/catch around createLabel hides the failure",
      ).toBeLessThanOrEqual(GITHUB_LABEL_DESCRIPTION_MAX);
    }
  });

  test("cms/preview-only says the edit reaches main with its branch, and promises no automatic drop", () => {
    const calls = createLabelCalls().calls.filter((c) => c.name === PREVIEW_ONLY);
    expect(calls.map((c) => c.where.split(":")[0])).toEqual(["cms-editorial-workflow.yml"]);
    const [{ description }] = calls;
    expect(description).toBe(
      "CMS edit on a feature-branch preview; reaches main when that branch merges, unless removed by hand",
    );
    expect(description).not.toMatch(/\b(drop|dropped|excluded|discarded)\b/i);
  });
});

// A label name this lint cannot see (imported from a repo script) could be
// any label, cms/preview-only included, so each one is listed here after
// review; a new one fails until it is.
const OPAQUE_NAMES = [
  // scripts/content-pr-guard.js's OVERRIDE_LABEL, "content-guard/override".
  ["cms-editorial-workflow.yml", "<OVERRIDE_LABEL>"],
];

test("every label name the lint cannot resolve is a reviewed one", () => {
  const opaque = createLabelCalls()
    .calls.filter((c) => c.opaque)
    .map((c) => [c.where.split(":")[0], c.name]);
  expect(opaque).toEqual(OPAQUE_NAMES);
});

// Review of #558, S3: each shape the lint cannot evaluate must fail it.
test.describe("createLabel lint is fail-closed", () => {
  const ok = `await github.rest.issues.createLabel({ owner: o, repo: r, name: 'cms/x', color: 'ededed', description: 'Fine' });`;

  test("an evaluable call is reported with its static name and description", () => {
    const tpl = "await github.rest.issues.createLabel({ name: `cms/y`, description: 'a' + `b` });";
    const bound = "const LABEL = 'cms/z'; await github.rest.issues.createLabel({ name: LABEL, description: 'c' });";
    const got = analyzeScript(`// createLabel in a comment does not count\n${ok}\n${tpl}\n${bound}`, "t");
    expect(got.problems).toEqual([]);
    expect(got.calls.map((c) => [c.name, c.description])).toEqual([
      ["cms/x", "Fine"],
      ["cms/y", "ab"],
      ["cms/z", "c"],
    ]);
    const shadowed = analyzeScript(
      "const L = 'cms/x'; function f() { const L = 'cms/y'; } await github.rest.issues.createLabel({ name: L, description: 'd' });",
      "t",
    );
    expect(shadowed.calls.map((c) => c.name), "a const declared twice is not resolved").toEqual(["<L>"]);
    const reassignable = analyzeScript("let L = 'cms/x'; await github.rest.issues.createLabel({ name: L, description: 'd' });", "t");
    expect(reassignable.calls.map((c) => c.name), "a let is not resolved").toEqual(["<L>"]);
  });

  const SHAPES = [
    ["a template literal with an expression", "await github.rest.issues.createLabel({ name: 'cms/x', description: `CMS ${what}` });", /description must be a static string/],
    ["a variable argument", "const opts = { name: 'cms/x', description: 'd' }; await github.rest.issues.createLabel(opts);", /must be called with one object literal/],
    ["a computed callee", "await github.rest.issues['createLabel']({ name: 'cms/x', description: 'd' });", /computed createLabel callee/],
    ["a computed callee built from parts", "await github.rest.issues['create' + 'Label']({ name: 'cms/x', description: 'd' });", /computed createLabel callee/],
    ["an unresolvable computed callee", "await github.rest.issues[method]({ name: 'cms/x', description: 'd' });", /computed callee this lint cannot resolve/],
    ["a spread into the argument", "await github.rest.issues.createLabel({ ...base, name: 'cms/x', description: 'd' });", /spread or computed key/],
    ["a name that is not static", "await github.rest.issues.createLabel({ name: `cms/${kind}`, description: 'd' });", /name must be a static string/],
    ["a name read off an object", "await github.rest.issues.createLabel({ name: cfg.label, description: 'd' });", /name must be a static string/],
    ["no description", "await github.rest.issues.createLabel({ name: 'cms/x' });", /description must be a static string/],
    ["a destructured alias", "const { createLabel } = github.rest.issues; await createLabel({ name: 'cms/x', description: 'd' });", /shape this lint cannot evaluate/],
    ["an unparseable body", "await github.rest.issues.createLabel({ name: 'cms/x', ", /cannot parse/],
  ];
  for (const [shape, src, message] of SHAPES) {
    test(`fails on ${shape}`, () => {
      const got = analyzeScript(`${ok}\n${src}`, "t");
      expect(got.problems.join("\n")).toMatch(message);
    });
  }
});

// Review of #558, N1: the preview-only createLabel failure used to vanish in
// `catch (_) {}`. Runs the real github-script step with a scripted client.
test.describe("cms/preview-only label creation reports failures by status code only", () => {
  function step() {
    const file = listWorkflows().find((f) => path.basename(f) === "cms-editorial-workflow.yml");
    const blocks = githubScriptBlocks(fs.readFileSync(file, "utf8")).filter((b) =>
      analyzeScript(b.script, "x").calls.some((c) => c.name === PREVIEW_ONLY),
    );
    expect(blocks).toHaveLength(1);
    return blocks[0].script;
  }

  async function run(previewOnlyError) {
    const warnings = [];
    const added = [];
    const github = {
      rest: {
        issues: {
          createLabel: async ({ name }) => {
            if (name === PREVIEW_ONLY && previewOnlyError) throw previewOnlyError;
          },
          addLabels: async ({ labels }) => added.push(...labels),
        },
      },
    };
    const context = {
      repo: { owner: "owner", repo: "repo" },
      payload: { pull_request: { number: 7, base: { ref: "feature/x" } } },
    };
    const core = { warning: (m) => warnings.push(String(m)) };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("github", "context", "core", step())(github, context, core);
    return { warnings, added };
  }

  const BODY = "body-text-that-must-not-be-logged";

  test("already_exists is silent", async () => {
    const err = Object.assign(new Error(BODY), {
      status: 422,
      response: { data: { message: BODY, errors: [{ resource: "Label", code: "already_exists", field: "name" }] } },
    });
    const { warnings, added } = await run(err);
    expect(warnings).toEqual([]);
    expect(added).toEqual(["cms/draft", PREVIEW_ONLY]);
  });

  test("a validation 422 warns with the status code and nothing from the body", async () => {
    const err = Object.assign(new Error(BODY), {
      status: 422,
      response: { data: { message: BODY, errors: [{ resource: "Label", code: "invalid", field: "description" }] } },
    });
    const { warnings, added } = await run(err);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 422");
    expect(warnings[0]).not.toContain(BODY);
    expect(added).toEqual(["cms/draft", PREVIEW_ONLY]);
  });

  test("a server error warns with its status code", async () => {
    const { warnings } = await run(Object.assign(new Error(BODY), { status: 500 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("HTTP 500");
    expect(warnings[0]).not.toContain(BODY);
  });

  test("no error, no warning", async () => {
    expect((await run(null)).warnings).toEqual([]);
  });
});
