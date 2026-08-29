/*
 * admin/single-entry-collection-shortcut.js — issue #329 item 7.
 *
 * ── The problem ────────────────────────────────────────────────────────
 * Singleton FILE collections (Header/Hero, About, Contact, Site Settings)
 * force an extra click through a one-item list before an editor can reach
 * the fields they actually came to edit.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * On landing on a bare collection route (`#/collections/<name>`), wait
 * ~700ms for Decap to finish rendering the list asynchronously, then jump
 * straight to the single entry — but ONLY when the render confirms this
 * really is a one-item, no-"add" collection:
 *
 *   - re-check `location.hash` is STILL the bare collection route before
 *     doing anything (abort otherwise);
 *   - the page has exactly ONE distinct `href` among
 *     `a[href^="#/collections/<name>/entries/"]`;
 *   - the page has NO `a[href^="#/collections/<name>/new"]` element.
 *
 * ── Why the re-check matters (racing shim #1) ───────────────────────────
 * `publish-baseline-refresh.js` (item 1) also transiently sets
 * `location.hash` to a bare collection route as part of its own refresh
 * round-trip, before restoring the original entry hash ~60ms later. Our
 * 700ms settle delay is deliberately longer than that, and re-confirming
 * the hash is UNCHANGED right before acting is what keeps this shim from
 * hijacking that round-trip and stranding the user on the collection list
 * instead of back in their entry.
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
 */
(function () {
  "use strict";

  var BARE_COLLECTION_RE = /^#\/collections\/([^/]+)$/;
  var SETTLE_MS = 700;

  function attempt(hash) {
    var m = BARE_COLLECTION_RE.exec(hash);
    if (!m) return;
    var name = m[1];

    setTimeout(function () {
      // Re-check we're still on the bare collection route the timer was
      // started for — this is what keeps the shim from racing
      // publish-baseline-refresh.js's own transient hash round-trip.
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

  window.addEventListener("hashchange", function () {
    attempt(location.hash || "");
  });
  attempt(location.hash || "");
})();
