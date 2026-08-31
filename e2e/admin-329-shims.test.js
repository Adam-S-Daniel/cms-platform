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
//      after a real publish the observer alone left the bar stale on
//      screen), not belt-and-braces, and it's cheap for a future edit to
//      drop one without noticing since either alone still "looks" wired up;
//   4b. publish-step-hint.js renders IN FLOW, never as a `position: fixed`
//      overlay, and compares before it writes `textContent`. Both are
//      measured regressions, not style preferences. The first shipped
//      version WAS a fixed top-centre notice and it covered 68% of the
//      Publish button and 47% of the Status control it was pointing at
//      (measured against a live Decap 3.15.1 at 1280x800); the browser-level
//      geometric assertion lives in e2e/admin-no-occlusion.spec.js, and this
//      is its cheap pure-fs half. The second is the render-loop trap that
//      killed a live page target from local-save-indicator.js's first draft:
//      an unconditional textContent write is a childList mutation inside the
//      subtree this shim's own MutationObserver watches;
//   5. publish-baseline-refresh.js registers `postPublish` and never
//      reaches into Decap's Redux internals (no `store` / `getState` /
//      `dispatch` token anywhere in the file) — it's public
//      `window.CMS.registerEventListener` API, `location`, and the DOM
//      only, per this directory's house style.
//
// A sixth, LOCAL-MODE-ONLY shim (theme/admin/local-save-indicator.js) was
// added to close #329 item 8 — a persistent save/status indicator for the
// local decap-server backend, which has no deploy or build to report and
// therefore only ever claims "saved to your working copy." Its own
// assertions below intentionally do NOT reuse the ADMIN_SHELLS loop above:
// the local-only scope (index-local.html loads it; index.html and
// index-test.html must NOT) is the contract, not an oversight to normalize
// away.
//
// This spec is deliberately NOT registered in PLATFORM_META_SPECS — it
// reads only theme/admin/, which every consumer also ships (the gem
// delivers this directory verbatim), so there is no platform-vs-consumer
// split here the way there is for e.g. the .github/workflows/ pin lints.
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "theme", "admin");

