/*
 * admin/route-focus.js — UX round 3 (keyboard and assistive tech), ad-kbd K8
 * and jd-kbd F5.
 *
 * ── The bug ───────────────────────────────────────────────────────────
 * Decap is a hash-routed React app. Pressing Enter on a list entry, Back,
 * Save or Delete unmounts the element that had focus, so `document.activeElement`
 * falls back to <body>. The next Tab then restarts near the top of the page
 * (after Back it lands on "Search all"), a screen-reader user hears nothing
 * about the new view, and an editor who has just saved loses their place.
 * There is also no skip link: the first entry on a collection list is the
 * 17th Tab stop.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * 1. A "Skip to content" link as the first child of <body>, visible only
 *    while it has focus. Its click is handled here (never followed: a
 *    `#fragment` navigation would change the hash Decap routes on) and moves
 *    focus to the new view's content target (below).
 * 2. When focus has been LOST (it is on <body> or nothing), put it back
 *    somewhere sensible, after
 *      - a `hashchange` (Enter on an entry, Back, "+ New", a delete that
 *        returns to the list), or
 *      - a trusted click on a button or menu item (Save, Publish, Delete, a
 *        list row's remove "x", a Status choice) or Enter/Space on a menu
 *        item (react-aria-menubutton selects without a click) that then
 *        left focus on <body> because that control was removed or disabled.
 *    Where focus goes:
 *      - a collection list or any other page: the `main` heading (`h1`), else
 *        `main` itself;
 *      - a NEW entry: the first form field;
 *      - an existing entry: the toolbar's Back link, the stable anchor at the
 *        top of the editor (the editor has no `main` or heading).
 *    The skip link goes to the first form field of an existing entry instead,
 *    since "skip to content" there means the form.
 *
 * ── It never fights another shim ──────────────────────────────────────
 * It acts ONLY while `document.activeElement` is <body> or null, checked
 * again on every animation frame it polls and immediately before it moves
 * focus. Anything that already put focus somewhere wins: the tags box
 * (tags-input.js refocuses its input), the first invalid field after a blocked
 * Save or Publish (validation-feedback.js, three frames after the click). After
 * a click it waits six frames before its first move, so that focus return lands
 * first, and it stops for good as soon as the person presses a key or presses a
 * pointer button (they have taken over). A click from script (autosave-on-hide
 * clicking Save, publish-baseline-refresh) is ignored: only trusted clicks
 * count. A search route is left alone: Decap re-renders the box while you type.
 * Nothing moves focus on the initial page load.
 *
 * ── Selector strategy / Decap-upgrade safety ──────────────────────────
 * Verified on Decap 3.15.1 (list: `main` > `h1` CollectionTopHeading; editor:
 * `div` EditorContainer holding the toolbar `a` ToolbarSectionBackLink and the
 * ControlContainer fields; no `main` in the editor). Same Emotion
 * component-name substring convention as list-row-affordance.js: if a class
 * name disappears the target is just not found and this shim is a silent
 * no-op (the skip link then does nothing visible).
 *
 * The target of a programmatic focus gets `tabindex="-1"` when it is not
 * natively focusable (a heading), and `outline: none` only for that kind of
 * target, since a heading is not an interactive control.
 */
