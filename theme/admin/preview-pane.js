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
 * Raw HTML embeds (#687). Decap's markdown preview passes its HTML through
 * DOMPurify with the default config (`sanitize_preview` defaults to true),
 * and the default drops <iframe>, so an HTML Embed showed only its caption in
 * the pane. A body whose raw HTML blocks hold an <iframe> is split: those
 * blocks are rendered here as React elements from a short allowlist of tags
 * and attributes (see renderHtmlBlock), and the markdown between them still
 * goes through Decap's own markdown preview, sanitized as before. A body with
 * no such block renders exactly as it did.
 *
 * Uses only Decap's public CMS API (registerPreviewStyle,
 * registerPreviewTemplate, and widgetFor's `values` argument) and the `h` it
 * exposes. Loaded after `decap-cms.js` in the admin shells so `window.CMS`
 * exists.
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

  // ── Raw HTML embeds (#687) ───────────────────────────────────────────────
  //
  // The body is split by line, the way CommonMark finds an HTML block: outside
  // a code fence, a line starting with `<` after a blank line (or a line
  // starting with `<iframe`) opens a block that runs to the next blank line.
  // Only blocks holding an <iframe> are taken out; everything else, including
  // an <iframe> shown inside a code fence, stays markdown.
  var FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
  var HTML_BLOCK_START = /^ {0,3}<(?:[A-Za-z]|\/[A-Za-z]|!--)/;
  var IFRAME_LINE_START = /^ {0,3}<iframe[\s>/]/i;
  var IFRAME_OPEN = /<iframe[\s>/]/i;

  function isBlank(line) {
    return /^\s*$/.test(line);
  }

  function closesFence(line, fence) {
    var m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    return !!m && m[1].charAt(0) === fence.charAt(0) && m[1].length >= fence.length;
  }

  // -> null when the body has no iframe block, else
  //    [{ kind: "markdown" | "html", text }] in document order.
  function splitBody(body) {
    if (typeof body !== "string" || !IFRAME_OPEN.test(body)) return null;
    var lines = body.split(/\r?\n/);
    var segments = [];
    var markdown = [];
    var fence = null;
    var prevBlank = true;
    var found = false;
    var i = 0;
    var flush = function () {
      if (markdown.length) segments.push({ kind: "markdown", text: markdown.join("\n") });
      markdown = [];
    };
    while (i < lines.length) {
      var line = lines[i];
      if (fence) {
        if (closesFence(line, fence)) fence = null;
        markdown.push(line);
        prevBlank = false;
        i++;
        continue;
      }
      var open = FENCE_OPEN.exec(line);
      if (open) {
        fence = open[1];
        markdown.push(line);
        prevBlank = false;
        i++;
        continue;
      }
      if ((prevBlank && HTML_BLOCK_START.test(line)) || IFRAME_LINE_START.test(line)) {
        var block = [];
        while (i < lines.length && !isBlank(lines[i])) block.push(lines[i++]);
        var text = block.join("\n");
        if (IFRAME_OPEN.test(text)) {
          flush();
          segments.push({ kind: "html", text: text });
          found = true;
        } else {
          markdown = markdown.concat(block);
        }
        prevBlank = false;
        continue;
      }
      markdown.push(line);
      prevBlank = isBlank(line);
      i++;
    }
    flush();
    return found ? segments : null;
  }

  // The sanitizer for those blocks. Elements are built with `h`, never
  // innerHTML, so React escapes the text and only the attributes below reach
  // the DOM: no event handlers, no `srcdoc`, no <script> or <style>, and URLs
  // limited to http(s) or a relative path. A tag outside the allowlist is
  // dropped and its children kept; a DROP_WITH_CONTENT tag goes with
  // everything inside it.
  var GLOBAL_ATTRS = ["class", "style", "title", "lang", "dir"];
  var ALLOWED_TAGS = {
    iframe: ["src", "width", "height", "loading", "allow", "allowfullscreen", "referrerpolicy", "frameborder", "sandbox"],
    a: ["href", "target", "rel"],
    img: ["src", "alt", "width", "height", "loading"],
    div: [],
    p: [],
    span: [],
    strong: [],
    em: [],
    b: [],
    i: [],
    u: [],
    small: [],
    code: [],
    pre: [],
    blockquote: [],
    figure: [],
    figcaption: [],
    ul: [],
    ol: [],
    li: [],
    h2: [],
    h3: [],
    h4: [],
    br: [],
    hr: [],
  };
  var URL_ATTRS = { href: true, src: true };
  var VOID_TAGS = { br: 1, hr: 1, img: 1, wbr: 1, source: 1, track: 1, input: 1, embed: 1, area: 1, col: 1, meta: 1, link: 1, base: 1, param: 1 };
  var DROP_WITH_CONTENT = { script: 1, style: 1, template: 1, noscript: 1, textarea: 1, title: 1, object: 1, svg: 1, math: 1, select: 1 };
  var REACT_PROP = {
    class: "className",
    referrerpolicy: "referrerPolicy",
    frameborder: "frameBorder",
  };
  var NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    larr: "←",
    rarr: "→",
    copy: "©",
  };

  function decodeEntities(s) {
    return String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, function (all, ref) {
      if (ref.charAt(0) === "#") {
        var n = ref.charAt(1).toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      var named = NAMED_ENTITIES[ref.toLowerCase()];
      return named === undefined ? all : named;
    });
  }

  // http(s) or relative only. Browsers ignore control characters and spaces
  // inside a scheme ("java\tscript:"), so they are removed before the check.
  function safeUrl(value) {
    var trimmed = String(value).trim();
    var scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed.replace(/[\u0000- \u007f]+/g, ""));
    if (!scheme) return trimmed;
    return /^https?$/i.test(scheme[1]) ? trimmed : null;
  }

  // "width:100%; min-height:560px" -> { width: "100%", minHeight: "560px" }
  function styleObject(css) {
    var out = {};
    String(css)
      .split(";")
      .forEach(function (decl) {
        var colon = decl.indexOf(":");
        if (colon < 1) return;
        var prop = decl.slice(0, colon).trim().toLowerCase();
        var value = decl.slice(colon + 1).trim();
        if (!value || !/^-{0,2}[a-z][a-z0-9-]*$/.test(prop)) return;
        var key =
          prop.indexOf("--") === 0
            ? prop
            : prop.replace(/-([a-z])/g, function (m, c) {
                return c.toUpperCase();
              });
        out[key] = value;
      });
    return out;
  }

  var TAG_TOKEN =
    /<!--[\s\S]*?(?:-->|$)|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  var ATTR_TOKEN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  function elementProps(tag, rawAttrs, key) {
    var props = { key: key };
    var allowed = GLOBAL_ATTRS.concat(ALLOWED_TAGS[tag]);
    var m;
    ATTR_TOKEN.lastIndex = 0;
    while ((m = ATTR_TOKEN.exec(rawAttrs))) {
      var name = m[1].toLowerCase();
      if (allowed.indexOf(name) === -1) continue;
      var raw = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
      var value = raw == null ? "" : decodeEntities(raw);
      if (URL_ATTRS[name]) {
        value = safeUrl(value);
        if (value === null) continue;
      }
      if (name === "style") props.style = styleObject(value);
      else if (name === "allowfullscreen") props.allowFullScreen = true;
      else props[REACT_PROP[name] || name] = value;
    }
    if (tag === "a" && props.target) props.rel = "noopener noreferrer";
    return props;
  }

  // One raw HTML block -> an array of React elements and strings.
  function renderHtmlBlock(h, html, keyPrefix) {
    var root = { tag: null, children: [] };
    var stack = [root];
    var count = 0;
    var last = 0;
    var m;
    var text = function (s) {
      if (s) stack[stack.length - 1].children.push(decodeEntities(s));
    };
    TAG_TOKEN.lastIndex = 0;
    while ((m = TAG_TOKEN.exec(html))) {
      text(html.slice(last, m.index));
      last = TAG_TOKEN.lastIndex;
      if (m[1]) {
        var closing = m[1].toLowerCase();
        for (var d = stack.length - 1; d > 0; d--) {
          if (stack[d].tag === closing) {
            stack.length = d;
            break;
          }
        }
      } else if (m[2]) {
        var tag = m[2].toLowerCase();
        if (DROP_WITH_CONTENT[tag]) {
          var end = html.toLowerCase().indexOf("</" + tag, last);
          var gt = end === -1 ? -1 : html.indexOf(">", end);
          last = TAG_TOKEN.lastIndex = gt === -1 ? html.length : gt + 1;
          continue;
        }
        if (!ALLOWED_TAGS[tag]) continue;
        var node = { tag: tag, props: elementProps(tag, m[3] || "", keyPrefix + "-" + count++), children: [] };
        stack[stack.length - 1].children.push(node);
        if (!VOID_TAGS[tag] && !/\/>$/.test(m[0])) stack.push(node);
      }
      // A comment (the html-embed sentinels) renders nothing.
    }
    text(html.slice(last));
    var build = function (n) {
      if (typeof n === "string") return n;
      return h.apply(null, [n.tag, n.props].concat(n.children.map(build)));
    };
    return root.children.map(build);
  }

  // The body: Decap's own widget when there is no iframe block; otherwise the
  // segments, each markdown run rendered by Decap's markdown preview through
  // widgetFor's `values` argument, so the body field's config still applies.
  function renderBody(h, props) {
    var entry = props.entry;
    var data = entry && typeof entry.get === "function" ? entry.get("data") : null;
    var segments = splitBody(field(entry, "body"));
    if (!segments || !data || typeof data.set !== "function") return props.widgetFor("body");
    return segments.map(function (segment, n) {
      if (segment.kind === "html") {
        var key = "embed-" + n;
        return h.apply(
          null,
          ["div", { key: key, className: "cms-preview-html" }].concat(renderHtmlBlock(h, segment.text, key)),
        );
      }
      return h(
        "div",
        { key: "md-" + n, className: "cms-preview-markdown" },
        props.widgetFor("body", undefined, data.set("body", segment.text)),
      );
    });
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

      children.push(h("div", { className: "post-content" }, renderBody(h, props)));

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

  window.adamdaniel_cms_preview_pane = { formatDate: formatDate, splitBody: splitBody, safeUrl: safeUrl };
})();
