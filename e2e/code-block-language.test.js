// @lane: local — pure-Node lifecycle regression; required self-ci node-unit-lints.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");
const SRC = fs.readFileSync(path.join(__dirname, "../theme/admin/code-block-language.js"), "utf8");
let parseHTML;
test.beforeAll(async () => { ({ parse: parseHTML } = await import("parse5")); });

function load() {
  class StockControl {
    constructor(props) {
      this.props = props;
      this.state = { lang: "", isLangInitialized: false };
      this.mounts = 0;
      this.changes = [];
      this.pendingState = [];
    }
    setState(patch) { this.pendingState.push(patch); }
    flushUpdates() {
      // React batches the stock mount and the subclass's setState together.
      // Updates queued by componentDidUpdate commit in the next batch.
      let batches = 0;
      while (this.pendingState.length) {
        if (++batches > 10) throw new Error("State updates did not settle");
        const previousState = this.state;
        const patches = this.pendingState;
        this.pendingState = [];
        this.state = Object.assign({}, previousState, ...patches);
        this.componentDidUpdate(previousState);
      }
    }
    getInitialLang() { return this.props.lang; }
    componentDidMount() {
      this.mounts++;
      this.setState({ lang: this.getInitialLang() || "" });
    }
    componentDidUpdate(previousState) {
      // Model the pinned CodeControl's updateCodeMirrorProps/handleChange path:
      // only a changed, nonempty language initializes or emits onChange.
      const changed = { lang: previousState.lang !== this.state.lang ? this.state.lang : undefined };
      if (!changed.lang) return;
      const ignore = !this.state.isLangInitialized && !!changed.lang;
      this.setState({ isLangInitialized: true });
      if (!ignore) this.changes.push(this.state.lang);
    }
    selectLanguage(lang) {
      this.setState({ lang });
    }
  }
  const widget = {
    control: StockControl, preview: function Preview() {}, schema: { type: "object" },
    allowMapValue: true, globalStyles: "stock styles", codeMirrorConfig: { extraKeys: {} },
  };
  const registrations = [];
  vm.runInNewContext(SRC, {
    window: { CMS: { getWidget: () => widget, registerWidget: w => {
      // Same option-spread order as Decap's public object registration API.
      const { name, controlComponent: control, previewComponent: preview, schema,
        allowMapValue, globalStyles, ...options } = w;
      registrations.push({ name, control, preview, schema, allowMapValue, globalStyles, ...options });
    } } },
    document: { readyState: "complete" }, Date, setTimeout() {},
  });
  return { widget, registered: registrations[0], registrations };
}

test("stock deferred initialization loses a new block's first selection but preserves existing mounts", () => {
  const { widget } = load();
  const empty = new widget.control({ isEditorComponent: true });
  empty.componentDidMount();
  empty.flushUpdates();
  expect(empty.state.isLangInitialized).toBe(false);
  empty.selectLanguage("python");
  empty.flushUpdates();
  expect(empty.changes).toEqual([]);
  expect(empty.state.isLangInitialized).toBe(true);

  const existing = new widget.control({ isEditorComponent: true, lang: "python" });
  existing.componentDidMount();
  expect(existing.state.lang).toBe("");
  existing.flushUpdates();
  expect(existing.state.lang).toBe("python");
  expect(existing.state.isLangInitialized).toBe(true);
  expect(existing.changes).toEqual([]);
  existing.selectLanguage("javascript");
  existing.flushUpdates();
  expect(existing.changes).toEqual(["javascript"]);
});

test("first Mode selection on a new code block is persisted", () => {
  const { registered } = load();
  for (const lang of [undefined, ""]) {
    const control = new registered.control({ isEditorComponent: true, lang });
    control.componentDidMount();
    control.flushUpdates();
    expect(control.changes).toEqual([]);
    control.selectLanguage("python");
    control.flushUpdates();
    expect(control.changes).toEqual(["python"]);
    expect(control.mounts).toBe(1);
  }
});

test("preexisting languages and standalone code fields keep stock initialization", () => {
  const { registered } = load();
  const existing = new registered.control({ isEditorComponent: true, lang: "python" });
  existing.componentDidMount();
  expect(existing.state.lang).toBe("");
  existing.flushUpdates();
  expect(existing.changes).toEqual([]);
  expect(existing.state.lang).toBe("python");
  existing.selectLanguage("javascript");
  existing.flushUpdates();
  expect(existing.changes).toEqual(["javascript"]);
  const standalone = new registered.control({ isEditorComponent: false });
  standalone.componentDidMount();
  standalone.flushUpdates();
  expect(standalone.state.isLangInitialized).toBe(false);
  standalone.selectLanguage("python");
  standalone.flushUpdates();
  expect(standalone.changes).toEqual([]);
});

test("widget registration retains the stock preview and configuration", () => {
  const { widget, registered, registrations } = load();
  expect(registrations).toHaveLength(1);
  expect(registered.name).toBe("code");
  for (const [key, value] of Object.entries(widget)) {
    if (key !== "control") expect(registered[key]).toBe(value);
  }
  expect(registered.control).not.toBe(widget.control);
  expect(new registered.control({})).toBeInstanceOf(widget.control);
});

