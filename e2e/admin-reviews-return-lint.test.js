// @lane: local — pure-fs/vm: the Reviews dashboards' "Back to CMS" return target (#625.9)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");
const { parse } = require("./spec-ast");

// The admin shell's Reviews link carries the hash route the owner left as
// ?return=<hash>; each dashboard turns it into its "Back to CMS" href. The
// value is attacker-controllable (a crafted link), so it must only ever
// resolve to a same-origin /admin/ hash route.

const REVIEWS_DIR = path.join(__dirname, "..", "theme", "admin", "reviews");
const SHELL = path.join(__dirname, "..", "theme", "admin", "index.html");

function scriptsOf(file) {
  const html = fs.readFileSync(file, "utf8");
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

// Load cmsReturnHref out of a dashboard's real inline script (declaration
// found by parsing the AST, then evaluated in an isolated vm context).
function loadReturnHref(page) {
  const src = scriptsOf(path.join(REVIEWS_DIR, page)).find((s) =>
    parse(s).body.some((n) => n.type === "FunctionDeclaration" && n.id.name === "cmsReturnHref"),
  );
  expect(src, `${page} must define cmsReturnHref`).toBeTruthy();
  const ast = parse(src);
  const decls = ast.body.filter(
    (n) =>
      n.type === "FunctionDeclaration" && ["cmsReturnHash", "cmsReturnHref"].includes(n.id.name),
  );
  const ctx = vm.createContext({ URLSearchParams });
  vm.runInContext(decls.map((n) => src.slice(n.start, n.end)).join("\n"), ctx);
  return ctx.cmsReturnHref;
}

for (const page of ["index.html", "health.html"]) {
  test.describe(`reviews/${page}: Back to CMS return target`, () => {
    test("honours a same-origin Decap hash route", () => {
      const href = loadReturnHref(page);
      const hash = "#/collections/posts/entries/2026-04-25-a-post";
      expect(href(`?return=${encodeURIComponent(hash)}`)).toBe(`/admin/${hash}`);
      expect(href(`?x=1&return=${encodeURIComponent("#/collections/media/new?a=b")}`)).toBe(
        "/admin/#/collections/media/new?a=b",
      );
    });

    test("falls back to /admin/ for a missing or non-admin-hash target", () => {
      const href = loadReturnHref(page);
      for (const bad of [
        "",
        "?return=",
        "?return=https://evil.example.net/",
        "?return=//evil.example.net",
        "?return=/admin/x",
        "?return=%23evil.example.net", // "#evil.example.net": not a "#/" route
        "?return=javascript:alert(1)",
        `?return=${encodeURIComponent('#/x"onmouseover="a')}`,
        `?return=${encodeURIComponent("#/x<script>")}`,
        `?return=${encodeURIComponent("#/" + "a".repeat(600))}`,
        "?return=%E0%A4%A", // malformed percent-encoding
      ]) {
        expect(href(bad), `search ${JSON.stringify(bad)}`).toBe("/admin/");
      }
    });

    test("the Back to CMS anchor is wired to it", () => {
      const html = fs.readFileSync(path.join(REVIEWS_DIR, page), "utf8");
      expect(html).toMatch(/<a id="back-to-cms" href="\/admin\/"/);
      expect(html).toContain("wireCmsReturnLinks");
    });
  });
}

test("the admin shell's Reviews link is re-pointed at the current hash on every route change", () => {
  const html = fs.readFileSync(SHELL, "utf8");
  expect(html).toContain("syncReviewsReturn");
  expect(html).toMatch(/addEventListener\('hashchange', syncReviewsReturn\)/);
  expect(html).toContain("'?return=' + encodeURIComponent(h)");
});
