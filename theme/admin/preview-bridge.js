/*
 * admin/preview-bridge.js — wires Decap CMS saves to the live preview page.
 *
 * Boots after Decap's `window.CMS` global is defined and:
 *   - Registers a `postSave` event listener. On every save, the current
 *     entry (collection, slug and fields) is broadcast via a same-origin
 *     BroadcastChannel that the `/preview/` page subscribes to, so every
 *     open preview tab updates within a frame of Save being pressed.
 *   - Answers a `/preview/` tab that has just loaded (#646). The tab posts
 *     `{ type: "cms-preview-request", collection }` on the same channel;
 *     when this tab is on that collection's entry editor, it replies with
 *     the entry in the save broadcast's own shape, so Live Preview on an
 *     already-saved entry renders it without another Save. The entry comes
 *     from the in-editor preview pane's latest render (preview-pane.js
 *     records it; Decap has no public event for an entry it merely
 *     loaded), else from this tab's last postSave. With the pane toggled
 *     off and nothing saved in this tab yet there is nothing to send, and
 *     the preview keeps its empty state.
 *
 *     The request crosses a trust boundary, so it is checked before anything
 *     is sent: the event's origin must be this origin (a BroadcastChannel is
 *     same-origin by construction; this is the belt to that brace), the
 *     message a plain object of the request type, and its collection a bare
 *     name equal to the one the editor route names. An entry whose slug is
 *     not the route's (a snapshot of an entry left earlier) is never sent.
 *
 * Uses only Decap's public CMS API (`registerEventListener`) — no
 * internal selectors, so it survives Decap minor-version churn.
 *
 * Exposed for tests: window.adamdaniel_cms_preview_url(collection).
 *
 * A previous version of this file also `MutationObserver`-injected a
 * "Live Preview" link next to Decap's "View on Live Site" toolbar
 * anchor. The observer ran on `document.documentElement` with
 * `childList: true, subtree: true`, and on EVERY mutation walked the
 * entire DOM tree recursively to discover shadow roots before running
 * an aria-label querySelector. Decap's React reconciliation during
 * the `loadEntries` phase fires hundreds of mutations a second; at
 * the 3K viewport this dominated the Safari main thread (WebKit is
 * markedly slower than V8 at deep recursion + queryselector with
 * attribute-matches selectors) and could leave the entries spinner
 * stuck on "Loading Entries…" indefinitely. The injection was
 * redundant — admin/index.html ships a fixed-position
 * `#live-preview-link` button that does the same job, and no e2e
 * spec or admin script references the injected
 * `[data-adamdaniel-live-preview]` anchor.
 */
