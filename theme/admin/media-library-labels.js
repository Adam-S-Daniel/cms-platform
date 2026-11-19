/*
 * admin/media-library-labels.js — PRODUCTION SHELL ONLY. Calls Decap's
 * library of uploaded pictures and files "Images & files" instead of
 * "Media", so the word "media" means one thing to a site owner: a site's own
 * content collection (articles, talks, press) when it has one. See "Words we
 * use" in docs/ADMIN-DELIVERY.md.
 *
 * Mechanism: Decap's locale override. decap-cms-app registers its English
 * phrases with CMS.registerLocale('en', ...), and the UI reads
 * merge({}, getLocale('en'), getLocale(<configured locale>)) when it renders.
 * registerLocale REPLACES a locale's whole phrase table, so this merges the
 * three changed phrases over CMS.getLocale('en') and registers the result;
 * every other phrase stays Decap's own. No DOM text is rewritten, so there is
 * no observer and nothing to re-apply when Decap re-renders. Phrases (decap-
 * cms-locales 3.8.x, en):
 *   app.header.media                          the top-nav "Media" tab
 *   mediaLibrary.mediaLibraryModal.mediaAssets the library modal's title
 *   mediaLibrary.mediaLibrary.onDelete         the delete confirmation
 *
 * Loaded (deferred) after decap-cms.js, which has already registered 'en';
 * Decap reads phrases when it renders, after its async config load. If a
 * future Decap drops getLocale or the English table this does nothing and
 * Decap keeps its own words. A site that registered its own 'en' phrases
 * keeps them (they are the table merged over).
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.__mediaLibraryLabelsInstalled) return;
  window.__mediaLibraryLabelsInstalled = true;

  var CMS = window.CMS;
  if (!CMS || typeof CMS.getLocale !== "function" || typeof CMS.registerLocale !== "function") return;
  var en = CMS.getLocale("en");
  if (!en || typeof en !== "object") return;

  function section(obj, key) {
    var next = obj[key];
    return next && typeof next === "object" ? Object.assign({}, next) : {};
  }

  var merged = Object.assign({}, en);
  merged.app = section(en, "app");
  merged.app.header = section(merged.app, "header");
  merged.app.header.media = "Images & files";
  merged.mediaLibrary = section(en, "mediaLibrary");
  merged.mediaLibrary.mediaLibraryModal = section(merged.mediaLibrary, "mediaLibraryModal");
  merged.mediaLibrary.mediaLibraryModal.mediaAssets = "Images & files";
  merged.mediaLibrary.mediaLibrary = section(merged.mediaLibrary, "mediaLibrary");
  merged.mediaLibrary.mediaLibrary.onDelete = "Are you sure you want to delete the selected files?";

  CMS.registerLocale("en", merged);
})();
