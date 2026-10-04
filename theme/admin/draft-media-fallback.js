/*
 * draft-media-fallback.js — shows an editor's not-yet-published uploads
 * instead of a broken image, in the Decap editor and on Live Preview.
 *
 * ── The defect ────────────────────────────────────────────────────────
 * config.base.yml sets `public_folder: /assets/images/uploads` (a flat,
 * absolute path; a documented, test-enforced content contract — see the
 * comment above it and e2e/cms-config.spec.js). Decap's `isAbsolutePath`
 * (decap-cms-lib-util: `/^(?:[a-z]+:)?\/\/|^\//i`) treats any value starting
 * with `/` as absolute, so `getAsset` hands that path back untouched and
 * Decap renders `<img src="/assets/images/uploads/x.jpeg">` against the
 * admin's own origin, skipping the draft blob it holds in memory. Production
 * does not have the file until the post publishes, so the widget thumbnail
 * and the preview pane show a broken image right after an upload (reproduced
 * live 2026-10-04: both imgs 404 while a `blob:` URL for the file existed).
 * /preview/ renders the raw field value and marked's raw body srcs, so it
 * breaks the same way.
 *
 * ── What this does ────────────────────────────────────────────────────
 * It waits for an image to FAIL, then retries it once from where the draft
 * really is. Nothing is rewritten up front, so a published image never pays
 * for this.
 *
 *   - A capture-phase `error` listener on `document` (an <img> error does
 *     not bubble, but it is capturable). Decap's preview pane is a
 *     same-origin srcdoc iframe; a capture-phase `load` listener on
 *     `document` (iframe loads are capturable too) attaches the same
 *     listener to each iframe's contentDocument, again on every load since
 *     a load can replace the document. A cross-origin frame is skipped.
 *     There is deliberately no MutationObserver walking the DOM: see the
 *     Safari performance postmortem in preview-bridge.js's header.
 *   - Only an <img> whose src is same-origin and whose path starts with the
 *     served config's `public_folder` + "/" is touched, and each image is
 *     retried at most once per distinct original src (the
 *     `data-draft-media-fallback` attribute records it), so it cannot loop;
 *     retry() grants one more attempt, which /preview/ uses once per Save.
 *
 * ── Where the bytes come from, in order ───────────────────────────────
 *   1. A File this tab just uploaded. Decap's AssetProxy calls
 *      `URL.createObjectURL(file)` for every upload, so this file wraps
 *      createObjectURL (hence it loads NON-deferred, BEFORE decap-cms.js, the
 *      publish-via-auto-merge.js idiom) and remembers each File. A File
 *      matches when its name, put through Decap's own upload-name transform
 *      (persistMedia: `sanitizeSlug(file.name.toLowerCase(), config.slug)`,
 *      mirrored by normalizeUploadName below), equals the image's basename.
 *      This is the only source for an entry that has never been saved.
 *   2. The entry's editorial branch, through the GitHub Contents API with
 *      the token Decap itself stores (`localStorage["decap-cms-user"]`).
 *      The branch is Decap's `cms/<collection>/<slug>` (decap-cms-lib-util
 *      `branchFromContentKey(generateContentKey(collection, slug))`), from
 *      the editor route `#/collections/<c>/entries/<slug>`, or from
 *      setEntry() on /preview/, which has no such route. A 404 there falls
 *      back to the config's `backend.branch`. GitHub-backend only; a
 *      local_backend config never reaches GitHub.
 * The admin CSP already allows `connect-src https://api.github.com` and
 * `img-src blob:` (infrastructure/bootstrap/template.yaml), so nothing here
 * widens it. Every failure (no token, no route, a failed read) is silent
 * apart from a console.debug line, and the token is never logged.
 *
 * ── Known gaps in the name match ──────────────────────────────────────
 * `slug.clean_accents: true` strips accents with Unicode NFD here, where
 * Decap uses the `diacritics` map; they differ on letters NFD does not
 * decompose (ø, ß, æ, ł…), and such an upload falls through to source 2.
 * A per-collection or per-field `public_folder` override is not read; this
 * platform's configs set only the top-level one.
 *
 * Exposed as window.CMSDraftMedia: the pure helpers (unit-tested in
 * e2e/draft-media-fallback.test.js), plus setEntry() and retry() for
 * /preview/.
 */