(function () {
  "use strict";

  var CHANNEL_NAME = "adamdaniel-cms-preview";
  var REQUEST_TYPE = "cms-preview-request";
  // The collection names a /preview/ request may carry; anything else is
  // dropped unanswered (buildPreviewURL strips to the same characters).
  var COLLECTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
  var CMS_READY_TIMEOUT_MS = 30_000;
  var CMS_POLL_INTERVAL_MS = 100;

  var channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (_) {
    // Very old browser — no live preview, but don't break the admin.
  }

  function buildPreviewURL(collection) {
    var safe = String(collection || "posts").replace(/[^a-zA-Z0-9_-]/g, "");
    // Live Preview shares this tab's BroadcastChannel, which is same-origin;
    // its origin must stay here even when publication goes somewhere else.
    return window.location.origin + "/preview/?collection=" + encodeURIComponent(safe);
  }
  window.adamdaniel_cms_preview_url = buildPreviewURL;

  function readEntry(entry) {
    if (!entry) return null;

    // Decap passes Immutable.js records with `get()` / `toJS()`; our
    // test harness passes plain objects with the same shape. Handle both.
    var dataHolder = typeof entry.get === "function" ? entry.get("data") : entry.data;
    var fields =
      dataHolder && typeof dataHolder.toJS === "function" ? dataHolder.toJS() : dataHolder || {};

    var collection =
      (typeof entry.get === "function" ? entry.get("collection") : entry.collection) || null;

    // The entry's slug names its editorial branch (`cms/<collection>/<slug>`),
    // which /preview/ needs to fetch a not-yet-published upload through
    // draft-media-fallback.js. postSave fires after the save, so it exists.
    var slug = (typeof entry.get === "function" ? entry.get("slug") : entry.slug) || null;

    return { collection: collection, slug: slug, fields: fields };
  }

  function post(payload) {
    channel.postMessage({
      type: "cms-preview-update",
      collection: payload.collection,
      slug: payload.slug,
      fields: payload.fields,
    });
  }

  // The slug of the entry the editor route names, when it is `collection`'s.
  function slugFromRoute(collection) {
    var m = /^#\/collections\/([^/?#]+)\/entries\/([^?#]+)/.exec(window.location.hash || "");
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]) === collection ? decodeURIComponent(m[2]) : null;
    } catch (_) {
      return null;
    }
  }

  // This tab's last save, for a request the preview pane cannot answer.
  var lastSave = null;

  function broadcast(entry) {
    if (!channel) return;
    var payload = readEntry(entry);
    if (!payload) return;
    lastSave = payload;
    post(payload);
    if (payload.slug || !payload.collection) return;
    // A NEW entry's postSave carries an empty slug: Decap computes it inside
    // backend.persistEntry, after reading the entry it hands this event.
    // It then replaces the route with #/collections/<c>/entries/<slug>
    // (routing/history.ts navigateToEntry), so the next route change names
    // it; re-send the same save once with that slug. Any other first route
    // change (the editor left) sends nothing.
    var onRoute = function () {
      window.removeEventListener("hashchange", onRoute);
      var slug = slugFromRoute(payload.collection);
      if (!slug) return;
      var named = { collection: payload.collection, slug: slug, fields: payload.fields };
      if (lastSave === payload) lastSave = named;
      post(named);
    };
    window.addEventListener("hashchange", onRoute);
  }

  // ── /preview/ asks for the entry on load (#646) ──────────────────────

  // The entry editor the route names: { collection, slug }, slug null on
  // `#/collections/<c>/new`. Null on any other route.
  function editorRoute() {
    var m = /^#\/collections\/([^/?#]+)\/(?:entries\/([^?#]+)|new(?:[?#]|$))/.exec(
      window.location.hash || "",
    );
    if (!m) return null;
    try {
      return { collection: decodeURIComponent(m[1]), slug: m[2] ? decodeURIComponent(m[2]) : null };
    } catch (_) {
      return null;
    }
  }

  function isTrustedOrigin(origin) {
    // Some engines leave a same-document message's origin empty; a
    // BroadcastChannel cannot carry another origin's message at all.
    return origin === window.location.origin || origin === "";
  }

  // The collection a well-formed request from this origin asks for, or null.
  function requestedCollection(event) {
    if (!event || !isTrustedOrigin(event.origin)) return null;
    var data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    if (data.type !== REQUEST_TYPE) return null;
    if (typeof data.collection !== "string" || !COLLECTION_NAME.test(data.collection)) return null;
    return data.collection;
  }

  // A payload is the route's entry when its collection matches and its slug
  // is the route's (an unsaved new entry has none yet, on either side).
  function matchesRoute(payload, route) {
    if (!payload || payload.collection !== route.collection) return false;
    if (!payload.fields || typeof payload.fields !== "object") return false;
    return route.slug ? payload.slug === route.slug : !payload.slug;
  }

  // The entry open in this editor for `collection`, in the broadcast shape.
  function currentEntry(collection) {
    var route = editorRoute();
    if (!route || route.collection !== collection) return null;
    var pane = window.adamdaniel_cms_preview_pane;
    var snapshot = pane && typeof pane.current === "function" ? pane.current() : null;
    if (snapshot && snapshot.collection === collection) {
      var drawn = readEntry(snapshot.entry);
      if (drawn) {
        drawn.collection = drawn.collection || collection;
        if (matchesRoute(drawn, route)) return drawn;
      }
    }
    return matchesRoute(lastSave, route) ? lastSave : null;
  }

  function answer(event) {
    var collection = requestedCollection(event);
    if (!collection) return;
    var payload = currentEntry(collection);
    if (!payload) return;
    try {
      post(payload);
    } catch (_) {
      // A field value the channel cannot clone: no reply; Save still works.
    }
  }

  if (channel && typeof channel.addEventListener === "function") {
    channel.addEventListener("message", answer);
  }

  function registerWithCMS(CMS) {
    if (!CMS || typeof CMS.registerEventListener !== "function") return false;
    CMS.registerEventListener({
      name: "postSave",
      handler: function (event) {
        broadcast(event && event.entry);
      },
    });
    return true;
  }

  function waitForCMS() {
    var start = Date.now();
    var tick = function () {
      if (registerWithCMS(window.CMS)) return;
      if (Date.now() - start > CMS_READY_TIMEOUT_MS) {
        // Give up silently. The admin still works; only live preview is lost.
        return;
      }
      setTimeout(tick, CMS_POLL_INTERVAL_MS);
    };
    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForCMS);
  } else {
    waitForCMS();
  }
})();
