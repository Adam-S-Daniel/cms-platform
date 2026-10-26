// @lane: local — parsed CSS and runtime contract for notice-safe Decap toasts.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const postcss = require("postcss");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const notices = postcss.parse(fs.readFileSync(path.join(ADMIN, "admin-notice-band.css"), "utf8"));

function declaration(rule, name) {
  let found;
  rule.walkDecls(name, (decl) => { found = decl; });
  return found;
}

test("top-right toasts use the measured notice edge and preserve the phone midpoint", () => {
  const rules = [];
  notices.walkRules((rule) => {
    if (rule.selector === 'body.cms-notice-band:has(> #cms-branch-binding-banner, > #cms-site-gate-banner)\n  [class*="Toastify__toast-container--top-right"]') rules.push(rule);
  });
  expect(rules).toHaveLength(1);
  expect(rules[0].parent.type).toBe("root");
  expect(declaration(rules[0], "top")?.value)
    .toBe("max(50%, calc(var(--cms-admin-notice-bottom, 0px) + 12px))");
  expect(declaration(rules[0], "top")?.important).toBe(true);
});

test("notice clearance follows wrapped banners and removes stale offsets", () => {
  const values = new Map();
  let mutated;
  let resize;
  const notices = new Map();
  const document = {
    documentElement: {},
    body: { style: {
      getPropertyValue: (key) => values.get(key) || "",
      setProperty: (key, value) => values.set(key, value),
      removeProperty: (key) => values.delete(key),
    } },
    getElementById: (id) => notices.get(id) || null,
  };
  const sandbox = {
    document,
    window: { addEventListener: (kind, fn) => { if (kind === "resize") resize = fn; } },
    MutationObserver: class {
      constructor(fn) { mutated = fn; }
      observe() {}
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ADMIN, "notice-toast-clearance.js"), "utf8"), sandbox);
  expect(values.size, "a page without notices keeps Decap's default position").toBe(0);

  notices.set("cms-branch-binding-banner", { getBoundingClientRect: () => ({ bottom: 90 }) });
  notices.set("cms-site-gate-banner", { getBoundingClientRect: () => ({ bottom: 236.2 }) });
  mutated();
  expect(values.get("--cms-admin-notice-bottom")).toBe("237px");
  notices.set("cms-site-gate-banner", { getBoundingClientRect: () => ({ bottom: 310 }) });
  resize();
  expect(values.get("--cms-admin-notice-bottom")).toBe("310px");
  notices.clear();
  mutated();
  expect(values.size).toBe(0);
});

test("the production shell loads the notice measurement after both banners", async () => {
  const { parse } = await import("parse5");
  const html = parse(fs.readFileSync(path.join(ADMIN, "index.html"), "utf8"));
  const scripts = [];
  function visit(node) {
    if (node.tagName === "script") {
      const src = (node.attrs || []).find((attr) => attr.name === "src");
      if (src) scripts.push(src.value);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(html);
  const clearance = scripts.indexOf("notice-toast-clearance.js");
  expect(clearance).toBeGreaterThan(scripts.indexOf("site-gate-banner.js"));
  expect(clearance).toBeGreaterThan(scripts.indexOf("branch-binding-banner.js"));
});
