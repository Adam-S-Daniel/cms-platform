/*
 * admin/tags-input.js — cms-platform#638.
 *
 * ── The bug (reproduced live against Decap 3.15.1) ────────────────────
 * Posts' Tags is Decap's plain `list` widget: ONE text box whose value is
 * split on commas. Two behaviors made it silently corrupt tags:
 *   1. The hint said "press Enter" but Enter does nothing, so
 *      `zz-test<Enter>ai` saved ONE tag, `zz-testai`.
 *   2. After a comma Decap rewrites the box to "a, " itself; the editor's
 *      own space then makes Decap drop the comma, so `alpha, beta` saved
 *      ONE tag, `alphabeta`. Only `alpha,beta` (no space) worked.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * Two key rules on the Tags box only (id `tags-field-<n>`, Decap's
 * `<field name>-field-<n>` scheme), as a capture-phase listener on
 * `document`, so it needs no Decap internals and no Emotion class names:
 *   - Enter ends the current tag: it appends a comma, which Decap turns
 *     into "a, ", exactly as if the editor had typed the comma. It never
 *     adds a comma to an empty box or after one already there.
 *   - A space typed right after a comma is dropped, since Decap already
 *     supplies it.
 * If Decap changes the box's id scheme the listener simply stops matching
 * and this shim is a silent no-op.
 *
 * ── A space at the end of a tag — cms-platform#756 ────────────────────
 * Decap's list widget runs `e.target.value.trim()` in handleChange on EVERY
 * keystroke and writes the result back to the controlled box, so a space
 * typed after a letter never survives: `Field Notes` became `FieldNotes`
 * (and the near-duplicate warning never saw the space). The widget offers no
 * option for this, so the shim keeps the in-progress space itself: an input
 * event that leaves the box ending in a space (caret at the end) is stopped
 * before React sees it, so Decap never trims it and the space stays on
 * screen. The next keystroke arrives as `field n`, which Decap stores
 * trimmed at the edges only, so the space inside survives. Decap's blur
 * handler trims whatever is left over. A second space, or one right after a
 * comma, is dropped (keydown), as before.
 *
 * ── Existing-tag suggestions — cms-platform#735 ───────────────────────
 * Nothing told a writer which tags already exist, so `quote` and `Quotes`
 * could be minted beside `quotes`, each with its own archive page. A small
 * status line under the box now:
 *   - lists existing tags that contain what is being typed (`quo` offers
 *     `quotes`), and
 *   - warns when a tag differs from an existing one only by case, plural,
 *     spaces or hyphens (`quote`, `Quotes` vs `quotes`).
 * Each offer is a button that swaps the typed text for the existing tag; Tab
 * from the box reaches them. It only ever offers: no tag is rewritten or
 * dropped on its own, a brand-new tag is still one Enter away, and stored
 * tags are never touched.
 *
 * The existing names are the ones the site already publishes on its tags
 * index (`/tags/`, `.tag-list-name` — the markup both the fixture site and
 * a consumer's tags/index.html ship; site.all_tags built by
 * auto_tag_pages.rb), read once, same-origin, the first time the box is
 * focused. If that page is missing or fails, there is simply nothing to
 * offer and the box behaves exactly as before.
 */
