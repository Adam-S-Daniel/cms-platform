// @lane: local — pure-fs static invariant on the issue #329 owner-persona fix set.
//
// Five independent shims (theme/admin/publish-baseline-refresh.js,
// publish-step-hint.js, search-scope-all.js, list-row-affordance.js,
// single-entry-collection-shortcut.js) were added to close #329 items
// 1/2/4/5/7. This lint is the cheapest possible regression guard on them —
// no browser, no build, no network — asserting from the filesystem alone:
//
//   1. all five files exist under theme/admin/;
//   2. all THREE admin shells (index.html / index-local.html /
//      index-test.html) reference all five, deferred — mirrors the
//      per-file scriptTag() check in admin-shim-load-order.test.js;
//   3. single-entry-collection-shortcut.js still carries its `/new` guard —
//      the regression that would trap a one-entry FOLDER collection with no
//      way back to the list to create a second entry (see that file's own
//      header comment for the full rationale);
//   4. publish-step-hint.js still carries BOTH a MutationObserver and a
//      setInterval re-sync — the interval is REQUIRED (verified live that
//      after a real publish the observer alone left the hint stale on
//      screen), not belt-and-braces, and it's cheap for a future edit to
//      drop one without noticing since either alone still "looks" wired up;
//   5. publish-baseline-refresh.js registers `postPublish` and never
//      reaches into Decap's Redux internals (no `store` / `getState` /
//      `dispatch` token anywhere in the file) — it's public
//      `window.CMS.registerEventListener` API, `location`, and the DOM
//      only, per this directory's house style.
//
// This spec is deliberately NOT registered in PLATFORM_META_SPECS — it
// reads only theme/admin/, which every consumer also ships (the gem
// delivers this directory verbatim), so there is no platform-vs-consumer
// split here the way there is for e.g. the .github/workflows/ pin lints.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "theme", "admin");

const SHIMS = [
  "publish-baseline-refresh.js",
  "publish-step-hint.js",
  "search-scope-all.js",
  "list-row-affordance.js",
  "single-entry-collection-shortcut.js",
];

const ADMIN_SHELLS = ["index.html", "index-local.html", "index-test.html"];

// The <script src="..."> tag (self-closing) for a given basename, returning
// { index, defer } or null when absent. `index` is the byte offset of the
// tag — mirrors admin-shim-load-order.test.js's scriptTag() helper.
function scriptTag(html, basename) {
  const re = new RegExp(
    `<script\\s+src="${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"([^>]*)>\\s*</script>`,
  );
  const m = re.exec(html);
  if (!m) return null;
  return { index: m.index, defer: /\bdefer\b/.test(m[1]) };
}

test.describe("issue #329 owner-persona fix set", () => {
  test("all five shim files exist under theme/admin/", () => {
    const missing = SHIMS.filter((name) => !fs.existsSync(path.join(ADMIN_DIR, name)));
    expect(missing, `missing shim file(s) under theme/admin/: ${missing.join(", ")}`).toEqual([]);
  });

  for (const shell of ADMIN_SHELLS) {
    test(`${shell} references all five shims, each deferred`, () => {
      const html = fs.readFileSync(path.join(ADMIN_DIR, shell), "utf8");
      for (const name of SHIMS) {
        const tag = scriptTag(html, name);
        expect(tag, `${shell} must load <script src="${name}">`).not.toBeNull();
        expect(tag.defer, `${shell}: ${name} must be loaded with the defer attribute`).toBe(true);
      }
    });
  }

  test("single-entry-collection-shortcut.js still carries its /new guard", () => {
    const src = fs.readFileSync(
      path.join(ADMIN_DIR, "single-entry-collection-shortcut.js"),
      "utf8",
    );
    // The regression this locks: dropping the "/new" check would let a
    // folder collection that currently holds exactly one entry auto-jump
    // into it, trapping the editor with no way back to the list to create
    // a second entry.
    expect(
      src.includes("/new"),
      "single-entry-collection-shortcut.js must still guard on the collection's " +
        '"+ New" link (a literal "/new" reference) — without it, a one-entry FOLDER ' +
        "collection would be silently treated as a singleton and auto-jumped into.",
    ).toBe(true);
  });

  test("publish-step-hint.js still carries both a MutationObserver and a setInterval re-sync", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, "publish-step-hint.js"), "utf8");
    expect(
      /MutationObserver/.test(src),
      "publish-step-hint.js must observe DOM mutations to re-sync the hint",
    ).toBe(true);
    expect(
      /setInterval/.test(src),
      "publish-step-hint.js must ALSO re-sync on an interval — verified live that the " +
        "MutationObserver alone missed the post-publish re-render and left the hint stale " +
        "on screen after a real publish",
    ).toBe(true);
  });

  test("publish-baseline-refresh.js registers postPublish and touches no Decap internal store", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, "publish-baseline-refresh.js"), "utf8");
    expect(
      /postPublish/.test(src),
      "publish-baseline-refresh.js must register a postPublish event listener",
    ).toBe(true);
    expect(
      /\b(store|getState|dispatch)\b/i.test(src),
      "publish-baseline-refresh.js must touch only the public window.CMS API, location, " +
        "and the DOM — never Decap's Redux internals (no store/getState/dispatch reference)",
    ).toBe(false);
  });
});
