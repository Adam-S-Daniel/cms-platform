/*
 * admin/editor-component-html-embed.js — Decap CMS editor component for
 * embedding raw HTML / JS / CSS inside a markdown body.
 *
 * Adds an "HTML Embed" button to the markdown widget toolbar. The block is
 * stored on disk as a kramdown-friendly HTML region wrapped in sentinel
 * comments so it round-trips cleanly between rich-text and raw modes:
 *
 *     <!-- html-embed:start -->
 *     <div class="post-embed">
 *     …author HTML…
 *     </div>
 *     <!-- html-embed:end -->
 *
 * Why this shape:
 *   • kramdown (Jekyll's parser) passes block-level HTML through verbatim,
 *     so the wrapper <div> renders as HTML in production with no plugin.
 *   • Sentinel comments give Decap an unambiguous regex anchor regardless
 *     of what HTML the author nests inside the wrapper.
 *   • A leading and trailing blank line in `toBlock` satisfies kramdown's
 *     block-HTML rule (blocks must be separated by blank lines).
 *
 * Loaded after `decap-cms.js` in admin/index*.html so `window.CMS` exists.
 */
(function () {
  "use strict";

  var REGISTER_TIMEOUT_MS = 30_000;
  var POLL_INTERVAL_MS = 100;

  var component = {
    id: "htmlEmbed",
    label: "HTML Embed",
    fields: [
      {
        name: "html",
        label: "HTML / JS / CSS",
        widget: "code",
        default_language: "html",
        allow_language_selection: false,
        output_code_only: true,
      },
    ],
    // No /g flag — Decap iterates blocks itself.
    pattern:
      /<!-- html-embed:start -->\n<div class="post-embed">\n([\s\S]*?)\n<\/div>\n<!-- html-embed:end -->/,
    fromBlock: function (match) {
      return { html: match[1] };
    },
    toBlock: function (data) {
      var html = (data && data.html) || "";
      // Leading + trailing newline pair keeps the block separated from
      // surrounding markdown so kramdown treats it as a block-HTML span.
      return (
        "<!-- html-embed:start -->\n" +
        '<div class="post-embed">\n' +
        html +
        "\n</div>\n" +
        "<!-- html-embed:end -->"
      );
    },
    toPreview: function (data) {
      var html = (data && data.html) || "";
      return '<div class="post-embed">' + html + "</div>";
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
      if (Date.now() - start > REGISTER_TIMEOUT_MS) {
        // Give up silently — the admin still works without this button.
        return;
      }
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