(function () {
  "use strict";

  if (window.__routeFocusInstalled) return;
  window.__routeFocusInstalled = true;

  var SKIP_ID = "cms-skip-link";
  var STYLE_ID = "cms-route-focus-style";
  var MARK = "data-route-focus";
  var EDITOR = '[class*="EditorContainer"]';
  var CONTROL = '[class*="ControlContainer"]';
  var BACK_LINK = 'a[class*="ToolbarSectionBackLink"]';
  var APP_MAIN = '[class*="AppMainContainer"]';
  var FOCUSABLE =
    'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]';
  var NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/;
  // Frames to poll for the new view to render and for focus to be lost (about
  // five seconds at 60 Hz; the loop pauses with the tab).
  var MAX_FRAMES = 300;
  // After a click, frames to leave focus alone first: validation-feedback.js
  // focuses the first invalid field three frames after a blocked Save.
  var ACTIVATION_SETTLE = 6;

  // Which view a route shows. "search" is left alone.
  function viewOf(hash) {
    var h = String(hash || "").split("?")[0];
    if (/^#\/search(\/|$)/.test(h)) return "search";
    if (/^#\/collections\/[^/]+\/new\/?$/.test(h)) return "new";
    if (/^#\/collections\/[^/]+\/entries\//.test(h)) return "entry";
    return "page";
  }

  function lost() {
    var a = document.activeElement;
    return !a || a === document.body || a === document.documentElement;
  }

  function firstField() {
    var editor = document.querySelector(EDITOR);
    if (!editor) return null;
    var fields = editor.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.offsetParent === null) continue;
      if (f.closest && !f.closest(CONTROL)) continue;
      return f;
    }
    return null;
  }

  function backLink() {
    return document.querySelector(BACK_LINK);
  }

  function pageTarget() {
    return document.querySelector("main h1") || document.querySelector("main");
  }

  // The element focus belongs on in `view`, or null while it has not rendered.
  function targetFor(view, forSkip) {
    if (view === "new") return firstField() || backLink();
    if (view === "entry") return (forSkip && firstField()) || backLink();
    return pageTarget() || (forSkip ? document.querySelector(APP_MAIN) : null);
  }

  function focusOn(el, preventScroll) {
    try {
      var natural = NATIVE.test(String(el.tagName)) || el.getAttribute("contenteditable") === "true";
      if (!natural) {
        if (el.getAttribute("tabindex") === null) el.setAttribute("tabindex", "-1");
        el.setAttribute(MARK, "");
      }
      el.focus({ preventScroll: !!preventScroll });
    } catch {
      /* the element went away mid-call: nothing to move */
    }
  }

  var job = 0;

  function cancel() {
    job++;
  }

  // Poll one frame at a time for `opts.view`'s target; move focus once,
  // and only while focus is lost.
  //   opts.wait   frames to leave alone first
  //   opts.source the clicked control: focus must have been lost WITH it
  function start(opts) {
    var id = ++job;
    var frames = 0;
    function tick() {
      if (id !== job) return;
      if (++frames > MAX_FRAMES) return;
      if (frames > opts.wait && lost()) {
        var src = opts.source;
        var sourceGone = !src || !src.isConnected || src.disabled === true;
        if (sourceGone) {
          var el = targetFor(opts.view || viewOf(location.hash), false);
          if (el) {
            focusOn(el, opts.preventScroll);
            return;
          }
        }
      }
      window.requestAnimationFrame(tick);
    }
    window.requestAnimationFrame(tick);
  }

  function onHashChange() {
    var view = viewOf(location.hash);
    if (view === "search") {
      cancel();
      return;
    }
    start({ wait: 0, view: view, preventScroll: false });
  }

  function onActivation(source) {
    var view = viewOf(location.hash);
    if (view === "search") return;
    start({ wait: ACTIVATION_SETTLE, view: view, source: source, preventScroll: true });
  }

  function control(target) {
    return target && target.closest ? target.closest('button, [role="menuitem"]') : null;
  }

  function onClick(e) {
    if (e.isTrusted === false) return;
    var c = control(e.target);
    if (c && c.id !== SKIP_ID) onActivation(c);
  }

  function onKeyDown(e) {
    // Any key or pointer press is the person taking over, except the press that
    // is itself an activation, handled below.
    cancel();
    if (e.isTrusted === false || (e.key !== "Enter" && e.key !== " ")) return;
    var item = e.target && e.target.closest ? e.target.closest('[role="menuitem"]') : null;
    if (item && String(item.tagName || "").toUpperCase() !== "BUTTON") onActivation(item);
  }

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "#" + SKIP_ID + "{position:fixed;left:8px;top:-100px;z-index:2147483000;padding:8px 14px;" +
      "background:#fff;color:#1d4ed8;border:2px solid #1d4ed8;border-radius:4px;" +
      "font:600 14px/1.2 system-ui,sans-serif;text-decoration:none}" +
      "#" + SKIP_ID + ":focus{top:8px}" +
      "[" + MARK + "]:focus{outline:none}";
    document.head.appendChild(s);
  }

  function addSkipLink() {
    if (document.getElementById(SKIP_ID)) return;
    var a = document.createElement("a");
    a.id = SKIP_ID;
    a.href = "#";
    a.textContent = "Skip to content";
    a.addEventListener("click", function (e) {
      // Never follow it: a `#fragment` would change the hash Decap routes on.
      e.preventDefault();
      cancel();
      var el = targetFor(viewOf(location.hash), true);
      if (el) focusOn(el, false);
    });
    document.body.insertBefore(a, document.body.firstChild);
  }

  function install() {
    addStyle();
    addSkipLink();
  }

  window.addEventListener("hashchange", onHashChange);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", cancel, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }

  window.__routeFocus = { viewOf: viewOf };
})();
