// @lane: local — pure-fs AST lint; no browser, no build, no network.
//
// Lint: never `expect.poll` for a file's mere EXISTENCE and then read it.
//
// WHY THIS EXISTS
// decap-server creates an entry file and then fills it, so an existence-only
// wait can win the race and read `""`. AGENTS.md already states the rule
// ("Never `existsSync`-then-read a file another process writes") and
// e2e/fs-poll.js exists to implement it — but nothing enforced it, and five
// specs kept the old shape after fs-poll landed. Two of them
// (cms-html-embed, cms-inline-image) feed that read straight back into a
// `writeFileSync` of the same path, so an empty read does not merely fail an
// assertion — it OVERWRITES the entry with front-matter-less content and leaves
// a corrupt page on disk for the retry to trip over.
//
// Poll `fileReady(finder)` (or `contentOrEmpty(path)`) instead: same wait, but
// it asks whether the content has arrived, and it says so when it never does.
//
// AST, not regex, per AGENTS.md: the signal is a code-shape fact — which finder
// a poll tests for existence, and whether that finder's result reaches a
// `readFileSync` (directly or through a local variable). A regex cannot follow
// the variable, and would match the same words inside a comment.
//
// An existence poll for a file the spec never READS is fine and is not flagged
// (cms-image-upload waits for an uploaded PNG only to check where it landed).
//
// Platform-internal: reads the harness's own spec sources.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");

function parse(src) {
  return acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true });
}

// `expect.poll(() => <finder>() !== null)` / `!== undefined` / `fs.existsSync(x)`
// — i.e. a poll whose predicate only asks "is it there yet?".
function existencePollFinders(ast) {
  const finders = new Set();
  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee;
      const isPoll =
        callee.type === "MemberExpression" &&
        callee.property.name === "poll" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "expect";
      if (!isPoll || !node.arguments.length) return;
      const pred = node.arguments[0];
      if (pred.type !== "ArrowFunctionExpression") return;
      const body = pred.body;
      // `<finder>() !== null`
      if (
        body.type === "BinaryExpression" &&
        (body.operator === "!==" || body.operator === "!=") &&
        body.left.type === "CallExpression" &&
        body.left.callee.type === "Identifier"
      ) {
        const right = body.right;
        const nullish =
          (right.type === "Literal" && right.value === null) ||
          (right.type === "Identifier" && right.name === "undefined");
        if (nullish) finders.add(body.left.callee.name);
      }
      // `fs.existsSync(<finder>())`
      if (
        body.type === "CallExpression" &&
        body.callee.type === "MemberExpression" &&
        body.callee.property.name === "existsSync"
      ) {
        const arg = body.arguments[0];
        if (arg && arg.type === "CallExpression" && arg.callee.type === "Identifier") {
          finders.add(arg.callee.name);
        }
      }
    },
  });
  return finders;
}

// Locals assigned from `<finder>()`, so `const p = find(); readFileSync(p)`
// counts as reading the finder's file.
function aliasesOf(ast, finders) {
  const aliases = new Map(); // localName -> finderName
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier" &&
        node.init &&
        node.init.type === "CallExpression" &&
        node.init.callee.type === "Identifier" &&
        finders.has(node.init.callee.name)
      ) {
        aliases.set(node.id.name, node.init.callee.name);
      }
    },
  });
  return aliases;
}

// Finders whose file is passed to readFileSync — directly or via an alias.
function findersRead(ast, finders, aliases) {
  const read = new Set();
  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee;
      const isRead =
        (callee.type === "MemberExpression" && callee.property.name === "readFileSync") ||
        (callee.type === "Identifier" && callee.name === "readFileSync");
      if (!isRead || !node.arguments.length) return;
      const arg = node.arguments[0];
      if (arg.type === "CallExpression" && arg.callee.type === "Identifier") {
        if (finders.has(arg.callee.name)) read.add(arg.callee.name);
      }
      if (arg.type === "Identifier" && aliases.has(arg.name)) read.add(aliases.get(arg.name));
    },
  });
  return read;
}

function offenders() {
  const out = [];
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".spec.js")).sort()) {
    let ast;
    try {
      ast = parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
    } catch (e) {
      continue; // spec-load-smoke.test.js's problem, not this lint's.
    }
    const finders = existencePollFinders(ast);
    if (!finders.size) continue;
    const read = findersRead(ast, finders, aliasesOf(ast, finders));
    for (const finder of finders) if (read.has(finder)) out.push(`${file} :: ${finder}()`);
  }
  return out;
}

test("no spec polls a file's existence and then reads it", () => {
  expect(
    offenders(),
    "these specs wait only for the file to EXIST and then read it, so they can read `\"\"` " +
      "while decap-server is still writing (and, where the read feeds a write-back, " +
      "corrupt the entry). Poll the content instead: " +
      '`await expect.poll(() => fileReady(<finder>), { timeout: 60_000 }).toBe(true)` ' +
      'from ./fs-poll.',
  ).toEqual([]);
});

test("the detector recognises the shape it polices", () => {
  // Guards against the AST walk silently matching nothing after a refactor.
  const sample = `
    const fs = require("node:fs");
    function findIt() { return null; }
    test("x", async () => {
      await expect.poll(() => findIt() !== null, { timeout: 60_000 }).toBe(true);
      const p = findIt();
      const body = fs.readFileSync(p, "utf8");
    });
  `;
  const ast = parse(sample);
  const finders = existencePollFinders(ast);
  expect([...finders]).toEqual(["findIt"]);
  expect([...findersRead(ast, finders, aliasesOf(ast, finders))]).toEqual(["findIt"]);
});

test("the detector does NOT flag an existence poll for a file that is never read", () => {
  // cms-image-upload's real shape: it waits for an uploaded PNG only to check
  // WHERE it landed (path.relative), never reading its bytes.
  const sample = `
    const path = require("node:path");
    function findUpload() { return null; }
    test("x", async () => {
      await expect.poll(() => findUpload() !== null, { timeout: 60_000 }).toBe(true);
      const rel = path.relative("/root", findUpload());
    });
  `;
  const ast = parse(sample);
  const finders = existencePollFinders(ast);
  expect([...finders]).toEqual(["findUpload"]);
  expect([...findersRead(ast, finders, aliasesOf(ast, finders))]).toEqual([]);
});