// ── "no fixed overlay" is a code-shape question, so it PARSES ────────────
//
// The obvious implementation — `/position\s*:\s*fixed/i.test(src)` — is
// wrong here, and provably so: it was written that way first and it red-failed
// the very file it was meant to bless, because that file's header comment
// EXPLAINS the fixed-overlay defect it exists to prevent. A lint that forbids
// naming the thing it forbids is a lint nobody can document around.
//
// So the check reads string literals and style writes from the AST, where
// comments do not exist by construction (the house rule in AGENTS.md,
// "AST always, never regex, for code-shape lints"). It covers the three
// shapes an admin shim could actually use: a `cssText`/style string carrying
// `position:fixed`, `el.style.position = "fixed"`, and
// `el.style.setProperty("position", "fixed")`.
function fixedPositionEvidence(src) {
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" });
  }
  const FIXED_IN_CSS = /position\s*:\s*fixed/i;
  const hits = [];
  const isFixed = (n) => n && n.type === "Literal" && String(n.value).toLowerCase() === "fixed";
  walk.simple(ast, {
    Literal(n) {
      if (typeof n.value === "string" && FIXED_IN_CSS.test(n.value)) hits.push(n.value.slice(0, 60));
    },
    TemplateLiteral(n) {
      for (const q of n.quasis) {
        const v = q.value.cooked || "";
        if (FIXED_IN_CSS.test(v)) hits.push(v.slice(0, 60));
      }
    },
    AssignmentExpression(n) {
      const l = n.left;
      if (l.type === "MemberExpression" && !l.computed && l.property.name === "position" && isFixed(n.right)) {
        hits.push('style.position = "fixed"');
      }
    },
    CallExpression(n) {
      const c = n.callee;
      if (
        c.type === "MemberExpression" &&
        !c.computed &&
        c.property.name === "setProperty" &&
        n.arguments.length >= 2 &&
        n.arguments[0].type === "Literal" &&
        String(n.arguments[0].value).toLowerCase() === "position" &&
        isFixed(n.arguments[1])
      ) {
        hits.push('setProperty("position", "fixed")');
      }
    },
  });
  return hits;
}

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

  // ── Placement: in flow, never an overlay ─────────────────────────────
  //
  // The first shipped version of this shim was a `position: fixed`,
  // top-centre notice. On a real Decap 3.15.1 instance it painted ON TOP of
  // the toolbar it was pointing at — 2682px2 of the Publish button (68% of
  // it) and 2520px2 of the Status control, at 1280x800. It was reported from
  // a live preview session, with a screenshot.
  //
  // Nothing caught it because the overlay carried `pointer-events: none`,
  // and the repo's occlusion guard (e2e/ui-visibility.js's expectReachable)
  // decides "covered" with document.elementFromPoint at the control's
  // centre — a HIT test, which a pointer-events:none overlay is invisible
  // to. The control stayed clickable while its label was unreadable, so the
  // guard stayed green. e2e/admin-no-occlusion.spec.js now also asserts the
  // GEOMETRIC case in a browser; this is the pure-fs half that runs in the
  // required node-unit-lints lane.
  test("publish-step-hint.js renders in flow — no position:fixed overlay", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, "publish-step-hint.js"), "utf8");
    expect(
      fixedPositionEvidence(src),
      "publish-step-hint.js must render its state bar in normal document flow. A " +
        "position:fixed overlay paints over the very toolbar controls the bar " +
        "describes (measured: 68% of the Publish button, 47% of the Status control " +
        "at 1280x800 on Decap 3.15.1) — and `pointer-events: none` hides that from " +
        "the hit-test-based occlusion guard, so it ships green.",
    ).toEqual([]);
  });

  // Guards the render loop that killed a live page target when
  // local-save-indicator.js's first draft made the same mistake. Assigning
  // textContent replaces the child text node even when the string is
  // identical — a childList mutation inside document.documentElement, the
  // exact subtree this shim's MutationObserver watches with subtree:true.
  // render() would then feed the observer that called it, and observer
  // callbacks are microtasks, so the loop never yields. A lexical check on a
  // leaf token, not a claim about code structure.
  test("publish-step-hint.js compares before it writes textContent", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, "publish-step-hint.js"), "utf8");
    expect(
      /textContent\s*!==/.test(src),
      "publish-step-hint.js must compare textContent before assigning it — an " +
        "unconditional write feeds this shim's own MutationObserver and wedges the " +
        "page (the exact failure local-save-indicator.js's first draft shipped past " +
        "a fully green pure-fs suite).",
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

test.describe("issue #329 item 8 — local-mode save/status indicator", () => {
  const LOCAL_SAVE_INDICATOR = "local-save-indicator.js";

  test("local-save-indicator.js exists under theme/admin/", () => {
    expect(
      fs.existsSync(path.join(ADMIN_DIR, LOCAL_SAVE_INDICATOR)),
      `missing shim file: theme/admin/${LOCAL_SAVE_INDICATOR}`,
    ).toBe(true);
  });

  test("index-local.html references local-save-indicator.js, deferred", () => {
    const html = fs.readFileSync(path.join(ADMIN_DIR, "index-local.html"), "utf8");
    const tag = scriptTag(html, LOCAL_SAVE_INDICATOR);
    expect(tag, `index-local.html must load <script src="${LOCAL_SAVE_INDICATOR}">`).not.toBeNull();
    expect(
      tag.defer,
      `index-local.html: ${LOCAL_SAVE_INDICATOR} must be loaded with the defer attribute`,
    ).toBe(true);
  });

  // The local-only scope IS the contract (see the file's own header
  // comment and this spec's top-of-file note) — assert the negative
  // directly rather than trusting that nobody ever copies the tag onto
  // the other two shells.
  test("index.html and index-test.html do NOT reference local-save-indicator.js", () => {
    for (const shell of ["index.html", "index-test.html"]) {
      const html = fs.readFileSync(path.join(ADMIN_DIR, shell), "utf8");
      expect(
        scriptTag(html, LOCAL_SAVE_INDICATOR),
        `${shell} must NOT load ${LOCAL_SAVE_INDICATOR} — it is scoped to the local ` +
          "decap-server backend only (index.html has a real deploy-status-pill.js; " +
          "index-test.html is a different backend covered separately by issue item 9)",
      ).toBeNull();
    }
  });

  test("local-save-indicator.js registers both postSave and postPublish", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, LOCAL_SAVE_INDICATOR), "utf8");
    expect(
      /postSave/.test(src),
      "local-save-indicator.js must register a postSave event listener — Decap's local " +
        "backend can fire postSave without a following postPublish",
    ).toBe(true);
    expect(
      /postPublish/.test(src),
      "local-save-indicator.js must register a postPublish event listener too — either " +
        "event can be the one that actually fires for a given save action",
    ).toBe(true);
  });

  test("local-save-indicator.js touches no Decap internal store", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, LOCAL_SAVE_INDICATOR), "utf8");
    expect(
      /\b(store|getState|dispatch)\b/i.test(src),
      "local-save-indicator.js must touch only the public window.CMS API and the DOM — " +
        "never Decap's Redux internals (no store/getState/dispatch reference)",
    ).toBe(false);
  });

  test("local-save-indicator.js does not use position:fixed", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, LOCAL_SAVE_INDICATOR), "utf8");
    expect(
      fixedPositionEvidence(src),
      "local-save-indicator.js must live in the toolbar row (no position:fixed) — no " +
        "admin shim may paint a fixed overlay over the editor toolbar. " +
        "publish-step-hint.js did exactly that until 2026-08-31 and covered 68% of " +
        "the Publish button; the same rule now applies to both files.",
    ).toEqual([]);
  });

  // ── Regression guard: the render loop that killed the page ────────────
  //
  // The first draft of this shim assigned `textContent` unconditionally on
  // every render. Assigning textContent replaces the child text node even
  // when the string is identical, which is a childList mutation inside
  // `document.documentElement` — the exact subtree the shim's own
  // MutationObserver watches with `subtree: true`. render() therefore fed
  // the observer that called it, and because observer callbacks are
  // microtasks the loop never yielded: injecting that version into a live
  // Decap 3.15.1 admin killed the page target outright ("Target page,
  // context or browser has been closed"). No pure-fs lint could see it and
  // the whole suite was green.
  //
  // The fix is to compare before writing, so the steady state mutates
  // nothing. This asserts the comparison is still there. It is a lexical
  // check on a leaf token, not a claim about code structure, which is why
  // it does not need the AST treatment the house rule reserves for
  // structural lints.
  test("local-save-indicator.js writes textContent only when it changed", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, LOCAL_SAVE_INDICATOR), "utf8");
    const guarded = /if\s*\(\s*el\.textContent\s*!==/.test(src);
    expect(
      guarded,
      "local-save-indicator.js must compare el.textContent before assigning it. An " +
        "unconditional write re-triggers the file's own MutationObserver (childList " +
        "on documentElement's subtree) and wedges the admin tab in a microtask loop.",
    ).toBe(true);
  });
});
