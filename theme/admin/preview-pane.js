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
 *     (theme/_layouts/preview.html), with the date formatted for people, and
 *   - a generic template for every other collection the editor opens (tags, a
 *     site's own Tools, ...): title, description and the markdown field, so the
 *     pane is not Decap's unstyled field dump (#726).
 *
 * A template renders only fields its collection declares. Decap's
 * `widgetFor(name)` THROWS when `name` is not a field, and an error thrown
 * while rendering replaces the pane with Decap's raw error screen for the rest
 * of the session; Projects has no `body` (its markdown field is `description`),
 * so the old unconditional `widgetFor("body")` crashed every new Project (#726).
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
    ".cms-preview-pane img, .cms-preview-pane iframe { max-width: 100%; }" +
    ".cms-preview-pane dt { font-weight: 600; margin-top: 1rem; }" +
    ".cms-preview-pane dd { margin: 0.25rem 0 0; }";

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

  // The collection's fields as plain {name, widget} objects, from the Immutable
  // List Decap hands every template as `props.fields`. null when the props
  // carry none (a stub), so callers fall back to the old assumptions.
  function fieldsOf(props) {
    var f = props && props.fields;
    if (f && typeof f.toJS === "function") f = f.toJS();
    return Array.isArray(f) ? f : null;
  }

  function findField(fields, name) {
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] && fields[i].name === name) return fields[i];
    }
    return null;
  }

  // The field whose markdown is the entry's body: `body` when declared, else
  // the first markdown-widget field (Projects: `description`), else null.
  // Without a field list, assume `body` as before.
  function bodyFieldName(props) {
    var fields = fieldsOf(props);
    if (!fields) return "body";
    if (findField(fields, "body")) return "body";
    for (var i = 0; i < fields.length; i++) {
      if (fields[i] && fields[i].widget === "markdown") return fields[i].name;
    }
    return null;
  }

  // widgetFor throws for a field the collection lacks and for one Decap cannot
  // render; either would blank the whole pane, so a bad field renders nothing.
  function bodyNodes(props, h) {
    var name = bodyFieldName(props);
    if (!name) return [];
    var content = null;
    try {
      content = props.widgetFor(name);
    } catch (_) {
      return [];
    }
    return [h("div", { className: "post-content" }, content)];
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

      children.push.apply(children, bodyNodes(props, h));

      return paneShell(h, children);
    };
  }

  function paneShell(h, children) {
    return h(
      "div",
      { className: "site-wrapper" },
      h("main", null, h("div", { className: "container cms-preview-pane" }, children)),
    );
  }

  // Widgets whose stored value is a short scalar worth showing as "Label: value".
  var SCALAR_WIDGETS = { string: 1, text: 1, number: 1, select: 1, datetime: 1, boolean: 1 };

  function scalarText(value) {
    if (value == null || value === "") return "";
    return typeof value === "string" ? value : String(value);
  }

  // Any collection without its own template: the heading (`title`, or `name`
  // for Tags), the `description` as the subtitle the site's own tool/project
  // pages use, and the markdown field. Only when the entry has neither a
  // markdown field nor a description (a site's list-like collections) are its
  // other short fields listed, labeled, so the pane is not just a heading.
  function makeGenericTemplate(h) {
    return function GenericPreviewTemplate(props) {
      var entry = props.entry;
      var fields = fieldsOf(props);
      var bodyName = bodyFieldName(props);
      var heading = field(entry, "title") || field(entry, "name");
      var children = [h("h1", null, heading ? String(heading) : "")];

      var description = bodyName === "description" ? "" : scalarText(field(entry, "description"));
      if (description) children.push(h("p", { className: "subtitle" }, description));

      var body = bodyNodes(props, h);
      children.push.apply(children, body);

      if (!body.length && !description && fields) {
        var rows = [];
        fields.forEach(function (f) {
          if (!f || f.name === "title" || f.name === "name" || !SCALAR_WIDGETS[f.widget]) return;
          var text = scalarText(field(entry, f.name));
          if (!text) return;
          rows.push(h("dt", null, f.label || f.name), h("dd", null, text));
        });
        if (rows.length) children.push(h("dl", { className: "cms-preview-fields" }, rows));
      }

      return paneShell(h, children);
    };
  }

  // The collection a `#/collections/<name>...` link or route names.
  function collectionFromHref(href) {
    var m = /#\/collections\/([^/?#]+)/.exec(String(href == null ? "" : href));
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return null;
    }
  }

  var OWN_COLLECTIONS = ["posts", "pages", "projects"];

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
    OWN_COLLECTIONS.forEach(function (collection) {
      CMS.registerPreviewTemplate(collection, makeTemplate(h, collection));
    });
    watchCollections(CMS, h);
    return true;
  }

  // Decap looks a template up by collection name and has no catch-all, and a
  // site's collection names are not known here. They ARE in the links the editor
  // uses to reach a collection and in the route, so the generic template is
  // registered for a collection when its link is pressed (before Decap
  // navigates, so before the pane first renders) or the route names it. One that
  // already has a template, ours or a site's own, is left alone.
  function watchCollections(CMS, h) {
    var generic = makeGenericTemplate(h);
    function claim(name) {
      if (!name || OWN_COLLECTIONS.indexOf(name) !== -1) return;
      if (typeof CMS.getPreviewTemplate === "function" && CMS.getPreviewTemplate(name)) return;
      CMS.registerPreviewTemplate(name, generic);
    }
    function fromEvent(event) {
      var el = event && event.target;
      var link = el && typeof el.closest === "function" ? el.closest("a[href]") : null;
      if (link) claim(collectionFromHref(link.getAttribute("href")));
    }
    function fromRoute() {
      claim(collectionFromHref(window.location.hash));
    }
    fromRoute();
    window.addEventListener("hashchange", fromRoute);
    document.addEventListener("pointerdown", fromEvent, true);
    document.addEventListener("click", fromEvent, true);
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
