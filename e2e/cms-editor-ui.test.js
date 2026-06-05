// @lane: local — pure-fs anti-drift lint for the shared Decap editor helpers (#1723)
//
// The #1723 prod-mutate cleanup failed because its Published-toggle
// selector had drifted to `getByRole("checkbox")` while every other spec
// had moved to `getByRole("switch")` (Decap renders it as a switch) — the
// same copy-paste drift cms-unpublish-republish.spec.js hit and fixed in
// PR #407. The fix was to single-source the toggle in e2e/cms-editor-ui.js;
// this lint keeps it single-sourced. It is pure-fs (no browser, sub-second)
// so it runs in the local lane on every PR and fails LOUD the moment a spec
// hand-rolls the selector again — long before a scheduled prod loop would.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");

const E2E_DIR = path.resolve(__dirname);
const HELPER = "cms-editor-ui.js";

// Match the Published widget queried as a given ARIA role:
//   page.getByRole("<role>", { name: /^Published$/i ...
// Quote-agnostic; tolerant of whitespace. Deliberately requires the
// `, { name:` so it matches real call sites, NOT prose in a comment that
// merely mentions `getByRole("checkbox")`. Literal (not built via
// `new RegExp`) to stay deterministic and lint-clean.
const PUBLISHED_SWITCH_RE = /getByRole\(\s*["'`]switch["'`]\s*,\s*\{\s*name:\s*\/\^Published\$\/i/;
const PUBLISHED_CHECKBOX_RE =
  /getByRole\(\s*["'`]checkbox["'`]\s*,\s*\{\s*name:\s*\/\^Published\$\/i/;

function specFiles() {
  return fs.readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.js"));
}
function read(f) {
  return fs.readFileSync(path.join(E2E_DIR, f), "utf8");
}

test.describe("cms-editor-ui shared helper — anti-drift lint (#1723)", () => {
  test("the Published switch selector lives ONLY in cms-editor-ui.js", () => {
    for (const f of specFiles()) {
      expect(
        PUBLISHED_SWITCH_RE.test(read(f)),
        `${f} hand-rolls the Published switch selector — import setPublished / ` +
          `expectPublished / publishedSwitch from ./cms-editor-ui instead, so the ` +
          `selector stays single-sourced and can't drift (#1723).`,
      ).toBe(false);
    }
    // The helper itself MUST own the canonical selector.
    expect(
      PUBLISHED_SWITCH_RE.test(read(HELPER)),
      "cms-editor-ui.js must define the canonical Published switch selector",
    ).toBe(true);
  });

  test("nothing queries Published as a checkbox — the exact #1723 / #407 bug", () => {
    for (const f of [...specFiles(), HELPER]) {
      expect(
        PUBLISHED_CHECKBOX_RE.test(read(f)),
        `${f}: the Decap Published widget is role="switch", NOT a checkbox — ` +
          `a getByRole("checkbox", { name: /^Published$/ }) is the precise selector ` +
          `drift that silently broke the prod-mutate cleanup (#1723) and the unpublish ` +
          `spec (#407). Use the cms-editor-ui helpers.`,
      ).toBe(false);
    }
  });

  test("cms-editor-ui exports the shared editor interactions", () => {
    const m = require("./cms-editor-ui");
    for (const fn of [
      "publishedSwitch",
      "setPublished",
      "expectPublished",
      "saveEntry",
      "publishViaUi",
      "openMediaLibrary",
      "mediaLibraryTop",
      "mediaLibraryButton",
      "confirmEditorDelete",
      "deleteConfirmButton",
    ]) {
      expect(typeof m[fn], `cms-editor-ui must export ${fn}()`).toBe("function");
    }
  });

  // ── #1815 delete-phase: prove the editor delete actually DISPATCHED ───
  // Prod runs 26996121665 / 26994473112 failed because the delete leg
  // clicked "Delete published entry", accepted the native window.confirm,
  // then SWALLOWED the optional in-page confirm-button miss — with NO proof
  // Decap had issued the git-data-API delete. onDelete silently no-op'd (no
  // POST /git/trees, no cms/* PR, no deploy) and the failure only surfaced
  // 900s later as "URL never 404s". confirmEditorDelete() now arms a
  // waitForRequest on POST /git/trees BEFORE the click and throws if it
  // never fires. These pure-fs assertions lock that proof-of-dispatch in.
  test("confirmEditorDelete arms a POST /git/trees dispatch proof (#1815)", () => {
    const src = read(HELPER);
    // KEYSTONE: the helper must await Decap's first delete-dispatch network
    // call. Goes red the moment confirmEditorDelete reverts to a
    // fire-and-forget click with no awaited proof — the exact regression.
    expect(
      /waitForRequest/.test(src),
      "confirmEditorDelete must waitForRequest on the delete dispatch (#1815)",
    ).toBe(true);
    expect(
      /git\/trees/.test(src),
      "confirmEditorDelete must match Decap's POST /git/trees delete write (#1815)",
    ).toBe(true);
  });

  test("the in-app delete-confirm selector is a ReDoS-safe flat alternation", () => {
    const src = read(HELPER);
    expect(
      /DELETE_CONFIRM_BUTTON_RE\s*=\s*\/\^\(delete\|confirm\|yes\|ok\)\$\/i/.test(src),
      "cms-editor-ui.js must define DELETE_CONFIRM_BUTTON_RE = /^(delete|confirm|yes|ok)$/i",
    ).toBe(true);
    // No nested quantifier (a `+`/`*`/`{…}` applied to a parenthesised group
    // that itself contains a quantifier) — the editorDeleteButton ReDoS rule.
    expect(
      /\([^)]*[+*][^)]*\)[+*]/.test(src),
      "the delete-confirm/selectors must not nest quantifiers (ReDoS lint)",
    ).toBe(false);
  });

  test("both prod-loop specs route the delete click through confirmEditorDelete", () => {
    for (const f of [
      "cms-publish-loop-prod-mutate.spec.js",
      "cms-media-roundtrip.spec.js",
    ]) {
      const src = read(f);
      expect(
        /confirmEditorDelete\(/.test(src),
        `${f} must dispatch-verify its delete via confirmEditorDelete (#1815)`,
      ).toBe(true);
    }
  });

  test("the media-library LibraryTop selector lives ONLY in cms-editor-ui.js", () => {
    // Mirrors the Published-switch anti-drift lint above: the brittle
    // `[class*="LibraryTop"]` selector + the open-and-wait sequence were
    // copy-pasted across cms-media-roundtrip.spec.js and
    // admin-no-occlusion.spec.js (#1815). They now live once in
    // cms-editor-ui.js (openMediaLibrary / mediaLibraryTop /
    // MEDIA_LIBRARY_TOP_SELECTOR). Callers that need the literal (e.g. a
    // page.evaluate DOM query) import the exported constant. Fail loud if
    // a spec re-hand-rolls the literal.
    const offenders = [];
    for (const f of specFiles()) {
      if (f === HELPER) continue;
      const src = fs.readFileSync(path.join(E2E_DIR, f), "utf8");
      if (/\[class\*=["']LibraryTop["']\]/.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      `these files hand-roll the LibraryTop selector instead of importing it from ${HELPER}: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
