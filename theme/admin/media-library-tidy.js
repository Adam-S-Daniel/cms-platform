/*
 * admin/media-library-tidy.js — EDITOR SHELLS ONLY (index.html + index-local.html).
 * Two small Decap media-library rough edges (#736), both in Decap core with no
 * config lever, fixed from outside it.
 *
 * ── 1. An upload's file name gets a dangling hyphen ────────────────────
 * `Workshop Diagram (final).jpg` was stored as `workshop-diagram-final-.jpg`.
 * Decap's `persistMedia` (decap-cms-core 3.15.1, actions/mediaLibrary) names
 * the file `sanitizeSlug(file.name.toLowerCase(), config.slug)`. sanitizeSlug
 * turns every character a URL cannot hold into the replacement ("-"), then
 * trims a leading or trailing replacement — but off the WHOLE string, and the
 * string still ends in ".jpg". The `)` before the dot became a "-" the trim
 * never sees. `slug:` options cannot help: `sanitize_replacement: ""` would
 * delete the word-separating hyphens too, and the same options also name every
 * post file.
 *
 * So the base name is trimmed here, before Decap reads it: leading and
 * trailing characters that are not a letter, mark or digit are dropped from
 * everything before the LAST dot (`Workshop Diagram (final)` -> `Workshop
 * Diagram (final`), and Decap's own sanitizer then produces
 * `workshop-diagram-final.jpg`. The extension is untouched. A name that would
 * be left empty (`(1).`, `---.png`) is passed through unchanged.
 *
 * HOW. The File objects the editor picks are renamed IN PLACE: an own `name`
 * property is defined on each File (the real one is a prototype getter). That
 * keeps the File identity — draft-media-fallback.js remembers uploads by File
 * and matches them to the stored name with its mirror of Decap's transform, so
 * it sees the same name Decap stores. Two capture-phase listeners on `document`
 * cover both ways the library takes a file, the Upload button (`change` on an
 * `<input type=file>`) and a drop (`drop`); they run before React's root
 * listeners, so Decap's `handlePersist` reads the renamed File. Nothing is
 * stopped, replaced or re-dispatched.
 *
 * ── 2. `.gitkeep` shows as an asset ────────────────────────────────────
 * An empty media folder is kept in git by a `.gitkeep`, and Decap lists every
 * blob in the folder, so the library shows it as a tile next to the real
 * images. The listing is trimmed to drop dotfiles instead of hiding the tile:
 * the library is a virtualized grid, so a hidden tile would leave a blank cell
 * where it was. Two transports carry the listing, and both are filtered in a
 * `window.fetch` wrap (non-deferred, loaded BEFORE decap-cms.js, the
 * publish-via-auto-merge.js idiom):
 *   - the GitHub backend: `GET <repo>/git/trees/<ref>:<dir>` (non-recursive),
 *     whose `tree[]` entries carry the file's path;
 *   - decap-server (index-local.html): a POST whose JSON body is
 *     `{"action":"getMedia",...}`, answered with an array of files.
 * Every other request goes straight through with the caller's own arguments
 * (publish-via-auto-merge.js documents why Safari needs that), and a response
 * this cannot parse is returned as it came. A folder listing in a collection
 * loses its dotfiles too, which is harmless: no entry is a dotfile.
 *
 * ── Not here: the image a deleted entry leaves behind ──────────────────
 * Deliberately not fixed. An upload is shared state, not part of an entry:
 * the same file can be a featured image on two posts, a body image, a site
 * hero or a Site Settings logo, and Decap has no reference index. Deleting
 * "the entry's images" on delete would break any other page that uses one.
 * See docs/ADMIN-DELIVERY.md § "Media library tidy".
 *
 * The pure helpers are exposed on `window.CMSMediaTidy` for
 * e2e/media-library-tidy.test.js, which runs them in a vm sandbox.
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__mediaLibraryTidyInstalled) return;
  window.__mediaLibraryTidyInstalled = true;

  var api = (window.CMSMediaTidy = window.CMSMediaTidy || {});

  // A character that is not a letter, a combining mark or a digit.
  var EDGE = /^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu;

  // `name` with the junk trimmed off both ends of the part before its last
  // dot. A dotfile (".gitkeep") is returned as it is.
  function tidyUploadName(name) {
    if (typeof name !== "string" || name.charAt(0) === ".") return name;
    var dot = name.lastIndexOf(".");
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : "";
    var tidy = base.replace(EDGE, "");
    return tidy ? tidy + ext : name;
  }

  // True for a file the library should not list: a dotfile.
  function isHiddenMediaName(name) {
    return typeof name === "string" && name.charAt(0) === ".";
  }

  function basename(path) {
    var s = String(path == null ? "" : path);
    return s.slice(s.lastIndexOf("/") + 1);
  }

  // A GitHub git-trees response with its dotfile blobs removed, or the input
  // itself when it is not a tree listing.
  function filterTree(body) {
    if (!body || !Array.isArray(body.tree)) return body;
    var out = {};
    Object.keys(body).forEach(function (k) {
      out[k] = body[k];
    });
    out.tree = body.tree.filter(function (e) {
      return !(e && e.type === "blob" && isHiddenMediaName(basename(e.path)));
    });
    return out;
  }

  // A decap-server getMedia response with its dotfiles removed.
  function filterLocalMedia(body) {
    if (!Array.isArray(body)) return body;
    return body.filter(function (f) {
      return !(f && isHiddenMediaName(f.name || basename(f.path)));
    });
  }

  // `GET .../git/trees/<ref>:<dir>`: a directory listing (the ref may hold
  // slashes; a plain tree SHA has no colon and never matches).
  function isTreeListingURL(url, method) {
    if (method !== "GET") return false;
    var path;
    try {
      path = decodeURIComponent(new URL(url, "http://x.invalid").pathname);
    } catch (e) {
      return false;
    }
    return /\/git\/trees\/[^:]+:[^:]+$/.test(path);
  }

  function isLocalGetMedia(method, body) {
    if (method !== "POST" || typeof body !== "string" || body.indexOf("getMedia") === -1) return false;
    try {
      var parsed = JSON.parse(body);
      return !!parsed && parsed.action === "getMedia";
    } catch (e) {
      return false;
    }
  }

  api.tidyUploadName = tidyUploadName;
  api.isHiddenMediaName = isHiddenMediaName;
  api.filterTree = filterTree;
  api.filterLocalMedia = filterLocalMedia;
  api.isTreeListingURL = isTreeListingURL;
  api.isLocalGetMedia = isLocalGetMedia;

  // ── 1. rename the picked files ────────────────────────────────────────
  function renameFiles(list) {
    if (!list) return;
    for (var i = 0; i < list.length; i += 1) {
      var file = list[i];
      if (!file || typeof file.name !== "string") continue;
      var tidy = tidyUploadName(file.name);
      if (tidy === file.name) continue;
      try {
        Object.defineProperty(file, "name", { value: tidy, configurable: true });
      } catch (e) {
        /* a frozen File: leave the name alone */
      }
    }
  }
  api.renameFiles = renameFiles;

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener(
      "change",
      function (e) {
        var t = e && e.target;
        if (t && t.type === "file") renameFiles(t.files);
      },
      true,
    );
    document.addEventListener(
      "drop",
      function (e) {
        if (e && e.dataTransfer) renameFiles(e.dataTransfer.files);
      },
      true,
    );
  }

  // ── 2. trim dotfiles out of the media listing ─────────────────────────
  function rewrite(res, filter) {
    return res
      .clone()
      .json()
      .then(
        function (body) {
          var headers = new Headers(res.headers);
          headers.delete("content-length");
          headers.delete("content-encoding");
          return new Response(JSON.stringify(filter(body)), {
            status: res.status,
            statusText: res.statusText,
            headers: headers,
          });
        },
        function () {
          return res;
        },
      );
  }

  if (typeof window.fetch === "function") {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var filter = null;
      if (isTreeListingURL(url, method)) filter = filterTree;
      else if (isLocalGetMedia(method, init && init.body)) filter = filterLocalMedia;
      // Transparent for everything else: the caller's own arguments.
      if (!filter) return origFetch.call(this, input, init);
      return origFetch.call(this, input, init).then(function (res) {
        return res && res.ok ? rewrite(res, filter) : res;
      });
    };
  }
})();
