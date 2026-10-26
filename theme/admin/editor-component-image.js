/*
 * admin/editor-component-image.js — stops an untouched Image block from
 * being saved as a literal `![]()` line (cms-platform#648).
 *
 * Decap's built-in Image editor component serializes its fields as
 * `![alt](image "title")` with every missing field coerced to "", so an
 * Image block the author inserted and left empty is written to the file as
 * `![]()`, which renders as a broken image. This re-registers the component
 * under the same id ("image") with the stock fields, pattern and parser, and
 * a `toBlock` that writes nothing when no image was chosen.
 *
 * Loaded after `decap-cms.js` in admin/index*.html so `window.CMS` exists
 * and Decap's own registration has already run (a later registration with
 * the same id replaces it).
 */
(function () {
  "use strict";

  var REGISTER_TIMEOUT_MS = 30_000;
  var POLL_INTERVAL_MS = 100;

  var component = {
    id: "image",
    label: "Image",
    fields: [
      { label: "Image", name: "image", widget: "image", media_library: { allow_multiple: false } },
      { label: "Alt Text", name: "alt" },
      { label: "Title", name: "title" },
    ],
    // Same pattern and parser as Decap's stock Image component.
    pattern: /^!\[([^\]]*)\]\((.*?)(\s"([^"]*)")?\)/,
    fromBlock: function (match) {
      return match && { image: match[2], alt: match[1], title: match[4] };
    },
    toBlock: function (data) {
      var image = data && data.image;
      if (!image) return "";
      var alt = data.alt || "";
      var title = data.title ? ' "' + data.title.replace(/"/g, '\\"') + '"' : "";
      return "![" + alt + "](" + image + title + ")";
    },
    // Same preview as the stock component; `window.h` is Decap's
    // createElement.
    toPreview: function (data, getAsset, fields) {
      var field = fields && fields.find(function (f) { return f.get("widget") === "image"; });
      var src = data && data.image ? getAsset(data.image, field) : "";
      return window.h("img", {
        src: src || "",
        alt: (data && data.alt) || "",
        title: (data && data.title) || "",
      });
    },
  };

  function tryRegister() {
    if (window.CMS && typeof window.CMS.registerEditorComponent === "function") {
      window.CMS.registerEditorComponent(component);
      return true;
    }
    return false;
  }

  function waitForCMS() {
    var start = Date.now();
    var tick = function () {
      if (tryRegister()) return;
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
})();
