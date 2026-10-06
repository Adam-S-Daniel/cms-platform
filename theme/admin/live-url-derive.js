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
 * field always wins (if set, slugified as Jekyll's `:slug` does), then the
 * title is slugified as the fallback,
 * then `name` for tags. This mirrors what Decap actually writes to disk
 * AFTER stripping the `_posts/` `YYYY-MM-DD-` date prefix Jekyll adds.
 *
 * ROUTABLE_COLLECTIONS (cms-platform#328.3) — compute() only knows how to
 * derive a URL for the four collection shapes above. Any OTHER collection —
 * a file/singleton collection (Header/Hero, Site Settings) or a folder
 * collection with no per-entry route (the section-collection shape both
 * single-page consumers' custom seams use) — has nothing to derive, no
 * matter how the entry's fields are filled in. Before this fix compute()
 * still returned `{ url: null }` for those, and live-url-banner.js rendered
 * that as "Set a title or slug to see the URL" — a hint the owner could
 * never satisfy, showing on every entry of every such collection including
 * ones with a filled title. Returning `null` outright (same as the
 * no-collection-at-all case just below) makes the banner hide entirely
 * instead — see live-url-banner.js's `render()`, `if (!data) { ...
 * display:none... }`. A future collection with a genuine per-entry route
 * (a `preview_path`) needs its own entry in this map AND in the `path`
 * lookup below to get a real URL rather than just going quiet.
 */
(function () {
  "use strict";

  var ROUTABLE_COLLECTIONS = { pages: true, posts: true, tags: true, projects: true };

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

  // Jekyll::Utils.slugify, "default" mode — a PORT, tested case for case
  // against the real Jekyll (e2e/jekyll-slugify-golden.json,
  // slugify-parity.test.js): runs of anything that is not a letter, a mark or a
  // decimal digit become "-", one leading/trailing "-" is dropped, then it is
  // lowercased. Unicode letters are KEPT ("Café" → "café"), as Jekyll keeps
  // them. Lowercasing is per code point because Ruby's String#downcase has no
  // Greek final-sigma rule and a whole-string JS toLowerCase() does ("ΟΔΟΣ":
  // Jekyll "οδοσ", toLowerCase "οδος"). Do not reach for a slug library: those
  // transliterate ("café" → "cafe"), which is not what Jekyll serves.
  function slugify(s) {
    var hyphenated = String(s == null ? "" : s)
      .replace(/[^\p{M}\p{L}\p{Nd}]+/gu, "-")
      .replace(/^-|-$/g, "");
    return Array.from(hyphenated, function (ch) {
      return ch.toLowerCase();
    }).join("");
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
    if (!collection || !ROUTABLE_COLLECTIONS[collection]) return null;
    // Publication follows the served config, including its protocol and port.
    // site-hostname.js loads first in every shell.
    var origin = window.CMSHostname && typeof window.CMSHostname.destinationOrigin === "function"
      ? window.CMSHostname.destinationOrigin()
      : window.CMSHostname && typeof window.CMSHostname.publicOrigin === "function"
        ? window.CMSHostname.publicOrigin() : window.location.origin;

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
    // Jekyll runs the front-matter slug through its default slugify too (the
    // `:slug` placeholder, Drops::UrlDrop#slug), so a typed "Bad Slug!" is
    // served at /blog/bad-slug/. Slugify it here or the link 404s. An already
    // slugified value (every slug-pin.js writes) is returned unchanged.
    var slug = slugify(explicitSlug) || slugify(fallback);

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
