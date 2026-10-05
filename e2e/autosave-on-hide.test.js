// @lane: local — pure-Node vm-sandbox unit tests for the autosave-on-hide shim
/*
 * Behavioural tests for theme/admin/autosave-on-hide.js (cms-platform#625
 * item 3). No browser, no real timers: the shim runs in a vm sandbox with a
 * fake DOM and an injected setTimeout whose callbacks the test fires by hand.
 *
 * Pinned both ways:
 *   - an entry with a REQUIRED field still empty must NOT have its Save
 *     clicked by idle / tab-hide autosave (Decap's Save would paint red
 *     "… IS REQUIRED." errors + the "missed a required field" toast on a form
 *     the owner never tried to save);
 *   - an entry whose required fields are all filled still autosaves.
 *
 * The real-Decap DOM coupling (Save button found by text, editorial draft
 * lands) stays in e2e/cms-autosave.spec.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../theme/admin/autosave-on-hide.js"),
  "utf8",
);

/**
 * fields: [{ id, label, tag?, value?, role? }] — rendered the way Decap's
 * LabelComponent does: <label for=id>Label[ (optional)]</label> + a control
 * element with that id.
 */
function boot({ hash = "#/collections/media/new", fields = [] }) {
  const listeners = {};
  const timers = [];
  const clicks = [];

  const saveButton = {
    textContent: " Save ",
    click: () => clicks.push("save"),
  };
  const labels = fields.map((f) => ({
    textContent: f.label + (f.optional ? " (optional)" : ""),
    getAttribute: (n) => (n === "for" ? f.id : null),
  }));
  const controls = {};
  for (const f of fields) {
    controls[f.id] = {
      tagName: (f.tag || "INPUT").toUpperCase(),
      value: f.value || "",
      getAttribute: (n) => (n === "role" ? f.role || null : null),
    };
  }

  const document = {
    visibilityState: "visible",
    addEventListener: (evt, fn) => {
      (listeners[evt] = listeners[evt] || []).push(fn);
    },
    querySelectorAll: (sel) => (sel === "button" ? [saveButton] : sel === "label[for]" ? labels : []),
    getElementById: (id) => controls[id] || null,
  };
  const win = {
    __AUTOSAVE_IDLE_MS: 1000,
    addEventListener: (evt, fn) => {
      (listeners["win:" + evt] = listeners["win:" + evt] || []).push(fn);
    },
  };
  win.window = win;
  const sandbox = {
    window: win,
    document,
    location: { hash },
    console: { warn: () => {}, error: () => {}, log: () => {} },
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM_SOURCE, sandbox);

  return {
    clicks,
    controls,
    // user input arms the idle timer; then the idle period "elapses"
    idleElapses: () => {
      (listeners.keydown || []).forEach((fn) => fn({}));
      timers.splice(0).pop()();
    },
    tabHide: () => {
      document.visibilityState = "hidden";
      (listeners.visibilitychange || []).forEach((fn) => fn({}));
    },
    pageHide: () => (listeners["win:pagehide"] || []).forEach((fn) => fn({})),
  };
}

const NEW_MEDIA = [
  { id: "c1", label: "Category", tag: "input", value: "", role: "combobox" },
  { id: "t1", label: "Title", value: "" },
  { id: "s1", label: "Source", value: "" },
  { id: "u1", label: "Article URL", value: "" },
  { id: "o1", label: "Order", value: "" },
  { id: "n1", label: "Notes", value: "", optional: true },
];

test.describe("autosave-on-hide.js (unit)", () => {
  test("idle autosave does NOT click Save while required fields are empty (new entry)", () => {
    const h = boot({ fields: NEW_MEDIA });
    h.idleElapses();
    expect(h.clicks).toEqual([]);
  });

  test("tab-hide and pagehide do not click Save while required fields are empty", () => {
    const h = boot({ fields: NEW_MEDIA });
    h.tabHide();
    h.pageHide();
    expect(h.clicks).toEqual([]);
  });

  test("a whitespace-only required field counts as empty", () => {
    const fields = NEW_MEDIA.map((f) => ({ ...f, value: f.optional || f.role ? "" : "   " }));
    const h = boot({ fields });
    h.idleElapses();
    expect(h.clicks).toEqual([]);
  });

  test("one empty required field is enough to hold autosave back", () => {
    const fields = NEW_MEDIA.map((f) => ({ ...f, value: f.optional || f.role ? "" : "x" }));
    fields[3].value = "";
    const h = boot({ fields });
    h.idleElapses();
    expect(h.clicks).toEqual([]);
  });

  test("idle autosave still saves when every required text field is filled", () => {
    const fields = NEW_MEDIA.map((f) => ({ ...f, value: f.optional || f.role ? "" : "x" }));
    const h = boot({ fields });
    h.idleElapses();
    expect(h.clicks).toEqual(["save"]);
  });

  test("tab-hide still saves a complete entry", () => {
    const fields = NEW_MEDIA.map((f) => ({ ...f, value: f.optional || f.role ? "" : "x" }));
    const h = boot({ fields, hash: "#/collections/media/entries/some-slug" });
    h.tabHide();
    expect(h.clicks).toEqual(["save"]);
  });

  test("an empty OPTIONAL field never blocks autosave", () => {
    const h = boot({ fields: [{ id: "n1", label: "Notes", value: "", optional: true }] });
    h.idleElapses();
    expect(h.clicks).toEqual(["save"]);
  });

  test("a form with no checkable fields (rich-text/select only) still autosaves", () => {
    const h = boot({ fields: [{ id: "c1", label: "Category", role: "combobox" }] });
    h.idleElapses();
    expect(h.clicks).toEqual(["save"]);
  });

  test("off an entry-editor route nothing is clicked", () => {
    const h = boot({ hash: "#/collections/media", fields: [] });
    h.idleElapses();
    expect(h.clicks).toEqual([]);
  });
});
