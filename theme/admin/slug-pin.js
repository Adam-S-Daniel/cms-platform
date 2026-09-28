/*
 * admin/slug-pin.js — write a post's address down the first time it is saved,
 * so editing the title later cannot move it.
 *
 * ── The defect (adamdaniel.ai#3857) ────────────────────────────────────
 * A post is served at `/blog/<slug>/`. Jekyll takes <slug> from the front-
 * matter `slug:` when it is set, and otherwise from the FILE NAME. Decap names
 * the file from the title at the first save and never renames it afterwards.
 * With URL Slug left blank — which its hint invited — a title edited after
 * that first save left the page at its old, file-name address while every
 * admin surface (live-url-derive.js's banner, Live Preview) and the required
 * cms-preview-url / console-clean checks derived the address from the NEW
 * title. Those checks 404'd and the publish stopped with "One of the automatic
 * safety checks did not pass", on a post with nothing wrong with it.
 *
 * ── The fix ────────────────────────────────────────────────────────────
 * On Decap's public `preSave` event, fill an EMPTY URL Slug on a post:
 *
 *   - a NEW post: from its title. Decap's preSave runs BEFORE the new file is
 *     named (backend persistEntry → invokePreSaveEvent → generateUniqueSlug,
 *     verified in the decap-cms@3.15.1 bundle), and the address comes from the
 *     front-matter slug regardless of the file name, so this is the address
 *     the post will have.
 *   - an EXISTING post: from its FILE NAME minus the `YYYY-MM-DD-` prefix —
 *     the address Jekyll is serving it at right now. Never from the title,
 *     which is exactly the thing that may have changed since.
 *
 * A slug the editor typed is never touched. Once written, the slug is the
 * address: the banner, the checks and Jekyll all read it first.
 *
 * ── Why the slugify is borrowed ────────────────────────────────────────
 * window.LiveURL.slugify (live-url-derive.js) is the browser copy of Jekyll's
 * default slugify that slugify-parity.test.js locks against the Node copy and
 * a canonical table. A third copy here would be a third thing to drift. It is
 * read at SAVE time, not at load, so script order cannot break it; if it is
 * missing the shim does nothing, and the editor gets the old behaviour rather
 * than a Save that throws.
 *
 * ── Scope ──────────────────────────────────────────────────────────────
 * `posts` only: it is the one base collection whose address comes from a
 * `slug` FIELD with a file-name fallback. The `e2e` canary collection also has
 * a slug field, but its specs control that field themselves.
 *
 * Only the public `window.CMS.registerEventListener` API — no Decap internal
 * state. `registerEventListener` rejects unknown event names by throwing, so
 * registration is wrapped: a future Decap without `preSave` leaves this inert.
 * The handler itself never throws; any surprise returns `undefined`, which
 * Decap reads as "no change" and saves the entry as typed.
 *
 * Tested in e2e/slug-pin.test.js (vm sandbox, the real live-url-derive.js).
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__slugPinInstalled) return;
  window.__slugPinInstalled = true;

  var COLLECTIONS = { posts: true };
  var DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
  var CMS_POLL_MS = 100;

  function slugify(s) {
    var L = window.LiveURL;
    if (!L || typeof L.slugify !== "function") return null;
    return L.slugify(s) || null;
  }

  // The slug to write, or null to leave the entry as the editor typed it.
  function pinnedSlug(entry) {
    if (!entry || typeof entry.get !== "function") return null;
    if (!COLLECTIONS[entry.get("collection")]) return null;
    var data = entry.get("data");
    if (!data || typeof data.get !== "function" || typeof data.set !== "function") return null;
    var current = data.get("slug");
    if (current != null && String(current).trim() !== "") return null;
    var source = entry.get("newRecord")
      ? data.get("title")
      : String(entry.get("slug") || "").replace(DATE_PREFIX, "");
    return source ? slugify(String(source)) : null;
  }

  function onPreSave(payload) {
    try {
      var entry = payload && payload.entry;
      var slug = pinnedSlug(entry);
      if (!slug) return undefined;
      return entry.get("data").set("slug", slug);
    } catch (e) {
      return undefined;
    }
  }

  function register(CMS) {
    try {
      CMS.registerEventListener({ name: "preSave", handler: onPreSave });
    } catch (e) {
      /* unknown event name on a future Decap release — stays inert */
    }
  }

  window.__slugPin = { pinnedSlug: pinnedSlug, onPreSave: onPreSave, slugify: slugify };

  var pollId = setInterval(function () {
    if (window.CMS && typeof window.CMS.registerEventListener === "function") {
      clearInterval(pollId);
      register(window.CMS);
    }
  }, CMS_POLL_MS);
})();
