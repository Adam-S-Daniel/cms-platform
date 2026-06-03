// @lane: local — pure-fs invariants on admin/index.html + admin/custom.css
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

/*
 * admin-theme-removed.test.js — pure-node invariants on admin/index.html
 *
 * PR #81 ("feat(admin): rip cobalt-thermal theme; /preview/ is the WYSIWYG")
 * removed the cobalt theme: `admin/custom.css` was deleted and the
 * stylesheet `<link>` was stripped from `admin/index.html`. Live preview
 * at `/preview/?collection=<n>` is the WYSIWYG now.
 *
 * This spec locks in the REMOVAL — assertions check that the theme stays
 * gone so a regression that re-introduces `admin/custom.css` or a
 * cobalt-theme `<link>` tag fails loud.
 *
 * (Earlier revision of this spec asserted the theme should EXIST, premised
 * on it being retained; the assertions were never updated after PR #81
 * actually removed the theme. The `<link>` and `custom.css` had been gone
 * since #81, so the original assertions were dead-on-arrival but only
 * surfaced once a PR touched `admin/index.html` and triggered the test
 * via diff-aware spec selection.)
 *
 * No browser, no jekyll — Playwright launches the file because it matches
 * testDir, but every assertion is plain `fs.readFileSync` + regex.
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const ADMIN_INDEX = path.join(REPO_ROOT, "theme", "admin", "index.html");
const ADMIN_CSS = path.join(REPO_ROOT, "theme", "admin", "custom.css");

test.describe("admin theme — removal invariants", () => {
  test("admin/custom.css does NOT exist (theme intentionally removed in #81)", () => {
    expect(
      fs.existsSync(ADMIN_CSS),
      `${ADMIN_CSS} should not exist — the cobalt theme was removed in #81. ` +
        "If you're intentionally restoring the theme, flip these assertions back.",
    ).toBe(false);
  });

  test("admin/index.html does NOT link custom.css", () => {
    const html = fs.readFileSync(ADMIN_INDEX, "utf8");
    expect(
      html,
      "admin/index.html should not link custom.css — that file was removed in #81.",
    ).not.toMatch(/<link\s+[^>]*href="custom\.css"/);
  });

  test("admin/index.html does NOT inline a cobalt-theme <style id>", () => {
    const html = fs.readFileSync(ADMIN_INDEX, "utf8");
    expect(html, "admin/index.html should not inline a cobalt-theme style block.").not.toMatch(
      /<style\s+id=["']cobalt[^"']*["']/,
    );
  });

  test("admin/index.html top-of-file comment notes the theme/preview context", () => {
    const html = fs.readFileSync(ADMIN_INDEX, "utf8");
    // The first HTML comment should mention either the removal context
    // (cobalt / theme / preview) so a future contributor reading top-down
    // sees why this admin shell is minimal.
    const firstComment = html.match(/<!--([\s\S]*?)-->/);
    expect(firstComment, "Expected a leading HTML comment in admin/index.html").not.toBeNull();
    expect(firstComment[1]).toMatch(/cobalt|theme|preview/i);
  });
});
