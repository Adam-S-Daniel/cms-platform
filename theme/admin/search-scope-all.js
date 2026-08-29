/*
 * admin/search-scope-all.js — issue #329 item 4.
 *
 * ── The bug (root-caused live) ────────────────────────────────────────
 * The sidebar search input is labelled "Search all", but its scope is
 * sticky and history-dependent rather than always "all collections".
 * Measured live, in one session: searching "HIPAA" from the `expertise`
 * collection routed to `#/collections/expertise/search/HIPAA` and
 * returned 0 hits — even though "HIPAA" is in that collection's own
 * `description` field — while the SAME search, later, from the SAME
 * collection routed to `#/search/HIPAA` and returned 3 hits. The user has
 * no visible scope control and no way to predict which route they'll get.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * Make the box honour its own label: whenever the URL lands on a
 * collection-scoped search route, immediately rewrite it to the
 * all-collections search route with the same search term, via
 * `location.replace(...)` so the scoped route never accumulates in
 * browser history (back-navigating out of a search shouldn't have to step
 * through a route the user never asked for).
 *
 * ── Why this is pure routing, not a Decap-internals patch ───────────────
 * Touches no Decap internals and no Emotion class names — only
 * `location.hash`. If Decap ever changes its route shape, the regex below
 * simply stops matching and this shim degrades to a silent no-op; it
 * cannot mis-rewrite an unrelated route and cannot throw.
 *
 * Verified live: rewrites `#/collections/expertise/search/HIPAA` to
 * `#/search/HIPAA` and turns the 0-hit result into the correct 3-hit one.
 */
(function () {
  "use strict";

  var SCOPED_SEARCH_RE = /^#\/collections\/[^/]+\/search\/(.*)$/;

  function rewrite() {
    var hash = location.hash || "";
    var m = SCOPED_SEARCH_RE.exec(hash);
    if (!m) return;
    try {
      location.replace("#/search/" + m[1]);
    } catch (e) {
      /* nothing else to do — leave the scoped (0-hit-prone) route in place */
    }
  }

  window.addEventListener("hashchange", rewrite);
  rewrite();
})();
