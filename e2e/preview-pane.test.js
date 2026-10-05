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
const walk = require("acorn-walk");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SRC = fs.readFileSync(path.join(ADMIN, "preview-pane.js"), "utf8");

function boot() {
  const styles = [];
  const templates = {};
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const window = {
    location: { href: "https://site.example.com/admin/index.html" },
    h,
    CMS: {
      registerPreviewStyle: (value, opts) => styles.push({ value, opts }),
      registerPreviewTemplate: (name, component) => (templates[name] = component),
    },
  };
  const sandbox = { window, document: { readyState: "complete" }, URL, Date, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { styles, templates, window };
}

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
