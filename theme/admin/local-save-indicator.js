/*
 * admin/local-save-indicator.js — issue #329 item 8 (LOCAL-MODE ONLY).
 *
 * ── The defect, verbatim from the issue ─────────────────────────────────
 * "[major, local-mode scoped] The local admin shows no deploy/build/site
 * status of any kind beyond a 3-second toast — the production
 * deploy-status pill machinery has no local presence at all, so a local
 * owner has zero 'did that take?' signal."
 *
 * ── The honesty constraint (read this before changing any copy here) ───
 * On the local `decap-server` backend there is NO deploy and NO build —
 * `decap-server` writes files straight into the contributor's working
 * copy, full stop. This shim must never imply a deployment, a build, or
 * anything reaching a live site; that would be a worse defect than the
 * silence it replaces. It reports exactly one true thing: a save landed
 * in your working copy, and here is when. That is why it is wired into
 * admin/index-local.html ONLY — index.html (production) already has
 * deploy-status-pill.js reporting a REAL deploy, and index-test.html is a
 * different backend covered separately by issue item 9. Copying this
 * indicator onto either of those shells would put a "saved to working
 * copy" claim next to machinery that talks to GitHub, which is exactly
 * the kind of misleading juxtaposition the honesty constraint forbids.
 *
 * ── Behaviour ────────────────────────────────────────────────────────────
 * A single `#cms-local-save-indicator` element lives in the editor
 * toolbar, in the same visual register as deploy-status-pill.js's pills
 * but never hidden — it starts in an unmistakably-local IDLE state
 * ("local · saves to your working copy") and flips, on the first
 * postSave/postPublish this session, to a persistent SAVED state
 * ("saved to working copy · HH:MM:SS") that does NOT auto-clear on a
 * timer. That persistence is the whole point — it replaces a 3-second
 * toast that gave a local owner no lasting "did that take?" signal.
 *
 * ── Why BOTH postSave and postPublish, de-duplicated ────────────────────
 * Decap's local `simple` publish mode can fire either event (or both, in
 * quick succession, for what the user experiences as one save), so this
 * registers on both and re-renders through a single `markSaved()` entry
 * point. A short de-dup window collapses a same-action postSave+postPublish
 * pair into one timestamp update instead of two redundant writes.
 *
 * ── Selector strategy (mirrors deploy-status-pill.js / native-preview-
 *    href.js / publish-baseline-refresh.js) ──────────────────────────────
 * Decap's toolbar component's emotion class label has been observed as
 * both `EditorToolbar` and `ToolbarContainer`; both contain "oolbar" in
 * the rendered className, so `[class*="oolbar"]` covers either release.
 * The indicator is inserted at the START of the toolbar
 * (`insertBefore(el, toolbar.firstChild)`), not appended — the toolbar
 * overflows to the right on narrow / mobile widths, and a right-appended
 * child gets clipped there (same reasoning as deploy-status-pill.js's
 * `buildPill`).
 *
 * ── Decap-upgrade safety ─────────────────────────────────────────────────
 * Only the public `window.CMS.registerEventListener` API and the DOM —
 * this file never reaches into Decap's Redux-based internal state
 * management at all. `registerEventListener` REJECTS unknown event
 * names (`login` / `logout` / `mounted` throw "Invalid event name" —
 * verified live), so each registration is wrapped in its own try/catch:
 * a future Decap release that renames postSave or postPublish degrades
 * this shim to a silent no-op for that event, never a page error, and the
 * two registrations are independent so losing one doesn't take down the
 * other. `window.CMS` is awaited with a short setInterval poll, cleared
 * the moment it's found.
 *
 * ── Surviving Decap's re-renders ─────────────────────────────────────────
 * Decap is React-driven and rebuilds the toolbar on entry switches and
 * navigation, so the indicator is re-inserted whenever it loses its
 * parent. Driven by a MutationObserver on `document.documentElement`
 * (`childList`, `subtree`) plus one call at boot; `render()` is
 * idempotent (reuses the existing element by id when it's still attached,
 * rebuilds it when it isn't) so the observer firing repeatedly is a
 * no-op in the steady state. The toolbar only exists on the entry-editor
 * route — when there is no toolbar yet, `render()` does nothing, quietly.
 *
 * Placement note: this sits IN the toolbar row — its CSS never pins it to
 * a fixed spot in the viewport. That is now the rule for every admin shim,
 * not a courtesy to this one: `publish-step-hint.js` WAS a fixed top-centre
 * overlay and covered 68% of the Publish button at ordinary laptop widths
 * before it was moved into flow (2026-08-31). Both files are lint-locked
 * against `position: fixed` in e2e/admin-329-shims.test.js.
 *
 * ── Test contract ────────────────────────────────────────────────────────
 * Static, filesystem-only assertions live in
 * e2e/admin-329-shims.test.js: the file exists, index-local.html loads it
 * deferred, index.html/index-test.html do NOT, both events are
 * registered, no reference to Decap's internal state container appears,
 * and this file's CSS never pins the indicator to a fixed viewport spot.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__localSaveIndicatorInstalled) return;
  window.__localSaveIndicatorInstalled = true;

  var INDICATOR_ID = "cms-local-save-indicator";
  var CMS_POLL_MS = 100;
  // Decap can fire postSave immediately followed by postPublish (or the
  // reverse) for what the user experiences as a single save action. A
  // window this short only ever collapses that same-action pair — a
  // genuinely separate later save is always well outside it.
  var DEDUP_WINDOW_MS = 250;

  // Date of the most recent de-duplicated save this session, or null
  // before any save has happened — drives the idle/saved render branch.
  var savedAt = null;
  var lastMarkAt = 0;

  // Same substring convention as deploy-status-pill.js / native-preview-
  // href.js: Emotion's class hash churns between Decap releases but this
  // trailing label does not.
  function findToolbar() {
    try {
      return document.querySelector('[class*="oolbar"]');
    } catch (e) {
      return null;
    }
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // Local 24h HH:MM:SS — deliberately NOT a UTC/ISO timestamp; the point
  // is "when, on my machine, in wall-clock terms I recognize."
  function formatTime(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function buildIndicator() {
    var el = document.createElement("span");
    el.id = INDICATOR_ID;
    // Transient status, not content — same convention as
    // deploy-status-pill.js's pills; excluded from the visual-regression
    // text diff.
    el.setAttribute("data-visreg-ignore", "");
    // Same visual register as deploy-status-pill.js's pills — small,
    // monospace, muted border, rounded 3px — but always visible (never
    // display:none) and with no fixed-viewport positioning at all: it
    // lives in the toolbar row, not floating over the page.
    el.style.cssText =
      [
        "display:inline-block",
        "order:-1",
        "margin-right:0.5rem",
        "padding:0.2rem 0.55rem",
        "background:rgba(255,255,255,0.95)",
        "border:1px solid #d0d7de",
        "border-radius:3px",
        "color:#57606a",
        "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
        "font-size:0.7rem",
        "letter-spacing:0.03em",
        "vertical-align:middle",
        "white-space:nowrap",
      ].join(";") + ";";
    return el;
  }

  function ensureIndicatorInToolbar() {
    var existing = document.getElementById(INDICATOR_ID);
    if (existing && existing.parentNode) return existing;
    var toolbar = findToolbar();
    if (!toolbar) return null; // not on the entry-editor route — nothing to do
    var el = existing || buildIndicator();
    // Insert at the START of the toolbar — see deploy-status-pill.js's
    // ensurePillInToolbar for why: the toolbar overflows right on narrow
    // widths and a right-appended child gets clipped.
    if (toolbar.firstChild) {
      toolbar.insertBefore(el, toolbar.firstChild);
    } else {
      toolbar.appendChild(el);
    }
    return el;
  }

  // Calm neutral idle tone — this is the default state and should not
  // read as an alert of any kind.
  function applyIdleStyle(el) {
    if (el.style.color !== "rgb(87, 96, 106)") el.style.color = "#57606a";
    if (el.style.borderColor !== "rgb(208, 215, 222)") el.style.borderColor = "#d0d7de";
  }

  // "It worked" tone — reuses the same green posts-list-enhance.js uses
  // for its "Published" state label, so a save reads as unambiguously
  // positive without inventing a second green in this codebase.
  function applySavedStyle(el) {
    if (el.style.color !== "rgb(26, 127, 55)") el.style.color = "#1a7f37";
    if (el.style.borderColor !== "rgb(143, 209, 158)") el.style.borderColor = "#8fd19e";
  }

  // WRITE-ONLY-ON-CHANGE, and this is load-bearing — do not "simplify" it
  // back into an unconditional assignment.
  //
  // Assigning `textContent` ALWAYS replaces the element's child text node,
  // even when the string is identical. That is a childList mutation, and it
  // happens inside `document.documentElement`, which is exactly the subtree
  // this file's own MutationObserver watches with `subtree: true`. An
  // unconditional write therefore feeds the observer that calls it: render
  // → mutate → observer → render → … Observer callbacks are delivered as
  // microtasks, so the loop never yields to the event loop and the admin tab
  // wedges. Measured: injecting the unguarded version into a live Decap
  // 3.15.1 admin killed the page target outright ("Target page, context or
  // browser has been closed").
  //
  // Comparing first makes render() genuinely idempotent: the steady state
  // performs no mutation at all, so the observer goes quiet. Style and title
  // are attribute writes, which this observer does not watch, but they are
  // guarded the same way to keep the whole function free of pointless DOM
  // churn on every unrelated mutation Decap makes.
  function render() {
    try {
      var el = ensureIndicatorInToolbar();
      if (!el) return; // toolbar isn't mounted yet — do nothing, quietly
      var text, title;
      if (savedAt) {
        text = "saved to working copy · " + formatTime(savedAt);
        title =
          "This save landed in your local working copy (decap-server writes " +
          "files directly to disk). Nothing was built or deployed.";
      } else {
        text = "local · saves to your working copy";
        title =
          "Local dev mode: Decap saves go straight to your working copy. " +
          "There is no deploy or build to report here.";
      }
      if (el.textContent !== text) el.textContent = text;
      if (el.title !== title) el.title = title;
      if (savedAt) {
        applySavedStyle(el);
      } else {
        applyIdleStyle(el);
      }
    } catch (e) {
      /* never throw out of a MutationObserver callback */
    }
  }

  function markSaved() {
    var now = Date.now();
    if (now - lastMarkAt < DEDUP_WINDOW_MS) return; // same-action postSave+postPublish pair
    lastMarkAt = now;
    savedAt = new Date();
    render();
  }

  function register(CMS) {
    // Independent try/catch per event: losing one to a future rename
    // must not take the other down with it.
    try {
      CMS.registerEventListener({ name: "postSave", handler: markSaved });
    } catch (e) {
      /* unknown event name on a future Decap release — stays inert */
    }
    try {
      CMS.registerEventListener({ name: "postPublish", handler: markSaved });
    } catch (e) {
      /* unknown event name on a future Decap release — stays inert */
    }
  }

  var pollId = setInterval(function () {
    if (window.CMS && typeof window.CMS.registerEventListener === "function") {
      clearInterval(pollId);
      register(window.CMS);
    }
  }, CMS_POLL_MS);

  // Decap re-renders the toolbar on entry switches and form mutations;
  // re-attach (and re-render) whenever the DOM changes. render() is
  // idempotent, so a burst of unrelated mutations is harmless.
  new MutationObserver(render).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  render(); // once at boot — quietly a no-op if the toolbar isn't mounted yet
})();
