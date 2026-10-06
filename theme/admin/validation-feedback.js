/*
 * admin/validation-feedback.js — cms-platform#730.
 *
 * ── What an editor saw (reproduced live against Decap 3.15.1) ─────────
 * A field with a `pattern: [regex, message]` that fails blocks Save and
 * Publish, and:
 *   1. Nothing happens where she clicked. Decap raises its red "you missed
 *      a required field" toast ONLY for a missing-value error
 *      (`ui.toast.missingRequiredField`, raised in persistEntry when a
 *      field error has type PRESENCE); a pattern error (type PATTERN)
 *      just rejects the save. The message sits under the field, usually
 *      off screen on a long form.
 *   2. The message read "URL SLUG DIDN'T MATCH THE PATTERN: USE LOWERCASE
 *      LETTERS ... EXAMPLE MY-TOOL.." — Decap's `regexPattern` phrase
 *      (`%{fieldLabel} didn't match the pattern: %{pattern}.`) wrapped
 *      around the site's own sentence, which already says what is
 *      expected (and often ends in its own period, hence "..").
 *   3. The error text is upper-cased by Decap's styling, which does worse
 *      than shout: "/pages/about/" is shown as "/PAGES/ABOUT/", the wrong
 *      thing to type.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 *   1. Replace the `regexPattern` phrase with `%{fieldLabel}: %{pattern}`,
 *      so the site's message (the part that says what to type) shows
 *      alone, after the field's name. Only the English phrase is replaced;
 *      a site that sets another `locale` keeps that locale's wording.
 *   2. Turn the upper-casing off for field error lists.
 *   3. After a click on Save or Publish, if a field error list is on
 *      screen and Decap raised no toast of its own, scroll the first one
 *      into view and show a toast with its message. Decap's own toast
 *      still covers the missing-value case, so there is never a second one.
 *
 * ── Follow-ups (cms-platform#750) ─────────────────────────────────────
 *   4. The toast used to sit fixed at the bottom for 10 s, over the field
 *      it named (the last field cannot scroll any higher) and swallowing
 *      clicks. It now sits on whichever edge the field is NOT near, lets
 *      every click through except on its own close button, and can be
 *      dismissed.
 *   5. A field inside a list row names the row ("Item 2 (Beta): URL: ..."),
 *      by its position and its summary; a collapsed row is opened so the
 *      field the message is about is on screen.
 *   6. Decap raises "you missed a required field" ONLY for an empty
 *      required field (PRESENCE), but its toast outlives the click that
 *      raised it by 8 s. A format error fixed-and-retried inside those 8 s
 *      used to find that stale toast, stand down, and leave the editor
 *      reading "missed a required field" for a format error (reproduced
 *      against Decap 3.15.1). Only a toast that appeared AFTER the click
 *      counts as Decap's answer to it; a stale error toast is closed when
 *      this one is shown.
 *
 * Everything keys on Decap's public surface (`CMS.getLocale`, the button
 * text) or on the `ControlErrorsList` Emotion label; if Decap changes any of
 * them the affected part is a silent no-op and Decap behaves as before.
 */
