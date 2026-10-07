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

// A minimal stand-in for Decap's Immutable entry: getIn(["data", k]) and
// get("data") returning a Map-like with get/set (set returns a copy).
function dataMap(data) {
  return { get: (k) => data[k], set: (k, v) => dataMap({ ...data, [k]: v }) };
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

  test("a project iframe renders from description without requesting an absent body field", () => {
    const b = boot();
    const props = decapProps(PROJECT_FIELDS, { title: "Robot", description: EMBED_BODY });
    const declaredWidget = props.widgetFor;
    const calls = [];
    props.widgetFor = (name, fields, values) => {
      declaredWidget(name);
      calls.push({ name, value: values.get(name), title: values.get("title") });
      return widgetFor(name, fields, values);
    };
    expect(() => declaredWidget("body")).toThrow();
    let tree;
    expect(() => (tree = b.templates.projects(props))).not.toThrow();
    expect(find(tree, (n) => n.type === "iframe")).toHaveLength(1);
    expect(calls).toEqual([
      { name: "description", value: "Intro paragraph.\n\n<!-- html-embed:start -->", title: "Robot" },
      { name: "description", value: "\nClosing paragraph.", title: "Robot" },
    ]);
  });

  test("a generic collection renders an iframe from its renamed markdown field", () => {
    const b = boot();
    b.press("#/collections/articles");
    const props = decapProps([
      { name: "title", widget: "string" },
      { name: "article", widget: "markdown" },
    ], { title: "An article", article: EMBED_BODY });
    const declaredWidget = props.widgetFor;
    const calls = [];
    props.widgetFor = (name, fields, values) => {
      declaredWidget(name);
      calls.push({ name, value: values.get(name) });
      return widgetFor(name, fields, values);
    };
    expect(() => declaredWidget("body")).toThrow();
    const tree = b.templates.articles(props);
    expect(find(tree, (n) => n.type === "iframe")).toHaveLength(1);
    expect(calls).toEqual([
      { name: "article", value: "Intro paragraph.\n\n<!-- html-embed:start -->" },
      { name: "article", value: "\nClosing paragraph." },
    ]);
  });

  test("a field-free collection ignores a stray body iframe without calling a widget", () => {
    const b = boot();
    b.press("#/collections/empty");
    for (const collection of ["posts", "pages", "projects", "empty"]) {
      let calls = 0;
      const props = decapProps([], { title: "Still standing", body: EMBED_BODY }, {
        widgetFor() {
          calls++;
          throw new Error("No fields are declared");
        },
      });
      const tree = b.templates[collection](props);
      expect(calls, collection).toBe(0);
      expect(textOf(tree), collection).toContain("Still standing");
      expect(find(tree, (n) => n.props.className === "post-content"), collection).toHaveLength(0);
      expect(find(tree, (n) => n.type === "iframe"), collection).toHaveLength(0);
    }
  });

  test("a widget that throws during split markdown leaves the pane standing", () => {
    const b = boot();
    let calls = 0;
    const props = decapProps(PROJECT_FIELDS, { title: "Robot", description: EMBED_BODY }, {
      widgetFor(name, fields, values) {
        calls++;
        if (calls === 2) throw new Error("Closing markdown failed");
        return widgetFor(name, fields, values);
      },
    });
    let tree;
    expect(() => (tree = b.templates.projects(props))).not.toThrow();
    expect(calls).toBe(2);
    expect(textOf(tree)).toContain("Robot");
    expect(find(tree, (n) => n.props.className === "post-content")).toHaveLength(0);
  });

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
    expect(md).toEqual(["Intro paragraph.\n\n<!-- html-embed:start -->", "\nClosing paragraph."]);
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

  test("an HTML comment ends before the following fenced iframe", () => {
    const body = '<!-- example -->\n```html\n<iframe src="/x"></iframe>\n```';
    expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body)).toBeNull();
    expect(find(renderPost(body), (n) => n.type === "iframe")).toHaveLength(0);
    expect(find(renderPost(body), (n) => n.type === "markdown-preview").map((n) => n.props.value)).toEqual(["WHOLE-BODY"]);
  });

  test("an iframe spelling inside an HTML comment is never extracted", () => {
    const body = '<div>\n<!-- <iframe src="/example"></iframe> -->\n</div>';
    expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body)).toBeNull();
    expect(find(renderPost(body), (n) => n.type === "markdown-preview").map((n) => n.props.value)).toEqual(["WHOLE-BODY"]);
  });

  test("terminated HTML blocks leave a following iframe example in markdown", () => {
    for (const prefix of [
      "<?demo?>",
      "<!DOCTYPE html>",
      "<![CDATA[example]]>",
      "<script>example</script>",
      "<pre>example</pre>",
      "<style>example</style>",
      "<textarea>example</textarea>",
    ]) {
      const body = `${prefix}\n~~~html\n<iframe src="/x"></iframe>\n~~~`;
      expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body), prefix).toBeNull();
      expect(find(renderPost(body), (n) => n.type === "iframe"), prefix).toHaveLength(0);
    }
  });

  test("HTML blocks ending at a blank line preserve a following fenced example", () => {
    for (const prefix of ["<div>example</div>", "<custom-tag>example</custom-tag>"]) {
      const body = `${prefix}\n\n~~~html\n<iframe src="/x"></iframe>\n~~~`;
      expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body), prefix).toBeNull();
      expect(find(renderPost(body), (n) => n.type === "iframe"), prefix).toHaveLength(0);
    }
  });

  test("fenced examples and real embeds keep their document order", () => {
    const body = '<!-- example -->\n```html\n<iframe src="/code"></iframe>\n```\n\n<iframe src="/live"></iframe>\n\nAfter.';
    const tree = renderPost(body);
    expect(find(tree, (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(["/live"]);
    const markdown = find(tree, (n) => n.type === "markdown-preview").map((n) => n.props.value);
    expect(markdown).toEqual(['<!-- example -->\n```html\n<iframe src="/code"></iframe>\n```\n', '\nAfter.']);
  });

  test("list and blockquote embeds remain live inside their containers", () => {
    for (const [body, container] of [
      ['- <iframe src="/x"></iframe>', "li"],
      ['> <iframe src="/x"></iframe>', "blockquote"],
    ]) {
      const tree = renderPost(body);
      expect(find(tree, (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(["/x"]);
      const [parent] = find(tree, (n) => n.type === container);
      expect(find(parent, (n) => n.type === "iframe")).toHaveLength(1);
    }
  });

  test("an HTML block stops when its quote or list item ends", () => {
    const bodies = [
      '> <!-- note\n<iframe src="/real"></iframe>',
      '> <div>\n> <iframe src="/quoted"></iframe>\n```html\n<iframe src="/code"></iframe>\n```',
      '- <div>\n  <iframe src="/first"></iframe>\n- <iframe src="/second"></iframe>',
    ];
    const expected = [["/real"], ["/quoted"], ["/first", "/second"]];
    for (let i = 0; i < bodies.length; i++) {
      const tree = renderPost(bodies[i]);
      expect(find(tree, (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(expected[i]);
      if (i === 1) {
        const markdown = find(tree, (n) => n.type === "markdown-preview").map((n) => n.props.value);
        expect(markdown.join("\n")).toContain('```html\n<iframe src="/code"></iframe>\n```');
      }
    }
  });

  test("fenced and indented examples inside containers remain markdown", () => {
    for (const body of [
      '> ```html\n> <iframe src="/x"></iframe>\n> ```',
      '- ```html\n  <iframe src="/x"></iframe>\n  ```',
      '    <iframe src="/x"></iframe>',
    ]) {
      expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body), body).toBeNull();
      expect(find(renderPost(body), (n) => n.type === "iframe"), body).toHaveLength(0);
    }
  });

  test("list padding preserves indented iframe code on initial and continuation lines", () => {
    for (const body of [
      '-     <iframe src="/code"></iframe>',
      '1.     <iframe src="/code"></iframe>',
      '> -     <iframe src="/code"></iframe>',
      '- Intro\n      <iframe src="/code"></iframe>',
      '1. Intro\n       <iframe src="/code"></iframe>',
      '> - Intro\n>       <iframe src="/code"></iframe>',
      '-     Intro\n      <iframe src="/code"></iframe>',
      '-\t  <iframe src="/code"></iframe>',
      '-\tIntro\n\n\t\t<iframe src="/code"></iframe>',
    ]) {
      expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body), body).toBeNull();
      expect(find(renderPost(body), (n) => n.type === "iframe"), body).toHaveLength(0);
    }
    for (const padding of [" ", "  ", "   ", "    ", "\t", "\t "]) {
      const body = `-${padding}<iframe src="/live"></iframe>`;
      expect(find(renderPost(body), (n) => n.type === "iframe").map((n) => n.props.src), body).toEqual(["/live"]);
    }
    expect(find(renderPost('-\tIntro\n\n\t<iframe src="/live"></iframe>'), (n) => n.type === "iframe")
      .map((n) => n.props.src)).toEqual(["/live"]);
    for (const body of [
      '-     ```html\n  <iframe src="/live"></iframe>',
      '1.     ```html\n   <iframe src="/live"></iframe>',
      '> -     ```html\n>   <iframe src="/live"></iframe>',
      '-     Intro\n      ```html\n  <iframe src="/live"></iframe>',
      '> -     Intro\n>       ```html\n>   <iframe src="/live"></iframe>',
    ]) {
      expect(find(renderPost(body), (n) => n.type === "iframe").map((n) => n.props.src), body).toEqual(["/live"]);
    }
  });

  test("a backtick in a fence info string leaves the next valid fence in control", () => {
    const direct = '```foo`bar\n<iframe src="/live"></iframe>';
    expect(find(renderPost(direct), (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(["/live"]);
    for (const prefix of ["", "- ", "> ", "> - "]) {
      const continuation = prefix.includes("-") ? (prefix.includes(">") ? ">   " : "  ") : prefix;
      const body = `${prefix}\`\`\`foo\`bar\n${continuation}text\n${continuation}\`\`\`\n${continuation}<iframe src="/code"></iframe>\n${continuation}\`\`\``;
      expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body), body).toBeNull();
      expect(find(renderPost(body), (n) => n.type === "iframe"), body).toHaveLength(0);
    }
    const body = '~~~foo`bar\n<iframe src="/code"></iframe>\n~~~\n<iframe src="/live"></iframe>';
    expect(find(renderPost(body), (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(["/live"]);
  });

  test("a quote fence ends at the quote boundary and the outer fence starts anew", () => {
    const body = '> ```\n```\n<iframe src="/code"></iframe>';
    expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body)).toBeNull();
    expect(find(renderPost(body), (n) => n.type === "iframe")).toHaveLength(0);
  });

  test("container-looking lines inside a fence remain code", () => {
    for (const body of [
      '```html\n- <iframe src="/code"></iframe>\n```',
      '```html\n> <iframe src="/code"></iframe>\n```',
      '> ```html\n> > <iframe src="/code"></iframe>\n> ```',
      '- ```html\n  - <iframe src="/code"></iframe>\n  ```',
      '- > ```html\n  > <iframe src="/code"></iframe>\n  > ```',
      '- - ```html\n    <iframe src="/code"></iframe>\n    ```',
      '> - > ```html\n>   > <iframe src="/code"></iframe>\n>   > ```',
      '- > ```html\n  > > <iframe src="/code"></iframe>\n  > ```',
    ]) {
      expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body), body).toBeNull();
      expect(find(renderPost(body), (n) => n.type === "iframe"), body).toHaveLength(0);
    }
  });

  test("a quote fence cannot suppress a real embed after the quote ends", () => {
    const body = '> ```\n<iframe src="/live"></iframe>';
    expect(find(renderPost(body), (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(["/live"]);
  });

  test("a list item embed remains in the item across a blank line", () => {
    const body = '- Intro\n\n  <iframe src="/live"></iframe>';
    const tree = renderPost(body);
    const [item] = find(tree, (n) => n.type === "li");
    expect(find(item, (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(["/live"]);
  });

  test("a block tag interrupts prose but an inline or type 7 tag does not", () => {
    expect(find(renderPost('Intro\n<div><iframe src="/x"></iframe></div>'), (n) => n.type === "iframe")).toHaveLength(1);
    for (const body of [
      'Intro <iframe src="/x"></iframe>',
      'Intro\n<custom-tag><iframe src="/x"></iframe></custom-tag>',
    ]) {
      expect(boot().window.adamdaniel_cms_preview_pane.splitBody(body), body).toBeNull();
    }
  });

  test("type 7 requires a complete valid tag before it can contain an embed", () => {
    const invalid = '<custom-tag ???>\n```html\n<iframe src="/code"></iframe>\n```';
    expect(boot().window.adamdaniel_cms_preview_pane.splitBody(invalid)).toBeNull();
    expect(find(renderPost(invalid), (n) => n.type === "iframe")).toHaveLength(0);

    const valid = '<custom-tag data-kind="example">\n<iframe src="/live"></iframe>';
    expect(find(renderPost(valid), (n) => n.type === "iframe").map((n) => n.props.src)).toEqual(["/live"]);
  });

  test("the embed renderer drops scripts, handlers, srcdoc and unsafe URLs", () => {
    const body = [
      "<div>",
      '<iframe src="javascript:alert(1)" srcdoc="<script>alert(1)</script>" onload="alert(1)"></iframe>',
      '<iframe src=" java\tscript:alert(1)"></iframe>',
      '<iframe src="data:text/html,hi"></iframe>',
      '<iframe src="https://example.com/embed/x" allowfullscreen></iframe>',
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
      "https://example.com/embed/x",
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
