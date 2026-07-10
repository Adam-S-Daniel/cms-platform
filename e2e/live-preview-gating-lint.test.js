// @lane: local — pure-fs lint on the Live Preview button's editor-only gating
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Locks the floating "Live Preview" button (#live-preview-link) to the
// ENTRY EDITOR routes. /preview/ only fills from the editor's Save
// broadcasts (preview-bridge.js), so on every other admin route — the
// login screen, the collection lists, the /workflow board — the button
// opened a canvas that can never fill (user report 2026-07-10).
//
// The gating is a style.display toggle, NOT DOM removal, on purpose:
// cms-link-crawler.spec.js harvests every `a[href]` regardless of
// visibility (the /preview/ href must stay crawlable), and
// cms-native-view-live.spec.js excludes the anchor by id — both keep
// working only while the anchor stays in the DOM. React is untouched
// either way: the anchor is our own static shell markup, not Decap's.

const ADMIN_SRC = path.join(__dirname, "..", "theme", "admin");
// index-test.html ships NO Live Preview button (test-repo backend — no
// live site to preview), so only the two shells that carry the anchor.
const SHELLS = ["index.html", "index-local.html"];

// The editor-route regex + display toggle as they appear in the shells'
// source text (toContain on exact source bytes — locks the mechanism,
// not a paraphrase of it).
const EDITOR_ROUTE_RE_SRC = "(entries\\/|new(\\?|$))";
const DISPLAY_TOGGLE_SRC = "link.style.display = editing ? '' : 'none'";

test.describe("Live Preview button — editor-only gating", () => {
  for (const shell of SHELLS) {
    test(`${shell}: gates #live-preview-link on the entry-editor routes`, () => {
      const src = fs.readFileSync(path.join(ADMIN_SRC, shell), "utf8");
      expect(
        src,
        `${shell} must match the editor routes (#/collections/<c>/entries/<slug> ` +
          `and #/collections/<c>/new) — the only routes where /preview/ can fill`,
      ).toContain(EDITOR_ROUTE_RE_SRC);
      expect(
        src,
        `${shell} must toggle style.display (never remove the anchor — the link ` +
          `crawler harvests hidden a[href], and display:'' restores the stylesheet's flex)`,
      ).toContain(DISPLAY_TOGGLE_SRC);
    });
  }

  test("index.html leaves #reviews-link ungated (always visible)", () => {
    const src = fs.readFileSync(path.join(ADMIN_SRC, "index.html"), "utf8");
    expect(
      src,
      "the Reviews button must stay always-visible — only the Live Preview " +
        "button is editor-scoped (the reviews dashboard is useful on every route)",
    ).not.toContain("getElementById('reviews-link')");
  });
});
