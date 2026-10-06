// @lane: local — pure-Node sandbox unit tests for theme/admin/preview-pane.js
/*
 * Issue #653: Decap's in-editor preview pane rendered in default Times, with the
 * raw `2026-10-05 09:40:00 -0400` date and "URL Slug:" lines, and overflowing
 * images. preview-pane.js registers the site stylesheet and a template per
 * previewable collection. The script is loaded in a vm sandbox with a stub
 * window.CMS and a recording `h`; the real pane is checked in a browser.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const yaml = require("yaml");
const walk = require("acorn-walk");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SRC = fs.readFileSync(path.join(ADMIN, "preview-pane.js"), "utf8");

function boot({ hash = "", lookup = true } = {}) {
  const styles = [];
  const templates = {};
  const listeners = { window: {}, document: {} };
  const listen = (where) => (type, fn) => (listeners[where][type] ||= []).push(fn);
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const window = {
    location: { href: "https://site.example.com/admin/index.html", hash },
    addEventListener: listen("window"),
    h,
    CMS: {
      registerPreviewStyle: (value, opts) => styles.push({ value, opts }),
      registerPreviewTemplate: (name, component) => (templates[name] = component),
      getPreviewTemplate: lookup ? (name) => templates[name] : undefined,
    },
  };
  const document = { readyState: "complete", addEventListener: listen("document") };
  const sandbox = { window, document, URL, Date, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  // A press on a link: what Decap's collection list and "+ New" button are.
  const press = (href) =>
    (listeners.document.pointerdown || []).forEach((fn) =>
      fn({ target: { closest: () => ({ getAttribute: () => href }) } }),
    );
  const navigate = (newHash) => {
    window.location.hash = newHash;
    (listeners.window.hashchange || []).forEach((fn) => fn({}));
  };
  return { styles, templates, window, press, navigate, listeners };
}

// Decap's real contract (decap-cms-core PreviewPane.widgetFor): a name that is
// not one of the collection's fields THROWS ("Cannot read properties of
// undefined (reading 'get')"), and the throw replaces the pane with Decap's raw
// error screen. `fields` is what Decap passes every template as props.fields.
function decapProps(fields, data, extra = {}) {
  return {
    entry: entry(data),
    fields: { toJS: () => fields },
    widgetFor(name) {
      if (!fields.some((f) => f.name === name)) {
        throw new TypeError("Cannot read properties of undefined (reading 'get')");
      }
      return "WIDGET:" + name;
    },
    getAsset: String,
    ...extra,
  };
}

// The fields of theme/admin/config.base.yml's collections the preview assumes.
const PROJECT_FIELDS = [
  { name: "title", widget: "string" },
  { name: "technology", widget: "string" },
  { name: "url_link", widget: "string" },
  { name: "featured", widget: "boolean" },
  { name: "images", widget: "list" },
  { name: "description", widget: "markdown" },
];
const TOOL_FIELDS = [
  { name: "title", widget: "string" },
  { name: "slug", label: "URL slug", widget: "string" },
  { name: "description", widget: "text" },
  { name: "featured", widget: "boolean" },
  { name: "embed_src", label: "Embed source path", widget: "string" },
  { name: "source_url", widget: "string" },
  { name: "body", widget: "markdown" },
];
const TAG_FIELDS = [
  { name: "name", widget: "string" },
  { name: "description", widget: "text" },
];

function entry(data) {
  return { getIn: ([, k]) => data[k] };
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return [].concat(node.children || []).map(textOf).join("|");
}

function find(node, pred, out = []) {
  if (!node || typeof node === "string") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) find(c, pred, out);
  return out;
}

test.describe("preview-pane.js", () => {
  test("registers the site stylesheet and a template per previewable collection", () => {
    const b = boot();
    expect(b.styles[0].value).toBe("https://site.example.com/assets/css/main.css");
    expect(Object.keys(b.templates).sort()).toEqual(["pages", "posts", "projects"]);
  });

  test("a post renders a formatted date, never the raw stored string", () => {
    const b = boot();
    const tree = b.templates.posts({
      entry: entry({ title: "Hello", date: "2026-10-05 09:40:00 -0400", slug: "x" }),
      widgetFor: () => "BODY",
      getAsset: (p) => p,
    });
    const [time] = find(tree, (n) => n.type === "time");
    expect(textOf(time)).toBe("October 5, 2026");
    const all = textOf(tree);
    expect(all).not.toContain("09:40:00");
    expect(all).not.toContain("URL Slug");
    expect(all).toContain("Hello");
    expect(all).toContain("BODY");
  });

  test("a featured image goes through getAsset", () => {
    const b = boot();
    const tree = b.templates.posts({
      entry: entry({ title: "T", featured_image: "/a.png" }),
      widgetFor: () => null,
      getAsset: (p) => "blob:" + p,
    });
    const [img] = find(tree, (n) => n.type === "img");
    expect(img.props.src).toBe("blob:/a.png");
  });

  test("a bad date is left as authored; pages and projects render titles", () => {
    const b = boot();
    expect(b.window.adamdaniel_cms_preview_pane.formatDate("soon")).toBe("soon");
    for (const c of ["pages", "projects"]) {
      const tree = b.templates[c]({ entry: entry({ title: "Name" }), widgetFor: () => null, getAsset: String });
      expect(textOf(tree)).toContain("Name");
    }
  });

  test("a project has no body field: the preview renders its description and never throws (#726)", () => {
    const b = boot();
    const props = decapProps(PROJECT_FIELDS, { title: "Robot", technology: "Python" });
    let tree;
    expect(() => (tree = b.templates.projects(props))).not.toThrow();
    const all = textOf(tree);
    expect(all).toContain("Robot");
    expect(all).toContain("Python");
    // The markdown field a Project does have is the one rendered.
    expect(all).toContain("WIDGET:description");
    expect(all).not.toContain("WIDGET:body");
  });

  test("a collection with no markdown field at all still renders (no body div, no throw)", () => {
    const b = boot();
    for (const c of ["posts", "pages", "projects"]) {
      const props = decapProps([{ name: "title", widget: "string" }], { title: "Only a title" });
      let tree;
      expect(() => (tree = b.templates[c](props)), c).not.toThrow();
      expect(textOf(tree), c).toContain("Only a title");
      expect(find(tree, (n) => n.props.className === "post-content"), c).toHaveLength(0);
    }
  });

  test("a collection WITH a body renders exactly what it did before", () => {
    const b = boot();
    const fields = [
      { name: "title", widget: "string" },
      { name: "body", widget: "markdown" },
    ];
    for (const c of ["posts", "pages"]) {
      const tree = b.templates[c](decapProps(fields, { title: "Hi" }));
      const [content] = find(tree, (n) => n.props.className === "post-content");
      expect(textOf(content), c).toBe("WIDGET:body");
    }
  });

  test("a widget that throws leaves the rest of the pane standing", () => {
    const b = boot();
    const props = decapProps(PROJECT_FIELDS, { title: "Robot" }, {
      widgetFor() {
        throw new Error("widget failed");
      },
    });
    expect(textOf(b.templates.projects(props))).toContain("Robot");
  });

  test("every collection the platform declares renders against its real field list", () => {
    // The platform's own folder collections, read from config.base.yml, are the
    // field lists a template is really handed (the list in this file's constants
    // would otherwise drift from it).
    const doc = yaml.parse(fs.readFileSync(path.join(ADMIN, "config.base.yml"), "utf8"));
    const b = boot();
    for (const c of doc.collections) {
      b.press("#/collections/" + c.name);
      const template = b.templates[c.name];
      expect(typeof template, c.name).toBe("function");
      const data = Object.fromEntries((c.fields || []).map((f) => [f.name, "x"]));
      const props = decapProps(c.fields || [], data);
      expect(() => template(props), c.name).not.toThrow();
    }
  });

  test("a site's own collection (Tools) gets a styled generic pane, not a field dump", () => {
    const b = boot();
    expect(b.templates.tools).toBeUndefined();
    b.press("#/collections/tools");
    const props = decapProps(TOOL_FIELDS, {
      title: "Calc",
      slug: "calc",
      description: "A calculator.",
      embed_src: "/assets/tools/calc/",
    });
    const tree = b.templates.tools(props);
    expect(find(tree, (n) => n.type === "h1").map(textOf)).toEqual(["Calc"]);
    expect(find(tree, (n) => n.props.className === "subtitle").map(textOf)).toEqual(["A calculator."]);
    const [content] = find(tree, (n) => n.props.className === "post-content");
    expect(textOf(content)).toBe("WIDGET:body");
    expect(find(tree, (n) => n.props.className === "container cms-preview-pane")).toHaveLength(1);
    const all = textOf(tree);
    expect(all).not.toContain("URL slug");
    expect(all).not.toContain("Embed source path");
    expect(all).not.toContain("/assets/tools/calc/");
  });

  test("Tags show their name and description", () => {
    const b = boot();
    b.press("#/collections/tags/new");
    const tree = b.templates.tags(decapProps(TAG_FIELDS, { name: "Python", description: "Snakes." }));
    expect(find(tree, (n) => n.type === "h1").map(textOf)).toEqual(["Python"]);
    expect(textOf(tree)).toContain("Snakes.");
  });

  test("a collection with neither markdown nor description lists its short fields, labeled", () => {
    const b = boot();
    b.press("#/collections/events");
    const fields = [
      { name: "title", widget: "string" },
      { name: "location", label: "Location", widget: "string" },
      { name: "weight", label: "Order", widget: "number" },
      { name: "links", label: "Links", widget: "list" },
    ];
    const tree = b.templates.events(decapProps(fields, { title: "Summit", location: "Kansas City, MO", weight: 2 }));
    expect(find(tree, (n) => n.type === "dt").map(textOf)).toEqual(["Location", "Order"]);
    expect(find(tree, (n) => n.type === "dd").map(textOf)).toEqual(["Kansas City, MO", "2"]);
  });

  test("the generic template is registered for the route's collection, once, and never over another", () => {
    const b = boot({ hash: "#/collections/tools/new" });
    expect(typeof b.templates.tools).toBe("function");
    const first = b.templates.tools;
    b.navigate("#/collections/tools/entries/calc");
    expect(b.templates.tools).toBe(first);
    // A template a site registered itself is left alone.
    const own = () => "own";
    b.templates.gadgets = own;
    b.press("#/collections/gadgets");
    expect(b.templates.gadgets).toBe(own);
    // The specific templates are never replaced, and non-collection links register nothing.
    const posts = b.templates.posts;
    b.press("#/collections/posts");
    b.press("#/search/tools");
    b.press("https://example.com/");
    expect(b.templates.posts).toBe(posts);
    expect(Object.keys(b.templates).sort()).toEqual(["gadgets", "pages", "posts", "projects", "tools"]);
  });

  test("the own-template guard holds without Decap's template lookup", () => {
    // getPreviewTemplate would also keep posts/pages/projects, so take it away:
    // only claim()'s own list stands between a link press and the generic
    // template replacing the specific one.
    const b = boot({ lookup: false });
    const own = { posts: b.templates.posts, pages: b.templates.pages, projects: b.templates.projects };
    for (const c of Object.keys(own)) b.press("#/collections/" + c);
    b.navigate("#/collections/projects/new");
    for (const c of Object.keys(own)) expect(b.templates[c], c).toBe(own[c]);
  });

  test("pane CSS constrains images and clears the floating buttons", () => {
    const b = boot();
    const raw = b.styles.find((s) => s.opts && s.opts.raw).value;
    expect(raw).toMatch(/img[^{]*\{\s*max-width:\s*100%/);
    expect(raw).toMatch(/padding-top/);
  });

  test("the script makes the three registration calls (AST)", () => {
    const calls = new Set();
    walk.simple(acorn.parse(SRC, { ecmaVersion: "latest" }), {
      CallExpression(n) {
        if (n.callee.type === "MemberExpression" && !n.callee.computed) calls.add(n.callee.property.name);
      },
    });
    expect(calls.has("registerPreviewStyle")).toBe(true);
    expect(calls.has("registerPreviewTemplate")).toBe(true);
  });

  test("every admin shell loads it after decap-cms.js", () => {
    for (const f of ["index.html", "index-local.html", "index-test.html"]) {
      const html = fs.readFileSync(path.join(ADMIN, f), "utf8");
      const decap = html.indexOf("decap-cms");
      const mine = html.indexOf('src="preview-pane.js"');
      expect(mine, f).toBeGreaterThan(decap);
    }
  });
});
