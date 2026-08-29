/*
 * admin/publish-baseline-refresh.js — issue #329 item 1 (the BLOCKER).
 *
 * ── The bug ────────────────────────────────────────────────────────────
 * Decap's dirty-tracking compares the current form against the entry
 * snapshot taken when the editor was OPENED, and a Publish does not
 * refresh that snapshot. Reproduced live, twice, on both a string and a
 * boolean widget:
 *
 *   1. Open an entry (baseline = ORIGINAL).
 *   2. Type A, Save, Publish A. The backend now holds A.
 *   3. Retype the ORIGINAL value. The form now equals the stale baseline
 *      taken in step 1, so Decap reports "Changes saved" and REMOVES the
 *      Publish control — even though the backend still holds A, not
 *      ORIGINAL.
 *
 * The owner's edit becomes unsaveable with no error and no hint. On
 * jodidaniel.com's `Site Live` boolean this left the site stuck gated,
 * with the admin insisting there was nothing to publish.
 *
 * ── The fix ────────────────────────────────────────────────────────────
 * Verified live: re-opening the entry refreshes the baseline and restores
 * correct behaviour. So a Publish does what a re-open does — a few hundred
 * ms after `postPublish` fires, remount the current entry editor by a
 * hash round-trip (navigate to the collection list, then straight back to
 * the entry). Decap tears down and remounts the editor on the hash change,
 * which re-fetches the entry and takes a fresh baseline snapshot.
 *
 * ── Why gated on the dropdown trigger, not applied unconditionally ─────
 * Right after `postPublish` + a settle delay, if Decap's Publish dropdown
 * trigger (see the selector strategy in publish-step-hint.js) is present,
 * the form is currently tracked as dirty — the user has started a new,
 * genuinely unsaved edit since the publish completed. Remounting then
 * would discard that in-flight edit, which is worse than the bug this
 * file fixes. So the refresh only runs when the trigger is ABSENT — the
 * state Decap currently believes is clean, and therefore the state the
 * stale-baseline bug can silently corrupt without the user noticing.
 * There is nothing to lose by remounting there, and everything to gain:
 * verified, this turns a permanently-stuck "Changes saved" after
 * retyping the original value back into a correctly reported "Unsaved
 * Changes" with a working Publish control.
 *
 * ── Only the entry route, never the editorial-workflow list route ──────
 * `postPublish` also fires when publishing takes the editorial-workflow
 * path, which navigates AWAY from the entry after publishing. Requiring
 * `location.hash` to still match the entry-editor route
 * (`#/collections/<c>/entries/<slug>`) at the moment the handler runs
 * makes this shim inert on that path — there is no entry editor left to
 * refresh.
 *
 * ── Registration is defensive on purpose ────────────────────────────────
 * `registerEventListener` REJECTS unknown event names (`login` / `logout`
 * / `mounted` throw "Invalid event name" — verified live). `preSave`,
 * `prePublish`, `postSave` and `postPublish` all fire on this Decap
 * version, but only `postPublish` is relevant here, and the registration
 * is wrapped in try/catch so a future Decap release that renames or drops
 * the event degrades this shim to a silent no-op rather than a page error.
 *
 * ── Decap-upgrade safety ────────────────────────────────────────────────
 * Never reaches into Decap's Redux internals — only the public
 * `window.CMS.registerEventListener` API, `location`, and one `document
 * .querySelector` against the same `[class*="PublishButton"]` substring
 * convention documented in native-preview-href.js's "Selector strategy"
 * (Emotion's class hash churns; the trailing component-name segment does
 * not). If the class name ever changes outright, `isDirty()` always
 * reports false and the refresh simply runs on every publish, including
 * the rare one where the user had already started retyping — degrading
 * toward "refreshes more often than strictly needed", never toward the
 * silent unsaveable state this file exists to remove.
 */
(function () {
  "use strict";

  var CMS_POLL_MS = 100;
  var SETTLE_MS = 250;
  var HOP_MS = 60;
  var ENTRY_HASH_RE = /^#\/collections\/([^/]+)\/entries\/(.+)$/;
  var DIRTY_TRIGGER_SELECTOR = '[role="button"][aria-haspopup="true"][class*="PublishButton"]';

  // Module-scoped re-entrancy flag: while OUR OWN hash round-trip is in
  // flight, ignore any further postPublish handler invocations rather than
  // starting a second overlapping round-trip on top of it.
  var refreshing = false;

  function isDirty() {
    try {
      return !!document.querySelector(DIRTY_TRIGGER_SELECTOR);
    } catch (e) {
      return false;
    }
  }

  function runRefresh() {
    if (refreshing) return;

    var hash = location.hash || "";
    var m = ENTRY_HASH_RE.exec(hash);
    if (!m) return; // not on an entry editor route — nothing to refresh

    if (isDirty()) return; // a real in-flight edit exists; don't discard it

    var collectionName = m[1];
    refreshing = true;
    try {
      location.hash = "#/collections/" + collectionName;
    } catch (e) {
      refreshing = false;
      return;
    }
    setTimeout(function () {
      try {
        // Only restore if we are still where WE put the router. If the user
        // navigated somewhere else inside the hop window, honour that — the
        // stale baseline they left behind stops mattering the moment they
        // leave the entry, and yanking them back would be a worse bug than
        // the one this file fixes.
        if (location.hash === "#/collections/" + collectionName) {
          location.hash = hash;
        }
      } catch (e) {
        /* nothing else to do — leave the user on the collection list */
      }
      refreshing = false;
    }, HOP_MS);
  }

  function onPostPublish() {
    setTimeout(runRefresh, SETTLE_MS);
  }

  function register(CMS) {
    try {
      CMS.registerEventListener({ name: "postPublish", handler: onPostPublish });
    } catch (e) {
      /* unknown event name on a future Decap release — shim stays inert */
    }
  }

  var pollId = setInterval(function () {
    if (window.CMS && typeof window.CMS.registerEventListener === "function") {
      clearInterval(pollId);
      register(window.CMS);
    }
  }, CMS_POLL_MS);
})();
