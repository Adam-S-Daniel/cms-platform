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
 *
 * ── "Check for Preview" on a preview-only draft (#642) ────────────
 * Decap's "Check for Preview" button (`RefreshPreviewButton`, decap-cms
 * 3.15.1) waits for the `deploy/preview` commit status deploy-preview.yml
 * sets. That workflow builds only PRs into the default branch, so a PR
 * whose base is anything else — every draft saved on a preview admin,
 * labeled `cms/preview-only` — never gets one, and the button spins on
 * every click forever. When publish-progress.js reports the open entry's
 * PR as `previewOnly`, the button is CSS-hidden (same idiom as above) and
 * a pointer to Live Preview — which renders the draft on every Save —
 * takes its place. Any other entry gets the button back. Shells without
 * the poller (index-test.html, index-local.html) are never changed.
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
    // The Live Preview pointer that stands in for "Check for Preview" on a
    // preview-only draft (below) — this shim's own anchor.
    "cms-live-preview-pointer",
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

  // ── "Check for Preview" on a preview-only draft (see the header) ──
  var CHECK_PREVIEW = '[class*="RefreshPreviewButton"]';
  var CHECK_HIDDEN_ATTR = "data-cms-check-preview-hidden";
  var POINTER_ID = "cms-live-preview-pointer";

  // Whether the entry on screen has an open PR that no deploy preview is
  // ever built for, per the poller. Its answer must be for THIS entry: a
  // snapshot left over from the previous route decides nothing.
  function entryIsPreviewOnly() {
    var p = window.CMSPublishProgress;
    var snap = p && typeof p.get === "function" ? p.get() : null;
    if (!snap || !snap.ready || !snap.entry || !snap.facts) return false;
    var entry = typeof p.currentEntry === "function" ? p.currentEntry() : null;
    if (!entry || entry.collection !== snap.entry.collection || entry.slug !== snap.entry.slug) return false;
    return Boolean(snap.facts.hasOpenPr && snap.facts.previewOnly);
  }

  // Only the properties hide() style-writes, so restoring is exact. Writes
  // nothing in the steady state (either direction), so the observer below
  // does not re-fire on its own changes.
  function setCheckHidden(el, hidden) {
    var marked = el.getAttribute(CHECK_HIDDEN_ATTR) === "1";
    if (hidden === marked) return;
    if (hidden) {
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
      el.setAttribute("aria-hidden", "true");
      el.setAttribute(CHECK_HIDDEN_ATTR, "1");
    } else {
      el.style.removeProperty("display");
      el.style.removeProperty("visibility");
      el.style.removeProperty("pointer-events");
      el.removeAttribute("aria-hidden");
      el.removeAttribute(CHECK_HIDDEN_ATTR);
    }
  }

  // The floating Live Preview link's current target, or null while it is
  // not offered (index.html hides it off the editor route and for a
  // collection /preview/ cannot render) — a pointer to a hidden button
  // would be a pointer to nothing.
  function livePreviewHref() {
    var link = document.getElementById("live-preview-link");
    if (!link || link.style.display === "none") return null;
    return link.getAttribute("href");
  }

  function syncCheckForPreview() {
    var hide = entryIsPreviewOnly();
    var buttons = document.querySelectorAll(CHECK_PREVIEW);
    var pointer = document.getElementById(POINTER_ID);
    var href = hide ? livePreviewHref() : null;
    for (var i = 0; i < buttons.length; i++) setCheckHidden(buttons[i], hide);
    var anchor = hide && href && buttons.length ? buttons[0] : null;
    if (!anchor) {
      // This shim's own node, never one React owns.
      if (pointer && pointer.parentNode) pointer.parentNode.removeChild(pointer);
      return;
    }
    if (!pointer) {
      pointer = document.createElement("a");
      pointer.id = POINTER_ID;
      pointer.target = "_blank";
      pointer.rel = "noopener";
      pointer.title =
        "No preview address is built for drafts saved here. " +
        "Live Preview shows this entry each time you Save.";
      pointer.textContent = "Use Live Preview";
    }
    if (pointer.getAttribute("href") !== href) pointer.setAttribute("href", href);
    if (pointer.previousSibling !== anchor || pointer.parentNode !== anchor.parentNode) {
      anchor.parentNode.insertBefore(pointer, anchor.nextSibling);
    }
  }

  // requestAnimationFrame never fires in a background tab, so a pass scheduled
  // there, or scheduled just before the tab went to the back, waited until the
  // editor returned (#644). A hidden tab paints nothing, so the next task is
  // as good as the next frame; `pending` makes whichever runs first the only
  // pass.
  var pending = false;
  function runHide() {
    if (!pending) return;
    pending = false;
    hide();
    syncCheckForPreview();
  }
  function scheduleHide() {
    if (pending) return;
    pending = true;
    if (document.hidden) setTimeout(runHide, 0);
    else requestAnimationFrame(runHide);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) runHide();
  });

  // Mutations re-hide when Decap (re)renders the toolbar — including
  // the initial mount, hash navigations between entries, and field
  // updates that re-render the toolbar action group.
  new MutationObserver(scheduleHide).observe(document.body, {
    childList: true,
    subtree: true,
  });
  // Hash changes navigate between entries — re-hide for the new context.
  window.addEventListener("hashchange", scheduleHide);
  // The poller's answer arrives after the toolbar mounts. publish-progress.js
  // loads before this script on every shell that has it (`defer`, document
  // order), so it is already defined here.
  if (window.CMSPublishProgress && typeof window.CMSPublishProgress.subscribe === "function") {
    window.CMSPublishProgress.subscribe(scheduleHide);
  }
  // Test hook (e2e/check-for-preview-preview-only.test.js).
  window.__nativePreviewHref = { syncCheckForPreview: syncCheckForPreview };
  scheduleHide();
})();
