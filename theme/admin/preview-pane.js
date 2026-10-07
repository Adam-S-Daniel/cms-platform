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

  // ── Raw HTML embeds (#687) ───────────────────────────────────────────────
  //
  // Follow CommonMark's HTML block endings so a comment cannot swallow the
  // fence after it. Only raw tag blocks holding an iframe leave markdown.
  var FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
  var IFRAME_OPEN = /<iframe[\s>/]/i;
  var BLOCK_TAG = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;
  var COMPLETE_OPEN_TAG = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>\s*$/;
  var COMPLETE_CLOSE_TAG = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>\s*$/;

  function isBlank(line) {
    return /^\s*$/.test(line);
  }

  function closesFence(line, fence) {
    var m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    return !!m && m[1].charAt(0) === fence.charAt(0) && m[1].length >= fence.length;
  }

  function htmlBlock(line, prevBlank) {
    var start = /^ {0,3}</.exec(line);
    if (!start) return null;
    var html = line.slice(start[0].length - 1);
    if (/^<(?:script|pre|style|textarea)(?:\s|>|\/)/i.test(html)) {
      var tag = /^<([A-Za-z]+)/.exec(html)[1];
      return { end: new RegExp("</" + tag + ">", "i"), raw: false };
    }
    if (html.indexOf("<!--") === 0) return { end: /-->/, raw: false };
    if (html.indexOf("<?") === 0) return { end: /\?>/, raw: false };
    if (/^<![A-Z]/.test(html)) return { end: />/, raw: false };
    if (html.indexOf("<![CDATA[") === 0) return { end: /\]\]>/, raw: false };
    var tag = /^<\/?([A-Za-z][\w-]*)(?=[\s/>]|$)/.exec(html);
    if (tag && BLOCK_TAG.test(tag[1])) return { end: null, raw: true };
    // A type 7 block cannot interrupt a paragraph. Require a complete tag;
    // an inline '<iframe' in prose must never become a separate block.
    if (prevBlank && (COMPLETE_OPEN_TAG.test(html) || COMPLETE_CLOSE_TAG.test(html))) {
      return { end: null, raw: true };
    }
    return null;
  }

  // CommonMark counts list padding in columns. More than four columns means
  // only one column is padding; the rest is content indentation (possibly code).
  function listMarker(line, baseColumn) {
    var match = /^ {0,3}([-+*]|\d{1,9}[.)])([ \t]+)/.exec(line);
    if (!match) return null;
    var column = baseColumn + match[0].length - match[2].length;
    var spaces = "";
    for (var i = 0; i < match[2].length; i++) {
      var width = match[2].charAt(i) === "\t" ? 4 - (column % 4) : 1;
      spaces += " ".repeat(width);
      column += width;
    }
    var padding = spaces.length > 4 ? 1 : spaces.length;
    return {
      marker: match[1],
      indent: match[0].length - match[2].length + padding,
      text: spaces.slice(padding) + line.slice(match[0].length),
    };
  }

  function stripIndent(line, columns, baseColumn) {
    var used = 0;
    var i = 0;
    while (used < columns && i < line.length && /[ \t]/.test(line.charAt(i))) {
      used += line.charAt(i) === "\t" ? 4 - ((baseColumn + used) % 4) : 1;
      i++;
    }
    return used < columns ? null : " ".repeat(used - columns) + line.slice(i);
  }

  // Strip Markdown container markers only for block recognition. The original
  // lines remain in markdown; extracted embeds keep their container metadata.
  function contentLine(line, listIndent) {
    var rest = line;
    var quotes = 0;
    var quote;
    while ((quote = /^ {0,3}> ?/.exec(rest))) {
      rest = rest.slice(quote[0].length);
      quotes++;
    }
    var list = listMarker(rest, line.length - rest.length);
    if (list) {
      return { text: list.text, quotes: quotes, list: list.marker, indent: list.indent, continued: false };
    }
    var continued = false;
    var stripped = listIndent ? stripIndent(rest, listIndent, line.length - rest.length) : null;
    if (stripped !== null) {
      rest = stripped;
      continued = true;
    }
    return { text: rest, quotes: quotes, list: null, indent: 0, continued: continued };
  }

  function fencedLine(line, fence) {
    var rest = line;
    var column = 0;
    for (var i = 0; i < fence.containers.length; i++) {
      var container = fence.containers[i];
      if (container === ">") {
        var quote = /^ {0,3}> ?/.exec(rest);
        if (!quote) return null;
        rest = rest.slice(quote[0].length);
        column += quote[0].length;
      } else {
        if (isBlank(rest)) return i === fence.containers.length - 1 ? "" : null;
        var stripped = stripIndent(rest, container, column);
        if (stripped === null) return null;
        rest = stripped;
        column += container;
      }
    }
    return rest;
  }

  function openingFence(line, listIndent) {
    var rest = line;
    var containers = [];
    var column = 0;
    var stripped = listIndent ? stripIndent(rest, listIndent, column) : null;
    if (stripped !== null) {
      containers.push(listIndent);
      rest = stripped;
      column += listIndent;
    }
    while (rest) {
      var quote = /^ {0,3}> ?/.exec(rest);
      if (quote) {
        containers.push(">");
        rest = rest.slice(quote[0].length);
        column += quote[0].length;
        continue;
      }
      var list = listMarker(rest, column);
      if (list) {
        containers.push(list.indent);
        rest = list.text;
        column += list.indent;
        continue;
      }
      break;
    }
    var open = FENCE_OPEN.exec(rest);
    if (open && open[1].charAt(0) === "`" && rest.slice(open[0].length).indexOf("`") !== -1) return null;
    return open ? { marker: open[1], containers: containers } : null;
  }

  // -> null when the body has no iframe block, else
  //    [{ kind: "markdown" | "html", text }] in document order.
  function splitBody(body) {
    if (typeof body !== "string" || !IFRAME_OPEN.test(body)) return null;
    var lines = body.split(/\r?\n/);
    var segments = [];
    var markdown = [];
    var fence = null;
    var listIndent = 0;
    var activeList = null;
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
        var fenced = fencedLine(line, fence);
        if (fenced !== null) {
          if (closesFence(fenced, fence.marker)) fence = null;
          markdown.push(line);
          prevBlank = false;
          i++;
          continue;
        }
        fence = null;
      }
      var content = contentLine(line, listIndent);
      var source = content.text;
      var priorListIndent = listIndent;
      if (isBlank(line)) {
        // A blank line can occur inside a list item; a later indented line
        // still belongs to it. An unindented nonblank line ends it below.
      } else if (content.list) {
        listIndent = content.indent;
        activeList = content.list;
      } else if (!isBlank(source) && !/^\s/.test(line.replace(/^ {0,3}> ?/, ""))) {
        listIndent = 0;
        activeList = null;
      }
      var open = openingFence(line, priorListIndent);
      if (open) {
        fence = open;
        markdown.push(line);
        prevBlank = false;
        i++;
        continue;
      }
      var html = htmlBlock(source, prevBlank);
      if (html) {
        var block = [];
        var rendered = [];
        var blockList = activeList;
        var blockQuotes = content.quotes;
        while (i < lines.length) {
          var part = contentLine(lines[i], listIndent);
          if (block.length && (part.quotes !== blockQuotes || part.list || (blockList && !part.continued))) break;
          if (!html.end && isBlank(part.text)) break;
          block.push(lines[i]);
          rendered.push(part.text);
          i++;
          if (html.end && html.end.test(part.text)) break;
        }
        var text = rendered.join("\n");
        if (html.raw && hasIframeTag(text)) {
          flush();
          segments.push({ kind: "html", text: text, quotes: content.quotes, list: activeList });
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

  function hasIframeTag(html) {
    var m;
    TAG_TOKEN.lastIndex = 0;
    while ((m = TAG_TOKEN.exec(html))) {
      if (!m[2]) continue;
      var tag = m[2].toLowerCase();
      if (DROP_WITH_CONTENT[tag]) {
        var end = html.toLowerCase().indexOf("</" + tag, TAG_TOKEN.lastIndex);
        var gt = end === -1 ? -1 : html.indexOf(">", end);
        TAG_TOKEN.lastIndex = gt === -1 ? html.length : gt + 1;
      } else if (tag === "iframe") {
        return true;
      }
    }
    return false;
  }

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
  // widgetFor's `values` argument, so the declared field's config still applies.
  function renderBody(h, props, name) {
    var entry = props.entry;
    var data = entry && typeof entry.get === "function" ? entry.get("data") : null;
    var segments = splitBody(field(entry, name));
    if (!segments || !data || typeof data.set !== "function") return props.widgetFor(name);
    return segments.map(function (segment, n) {
      if (segment.kind === "html") {
        var key = "embed-" + n;
        var embed = h.apply(
          null,
          ["div", { key: key, className: "cms-preview-html" }].concat(renderHtmlBlock(h, segment.text, key)),
        );
        if (segment.list) {
          var listTag = /^\d/.test(segment.list) ? "ol" : "ul";
          embed = h(listTag, { key: key + "-list" }, h("li", null, embed));
        }
        for (var q = 0; q < segment.quotes; q++) embed = h("blockquote", { key: key + "-quote-" + q }, embed);
        return embed;
      }
      return h(
        "div",
        { key: "md-" + n, className: "cms-preview-markdown" },
        props.widgetFor(name, undefined, data.set(name, segment.text)),
      );
    });
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
      content = renderBody(h, props, name);
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

  window.adamdaniel_cms_preview_pane = { formatDate: formatDate, splitBody: splitBody, safeUrl: safeUrl };
})();
