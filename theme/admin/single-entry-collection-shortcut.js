/*
 * admin/single-entry-collection-shortcut.js — issue #329 item 7.
 *
 * ── The problem ────────────────────────────────────────────────────────
 * Singleton FILE collections (Header/Hero, About, Contact, Site Settings)
 * force an extra click through a one-item list before an editor can reach
 * the fields they actually came to edit.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * On ARRIVING at a bare collection route (`#/collections/<name>`), wait
 * ~700ms for Decap to finish rendering the list asynchronously, then jump
 * straight to the single entry — but ONLY when the render confirms this
 * really is a one-item, no-"add" collection:
 *
 *   - the arrival did not come from an entry of this same collection
 *     (see "the one arrival that must not jump" below);
 *   - re-check `location.hash` is STILL the bare collection route before
 *     doing anything (abort otherwise);
 *   - the page has exactly ONE distinct `href` among
 *     `a[href^="#/collections/<name>/entries/"]`;
 *   - the page has NO `a[href^="#/collections/<name>/new"]` element.
 *
 * ── The one arrival that must NOT jump (issue #405) ────────────────────
 * Coming out of the collection's OWN entry is the editor asking to leave
 * it, and it lands on exactly the same route as any other arrival. The
 * first version of this shim could not tell the two apart, so it jumped
 * on both — and Decap's back link ("← Writing in <collection> collection")
 * became unusable: the list appeared for ~700ms and was then replaced by
 * the entry again, every time, with no way to reach the list at all.
 * Reproduced on jodidaniel.com's `site_header` against a local
 * decap-server admin; the measured hash timeline held the list for 600ms
 * and bounced at 800ms, which is the "flashes briefly, then returns" the
 * report described. https://github.com/Adam-S-Daniel/cms-platform/issues/405
 *
 * So the transition's ORIGIN decides. An arrival from
 * `#/collections/<name>/entries/...` — the same `<name>` — is a deliberate
 * exit and is left alone. Every other arrival (a fresh load, the sidebar,
 * a different collection, the browser's own history) is the arrival item 7
 * is about, and still jumps.
 *
 * ── Why that also settles the race with shim #1 ─────────────────────────
 * `publish-baseline-refresh.js` (item 1) transiently sets `location.hash`
 * to a bare collection route as part of its own refresh round-trip, before
 * restoring the original entry hash ~60ms later. That hop leaves the
 * entry route of the very same collection, so the origin rule above makes
 * this shim structurally inert on it. The 700ms settle delay and the
 * re-check that the hash is UNCHANGED right before acting both remain —
 * they are cheap, and they still cover any future hop this rule does not
 * anticipate — but correctness no longer rests on out-racing another shim.
 *
 * ── Why the "no /new link" check is load-bearing ────────────────────────
 * Folder collections render a "+ New" link; file collections do not. A
 * folder collection that happens to contain exactly one entry today is
 * NOT a singleton by design — it's one entry away from having a second —
 * and jumping straight into it would trap the editor with no way back to
 * the list to create that second entry. Dropping this check would silently
 * regress that case. Verified live: `site_header` / `site_settings` (file
 * collections) render exactly one entry link and no `/new` link and DO
 * jump; `expertise` (6 entries) and `education` (3 entries), both folder
 * collections, render a `/new` link and correctly do NOT jump regardless
 * of entry count.
 *
 * `location.replace(...)` is used for the jump so the skipped list route
 * never lands in browser history.
 *
 * Behaviour is pinned by e2e/single-entry-collection-shortcut.test.js —
 * both directions, because suppressing too much silently un-ships item 7
 * and suppressing too little re-traps the editor.
 */
(function () {
  "use strict";

  var BARE_COLLECTION_RE = /^#\/collections\/([^/]+)$/;
  var SETTLE_MS = 700;

  // The fragment of a full URL, as `hashchange` reports oldURL/newURL.
  function hashOf(url) {
    if (typeof url !== "string") return "";
    var i = url.indexOf("#");
    return i === -1 ? "" : url.slice(i);
  }

  // Did this arrival come out of an entry of this same collection? Compared as
  // a literal prefix rather than a built regex, so a collection name carrying a
  // regex metacharacter cannot change what is being asked.
  function cameFromEntryOf(name, fromHash) {
    if (!fromHash) return false;
    return fromHash.indexOf("#/collections/" + name + "/entries/") === 0;
  }

  function attempt(hash, fromHash) {
    var m = BARE_COLLECTION_RE.exec(hash);
    if (!m) return;
    var name = m[1];

    // A deliberate exit from this collection's own entry. Honour it — jumping
    // back is what made the back link unusable.
    if (cameFromEntryOf(name, fromHash)) return;

    setTimeout(function () {
      // Re-check we're still on the bare collection route the timer was
      // started for; anything that moved the router in the meantime wins.
      var current = location.hash || "";
      if (current !== hash) return;

      var entryPrefix = "#/collections/" + name + "/entries/";
      var newPrefix = "#/collections/" + name + "/new";

      var anchors;
      try {
        anchors = document.querySelectorAll('a[href^="' + entryPrefix + '"]');
      } catch (e) {
        return;
      }
      var seen = Object.create(null);
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].getAttribute("href");
        if (href) seen[href] = true;
      }
      var distinct = Object.keys(seen);
      if (distinct.length !== 1) return; // not a single-entry list

      var hasNewLink;
      try {
        hasNewLink = !!document.querySelector('a[href^="' + newPrefix + '"]');
      } catch (e) {
        return;
      }
      if (hasNewLink) return; // a folder collection — never auto-jump

      try {
        location.replace(distinct[0]);
      } catch (e) {
        /* nothing else to do — leave the editor on the one-item list */
      }
    }, SETTLE_MS);
  }

  window.addEventListener("hashchange", function (ev) {
    attempt(location.hash || "", hashOf(ev && ev.oldURL));
  });
  // First paint: there is no previous route, so this is always an arrival.
  attempt(location.hash || "", "");
})();
