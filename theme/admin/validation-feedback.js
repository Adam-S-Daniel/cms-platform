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

  function raisedByDecap() {
    return document.querySelector(DECAP_TOAST) !== null;
  }

  function toast(msg) {
    try {
      removeToast();
      var t = document.createElement("div");
      t.textContent = msg;
      t.setAttribute("role", "alert");
      t.setAttribute("data-validation-feedback-toast", "");
      // Inline style, as the other admin toasts: admin-css-banned-patterns
      // scans .css files and <style> blocks only.
      t.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
        "background:#7f1d1d;color:#fff;padding:14px 20px;border-radius:8px;" +
        "font:14px/1.4 system-ui,sans-serif;max-width:min(560px,calc(100vw - 32px));z-index:2147483647;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.3);";
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

  function report() {
    // An earlier "Not saved yet" must not outlive a save that went through.
    removeToast();
    var lists = document.querySelectorAll(ERROR_LIST);
    if (!lists.length) return;
    var first = lists[0];
    try {
      first.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      /* old browser: the toast still says what is wrong */
    }
    if (raisedByDecap()) return;
    var msg = messageOf(first);
    var more = lists.length - 1;
    toast("Not saved yet. " + msg + (more > 0 ? " (" + more + " more below.)" : ""));
  }

  function afterClick(e) {
    if (!isSaveOrPublish(e.target)) return;
    var frames = SETTLE_FRAMES;
    function tick() {
      if (--frames > 0) window.requestAnimationFrame(tick);
      else report();
    }
    window.requestAnimationFrame(tick);
  }

  setLocalePhrase();
  addStyle();
  document.addEventListener("click", afterClick, true);
})();
