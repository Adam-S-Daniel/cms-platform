/*
 * admin/native-preview-href.js — HIDES Decap CMS's native "View Live"
 * toolbar anchor whenever Decap (re-)renders it.
 *
 * Why hide (not rewrite, not remove): on narrow / mobile viewports the
 * editor toolbar (`Save | Published ▼ | Delete published entry |
 * View Live | adamdaniel.ai | <avatar> | <publishing pill>`) overflows
 * the viewport and pushes the deploy-status / commit pills off the
 * right edge. The native "View Live" link is redundant with two
 * existing surfaces:
 *
 *   - the floating eye-icon "Live Preview" button
 *     (`#live-preview-link` in admin/index.html), which opens the
 *     /preview/ WYSIWYG in a new tab, and
 *   - the deploy-status pill (`#cms-prod-status-pill`) plus the
 *     deployed-commit pill (`#cms-commit-pill`), which surface the
 *     in-flight + last-known live state.
 *
 * Hiding the redundant anchor reclaims the horizontal space the
 * deploy / commit pills need to stay inside the viewport on narrow
 * widths, with no loss of editor capability.
 *
 * Why CSS-hide instead of `removeChild`: Decap is React-driven and
 * owns the anchor in its virtual DOM. Yanking it out of the live DOM
 * provokes React to re-mount it on the next reconciliation pass,
 * which our MutationObserver then re-removes — a fight loop that
 * (per the failed `prod-mutate` and `host-loop` runs on commit
 * 503365a) wedges the editor mid-flow. `display:none` leaves the
 * anchor where React expects it; React doesn't observe inline styles,
 * so reconciliation is a no-op and there's no fight.
 *
 * Historical note: this script previously REWROTE the anchor's `href`
 * to match `window.LiveURL.compute()` — necessary because Decap's
 * two-pass `preview_path` substitution diverged from Jekyll's
 * `permalink: /blog/:slug/` for date-prefixed Posts (the toolbar 404'd
 * on every Post). With the anchor hidden the rewrite is moot, but
 * the live-url-derive.js dependency is kept since the in-editor banner
 * and any future toolbar surfaces will need it.
 *
 * Selector strategy:
 *   - Decap's component class names are emotion-generated and churn
 *     between versions. The toolbar's emotion `label:` has been
 *     observed as both `EditorToolbar` and `ToolbarContainer` across
 *     recent releases; we match both via a `[class*="oolbar"]`
 *     substring (covers either, and emotion never strips that
 *     substring from a labelled component).
 *   - Inside that, the native PreviewLink is an `<a>` with
 *     `target="_blank"` and `rel*="noopener"`.
 *   - Exclude this site's own surfaces (cms-live-url-banner-link,
 *     live-preview-link, cms-commit-pill, cms-prod-status-pill,
 *     cms-preview-build-pill) — those are also `target="_blank"`
 *     anchors in the same document and would otherwise match. The
 *     live-URL banner anchor (admin/live-url-banner.js) renders in
 *     the form pane, not the toolbar, so it normally wouldn't match
 *     anyway; it's excluded defensively and to honour the original
 *     pre-#184 contract now that the banner is restored.
 */
(function () {
  "use strict";

  // Excluded anchor IDs — these are surfaces this site renders itself,
  // not Decap's native toolbar. Hiding them would clobber what those
  // affordances are pointing at.
  var EXCLUDE_IDS = [
    // The in-editor "View page on site:" banner anchor
    // (admin/live-url-banner.js). It lives in the form pane, not the
    // toolbar, so it normally wouldn't match the selector — excluded
    // defensively, and to honour the original pre-#184 contract now
    // that the banner has been restored.
    "cms-live-url-banner-link",
    "live-preview-link",
    "cms-commit-pill",
    // The deploy-status pills inject INTO the toolbar with their own
    // target="_blank" links pointing at GitHub Actions runs. Without
    // this exclusion they'd match the native-anchor selector and get
    // hidden along with the View Live link.
    "cms-prod-status-pill",
    "cms-preview-build-pill",
  ];

  function findToolbarAnchors() {
    // Match either EditorToolbar (older Decap) or ToolbarContainer (newer).
    // Both contain "oolbar" in their emotion label, which gets baked into
    // the className.
    var toolbars = document.querySelectorAll('[class*="oolbar"]');
    var anchors = [];
    var seen = Object.create(null);
    for (var i = 0; i < toolbars.length; i++) {
      var as = toolbars[i].querySelectorAll('a[target="_blank"][rel*="noopener"][href]');
      for (var j = 0; j < as.length; j++) {
        var a = as[j];
        if (EXCLUDE_IDS.indexOf(a.id) !== -1) continue;
        // De-dup: an anchor inside nested toolbars matches both.
        var key = a.outerHTML;
        if (seen[key]) continue;
        seen[key] = true;
        anchors.push(a);
      }
    }
    return anchors;
  }

  // Marker so we don't log the same hide repeatedly when Decap's
  // re-renders churn through the same anchor instance multiple times.
  // We DO re-apply the styles every pass even with the marker set —
  // emotion can re-emit a `style` attribute from CSS-in-JS that
  // clobbers our inline display:none, so re-asserting is cheap
  // insurance.
  var HIDDEN_ATTR = "data-native-view-live-hidden";

  function hide() {
    var anchors = findToolbarAnchors();
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var alreadyMarked = a.getAttribute(HIDDEN_ATTR) === "1";
      // CSS-only hide. Don't `removeChild` — Decap is React-driven
      // and React re-mounts elements it owns when it sees them
      // missing from the DOM, which kicks our MutationObserver and
      // re-fires this loop. display:none + visibility:hidden +
      // pointer-events:none + aria-hidden gets the anchor out of
      // the layout, the tab order, and the a11y tree without
      // touching the DOM tree React reconciles against.
      a.style.setProperty("display", "none", "important");
      a.style.setProperty("visibility", "hidden", "important");
      a.style.setProperty("pointer-events", "none", "important");
      a.setAttribute("aria-hidden", "true");
      a.setAttribute("tabindex", "-1");
      if (!alreadyMarked) {
        a.setAttribute(HIDDEN_ATTR, "1");
        console.info("[native-preview-href] hid redundant native View Live anchor");
      }
    }
  }

  var pending = false;
  function scheduleHide() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      hide();
    });
  }

  // Mutations re-hide when Decap (re)renders the toolbar — including
  // the initial mount, hash navigations between entries, and field
  // updates that re-render the toolbar action group.
  new MutationObserver(scheduleHide).observe(document.body, {
    childList: true,
    subtree: true,
  });
  // Hash changes navigate between entries — re-hide for the new context.
  window.addEventListener("hashchange", scheduleHide);
  scheduleHide();
})();