(function () {
  "use strict";

  var ATTR = "data-draft-media-fallback";
  var DEFAULT_CONFIG_FILE = "config.yml";
  var GITHUB_API = "https://api.github.com";
  var BRANCH_PREFIX = "cms";
  var MAX_REMEMBERED_FILES = 50;
  var REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  var NAME_PART = /^[A-Za-z0-9_.-]+$/;

  // ── Pure helpers ─────────────────────────────────────────────────────

  // One YAML scalar, as the line-level config read below meets it: quotes
  // removed, a trailing comment dropped, empty → null.
  function scalar(raw) {
    var s = String(raw == null ? "" : raw).trim();
    var quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(s);
    if (quoted) return quoted[2];
    s = s.replace(/(^|\s)#.*$/, "").trim();
    return s === "" ? null : s;
  }

  // Lexical read of the top-level leaves this file needs from the served
  // config (the same posture as site-hostname.js's parseServedConfig; no
  // YAML parser is exposed in the admin). Top-level keys sit at column 0,
  // `backend:` and `slug:` children at two spaces; anything deeper (a
  // collection's own keys) is ignored.
  function parseConfig(text) {
    var out = {
      publicFolder: null,
      mediaFolder: null,
      backendName: null,
      repo: null,
      branch: null,
      localBackend: false,
      slug: {},
    };
    var section = null;
    String(text || "")
      .split(/\r?\n/)
      .forEach(function (line) {
        if (/^\s*(#|$)/.test(line)) return;
        var top = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
        if (top) {
          section = top[1];
          var value = scalar(top[2]);
          if (section === "public_folder") out.publicFolder = value;
          else if (section === "media_folder") out.mediaFolder = value;
          else if (section === "local_backend") out.localBackend = value === "true";
          return;
        }
        var child = /^ {2}([A-Za-z_][\w-]*):(.*)$/.exec(line);
        if (!child) return;
        var key = child[1];
        var v = scalar(child[2]);
        if (section === "backend") {
          if (key === "name") out.backendName = v;
          else if (key === "repo") out.repo = v;
          else if (key === "branch") out.branch = v;
        } else if (section === "slug") {
          if (key === "encoding") out.slug.encoding = v;
          else if (key === "clean_accents") out.slug.clean_accents = v === "true";
          // An explicit empty replacement is meaningful (characters dropped).
          else if (key === "sanitize_replacement") out.slug.sanitize_replacement = v === null ? "" : v;
        }
      });
    return out;
  }

  // The basename an <img> src asks for under public_folder, or null when the
  // src is not a same-origin upload path.
  function uploadBasename(src, origin, publicFolder) {
    if (!src || !publicFolder) return null;
    var url;
    try {
      url = new URL(String(src), origin);
    } catch (e) {
      return null;
    }
    if (url.origin !== origin) return null;
    var prefix = "/" + String(publicFolder).replace(/^\/+|\/+$/g, "") + "/";
    if (url.pathname.indexOf(prefix) !== 0) return null;
    var rest = url.pathname.slice(prefix.length);
    if (!rest || rest.indexOf("/") !== -1) return null;
    try {
      return decodeURIComponent(rest);
    } catch (e) {
      return null;
    }
  }

  // Decap's urlHelper character classes (decap-cms-core lib/urlHelper.ts).
  var URI_CHARS = /[\w\-.~]/i;
  var UCS_CHARS =
    /[\xA0-\u{D7FF}\u{F900}-\u{FDCF}\u{FDF0}-\u{FFEF}\u{10000}-\u{1FFFD}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}\u{40000}-\u{4FFFD}\u{50000}-\u{5FFFD}\u{60000}-\u{6FFFD}\u{70000}-\u{7FFFD}\u{80000}-\u{8FFFD}\u{90000}-\u{9FFFD}\u{A0000}-\u{AFFFD}\u{B0000}-\u{BFFFD}\u{C0000}-\u{CFFFD}\u{D0000}-\u{DFFFD}\u{E1000}-\u{EFFFD}]/u;

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function utf8Length(ch) {
    var c = ch.codePointAt(0);
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }

  // The `sanitize-filename` package Decap applies after sanitizeURI.
  function sanitizeFilename(input, replacement) {
    var s = input
      .replace(/[\/\?<>\\:\*\|"]/g, replacement)
      .replace(/[\x00-\x1f\x80-\x9f]/g, replacement)
      .replace(/^\.+$/, replacement)
      .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, replacement)
      .replace(/[\. ]+$/, replacement);
    var bytes = 0;
    var out = "";
    var chars = Array.from(s);
    for (var i = 0; i < chars.length; i += 1) {
      bytes += utf8Length(chars[i]);
      if (bytes > 255) break;
      out += chars[i];
    }
    return out;
  }

  // The name Decap stores an upload under: persistMedia's
  // `sanitizeSlug(file.name.toLowerCase(), config.slug)` with Decap's slug
  // defaults (encoding unicode, clean_accents false, replacement "-").
  function normalizeUploadName(name, slugOptions) {
    var opts = slugOptions || {};
    var encoding = opts.encoding === "ascii" ? "ascii" : "unicode";
    var replacement = typeof opts.sanitize_replacement === "string" ? opts.sanitize_replacement : "-";
    var s = String(name == null ? "" : name).toLowerCase();
    if (opts.clean_accents) s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    s = Array.from(s)
      .map(function (ch) {
        var ok = URI_CHARS.test(ch) || (encoding === "unicode" && UCS_CHARS.test(ch));
        return ok ? ch : replacement;
      })
      .join("");
    s = sanitizeFilename(s, replacement);
    if (replacement !== "") {
      var r = escapeRegExp(replacement);
      s = s
        .replace(new RegExp("(?:" + r + ")+", "g"), replacement)
        .replace(new RegExp("^" + r), "")
        .replace(new RegExp(r + "$"), "");
    }
    return s;
  }

  // { collection, slug } from Decap's editor route, else null.
  function entryFromHash(hash) {
    var m = /^#\/collections\/([^/?#]+)\/entries\/([^?#]+)/.exec(String(hash || ""));
    if (!m) return null;
    try {
      return validEntry({
        collection: decodeURIComponent(m[1]),
        slug: m[2].split("/").map(decodeURIComponent).join("/"),
      });
    } catch (e) {
      return null;
    }
  }

  function validEntry(entry) {
    if (!entry) return null;
    var collection = String(entry.collection || "");
    var slug = String(entry.slug || "");
    if (!NAME_PART.test(collection) || !slug) return null;
    if (/[\x00-\x20\x7f\\]/.test(slug)) return null;
    if (slug.split("/").some(function (p) { return p === "" || p === "." || p === ".."; })) return null;
    return { collection: collection, slug: slug };
  }

  // Decap's editorial branch for an entry: `cms/<collection>/<slug>`.
  function editorialBranch(entry) {
    var e = validEntry(entry);
    return e ? BRANCH_PREFIX + "/" + e.collection + "/" + e.slug : null;
  }

  // GET URL for one upload on one ref, or null when an input is malformed.
  function contentsURL(repo, mediaFolder, name, ref) {
    if (!REPO_SHAPE.test(String(repo || "")) || !name || !ref) return null;
    var folder = String(mediaFolder || "").replace(/^\/+|\/+$/g, "");
    var parts = folder ? folder.split("/") : [];
    parts.push(String(name));
    if (parts.some(function (p) { return p === "" || p === "." || p === ".."; })) return null;
    return (
      GITHUB_API +
      "/repos/" +
      repo +
      "/contents/" +
      parts.map(encodeURIComponent).join("/") +
      "?ref=" +
      encodeURIComponent(ref)
    );
  }

  var IMAGE_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
  };

  // The image media type for a file name, by extension; "" when unknown.
  function imageType(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
    return (m && IMAGE_TYPES[m[1].toLowerCase()]) || "";
  }

  var api = {
    parseConfig: parseConfig,
    imageType: imageType,
    uploadBasename: uploadBasename,
    normalizeUploadName: normalizeUploadName,
    entryFromHash: entryFromHash,
    editorialBranch: editorialBranch,
    contentsURL: contentsURL,
  };
  if (typeof window !== "undefined") window.CMSDraftMedia = api;

  // ── Runtime ──────────────────────────────────────────────────────────
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (typeof document.addEventListener !== "function") return;
  if (window.__draftMediaFallbackInstalled) return;
  window.__draftMediaFallbackInstalled = true;

  function debug(msg) {
    try {
      console.debug("[draft-media-fallback] " + msg);
    } catch (e) {
      /* no console */
    }
  }

  // Captured before the wrap so our own blob URLs are not recorded.
  var URLs = window.URL;
  var originalCreate =
    URLs && typeof URLs.createObjectURL === "function" ? URLs.createObjectURL.bind(URLs) : null;
  var files = [];

  if (originalCreate) {
    URLs.createObjectURL = function (obj) {
      var url = originalCreate.apply(null, arguments);
      try {
        if (typeof File === "function" && obj instanceof File && obj.name) {
          files.push(obj);
          if (files.length > MAX_REMEMBERED_FILES) files.shift();
        }
      } catch (e) {
        /* recording is best effort */
      }
      return url;
    };
  }

  // The config this page's Decap reads: a shell's cms-config-url link, else
  // config.yml beside THIS script (it lives in /admin/, so the same path
  // works from /preview/).
  function configURL() {
    var link = document.querySelector && document.querySelector('link[rel="cms-config-url"]');
    if (link && link.getAttribute("href")) return new URL(link.getAttribute("href"), document.baseURI).href;
    var script = document.currentScript;
    var base = (script && script.src) || document.baseURI || window.location.href;
    return new URL(DEFAULT_CONFIG_FILE, base).href;
  }

  var config = null;
  try {
    config = fetch(configURL(), { cache: "no-cache" })
      .then(function (res) {
        return res && res.ok ? res.text() : null;
      })
      .then(function (text) {
        return text === null ? null : parseConfig(text);
      })
      .catch(function () {
        return null;
      });
  } catch (e) {
    config = Promise.resolve(null);
  }

  var entryOverride = null;
  function setEntry(entry) {
    entryOverride = validEntry(entry);
  }
  api.setEntry = setEntry;

  function token() {
    try {
      var user = JSON.parse(window.localStorage.getItem("decap-cms-user") || "null");
      return user && typeof user.token === "string" && user.token ? user.token : null;
    } catch (e) {
      return null;
    }
  }

  var fileURLs = typeof WeakMap === "function" ? new WeakMap() : null;

  function fromUploadedFile(basename, cfg) {
    for (var i = files.length - 1; i >= 0; i -= 1) {
      var file = files[i];
      if (normalizeUploadName(file.name, cfg.slug) !== basename) continue;
      var url = fileURLs && fileURLs.get(file);
      if (!url) {
        url = originalCreate(file);
        if (fileURLs) fileURLs.set(file, url);
      }
      return url;
    }
    return null;
  }

  // One read per upload and branch list, shared while in flight (the widget
  // and the preview pane fail together) and kept once it succeeds, so a
  // re-render does not refetch. A failure is dropped: the branch appears on
  // the first Save.
  var reads = {};

  function fromBranch(basename, cfg) {
    if (cfg.backendName !== "github" || cfg.localBackend) return Promise.resolve(null);
    var t = token();
    if (!t) {
      debug("no stored token; skipping the branch read");
      return Promise.resolve(null);
    }
    var repo = cfg.repo || window.CMS_REPO;
    var refs = [];
    var branch = editorialBranch(entryOverride || entryFromHash(window.location.hash));
    if (branch) refs.push(branch);
    if (cfg.branch && refs.indexOf(cfg.branch) === -1) refs.push(cfg.branch);

    function next(i) {
      if (i >= refs.length) return Promise.resolve(null);
      var url = contentsURL(repo, cfg.mediaFolder, basename, refs[i]);
      if (!url) return Promise.resolve(null);
      return fetch(url, {
        headers: {
          Authorization: "token " + t,
          Accept: "application/vnd.github.raw",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-cache",
      }).then(function (res) {
        if (res.status === 404) return next(i + 1);
        if (!res.ok) {
          debug("branch read HTTP " + res.status);
          return null;
        }
        return res.blob().then(function (blob) {
          // The raw media type answers `application/vnd.github.raw`; an SVG
          // renders in an <img> only under its own type, so retype by name.
          var typed = typeof Blob === "function" ? new Blob([blob], { type: imageType(basename) }) : blob;
          return originalCreate ? originalCreate(typed) : null;
        });
      });
    }
    var key = refs.concat(basename).join("\n");
    if (!reads[key]) {
      reads[key] = next(0)
        .catch(function () {
          debug("branch read failed");
          return null;
        })
        .then(function (url) {
          if (!url) delete reads[key];
          return url;
        });
    }
    return reads[key];
  }

  function onError(event) {
    var img = event && event.target;
    if (!img || img.tagName !== "IMG") return;
    var src = img.currentSrc || img.src || "";
    if (!src || src.indexOf("blob:") === 0) return;
    if (img.getAttribute(ATTR) === src) return;
    img.setAttribute(ATTR, src);
    config
      .then(function (cfg) {
        if (!cfg) return null;
        var basename = uploadBasename(src, window.location.origin, cfg.publicFolder);
        if (!basename) return null;
        return fromUploadedFile(basename, cfg) || fromBranch(basename, cfg);
      })
      .then(function (url) {
        // Leave it alone if the editor changed the image meanwhile.
        if (url && (img.currentSrc || img.src) === src) img.src = url;
      })
      .catch(function () {
        debug("could not resolve a draft image");
      });
  }

  // Give images under `root` that already failed (and are still broken) one
  // more attempt. /preview/ calls it after setEntry(): its featured image
  // keeps the same element and src across saves, so it raises no new error
  // once the entry (and so the branch) becomes known.
  function retry(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    Array.prototype.forEach.call(root.querySelectorAll("img[" + ATTR + "]"), function (img) {
      var src = img.currentSrc || img.src || "";
      if (img.getAttribute(ATTR) !== src || !img.complete || img.naturalWidth > 0) return;
      img.removeAttribute(ATTR);
      onError({ target: img });
    });
  }
  api.retry = retry;

  function watch(doc) {
    if (!doc || doc.__draftMediaFallback) return;
    try {
      doc.__draftMediaFallback = true;
      doc.addEventListener("error", onError, true);
      doc.addEventListener("load", onLoad, true);
    } catch (e) {
      /* a document we may not touch */
    }
  }

  function watchFrame(frame) {
    var doc = null;
    try {
      doc = frame.contentDocument;
    } catch (e) {
      return; // cross-origin
    }
    watch(doc);
  }

  // Each load can bring a new contentDocument, so re-check every time.
  function onLoad(event) {
    var target = event && event.target;
    if (target && target.tagName === "IFRAME") watchFrame(target);
  }

  watch(document);
  function watchExistingFrames() {
    Array.prototype.forEach.call(document.querySelectorAll("iframe"), watchFrame);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchExistingFrames);
  else watchExistingFrames();
})();
