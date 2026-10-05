/*
 * admin/preview-pane.js — styles Decap's in-editor preview pane like the site.
 *
 * Without a preview template Decap lists every field as raw text ("URL Slug:",
 * `2026-10-05 09:40:00 -0400`) in the browser's default serif, and a body image
 * wider than the pane scrolls it sideways. This registers:
 *   - the site's own stylesheet (assets/css/main.css, the file the live site
 *     links, so typography and `img { max-width: 100% }` match by construction)
 *     plus a few lines of pane-only CSS, and
 *   - a template per previewable collection (posts, pages, projects) that
 *     renders the same markup as the Live Preview layout
 *     (theme/_layouts/preview.html), with the date formatted for people.
 *
 * Uses only Decap's public CMS API (registerPreviewStyle,
 * registerPreviewTemplate) and the `h` it exposes. Loaded after
 * `decap-cms.js` in the admin shells so `window.CMS` exists.
 */
(function () {
  "use strict";

  var REGISTER_TIMEOUT_MS = 30_000;
  var POLL_INTERVAL_MS = 100;

  var MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  // The site stylesheet, resolved from the admin page so a sub-path site works.
  function siteStylesheetUrl() {
    return new URL("../assets/css/main.css", window.location.href).href;
  }

  // Pane-only rules. The top padding keeps a long title clear of the floating
  // Live Preview / toggle buttons Decap overlays on the pane's top-right.
  var PANE_CSS =
    ".cms-preview-pane { padding-top: 3.5rem; box-sizing: border-box; overflow-wrap: anywhere; }" +
    ".cms-preview-pane img, .cms-preview-pane iframe { max-width: 100%; }";

  // "2026-10-05 09:40:00 -0400" -> "October 5, 2026". Read from the leading
  // YYYY-MM-DD, never `new Date(string)`: that stored form is not ISO-8601 and
  // WebKit rejects it (see the `summary` note in config.base.yml).
  function formatDate(raw) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw == null ? "" : raw));
    if (!m) return raw ? String(raw) : "";
    var month = MONTHS[Number(m[2]) - 1];
    if (!month) return String(raw);
    return month + " " + Number(m[3]) + ", " + m[1];
  }

  function field(entry, name) {
    return entry && typeof entry.getIn === "function" ? entry.getIn(["data", name]) : undefined;
  }

  function makeTemplate(h, collection) {
    return function PreviewTemplate(props) {
      var entry = props.entry;
      var title = field(entry, "title");
      var children = [];

      if (collection === "posts") {
        var image = field(entry, "featured_image");
        var date = formatDate(field(entry, "date"));
        children.push(
          h(
            "div",
            { className: "post-meta" },
            date ? h("time", { className: "post-date" }, date) : null,
          ),
        );
        children.push(h("h1", null, title || ""));
        if (image) {
          children.push(
            h("img", { className: "featured-image", src: String(props.getAsset(image)), alt: "" }),
          );
        }
      } else if (collection === "projects") {
        var tech = field(entry, "technology");
        children.push(
          h("div", { className: "post-meta" }, tech ? h("span", { className: "project-tech" }, tech) : null),
        );
        children.push(h("h1", null, title || ""));
      } else {
        children.push(h("h1", null, title || ""));
      }

      children.push(h("div", { className: "post-content" }, props.widgetFor("body")));

      return h(
        "div",
        { className: "site-wrapper" },
        h("main", null, h("div", { className: "container cms-preview-pane" }, children)),
      );
    };
  }

  function register(CMS) {
    var h = window.h || (CMS && CMS.h);
    if (
      !CMS ||
      typeof CMS.registerPreviewStyle !== "function" ||
      typeof CMS.registerPreviewTemplate !== "function" ||
      typeof h !== "function"
    ) {
      return false;
    }
    CMS.registerPreviewStyle(siteStylesheetUrl());
    CMS.registerPreviewStyle(PANE_CSS, { raw: true });
    ["posts", "pages", "projects"].forEach(function (collection) {
      CMS.registerPreviewTemplate(collection, makeTemplate(h, collection));
    });
    return true;
  }

  function waitForCMS() {
    var start = Date.now();
    var tick = function () {
      if (register(window.CMS)) return;
      if (Date.now() - start > REGISTER_TIMEOUT_MS) return;
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForCMS);
  } else {
    waitForCMS();
  }

  window.adamdaniel_cms_preview_pane = { formatDate: formatDate };
})();
