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

// It also carries the two #328 PRODUCT-COPY locks for this surface, because
// this is the file that already knows the show/hide rule the copy has to be
// true of:
//
//   #328.5 — the floating button's `title`. It vanished on every non-editor
//     route with nothing anywhere explaining why, and its old tip described
//     only the Save mechanic. The title must now say what the button DOES and
//     WHEN it is available, and both halves must stay true of the gating
//     asserted above.
//   #328.2 — /preview/'s empty state. The bridge streams from the editor
//     tab's Save broadcasts, so a fresh load of the preview tab (an ordinary
//     RELOAD included) has nothing to show. The old copy described that
//     accurately and read, to a non-technical owner who had just reloaded, as
//     her content having vanished. The reassurance sentence is the fix, so it
//     is the thing worth locking: it is one "tighten the copy" edit away from
//     being deleted as redundant, and its absence is silent.
const ADMIN_SRC = path.join(__dirname, "..", "theme", "admin");
const PREVIEW_LAYOUT = path.join(__dirname, "..", "theme", "_layouts", "preview.html");

// The button's tooltip, byte-identical on both live shells.
const LIVE_PREVIEW_TITLE =
  "Live Preview — opens a tab that mirrors this entry each time you Save. " +
  "Available while you're editing an entry in a section the preview can render.";
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

test.describe("Live Preview button — the tooltip explains what it does and when (#328.5)", () => {
  for (const shell of SHELLS) {
    test(`${shell}: #live-preview-link carries the explanatory title`, () => {
      const src = fs.readFileSync(path.join(ADMIN_SRC, shell), "utf8");
      expect(
        src,
        `${shell}'s Live Preview button must carry the title that says what it does AND when ` +
          `it appears. Without the second half the button silently vanishes on every non-editor ` +
          `route and on every collection /preview/ cannot render, with nothing anywhere saying ` +
          `why (#328.5). Keep it byte-identical across shells.`,
      ).toContain(`title="${LIVE_PREVIEW_TITLE}"`);
      // The title claims availability is conditional; that claim is only true
      // while the gating above is what actually decides. Asserted together so
      // a future edit cannot loosen one and leave the other lying.
      expect(
        src,
        `${shell}: the title promises the button appears only while editing a previewable ` +
          `entry — so the display toggle it describes must still be there`,
      ).toContain(DISPLAY_TOGGLE_SRC);
    });
  }

  test("the visible label is text, so no aria-label is needed or added", () => {
    // The anchor's accessible name comes from its own text ("Live Preview")
    // next to the decorative svg. An aria-label would OVERRIDE that name with
    // the long title, which is worse for a screen reader, not better — so its
    // absence here is a decision, recorded so nobody "fixes" it.
    for (const shell of SHELLS) {
      const src = fs.readFileSync(path.join(ADMIN_SRC, shell), "utf8");
      const anchorIdx = src.indexOf('id="live-preview-link"');
      expect(anchorIdx, `${shell} carries the anchor`).toBeGreaterThan(-1);
      const anchor = src.slice(anchorIdx, src.indexOf("</a>", anchorIdx));
      expect(anchor, `${shell}: the anchor keeps its visible "Live Preview" text`).toContain(
        "Live Preview",
      );
      expect(
        anchor,
        `${shell}: no aria-label — it would override the visible label with the tooltip`,
      ).not.toContain("aria-label");
    }
  });
});

test.describe("/preview/ empty state says nothing was lost (#328.2)", () => {
  const src = () => fs.readFileSync(PREVIEW_LAYOUT, "utf8");

  test("the reassurance sentence is present, verbatim", () => {
    expect(
      src().replace(/\s+/g, " "),
      "theme/_layouts/preview.html's #preview-empty-state must say outright that nothing is " +
        "lost. A reload of the preview tab shows this screen — the bridge only streams from " +
        "the editor's Save broadcasts, so a fresh load has none — and the previous copy read " +
        "to a non-technical owner as her content having vanished (#328.2). This sentence IS " +
        "the fix; do not trim it as redundant.",
    ).toContain(
      "Your saved and published content is safe; reloading this tab only clears the preview, " +
        "never your work.",
    );
  });

  test("the heading names the TAB, not the content", () => {
    expect(
      src(),
      'the heading must not be a bare "Live preview" over an empty screen — it has to say ' +
        "that it is THIS TAB that has nothing yet (#328.2)",
    ).toContain("<h2>Nothing to preview in this tab yet</h2>");
  });

  test("the <code> convention and the .hint line survive", () => {
    const html = src();
    const block = html.slice(
      html.indexOf('<div id="preview-empty-state">'),
      html.indexOf("</div>", html.indexOf('<div id="preview-empty-state">')),
    );
    expect(block, "Save is still styled as a <code> control name").toContain("<code>Save</code>");
    expect(block, "the .hint line is still the last, quietest line").toContain('<p class="hint">');
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