(function () {
  "use strict";

  var PHRASE = "%{fieldLabel}: %{pattern}";
  var ERROR_LIST = '[class*="ControlErrorsList"]';
  // Decap's own toasts are react-toastify; see raisedByDecap().
  var DECAP_TOAST = '[class*="Toastify__toast"]';
  var CLICK_TARGET = 'button, [role="menuitem"], [role="button"]';
  var SAVE_OR_PUBLISH = /^(save|publish)\b/i;
  var TOAST_MS = 10000;
  // A list row, its summary (kept in the DOM, shown only while the row is
  // collapsed), and the row's own expand/collapse button.
  var ROW = '[class*="SortableListItem"]';
  var ROW_LABEL = '[class*="NestedObjectLabel"]';
  var ROW_TOGGLE = '[class*="StyledListItemTopBar"] button';
  var CONTROL = '[class*="ControlContainer"]';
  var DECAP_CLOSE = '[class*="Toastify__close-button"]';
  // Frames to let Decap validate and re-render after a click before looking.
  var SETTLE_FRAMES = 3;

  function setLocalePhrase() {
    try {
      var en = window.CMS && typeof window.CMS.getLocale === "function" ? window.CMS.getLocale("en") : null;
      var widget = en && en.editor && en.editor.editorControlPane && en.editor.editorControlPane.widget;
      if (widget && typeof widget.regexPattern === "string") widget.regexPattern = PHRASE;
    } catch {
      /* Decap's locale shape changed — keep its wording. */
    }
  }

  function addStyle() {
    var s = document.createElement("style");
    s.setAttribute("data-validation-feedback", "");
    s.textContent = ERROR_LIST + " { text-transform: none !important; }";
    (document.head || document.documentElement).appendChild(s);
  }

  // The toolbar's "Publish" control only opens a menu (aria-haspopup); the
  // menu items inside it ("Publish now", ...) are what publish.
  function isSaveOrPublish(el) {
    var btn = el && el.closest ? el.closest(CLICK_TARGET) : null;
    if (!btn || btn.getAttribute("aria-haspopup") === "true") return false;
    return SAVE_OR_PUBLISH.test(String(btn.textContent || "").trim());
  }

  // One error list holds one <li> per failed rule on that field; read them
  // apart, since their textContent runs together with no space. Each ends in
  // a period so the toast reads as sentences, whatever the site wrote.
  function messageOf(list) {
    var items = list.querySelectorAll ? list.querySelectorAll("li") : [];
    var texts = [];
    for (var i = 0; i < items.length; i++) {
      var t = String(items[i].textContent || "").trim();
      if (t) texts.push(/[.!?)]$/.test(t) ? t : t + ".");
    }
    return texts.length ? texts.join(" ") : String(list.textContent || "").trim();
  }

  function removeToast() {
    try {
      var old = document.querySelector("[data-validation-feedback-toast]");
      if (old) old.remove();
    } catch {
      /* ignore */
    }
  }

  function decapToasts() {
    return Array.prototype.slice.call(document.querySelectorAll(DECAP_TOAST));
  }

  // Decap's toast lives 8 s, so one left over from an earlier click is not
  // an answer to this one: only a toast that was not there at the click is.
  function raisedByDecap(before) {
    var now = decapToasts();
    for (var i = 0; i < now.length; i++) if (before.indexOf(now[i]) < 0) return true;
    return false;
  }

  // An earlier "you missed a required field" would sit beside a message that
  // says something else; close it through Decap's own close button.
  function closeStaleDecapToasts(before) {
    for (var i = 0; i < before.length; i++) {
      try {
        if (!/Toastify__toast--error/.test(String(before[i].className || ""))) continue;
        var x = before[i].querySelector(DECAP_CLOSE);
        if (x) x.click();
      } catch {
        /* the stale toast is only noise; leave it */
      }
    }
  }

  // The list rows around a field, outermost first.
  function rowsOf(el) {
    var rows = [];
    var n = el && el.closest ? el.closest(ROW) : null;
    while (n) {
      rows.unshift(n);
      var up = n.parentElement;
      n = up && up.closest ? up.closest(ROW) : null;
    }
    return rows;
  }

  function summaryOf(row) {
    var label = row.querySelector(ROW_LABEL);
    return label ? String(label.textContent || "").trim() : "";
  }

  // "Item 2 (Beta)": the row's 1-based position among its siblings and the
  // summary Decap shows for it. The summary is the editor's own name for it,
  // the position is what is left when the summary is blank.
  function rowName(row) {
    var sibs = row.parentElement ? row.parentElement.children : [];
    var pos = 0;
    for (var i = 0; i < sibs.length; i++) {
      if (sibs[i].matches && sibs[i].matches(ROW)) {
        pos++;
        if (sibs[i] === row) break;
      }
    }
    var summary = summaryOf(row);
    return "Item " + (pos || "?") + (summary ? " (" + summary + ")" : "");
  }

  function rowPath(list) {
    try {
      return rowsOf(list).map(rowName).join(" > ");
    } catch {
      return "";
    }
  }

  // A collapsed row keeps its fields in the DOM but hidden, so the message
  // would point at nothing. Open each collapsed row around the field (a
  // collapsed row is the one whose summary is showing).
  function expandRowsAround(list) {
    try {
      var rows = rowsOf(list);
      for (var i = 0; i < rows.length; i++) {
        var label = rows[i].querySelector(ROW_LABEL);
        var toggle = rows[i].querySelector(ROW_TOGGLE);
        if (label && label.offsetParent !== null && toggle) toggle.click();
      }
    } catch {
      /* Decap's list markup changed: the toast still names the row */
    }
  }

  // The toast goes on the edge of the screen the field is not near. Called
  // after the (instant) scroll, so the field is where it will stay.
  function fieldInLowerHalf(list) {
    try {
      var box = list.closest && list.closest(CONTROL) ? list.closest(CONTROL) : list;
      var r = box.getBoundingClientRect();
      return r.top + r.height / 2 > window.innerHeight / 2;
    } catch {
      return false;
    }
  }

  function toast(msg, atTop) {
    try {
      removeToast();
      var t = document.createElement("div");
      t.setAttribute("role", "alert");
      t.setAttribute("data-validation-feedback-toast", "");
      // Inline style, as the other admin toasts: admin-css-banned-patterns
      // scans .css files and <style> blocks only. pointer-events:none lets
      // every click through to the form; only the close button takes one.
      t.style.cssText =
        "position:fixed;" +
        (atTop ? "top:12px;" : "bottom:24px;") +
        "left:50%;transform:translateX(-50%);pointer-events:none;" +
        "display:flex;align-items:flex-start;gap:12px;" +
        "background:#7f1d1d;color:#fff;padding:14px 12px 14px 20px;border-radius:8px;" +
        "font:14px/1.4 system-ui,sans-serif;max-width:min(560px,calc(100vw - 32px));z-index:2147483647;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.3);";
      var text = document.createElement("span");
      text.textContent = msg;
      var close = document.createElement("button");
      close.setAttribute("type", "button");
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "\u00d7";
      close.style.cssText =
        "pointer-events:auto;cursor:pointer;background:none;border:0;color:inherit;" +
        "font:20px/1 system-ui,sans-serif;padding:0 6px;margin:-2px 0 0;";
      close.addEventListener("click", function () {
        try {
          t.remove();
        } catch {
          /* ignore */
        }
      });
      t.appendChild(text);
      t.appendChild(close);
      document.body.appendChild(t);
      setTimeout(function () {
        try {
          t.remove();
        } catch {
          /* ignore */
        }
      }, TOAST_MS);
    } catch {
      /* DOM not ready — nothing to show on. */
    }
  }

  function report(before) {
    // An earlier "Not saved yet" must not outlive a save that went through.
    removeToast();
    var lists = document.querySelectorAll(ERROR_LIST);
    if (!lists.length) return;
    var first = lists[0];
    expandRowsAround(first);
    try {
      // Instant, so the toast can be placed against where the field ends up.
      first.scrollIntoView({ block: "center", behavior: "auto" });
    } catch {
      /* old browser: the toast still says what is wrong */
    }
    if (raisedByDecap(before)) return;
    closeStaleDecapToasts(before);
    var where = rowPath(first);
    var msg = (where ? where + ": " : "") + messageOf(first);
    var more = lists.length - 1;
    toast("Not saved yet. " + msg + (more > 0 ? " (" + more + " more below.)" : ""), fieldInLowerHalf(first));
  }

  function afterClick(e) {
    if (!isSaveOrPublish(e.target)) return;
    // Taken before Decap handles the click (this listener is in the capture
    // phase), so a toast raised BY the click is told from one left over.
    var before = decapToasts();
    var frames = SETTLE_FRAMES;
    function tick() {
      if (--frames > 0) window.requestAnimationFrame(tick);
      else report(before);
    }
    window.requestAnimationFrame(tick);
  }

  setLocalePhrase();
  addStyle();
  document.addEventListener("click", afterClick, true);
})();
