/*
 * autosave-on-hide.js — admin/ shim that AUTOSAVES the open entry by
 * clicking the toolbar Save button on tab-hide + idle (issues #161 / #160,
 * Decision 2).
 *
 * ── Why ───────────────────────────────────────────────────────────────
 * confirm-wrap-local-backup.js disables Decap's misleading "restore local
 * backup" dialog (that feature silently drops work — see its header). To
 * replace the lost safety net with a RELIABLE one, this shim autosaves "the
 * way the Save button saves": it clicks the real toolbar Save button, so it
 * inherits Save's exact semantics. Under `publish_mode: editorial_workflow`
 * that commits to the entry's own `cms/<collection>/<slug>` PR branch — NOT
 * `main` — so autosaved changes are NOT on the live site until the editor
 * hits Publish/Republish (which merges the PR).
 *
 * ── The Save seam (verbatim from the pinned decap-cms bundle) ─────────
 *   renderWorkflowControls: _n(SaveButton,{disabled:!i,key:"save-button",
 *     onClick:()=>i&&e()}, t(l?"editor.editorToolbar.saving":"editor.editorToolbar.save"))
 * where `i` = hasChanged, `e` = onPersist. The onClick is a BUILT-IN NO-OP
 * when there are no unsaved changes (`i && e()`), so a Save click on a clean
 * entry produces no commit / no empty PR — we rely on that: tab-hide / idle
 * clicks on a non-dirty entry do nothing. We locate the Save button by its
 * trimmed textContent === "Save" (which EXCLUDES the "Saving..." — three
 * ASCII dots — persisting state). The Save button only exists in
 * editorial_workflow mode; on the simple/local backend (Publish-only) this
 * shim finds no button and is harmlessly inert.
 *
 * ── Cadence: tab-hide + idle (NOT a fast per-keystroke timer) ─────────
 *  (a) `visibilitychange` → document.visibilityState === "hidden"
 *  (b) `pagehide`
 *  (c) idle: after IDLE_MS with no user input (keydown / mousedown / input
 *      reset the timer). Fires ONCE per idle period, not per keystroke — the
 *      timer only elapses after the editor stops typing for IDLE_MS, and is
 *      not re-armed until the next input. IDLE_MS defaults to 120000ms (2min)
 *      and is overridable via `window.__AUTOSAVE_IDLE_MS` (a TEST SEAM — the
 *      @admin-write e2e spec sets it low to exercise the idle path; also
 *      documented in theme/admin/README.md's window.CMS_* / contract table).
 *
 * ── Route gate ────────────────────────────────────────────────────────
 * Acts only on entry-editor routes — hash `#/collections/<c>/entries/<slug>`
 * or `#/collections/<c>/new` — mirroring the entry-route logic the admin
 * shells + native-preview-href.js use. Off an entry route (list / login /
 * workflow board) there is nothing to save.
 *
 * Loaded via a DEFERRED <script> tag AFTER decap-cms.js (post-load behaviour;
 * it clicks a button Decap renders). It wraps NOTHING (no fetch, no confirm),
 * so it composes with publish-via-auto-merge.js + confirm-wrap-local-backup.js.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__autosaveOnHideInstalled) return;
  window.__autosaveOnHideInstalled = true;

  var DEFAULT_IDLE_MS = 120000;

  // Entry-editor routes only: #/collections/<c>/entries/<slug> or /new.
  // Mirrors the shells' live-preview-link route gate + native-preview-href.js.
  function onEntryEditorRoute() {
    var h = location.hash || "";
    return /^#\/collections\/[^/]+\/(entries\/|new(\?|$))/.test(h);
  }

  // The toolbar Save button = a <button> whose trimmed textContent is exactly
  // "Save". The exact match EXCLUDES the persisting "Saving..." label (three
  // ASCII dots) and any other toolbar button (Publish, Delete...).
  function findSaveButton() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if ((b.textContent || "").trim() === "Save") return b;
    }
    return null;
  }

  // The save-click fire function. Route-gated; clicks Save iff we're on an
  // entry editor and a "Save" button exists. Decap's own onClick guard
  // (()=>hasChanged&&onPersist()) makes a click on a clean entry a no-op, so
  // this never produces an empty commit / empty PR.
  function fire() {
    if (!onEntryEditorRoute()) return;
    var btn = findSaveButton();
    if (!btn) return;
    btn.click();
    // Always log (error/warn are the levels the host-loop trace captures);
    // the e2e spec can assert the fire via this tag too.
    console.warn("[autosave-on-hide] clicked Save (tab-hide / idle autosave)");
  }

  function idleMs() {
    var v = window.__AUTOSAVE_IDLE_MS;
    return typeof v === "number" && v > 0 ? v : DEFAULT_IDLE_MS;
  }

  // Idle timer: reset on user input; fires ONCE when IDLE_MS elapses with no
  // input (then stays un-armed until the next input — once per idle period).
  var idleTimer = null;
  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      idleTimer = null;
      fire();
    }, idleMs());
  }

  // Tab-hide + close.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") fire();
  });
  window.addEventListener("pagehide", fire);

  // User-input listeners drive the idle cadence (capture phase so we see the
  // event even if Decap stops propagation). keydown/mousedown/input reset the
  // timer — so the idle save fires after the editor pauses, not per keystroke.
  ["keydown", "mousedown", "input"].forEach(function (evt) {
    document.addEventListener(evt, resetIdle, true);
  });

  // Small test surface — lets a spec assert the shim is installed and drive
  // the save-click directly if needed.
  window.__autosaveOnHide = {
    installed: true,
    fire: fire,
  };
})();
