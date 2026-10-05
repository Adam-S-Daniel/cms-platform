// @lane: local — pure-Node sandbox unit tests for theme/admin/preview-pane.js
/*
 * Issue #653: Decap's in-editor preview pane rendered in default Times, with the
 * raw `2026-10-05 09:40:00 -0400` date and "URL Slug:" lines, and overflowing
 * images. preview-pane.js registers the site stylesheet and a template per
 * previewable collection. Issue #687: an <iframe> embed in the body, which
 * Decap's sanitized markdown preview drops, is rendered by the template
 * itself from an allowlist. The script is loaded in a vm sandbox with a stub
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

// A minimal stand-in for Decap's Immutable entry: getIn(["data", k]) and
// get("data") returning a Map-like with get/set (set returns a copy).
function dataMap(data) {
  return { get: (k) => data[k], set: (k, v) => dataMap({ ...data, [k]: v }) };
}

function entry(data) {
  return { getIn: ([, k]) => data[k], get: (k) => (k === "data" ? dataMap(data) : undefined) };
}

// widgetFor(name, fields, values) stand-in: records the markdown it was given.
function widgetFor(name, _fields, values) {
  return { type: "markdown-preview", props: { value: values ? values.get(name) : "WHOLE-BODY" }, children: [] };
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

  // Issue #687: Decap's markdown preview sanitizes with DOMPurify's defaults,
  // which drop <iframe>. The template renders an HTML block holding one itself.
  const EMBED_BODY = [
    "Intro paragraph.",
    "",
    "<!-- html-embed:start -->",
    '<div class="post-embed">',
    "<iframe",
    '  src="/assets/tools/claude-memory-map/"',
    '  title="Claude Memory Map &mdash; a map"',
    '  loading="lazy"',
    '  style="width:100%; height:80vh; min-height:560px;"></iframe>',
    '<p style="font-size:0.85em;">Trouble? <a href="/tools/x/" target="_blank">Open it &rarr;</a></p>',
    "</div>",
    "<!-- html-embed:end -->",
    "",
    "Closing paragraph.",
  ].join("\n");

  function renderPost(body) {
    const b = boot();
    return b.templates.posts({ entry: entry({ title: "T", body }), widgetFor, getAsset: String });
  }

  test("an iframe embed in the body renders as an <iframe> in the template output", () => {
    const tree = renderPost(EMBED_BODY);
    const [iframe] = find(tree, (n) => n.type === "iframe");
    expect(iframe, "no <iframe> in the rendered template").toBeTruthy();
    expect(iframe.props.src).toBe("/assets/tools/claude-memory-map/");
    expect(iframe.props.title).toBe("Claude Memory Map — a map");
    expect(iframe.props.loading).toBe("lazy");
    expect(iframe.props.style).toEqual({ width: "100%", height: "80vh", minHeight: "560px" });
    // It sits in the embed wrapper, and the caption link survives with rel set.
    const [wrapper] = find(tree, (n) => n.type === "div" && n.props.className === "post-embed");
    expect(find(wrapper, (n) => n.type === "iframe")).toHaveLength(1);
    const [a] = find(wrapper, (n) => n.type === "a");
    expect(a.props).toMatchObject({ href: "/tools/x/", target: "_blank", rel: "noopener noreferrer" });
    expect(textOf(a)).toBe("Open it →");
    // The markdown around it still goes through Decap's markdown preview.
    const md = find(tree, (n) => n.type === "markdown-preview").map((n) => n.props.value);
    expect(md).toEqual(["Intro paragraph.\n", "\nClosing paragraph."]);
  });

  test("a body without an iframe block renders through widgetFor unchanged", () => {
    const tree = renderPost("Just text.\n\n<div>no frame</div>");
    const md = find(tree, (n) => n.type === "markdown-preview");
    expect(md.map((n) => n.props.value)).toEqual(["WHOLE-BODY"]);
    expect(find(tree, (n) => n.type === "iframe")).toHaveLength(0);
  });

  test("an iframe inside a code fence stays markdown", () => {
    const body = 'Example:\n\n```html\n<iframe src="/x"></iframe>\n```\n';
    expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body)).toBeNull();
    expect(find(renderPost(body), (n) => n.type === "iframe")).toHaveLength(0);
  });

  test("the embed renderer drops scripts, handlers, srcdoc and unsafe URLs", () => {
    const body = [
      "<div>",
      '<iframe src="javascript:alert(1)" srcdoc="<script>alert(1)</script>" onload="alert(1)"></iframe>',
      '<iframe src=" java\tscript:alert(1)"></iframe>',
      '<iframe src="data:text/html,hi"></iframe>',
      '<iframe src="https://www.youtube-nocookie.com/embed/x" allowfullscreen></iframe>',
      "<script>alert(1)</script><style>body{}</style>",
      '<img src="/a.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a>',
      '<object data="/x"><embed src="/x"></object><custom-el>kept text</custom-el>',
      "</div>",
    ].join("\n");
    const tree = renderPost(body);
    const iframes = find(tree, (n) => n.type === "iframe");
    expect(iframes.map((n) => n.props.src)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://www.youtube-nocookie.com/embed/x",
    ]);
    expect(iframes[3].props.allowFullScreen).toBe(true);
    const types = new Set(find(tree, () => true).map((n) => n.type));
    for (const t of ["script", "style", "object", "embed", "custom-el"]) expect(types.has(t), t).toBe(false);
    for (const n of find(tree, () => true)) {
      for (const k of Object.keys(n.props)) {
        expect(k.toLowerCase(), `${n.type}.${k}`).not.toMatch(/^on|^srcdoc$|^dangerouslysetinnerhtml$/);
      }
    }
    const [a] = find(tree, (n) => n.type === "a");
    expect(a.props.href).toBeUndefined();
    const all = textOf(tree);
    expect(all).not.toContain("alert");
    expect(all).toContain("kept text");
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
