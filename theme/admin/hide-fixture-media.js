/*
 * admin/hide-fixture-media.js — issue #652.
 *
 * ── The bug ────────────────────────────────────────────────────────────
 * `assets/images/uploads/e2e-preview-media-probe.png` is a committed sentinel
 * (the `preview-media` gate fetches it; scaffold/create-site.js seeds it and
 * scripts/check-platform-pin-consistency.js requires it), so it cannot be
 * deleted from a site. It lives in the real `media_folder`, so Decap's media
 * library and the in-entry image picker list it, a red test square among the
 * editors' real images, right beside "Delete selected".
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * Hide the card of any library file whose name starts with `e2e-preview-`
 * (the same idea as posts-list-enhance.js hiding the E2E canary posts). The
 * file stays on disk and on the site; only the picker stops showing it.
 * The prefix is deliberately NARROW: cms-media-roundtrip.spec.js uploads
 * `e2e-media-roundtrip-<id>.png` and must still see it in the library to
 * delete it, so a bare `e2e-` prefix would break that spec.
 *
 * Hidden with `display: none` (React owns the card; removing it would provoke
 * a re-mount loop, see native-preview-href.js). Idempotent, so a re-render
 * that re-creates the card is hidden again on the next observer pass.
 * Selector convention as in list-row-affordance.js: the Emotion label
 * substring `CardText` survives hash churn; if Decap drops it the shim just
 * stops hiding, never errors.
 */
(function () {
  "use strict";

  var FIXTURE_MEDIA_RE = /^e2e-preview-/i;
  var CARD_TEXT_SELECTOR = '[class*="CardText"]';
  var HIDDEN_ATTR = "data-fixture-media-hidden";

  function cardOf(label) {
    for (var el = label; el && el.nodeType === 1; el = el.parentElement) {
      var cls = typeof el.className === "string" ? el.className : "";
      if (/(^|\s)[\w-]*-Card(\s|$)/.test(cls)) return el;
    }
    return null;
  }

  function sync() {
    var labels = document.querySelectorAll(CARD_TEXT_SELECTOR);
    for (var i = 0; i < labels.length; i++) {
      var name = String(labels[i].textContent || "").trim();
      var card = cardOf(labels[i]);
      if (!card) continue;
      // Bidirectional: the grid is virtualized (react-window keys cells by
      // index), so a node hidden for a fixture can be reused for a real file.
      if (FIXTURE_MEDIA_RE.test(name)) {
        card.setAttribute(HIDDEN_ATTR, "1");
        card.style.setProperty("display", "none", "important");
      } else if (card.hasAttribute(HIDDEN_ATTR)) {
        card.removeAttribute(HIDDEN_ATTR);
        card.style.removeProperty("display");
      }
    }
  }

  try {
    new MutationObserver(sync).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    /* MutationObserver unavailable — fixture media simply stays listed */
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync);
  } else {
    sync();
  }

  window.__hideFixtureMedia = { pattern: FIXTURE_MEDIA_RE.source, sync: sync };
})();
