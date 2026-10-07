// @lane: local — pure-Node lifecycle regression; required self-ci node-unit-lints.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");
const SRC = fs.readFileSync(path.join(__dirname, "../theme/admin/code-block-language.js"), "utf8");

function load() {
  class StockControl {
    constructor(props) {
      this.props = props;
      this.state = { lang: "", isLangInitialized: false };
      this.mounts = 0;
      this.changes = [];
    }
    setState(patch) { Object.assign(this.state, patch); }
    getInitialLang() { return this.props.lang; }
    componentDidMount() {
      this.mounts++;
      this.setState({ lang: this.getInitialLang() || "" });
      // Stock updateCodeMirrorProps runs only when the language changed.
      if (this.state.lang) this.setState({ isLangInitialized: true });
    }
    selectLanguage(lang) {
      // Stock's first language update is treated as initialization.
      const ignore = !this.state.isLangInitialized;
      this.setState({ lang, isLangInitialized: true });
      if (!ignore) this.changes.push(lang);
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
      registrations.push({ control, preview, schema, allowMapValue, globalStyles, ...options });
    } } },
    document: { readyState: "complete" }, Date, setTimeout() {},
  });
  return { widget, registered: registrations[0], registrations };
}

test("first Mode selection on a new code block is persisted", () => {
  const { registered } = load();
  for (const lang of [undefined, ""]) {
    const control = new registered.control({ isEditorComponent: true, lang });
    control.componentDidMount();
    control.selectLanguage("python");
    expect(control.changes).toEqual(["python"]);
    expect(control.mounts).toBe(1);
  }
});

test("preexisting languages and standalone code fields keep stock initialization", () => {
  const { registered } = load();
  const existing = new registered.control({ isEditorComponent: true, lang: "python" });
  existing.componentDidMount();
  expect(existing.changes).toEqual([]);
  expect(existing.state.lang).toBe("python");
  existing.selectLanguage("javascript");
  expect(existing.changes).toEqual(["javascript"]);
  const standalone = new registered.control({ isEditorComponent: false });
  standalone.componentDidMount();
  expect(standalone.state.isLangInitialized).toBe(false);
});

test("widget registration retains the stock preview and configuration", () => {
  const { widget, registered, registrations } = load();
  expect(registrations).toHaveLength(1);
  for (const key of ["schema", "allowMapValue", "globalStyles", "codeMirrorConfig"]) {
    expect(registered[key]).toBe(widget[key]);
  }
  expect(registered.preview).toBe(widget.preview);
  expect(registered.control).not.toBe(widget.control);
  expect(new registered.control({})).toBeInstanceOf(widget.control);
});

test("all three admin shells load the fix after Decap", () => {
  for (const name of ["index.html", "index-local.html", "index-test.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "../theme/admin", name), "utf8");
    // Script src is a lexical HTML attribute, not JavaScript code shape.
    const sources = Array.from(html.matchAll(/<script\s+src="([^"]+)"/g), m => m[1]);
    expect(sources.filter(s => s === "code-block-language.js")).toHaveLength(1);
    const decapIndex = sources.findIndex(s => s.endsWith("/decap-cms.js"));
    expect(decapIndex).toBeGreaterThanOrEqual(0);
    expect(sources.indexOf("code-block-language.js")).toBeGreaterThan(decapIndex);
  }
});
