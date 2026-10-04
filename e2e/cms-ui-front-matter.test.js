// @lane: local — Decap's offline new-entry/default/preSave/front-matter path (#531).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const acorn = require("acorn");
const YAML = require("yaml");
const { test, expect } = require("./base");
const { markEphemeralTestPost } = require("./cms-editor-ui");
const { decapPin } = require("./admin-bundle-parity");

const ROOT = path.resolve(__dirname, "..");
const CORE = path.dirname(require.resolve("decap-cms-core/package.json"));
const coreRequire = createRequire(path.join(CORE, "package.json"));
const { fromJS, List, Map } = coreRequire("immutable");

// The shell's Decap 3.15.1 release contains core 3.17.1, not core 3.15.1:
// https://github.com/decaporg/decap-cms/blob/bc76c05a80ab70d6b5c7cdaafc7d10cf56939c02/packages/decap-cms-core/package.json
// Test-only nested overrides retain this core's Immutable 3 and React 19
// runtime despite newer peer-library declarations; plain npm ci still works.
// Use installed upstream source, never a copied serializer or a fake Map.
// Loading the whole browser application would mount React and require a DOM.
// This AST loader evaluates its original pure ESM modules and selected functions
// unchanged; missing declarations fail closed when upstream changes their shape.
function decapRuntime() {
  const cache = new globalThis.Map();
  function read(file) {
    const source = fs.readFileSync(file, "utf8");
    return { source, ast: acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }) };
  }
  function evaluate(source, bindings, names, file) {
    return vm.compileFunction(`${source}\nreturn { ${names.join(", ")} };`,
      Object.keys(bindings), { filename: file })(...Object.values(bindings));
  }
  function module(file) {
    if (cache.has(file)) return cache.get(file);
    const { source, ast } = read(file);
    const bindings = {};
    const exports = [];
    const pieces = [];
    for (const node of ast.body) {
      if (node.type === "ImportDeclaration") {
        const target = node.source.value;
        const imported = target.startsWith(".")
          ? module(path.resolve(path.dirname(file), `${target}.js`))
          : coreRequire(target);
        for (const spec of node.specifiers) {
          bindings[spec.local.name] = spec.type === "ImportDefaultSpecifier"
            ? imported.default ?? imported
            : imported[spec.imported.name];
        }
      } else if (node.type === "ExportDefaultDeclaration") {
        pieces.push(`const defaultExport = ${source.slice(node.declaration.start, node.declaration.end)};`);
        exports.push("default: defaultExport");
      } else if (node.type === "ExportNamedDeclaration") {
        if (!node.declaration) throw new Error(`Unsupported re-export in ${file}`);
        pieces.push(source.slice(node.declaration.start, node.declaration.end));
        exports.push(...declarationNames(node.declaration));
      } else {
        pieces.push(source.slice(node.start, node.end));
      }
    }
    const result = evaluate(pieces.join("\n"), bindings, exports, file);
    cache.set(file, result);
    return result;
  }
  function declarationNames(node) {
    return node.type === "VariableDeclaration"
      ? node.declarations.map(d => d.id.name)
      : [node.id.name];
  }
  function selected(relative, names, bindings) {
    const file = path.join(CORE, "dist/esm", relative);
    const { source, ast } = read(file);
    const nodes = ast.body.map(node => node.type === "ExportNamedDeclaration" ? node.declaration : node);
    const declarations = names.map(name => {
      const node = nodes.find(n => n && ["FunctionDeclaration", "VariableDeclaration"].includes(n.type)
        && declarationNames(n).includes(name));
      if (!node) throw new Error(`Missing Decap declaration ${relative}:${name}`);
      return source.slice(node.start, node.end);
    });
    return evaluate(declarations.join("\n"), bindings, names, file);
  }
  const registry = module(path.join(CORE, "dist/esm/lib/registry.js"));
  const formats = module(path.join(CORE, "dist/esm/formats/formats.js"));
  const widgetPath = path.join(path.dirname(coreRequire.resolve("decap-cms-lib-widgets/package.json")),
    "dist/esm/stringTemplate.js");
  const { keyToPathArray } = module(widgetPath);
  const comments = selected("reducers/collections.js",
    ["getFieldsNames", "selectField", "selectFieldsComments"], { List, keyToPathArray });
  const defaults = selected("actions/entries.js", ["createEmptyDraftData"],
    { List, Map, isEqual: coreRequire("lodash/isEqual") });
  const backendFile = path.join(CORE, "dist/esm/backend.js");
  const { source, ast } = read(backendFile);
  const backend = ast.body.map(node => node.type === "ExportNamedDeclaration" ? node.declaration : node)
    .find(node => node?.type === "ClassDeclaration" && node.id.name === "Backend");
  if (!backend) throw new Error("Missing Decap Backend class");
  const methods = ["invokeEventWithEntry", "invokePreSaveEvent", "fieldsOrder", "entryToRaw"].map(name => {
    const node = backend.body.body.find(n => n.type === "MethodDefinition" && n.key.name === name);
    if (!node) throw new Error(`Missing Decap Backend.${name}`);
    return source.slice(node.start, node.end);
  });
  const { SaveBackend } = evaluate(`class SaveBackend { ${methods.join("\n")} }`,
    { List, invokeEvent: registry.invokeEvent, resolveFormat: formats.resolveFormat,
      selectFieldsComments: comments.selectFieldsComments }, ["SaveBackend"], backendFile);
  return { registry, defaults, backend: new SaveBackend() };
}

