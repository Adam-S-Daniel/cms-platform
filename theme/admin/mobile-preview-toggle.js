/*
 * admin/mobile-preview-toggle.js — makes Decap's eye ("Toggle preview") work
 * on a phone (cms-platform#645).
 *
 * ── The defect ─────────────────────────────────────────────────────────
 * admin-mobile.css (rule 4) hides react-split-pane's `.Pane2` below 768px so
 * the form gets the full width. Decap's eye flips its `previewVisible` state,
 * which only swaps between two layouts:
 *   - on:  <SplitPane> .Pane1 = form, .Pane2 = PreviewPaneContainer (iframe)
 *   - off: <NoPreviewContainer> form only, no SplitPane at all
 * (EditorInterface `EditorContent` in decap-cms 3.15.1; the state defaults to
 * on and persists in localStorage `cms.preview-visible`). Both layouts look
 * identical on a phone, because the only thing that differs is a pane the CSS
 * can never show. The eye was a visible no-op.
 *
 * ── The fix ────────────────────────────────────────────────────────────
 * Below 768px the eye switches between two FULL-WIDTH views instead of a
 * side-by-side split: the form (today's layout, unchanged) and the preview.
 * The preview view is the `cms-mobile-preview` class on <html>, which
 * admin-mobile.css keys off to hide `.Pane1` and show `.Pane2` at 100% width.
 * A "Back to editing" button at the top of the preview returns to the form,
 * and so does the eye.
 *
 * The class is set only while Decap really has the preview pane mounted, so
 * the CSS can never hide the form with nothing to show in its place:
 *   - Decap preview ON (the default): the pane is mounted but hidden. The eye
 *     tap is taken here (capture phase, before React's root listener) and
 *     only flips the class, so Decap's state and its stored preference stay
 *     as they were.
 *   - Decap preview OFF (a stored `false`): the tap goes through to Decap,
 *     which mounts the split pane; the observer sets the class once the pane
 *     exists.
 *   - In preview: the tap is taken here and clears the class. Decap's preview
 *     stays on, so the next tap needs no re-render.
 * The class is dropped whenever the preview pane goes away (another editor
 * toggle, a route change), so it never outlives the pane it reveals.
 *
 * At 769px and up the shim does nothing and Decap's eye behaves as upstream.
 *
 * ── Selectors ──────────────────────────────────────────────────────────
 * The eye is matched by its `title` inside Decap's `ViewControls` (the label
 * Decap 3.15.1 renders for `editor.editorInterface.togglePreview` in English,
 * the only locale these sites configure). If Decap renames it the match
 * misses and the eye goes back to upstream behavior: degrade-safe. The pane
 * is react-split-pane's `.Pane2` holding Decap's `PreviewPaneContainer`;
 * `ControlPaneContainer` is styled from it and carries both labels, so it is
 * excluded to keep the i18n side-by-side editor from counting as a preview.
 *
 * The back bar is the one node this shim adds. It goes inside `.Pane2`, a
 * node React owns, but React only reconciles the children it created and
 * leaves a foreign sibling alone (the same pattern publish-step-hint.js uses
 * for #cms-publish-state). Nothing Decap owns is removed or restyled inline.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__mobilePreviewToggleInstalled) return;
  window.__mobilePreviewToggleInstalled = true;

  var MODE_CLASS = "cms-mobile-preview";
  var BAR_ID = "cms-mobile-preview-back";
  var BACK_LABEL = "Back to editing";
  var MOBILE_QUERY = "(max-width: 768px)";
  var TOGGLE_SELECTOR = '[class*="ViewControls"] button[title="Toggle preview"]';
  var PREVIEW_PANE_SELECTOR =
    '.SplitPane > .Pane2 > [class*="PreviewPaneContainer"]:not([class*="ControlPaneContainer"])';

  // Set when an eye tap was handed to Decap to mount the preview pane; the
  // observer enters the preview view once that pane exists.
  var pending = false;

  // ── Pure decision (unit-tested) ───────────────────────────────────────
  //   "pass"         — not a phone layout: leave the tap to Decap.
  //   "exit"         — preview view showing: take the tap, back to the form.
  //   "enter"        — pane mounted but hidden: take the tap, show it.
  //   "enter-later"  — Decap has the preview off: let the tap through so
  //                    Decap mounts the pane, then show it.
  function decide(state) {
    if (!state.mobile) return "pass";
    if (state.showing) return "exit";
    if (state.paneMounted) return "enter";
    return "enter-later";
  }

  function isMobile() {
    try {
      return !!(window.matchMedia && window.matchMedia(MOBILE_QUERY).matches);
    } catch (e) {
      return false;
    }
  }

  function root() {
    return document.documentElement;
  }

  function isShowing() {
    return root().classList.contains(MODE_CLASS);
  }

  function previewPane() {
    return document.querySelector(PREVIEW_PANE_SELECTOR);
  }

  function ensureBar(pane2) {
    if (!pane2 || pane2.querySelector("#" + BAR_ID)) return;
    var bar = document.createElement("div");
    bar.id = BAR_ID;
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = BACK_LABEL;
    button.addEventListener("click", function () {
      exitPreview();
    });
    bar.appendChild(button);
    pane2.insertBefore(bar, pane2.firstChild);
  }

  function enterPreview() {
    var pane = previewPane();
    if (!pane) return false;
    ensureBar(pane.parentNode);
    root().classList.add(MODE_CLASS);
    return true;
  }

  function exitPreview() {
    root().classList.remove(MODE_CLASS);
  }

  function onClick(event) {
    var target = event.target;
    var toggle = target && target.closest ? target.closest(TOGGLE_SELECTOR) : null;
    if (!toggle) return;
    var action = decide({
      mobile: isMobile(),
      showing: isShowing(),
      paneMounted: !!previewPane(),
    });
    if (action === "pass") return;
    if (action === "enter-later") {
      pending = true;
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    if (action === "exit") exitPreview();
    else enterPreview();
  }

  // Runs on every DOM mutation, so the common case (no preview view, nothing
  // pending) returns before touching the DOM.
  function sync() {
    if (pending) {
      if (enterPreview()) pending = false;
      return;
    }
    if (isShowing() && !previewPane()) exitPreview();
  }

  document.addEventListener("click", onClick, true);
  window.addEventListener("hashchange", function () {
    pending = false;
    exitPreview();
  });
  try {
    new MutationObserver(sync).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    /* MutationObserver unavailable: the stored-off case needs a second tap */
  }

  window.__cmsMobilePreviewToggle = {
    decide: decide,
    sync: sync,
    MODE_CLASS: MODE_CLASS,
    BAR_ID: BAR_ID,
    TOGGLE_SELECTOR: TOGGLE_SELECTOR,
    PREVIEW_PANE_SELECTOR: PREVIEW_PANE_SELECTOR,
  };
})();