(function () {
  "use strict";

  var TAGS_ID_RE = /^tags-field-\d+$/;

  function isTagsBox(el) {
    return !!el && el.tagName === "INPUT" && TAGS_ID_RE.test(String(el.id || ""));
  }

  // React tracks an input's value itself, so a plain `el.value = ...` is
  // ignored by its onChange; go through the native setter, then fire `input`.
  function setValue(el, value) {
    var proto = typeof HTMLInputElement !== "undefined" ? HTMLInputElement.prototype : null;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function onKeyDown(e) {
    var el = e.target;
    if (!isTagsBox(el) || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    var value = String(el.value || "");
    if (e.key === "Enter") {
      e.preventDefault();
      if (value.trim() && !/,\s*$/.test(value)) setValue(el, value.replace(/\s+$/, "") + ",");
    } else if (e.key === " " && /(,\s*|\s)$/.test(value) && atEnd(el)) {
      e.preventDefault();
    }
  }

  function atEnd(el) {
    var end = el.selectionEnd;
    return typeof end !== "number" || end === String(el.value || "").length;
  }

  // Pure: should an input event that left the box as `value` be hidden from
  // Decap (#756)? True for a single in-progress space right after a letter
  // (not after a comma, which Decap rewrites itself), with the caret at the end.
  function holdsTrailingSpace(value, caretAtEnd) {
    return !!caretAtEnd && /[^\s,] $/.test(String(value || ""));
  }

  // ── Existing-tag suggestions (#735) ─────────────────────────────────
  var MAX_SUGGESTIONS = 6;

  // Two tags "match" when they differ only by case, spaces, hyphens,
  // underscores, dots or a trailing plural s (kept off short words, so
  // `news` is not read as `new`).
  function keyOf(name) {
    var k = String(name).toLowerCase().replace(/[\s\-_.]+/g, "");
    return k.length > 4 && k.charAt(k.length - 1) === "s" ? k.slice(0, -1) : k;
  }

  function splitTags(value) {
    return String(value || "")
      .split(",")
      .map(function (t) {
        return t.trim();
      });
  }

  // Pure: what to tell the editor about `value` given the site's `existing`
  // tags. `near` = typed tags that are NOT an existing tag but match one
  // (`matches` lists those); `suggest` = existing tags containing the text
  // still being typed (the last comma-separated piece).
  function analyze(value, existing) {
    var tokens = splitTags(value);
    var last = tokens.length - 1;
    var names = existing || [];
    var near = [];
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (!tok || names.indexOf(tok) !== -1) continue;
      var matches = names.filter(function (n) {
        return keyOf(n) === keyOf(tok);
      });
      if (matches.length) near.push({ index: i, typed: tok, matches: matches });
    }
    var suggest = [];
    var frag = tokens[last];
    if (frag) {
      var lower = frag.toLowerCase();
      var typedLower = tokens.map(function (t) {
        return t.toLowerCase();
      });
      var shown = [];
      near.forEach(function (n) {
        if (n.index === last) shown = shown.concat(n.matches);
      });
      var hits = names.filter(function (n) {
        return (
          n.toLowerCase().indexOf(lower) !== -1 && typedLower.indexOf(n.toLowerCase()) === -1 && shown.indexOf(n) === -1
        );
      });
      hits.sort(function (a, b) {
        return Number(b.toLowerCase().indexOf(lower) === 0) - Number(a.toLowerCase().indexOf(lower) === 0);
      });
      suggest = hits.slice(0, MAX_SUGGESTIONS);
    }
    return { near: near, suggest: suggest, last: last };
  }

  // Pure: the box value after swapping piece `index` for `name`, ending in
  // ", " so the next tag can be typed straight away (#756), as after Enter.
  // The trailing separator is trimmed again when focus leaves the box, so no
  // empty tag is saved (see onFocusOut).
  function replaceTag(value, index, name) {
    var tokens = splitTags(value);
    tokens[index] = name;
    while (tokens.length && !tokens[tokens.length - 1]) tokens.pop();
    return tokens.join(",") + ", ";
  }

  var existing = [];
  var loading = null;
  var panel = null;

  function loadExisting() {
    if (loading) return loading;
    if (typeof fetch !== "function" || typeof DOMParser === "undefined" || typeof URL === "undefined") {
      loading = Promise.resolve();
      return loading;
    }
    loading = Promise.resolve()
      .then(function () {
        return fetch(new URL("../tags/", location.href).href, { credentials: "same-origin", cache: "no-store" });
      })
      .then(function (r) {
        return r && r.ok ? r.text() : "";
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var seen = {};
        existing = [];
        Array.prototype.forEach.call(doc.querySelectorAll(".tag-list-name"), function (n) {
          var name = String(n.textContent || "").trim();
          if (name && !seen[name]) {
            seen[name] = true;
            existing.push(name);
          }
        });
      })
      .catch(function () {});
    return loading;
  }

  // Chips are ~20 px tall: too small for a finger. On a coarse pointer (a
  // phone) give them a 44 px tap target (#756). A rule, not inline style, so
  // the media query can apply; `!important` beats the inline `padding`.
  function ensureChipStyle() {
    if (document.getElementById("cms-tags-chip-style")) return;
    var s = document.createElement("style");
    s.id = "cms-tags-chip-style";
    s.textContent =
      "@media (pointer: coarse) { #cms-tags-suggest .cms-tags-chip { min-height: 44px !important; min-width: 44px !important; padding-top: 0 !important; padding-bottom: 0 !important; } }";
    document.head.appendChild(s);
  }

  function button(label, title, onPick) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.className = "cms-tags-chip";
    b.style.cssText =
      "margin:0 6px 4px 0;padding:1px 8px;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer;";
    ensureChipStyle();
    // Keep focus in the Tags box so the click does not blur it first.
    b.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });
    b.addEventListener("click", onPick);
    return b;
  }

  // The panel is an aria-live region. A live region announces what is ADDED to
  // it, not what it already holds when it appears, so it is created empty and
  // filled one frame later; once it exists it is emptied, never hidden or
  // removed, so every later change is announced too.
  var boxEl = null; // the Tags box the panel belongs to
  var boxWith = true; // whether suggestions (not just warnings) are shown

  function nextFrame(fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 16);
  }

  // Removing the button that has focus fires `focusout` synchronously; that
  // handler must not re-render in the middle of the removal.
  var clearing = false;

  function clearPanel() {
    clearing = true;
    try {
      while (panel.firstChild) panel.removeChild(panel.firstChild);
    } finally {
      clearing = false;
    }
    panel.style.marginTop = "0";
  }

  function render(el, withSuggestions) {
    boxEl = el;
    boxWith = withSuggestions;
    var a = analyze(el.value, existing);
    if (!withSuggestions) a.suggest = [];
    if (!a.near.length && !a.suggest.length) {
      if (panel) clearPanel();
      return;
    }
    var fresh = !panel || !panel.isConnected;
    if (fresh) {
      panel = document.createElement("div");
      panel.id = "cms-tags-suggest";
      panel.setAttribute("role", "status");
      panel.setAttribute("aria-live", "polite");
      panel.style.cssText = "font-size:13px;line-height:1.5;";
    }
    if (panel.previousSibling !== el) el.parentNode.insertBefore(panel, el.nextSibling);
    if (fresh) {
      clearPanel();
      nextFrame(function () {
        if (boxEl) render(boxEl, boxWith);
      });
      return;
    }
    clearPanel();
    panel.style.marginTop = "6px";
    function pick(index, name) {
      return function () {
        setValue(el, replaceTag(el.value, index, name));
        el.focus();
      };
    }
    a.near.forEach(function (n) {
      var line = document.createElement("div");
      var tag = n.matches.length > 1 ? "the existing tags " : "the existing tag ";
      line.appendChild(
        document.createTextNode(
          "“" +
            n.typed +
            "” is a new tag that is nearly identical to " +
            tag +
            n.matches.map(quote).join(", ") +
            " (ignoring case, plurals, spaces and punctuation). "
        )
      );
      n.matches.forEach(function (m) {
        line.appendChild(button("Use " + quote(m), "Replace " + quote(n.typed) + " with " + quote(m), pick(n.index, m)));
      });
      panel.appendChild(line);
    });
    if (a.suggest.length) {
      var line2 = document.createElement("div");
      line2.appendChild(document.createTextNode("Existing tags: "));
      a.suggest.forEach(function (m) {
        line2.appendChild(button(m, "Use the existing tag " + quote(m), pick(a.last, m)));
      });
      panel.appendChild(line2);
    }
  }

  function quote(s) {
    return "“" + s + "”";
  }

  function onInput(e) {
    var el = e.target;
    if (!isTagsBox(el)) return;
    // #756: keep an in-progress trailing space away from Decap's trim.
    if (!e.isComposing && holdsTrailingSpace(el.value, atEnd(el))) e.stopImmediatePropagation();
    render(el, true);
  }

  function onFocusIn(e) {
    var el = e.target;
    if (!isTagsBox(el)) return;
    render(el, true);
    loadExisting().then(function () {
      if (document.activeElement === el) render(el, true);
    });
  }

  function onFocusOut(e) {
    if (clearing) return;
    var t = e.target;
    var inPanel = !!panel && panel.contains(t);
    if (!isTagsBox(t) && !inPanel) return;
    // Focus moving between the box and its own buttons (Tab, Shift+Tab, or one
    // button to the next) must not rebuild the panel: that would remove the
    // very button about to take focus and drop focus on <body>.
    var to = e.relatedTarget;
    if (to && ((panel && panel.contains(to)) || isTagsBox(to))) return;
    // Focus left the box and its panel. A box left ending in a separator
    // (after Enter, or an applied suggestion) would save an empty tag: Decap's
    // blur handler tidies only what is shown, never the stored list. Trim the
    // separator through the box so Decap stores the tidied list (#756).
    if (isTagsBox(t) && /[,\s]$/.test(t.value) && t.value.replace(/[,\s]+$/, "")) {
      setValue(t, t.value.replace(/[,\s]+$/, ""));
    }
    // Keep the near-duplicate warnings (they matter at Save time) but drop the
    // as-you-type suggestions.
    render(isTagsBox(t) ? t : boxEl, false);
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);

  // Pure helpers, exposed for the unit test (e2e/tags-suggest.test.js).
  window.__tagsInput = { keyOf: keyOf, analyze: analyze, replaceTag: replaceTag, holdsTrailingSpace: holdsTrailingSpace };
})();