function renderedPostsCollection(collectionName = "posts") {
  const cacheDirectory = path.join(__dirname, "node_modules/.cache");
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(cacheDirectory, "c38-config-"));
  try {
    const admin = path.join(temporary, "admin");
    fs.mkdirSync(admin);
    for (const name of ["config.base.yml", "field_library.yml"]) {
      fs.copyFileSync(path.join(ROOT, "theme/admin", name), path.join(admin, name));
    }
    fs.writeFileSync(path.join(temporary, "_config.yml"), YAML.stringify({
      url: "https://example.com", title: "Fixture site",
      cms: { repository: "example/site", oauth_base_url: "https://example.com/oauth" },
    }));
    const output = path.join(temporary, "_site");
    execFileSync("ruby", [path.join(ROOT, "scripts/render-decap-config.rb"), temporary, output],
      { encoding: "utf8" });
    const config = YAML.parse(fs.readFileSync(path.join(output, "admin/config.yml"), "utf8"));
    return fromJS(config.collections.find(c => c.name === "posts")).set("name", collectionName);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function uiGeneratedPost(title, collectionName = "posts") {
  const collection = renderedPostsCollection(collectionName);
  const { registry, defaults, backend } = decapRuntime();
  // The author lookup is the only backend I/O used by this save path.
  backend.currentUser = async () => ({ login: "fixture-author", name: "Fixture author" });
  await markEphemeralTestPost({
    evaluate: async (fn, arg) => vm.runInNewContext(`(${fn.toString()})(arg)`,
      { window: { CMS: registry }, arg }),
  }, { title: "E2E Offline Front Matter" });
  const data = fromJS(defaults.createEmptyDraftData(collection.get("fields")))
    .merge({ title, body: "Offline editor content.", date: "2026-01-02 03:04:05 +0000", published: true });
  const entry = fromJS({ collection: collectionName, newRecord: true }).set("data", data);
  // These are the same calls persistEntry uses before handing raw to its
  // backend. GitHub persistence, widgets' date clock, and React mounting are
  // outside this deterministic regression; serialization is entirely Decap.
  const savedEntry = await backend.invokePreSaveEvent(entry);
  const raw = backend.entryToRaw(collection, savedEntry);
  const documents = YAML.parseAllDocuments(raw);
  expect(documents[0].errors).toEqual([]);
  expect(documents[1].errors).toEqual([]);
  expect(documents[1].toJS()).toBe("Offline editor content.");
  expect(documents[0].get("published")).toBe(true);
  return documents[0].toJS();
}

test("offline serializer matches the Decap release shipped by the admin shell", () => {
  expect(decapPin(fs.readFileSync(path.join(ROOT, "theme/admin/index.html"), "utf8"))).toBe("3.15.1");
  expect(coreRequire("./package.json").version).toBe("3.17.1");
});

test("the UI test-post save produces all three YAML exclusion markers", async () => {
  const data = await uiGeneratedPost("E2E Offline Front Matter");
  expect(data.title).toBe("E2E Offline Front Matter");
  expect(data.robots).toBe("noindex,nofollow");
  expect(data.sitemap).toBe(false);
  expect(data.test_fixture).toBe(true);
});

test("a normal UI post retains the hidden default without test-post exclusions", async () => {
  // Same form and still-registered listener: its title boundary protects a
  // normal post rather than relying on a separate unmarked save implementation.
  const data = await uiGeneratedPost("Normal editor post");
  expect(data.title).toBe("Normal editor post");
  expect(Object.hasOwn(data, "robots")).toBe(false);
  expect(Object.hasOwn(data, "sitemap")).toBe(false);
  expect(data.test_fixture).toBe(false);
});

test("a matching test-post title in a non-posts collection preserves the complete normal save", async () => {
  // Reuse every rendered field and the actual Decap save pipeline, changing
  // only the collection name so the registered title cannot mask this guard.
  const normal = await uiGeneratedPost("Normal editor post", "pages");
  const matching = await uiGeneratedPost("E2E Offline Front Matter", "pages");
  expect(matching).toEqual({ ...normal, title: "E2E Offline Front Matter" });
  expect(matching.title).toBe("E2E Offline Front Matter");
  expect(matching.date).toBe("2026-01-02 03:04:05 +0000");
  expect(matching.published).toBe(true);
  expect(matching.test_fixture).toBe(false);
  expect(Object.hasOwn(matching, "robots")).toBe(false);
  expect(Object.hasOwn(matching, "sitemap")).toBe(false);
});
