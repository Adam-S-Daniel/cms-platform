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
 *   - an EXISTING post: from its FILE NAME minus the `YYYY-MM-DD-` prefix,
 *     VERBATIM — the value theme/lib/cms-platform-theme/normalize_empty_slug.rb
 *     already gives Jekyll for an empty slug, so it is the address the page is
 *     served at right now. Never from the title, which is exactly the thing
 *     that may have changed since.
 *
 * A slug the editor typed is never touched. Once written, the slug is the
 * address: the banner, the checks and Jekyll all read it first.
 *
 * Two guards against giving a NEW post someone else's address (both found in
 * adversarial review):
 *   - Duplicate. Decap's Duplicate copies every field, the pinned slug
 *     included, into a new record on the plain `/new` route, with no marker.
 *     So on a new post a non-empty slug is kept only if the editor TYPED into
 *     URL Slug on this screen; otherwise it is re-derived from the title.
 *   - A taken address. One HEAD request for `/blog/<slug>/` on this site; if a
 *     page is already there (a same-title post — which Decap's `-1` file
 *     suffix used to keep apart on the same day), nothing is pinned and the
 *     post behaves exactly as it did before this shim. The probe gives up
 *     after 3 s and any failure reads as "free", so Save never waits on it.
 *
 * ── Why the slugify is borrowed ────────────────────────────────────────
 * window.LiveURL.slugify (live-url-derive.js) is the browser copy of Jekyll's
 * default slugify that slugify-parity.test.js locks against the Node copy and
 * a canonical table. A third copy here would be a third thing to drift. It is
 * read at SAVE time, not at load, so script order cannot break it; if it is
 * missing the shim does nothing, and the editor gets the old behavior rather
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

  // Which screen (Decap hash route) the editor last typed into URL Slug on.
  // Decap's Duplicate copies EVERY field — the pinned slug included — into a
  // new record on the plain `/new` route, with no marker; keeping that slug
  // would put the copy at the original's address. So on a NEW post a
  // non-empty slug is kept only if the editor typed it on this screen.
  var typedOn = null;

  function slugFieldTyped() {
    return typedOn !== null && typedOn === (window.location && window.location.hash);
  }

  // The slug to write, "keep" to leave the entry as it is, or null for
  // nothing derivable. Pure given the entry and whether the field was typed.
  function pinnedSlug(entry, typed) {
    if (!entry || typeof entry.get !== "function") return null;
    if (!COLLECTIONS[entry.get("collection")]) return null;
    var data = entry.get("data");
    if (!data || typeof data.get !== "function" || typeof data.set !== "function") return null;
    var current = data.get("slug");
    var hasSlug = current != null && String(current).trim() !== "";
    if (entry.get("newRecord")) {
      if (hasSlug && typed) return null;
      var title = data.get("title");
      var fromTitle = title ? slugify(String(title)) : null;
      return fromTitle && fromTitle !== current ? fromTitle : null;
    }
    if (hasSlug) return null;
    // VERBATIM, not re-slugified: this is exactly the value
    // normalize_empty_slug.rb hands Jekyll for an empty slug, so the served
    // address cannot change. Decap's default `unicode` slug encoding keeps
    // accented letters in file names (`…-café-notes`); an ASCII slugify would
    // turn that into `caf-notes` and move a live page on its next save.
    var fromFile = String(entry.get("slug") || "").replace(DATE_PREFIX, "").trim();
    return fromFile || null;
  }

  // Is `/blog/<slug>/` already a page on this site? A same-title post (or any
  // post whose address this title would take) would otherwise be overwritten
  // in the build — before this shim, Decap's `-1` file suffix kept same-day
  // twins apart. Any failure, or no answer within PROBE_MS, reads as "free":
  // Save must never wait on this.
  var PROBE_MS = 3000;
  function addressTaken(slug) {
    if (typeof fetch !== "function" || !window.location || !window.location.origin) {
      return Promise.resolve(false);
    }
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, PROBE_MS);
    // The editor tab's origin is intentional: a cross-origin HEAD response may
    // be blocked by CORS, which would silently treat an occupied address as free.
    var probe = fetch(window.location.origin + "/blog/" + encodeURIComponent(slug) + "/", {
      method: "HEAD",
      cache: "no-store",
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (res) {
        return Boolean(res && res.ok);
      })
      .catch(function () {
        return false;
      });
    return probe.then(function (taken) {
      clearTimeout(timer);
      return taken;
    });
  }

  async function onPreSave(payload) {
    try {
      var entry = payload && payload.entry;
      var slug = pinnedSlug(entry, slugFieldTyped());
      if (!slug) return undefined;
      if (entry.get("newRecord") && (await addressTaken(slug))) return undefined;
      return entry.get("data").set("slug", slug);
    } catch (e) {
      return undefined;
    }
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener(
      "input",
      function (ev) {
        var id = ev && ev.target && ev.target.id;
        if (typeof id === "string" && id.indexOf("slug-field") === 0) typedOn = window.location.hash;
      },
      true,
    );
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
