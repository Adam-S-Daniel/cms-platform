// @lane: local — pure-fs lint on the Live Preview button's editor-only +
// previewable-collection gating
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

// Locks the floating "Live Preview" button (#live-preview-link) to the
// ENTRY EDITOR routes. /preview/ only fills from the editor's Save
// broadcasts (preview-bridge.js), so on every other admin route — the
// login screen, the collection lists, the /workflow board — the button
// opened a canvas that can never fill (user report 2026-07-10).
//
// It is ALSO locked to collections /preview/ has a real template for
// (cms-platform#328.1). Any other collection falls back to the "posts"
// variant in theme/_layouts/preview.html and renders a generic dark blog
// article — nothing like the entry actually is. A wrong preview is worse
// than none (it teaches distrust of the real one), so those collections
// get no button at all.
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

// The editor-route regex + previewable-collection map + display toggle as
// they appear in the shells' source text (toContain on exact source bytes —
// locks the mechanism, not a paraphrase of it).
const EDITOR_ROUTE_RE_SRC = "(entries\\/|new(\\?|$))";
const PREVIEWABLE_MAP_SRC = "{ posts: true, pages: true, projects: true }";
const DISPLAY_TOGGLE_SRC = "link.style.display = editing && PREVIEWABLE_COLLECTIONS[col] ? '' : 'none'";

test.describe("Live Preview button — editor-only + previewable-collection gating", () => {
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
        `${shell} must declare the same three previewable collections as ` +
          `theme/_layouts/preview.html's data-preview-layout variants`,
      ).toContain(PREVIEWABLE_MAP_SRC);
      expect(
        src,
        `${shell} must toggle style.display on BOTH conditions (never remove the ` +
          `anchor — the link crawler harvests hidden a[href], and display:'' restores ` +
          `the stylesheet's flex)`,
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

// ── Behavioral proof (cms-platform#328.1) ───────────────────────────────
// Extract the actual live-preview-link sync IIFE out of each shell and run
// it for real in a vm sandbox, so this doesn't just lock source bytes — it
// proves the button is actually hidden for a non-previewable collection
// (e.g. a Media Items entry) and actually shown for a previewable one, on
// both live shells.

function extractSyncScript(html) {
  const marker = "getElementById('live-preview-link')";
  const anchorIdx = html.indexOf(marker);
  if (anchorIdx === -1) throw new Error("live-preview-link sync script not found");
  const scriptOpen = html.lastIndexOf("<script>", anchorIdx);
  const scriptClose = html.indexOf("</script>", anchorIdx);
  if (scriptOpen === -1 || scriptClose === -1) {
    throw new Error("could not bound the <script> block around the sync IIFE");
  }
  return html.slice(scriptOpen + "<script>".length, scriptClose);
}

function runSyncScript(src, hash) {
  const link = { href: "", style: { display: "" } };
  const listeners = [];
  const sandbox = {
    document: {
      getElementById(id) {
        return id === "live-preview-link" ? link : null;
      },
    },
    window: {
      addEventListener(evt, fn) {
        listeners.push([evt, fn]);
      },
    },
    location: { hash },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return link;
}

test.describe("Live Preview button — behavioral proof", () => {
  for (const shell of SHELLS) {
    const html = fs.readFileSync(path.join(ADMIN_SRC, shell), "utf8");
    const script = extractSyncScript(html);

    test(`${shell}: hides the button on a non-previewable collection's editor route`, () => {
      const link = runSyncScript(script, "#/collections/media_items/entries/foo");
      expect(
        link.style.display,
        "a collection outside {posts,pages,projects} has no /preview/ template — " +
          "the button must stay hidden even on an entry-editor route",
      ).toBe("none");
    });

    for (const col of ["posts", "pages", "projects"]) {
      test(`${shell}: shows the button on the previewable "${col}" collection's editor route`, () => {
        const link = runSyncScript(script, `#/collections/${col}/entries/foo`);
        expect(link.style.display, `${col} has a real /preview/ template`).toBe("");
        const linkNew = runSyncScript(script, `#/collections/${col}/new`);
        expect(linkNew.style.display, `${col}/new also has a real /preview/ template`).toBe("");
      });
    }

    test(`${shell}: hides the button on a previewable collection's LIST route (not editing)`, () => {
      const link = runSyncScript(script, "#/collections/posts");
      expect(
        link.style.display,
        "collection previewability alone isn't enough — must also be an entry-editor route",
      ).toBe("none");
    });
  }
});