function activeScripts(html) {
  const scripts = [];
  function visit(node) {
    // Templates and scripting-enabled noscript contents are inert markup.
    // Comments have no child elements, so they cannot contribute scripts.
    if (node.tagName === "template" || node.tagName === "noscript") return;
    if (node.tagName === "script") {
      scripts.push({ node, attributes: Object.fromEntries(node.attrs.map(a => [a.name, a.value])) });
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parseHTML(html, { sourceCodeLocationInfo: true, scriptingEnabled: true }));
  return scripts;
}

function assertFixLoadsAfterDecap(html) {
  const scripts = activeScripts(html);
  const fixes = scripts.filter(s => s.attributes.src === "code-block-language.js");
  const decap = scripts.filter(s => (s.attributes.src || "").endsWith("/decap-cms.js"));
  expect(fixes).toHaveLength(1);
  expect(decap).toHaveLength(1);
  for (const script of [decap[0], fixes[0]]) {
    const attrs = script.attributes;
    expect([undefined, "", "text/javascript", "application/javascript"]).toContain(attrs.type);
    expect(attrs).not.toHaveProperty("async");
    expect(attrs).not.toHaveProperty("nomodule");
  }
  expect(scripts.indexOf(fixes[0])).toBeGreaterThan(scripts.indexOf(decap[0]));
  // Blocking Decap precedes either mode; deferred Decap requires a deferred fix.
  if (Object.hasOwn(decap[0].attributes, "defer")) {
    expect(fixes[0].attributes).toHaveProperty("defer");
  }
}

for (const name of ["index.html", "index-local.html", "index-test.html"]) {
  const html = fs.readFileSync(path.join(__dirname, "../theme/admin", name), "utf8");
  test(`${name} loads an active executable fix after Decap`, () => {
    assertFixLoadsAfterDecap(html);
  });
  for (const wrapper of ["comment", "template", "noscript"]) {
    test(`${name} rejects a fix hidden in ${wrapper} markup`, () => {
      const fix = activeScripts(html).find(s => s.attributes.src === "code-block-language.js");
      const { startOffset, endOffset } = fix.node.sourceCodeLocation;
      const tag = html.slice(startOffset, endOffset);
      const hidden = wrapper === "comment" ? `<!--${tag}-->` : `<${wrapper}>${tag}</${wrapper}>`;
      const disabled = html.slice(0, startOffset) + hidden + html.slice(endOffset);
      expect(() => assertFixLoadsAfterDecap(disabled)).toThrow();
    });
  }
  for (const attribute of ['type="text/plain"', "nomodule", "async"]) {
    test(`${name} rejects a fix with ${attribute}`, () => {
      const fix = activeScripts(html).find(s => s.attributes.src === "code-block-language.js");
      const { startOffset } = fix.node.sourceCodeLocation;
      const disabled = html.slice(0, startOffset) + `<script ${attribute}` + html.slice(startOffset + "<script".length);
      expect(() => assertFixLoadsAfterDecap(disabled)).toThrow();
    });
  }
  test(`${name} rejects asynchronous Decap loading`, () => {
    const decap = activeScripts(html).find(s => (s.attributes.src || "").endsWith("/decap-cms.js"));
    const { startOffset } = decap.node.sourceCodeLocation;
    const asynchronous = html.slice(0, startOffset) + "<script async" + html.slice(startOffset + "<script".length);
    expect(() => assertFixLoadsAfterDecap(asynchronous)).toThrow();
  });
  test(`${name} rejects the fix ordered before Decap`, () => {
    const scripts = activeScripts(html);
    const fix = scripts.find(s => s.attributes.src === "code-block-language.js");
    const decap = scripts.find(s => (s.attributes.src || "").endsWith("/decap-cms.js"));
    const { startOffset, endOffset } = fix.node.sourceCodeLocation;
    const tag = html.slice(startOffset, endOffset);
    const withoutFix = html.slice(0, startOffset) + html.slice(endOffset);
    const before = decap.node.sourceCodeLocation.startOffset;
    const reordered = withoutFix.slice(0, before) + tag + withoutFix.slice(before);
    expect(() => assertFixLoadsAfterDecap(reordered)).toThrow();
  });
  test(`${name} rejects a blocking fix ordered after deferred Decap`, () => {
    const scripts = activeScripts(html);
    const fix = scripts.find(s => s.attributes.src === "code-block-language.js");
    const decap = scripts.find(s => (s.attributes.src || "").endsWith("/decap-cms.js"));
    const { startOffset, endOffset } = fix.node.sourceCodeLocation;
    const blockingFix = '<script src="code-block-language.js"></script>';
    const withBlockingFix = html.slice(0, startOffset) + blockingFix + html.slice(endOffset);
    const before = decap.node.sourceCodeLocation.startOffset;
    const deferred = withBlockingFix.slice(0, before) + "<script defer" + withBlockingFix.slice(before + "<script".length);
    expect(() => assertFixLoadsAfterDecap(deferred)).toThrow();
  });
}
