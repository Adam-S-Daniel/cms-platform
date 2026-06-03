/*
 * admin/live-url-derive.js — single source of truth for "what URL does the
 * currently-edited Decap entry resolve to on the live site?"
 *
 * Two consumers depend on this:
 *
 *   1. `live-url-banner.js` — renders the "VIEW PAGE ON SITE:" banner above
 *      the form so editors can click straight through to the live page.
 *   2. (historical) `native-preview-href.js` used to rewrite Decap's native
 *      "View Live" toolbar anchor's href on every form mutation. That anchor
 *      is now CSS-hidden (redundant with the floating Live Preview button
 *      and the deploy-status / commit pills, and it clipped the publish-
 *      status pill off-screen on narrow viewports). The override script
 *      remains and hides the anchor; it no longer needs compute().
 *
 * Both used to maintain their own view of the slug → URL math, which made
 * keeping them in sync impossible. Centralising the logic here means a future
 * fix lands in one place and both surfaces inherit it.
 *
 * Exposed as `window.LiveURL.compute()` (plus the helpers it composes) so
 * either consumer can call it without bundling. The helpers stay free
 * functions — there's no class, no instances, the surface is flat and
 * tree-shakable when this eventually moves into a real bundle.
 *
 * URL templates mirror Jekyll's `_config.yml` permalinks:
 *   posts    -> /blog/<slug>/
 *   tags     -> /tags/<slug>/
 *   projects -> /projects/<slug>/
 *   pages    -> the permalink field's value (verbatim)
 *
 * The slug-derivation chain is intentional: an editor's explicit `slug`
 * field always wins (if set), then the title is slugified as the fallback,
 * then `name` for tags. This mirrors what Decap actually writes to disk
 * AFTER stripping the `_posts/` `YYYY-MM-DD-` date prefix Jekyll adds.
 */
(function () {
  "use strict";

  function getCollection() {
    var m = /#\/collections\/([^/]+)/.exec(window.location.hash || "");
    return m ? m[1] : null;
  }

  function readField(name) {
    var el = document.querySelector(
      'input[id^="' + name + '-field"], textarea[id^="' + name + '-field"]',
    );
    return el ? el.value : null;
  }

  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // null = no Published toggle in this schema → treat as always live.
  // true / false = current toggle state.
  function readPublished() {
    var matches = [];
    var nodes = document.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var direct = "";
      for (var j = 0; j < el.childNodes.length; j++) {
        var n = el.childNodes[j];
        if (n.nodeType === 3) direct += n.textContent;
      }
      if (/^\s*Published\s*$/i.test(direct)) matches.push(el);
    }
    for (var k = 0; k < matches.length; k++) {
      var cur = matches[k];
      for (var d = 0; d < 6 && cur; d++) {
        if (typeof cur.className === "string" && cur.className.indexOf("ControlContainer") !== -1) {
          var toggle = cur.querySelector('button[role="switch"]');
          if (toggle) return toggle.getAttribute("aria-checked") === "true";
        }
        cur = cur.parentElement;
      }
    }
    return null;
  }

  function compute() {
    var collection = getCollection();
    if (!collection) return null;
    var origin = window.location.origin;

    if (collection === "pages") {
      var permalink = readField("permalink");
      return {
        collection: collection,
        published: readPublished(),
        url: permalink ? origin + permalink : null,
      };
    }

    var explicitSlug = (readField("slug") || "").trim();
    var fallback = readField("title") || readField("name") || "";
    var slug = explicitSlug || slugify(fallback);

    var path = {
      posts: "/blog/",
      tags: "/tags/",
      projects: "/projects/",
    }[collection];

    return {
      collection: collection,
      published: readPublished(),
      url: path && slug ? origin + path + slug + "/" : null,
    };
  }

  window.LiveURL = {
    compute: compute,
    slugify: slugify,
    readField: readField,
    readPublished: readPublished,
    getCollection: getCollection,
  };
})();
