/*
 * admin/collection-controls-trim.js — EDITOR SHELLS ONLY. Removes the two
 * collection-list controls above an entry list that nobody on these sites
 * uses, and takes their row back with them.
 *
 * ── What it removes ────────────────────────────────────────────────────
 *   1. The "Sort by" dropdown.
 *   2. The list/grid view-style toggle.
 *   3. The row itself — `CollectionControlsContainer` — but ONLY when those
 *      two were the whole of it. The container also carries the Filter and
 *      Group dropdowns, which config.base.yml really does configure (posts
 *      and projects both declare `view_filters`), so it is hidden by
 *      emptiness, never by name.
 *
 * Step 3 is the point of the change as much as steps 1 and 2. With just the
 * children hidden the row still costs its own `margin-top: 22px` plus the
 * 20px `gap` its parent reserves for it — 42px of nothing, above the fold,
 * on a 393px-wide phone.
 *
 * ── Why remove them ────────────────────────────────────────────────────
 * Reported from a live /admin session: neither control earns its space on
 * either consumer, and both sit directly above the entry list on a phone.
 * The sort dropdown is the weaker of the two — a site whose collections
 * declare no `sortable_fields` gets Decap's DEFAULTS (commit date, the
 * identifier field, commit author), so on jodidaniel.com it cannot even
 * offer the manual `weight` order the sections are actually rendered in.
 * It sorts an editor's own list by three keys they never think in.
 *
 * ── Why a shim and not config ──────────────────────────────────────────
 * Decap has a config lever for exactly one of the two: `sortable_fields: []`
 * leaves `sortableFields.length` at zero and the sort control never mounts.
 * There is none for the view-style toggle. Taking that route would mean the
 * key on every collection in the platform's config.base.yml AND in each
 * consumer's site-owned admin/collections.site.yml seam — a per-collection
 * opt-out that a newly added collection silently misses, in a file the
 * platform does not own. One shim covers every collection on both
 * consumers, present and future.
 *
 * ── Why the sort control is matched by its LABEL ───────────────────────
 * Decap renders Sort, Filter and Group with the same component — a
 * `ControlButton` inside the shared dropdown wrapper — as siblings of the
 * view-style toggle, in DOM order [view-style, group?, filter?, sort?].
 * Nothing in the class list, the attributes or the structural position
 * separates sort from filter: each of the three is optional, so "the last
 * child" is the sort control on one collection and the filter control on
 * the next. Filter is configured and wanted, so a selector that cannot tell
 * them apart would silently delete a control nobody asked to remove.
 *
 * The visible label is the only discriminator, and it fails in the right
 * direction: a Decap copy change or a non-English locale makes the match
 * miss and the sort dropdown simply comes back — never a wrongly hidden
 * filter, never a page error. That is the same degrade-safe argument
 * one-door-publish.js makes for its class-substring selectors, and the
 * matcher is pure, so e2e/admin-collection-controls-trim.test.js pins both
 * directions of it in a vm sandbox.
 *
 * The view-style toggle needs no such care: `ViewControlsSection` is its own
 * component and nothing else uses it. Emotion's class hash churns between
 * Decap releases but the trailing component-name segment does not — the
 * substring convention native-preview-href.js and one-door-publish.js use.
 *
 * ── Why CSS-hide and never removeChild ─────────────────────────────────
 * The native-preview-href.js precedent: Decap is React-driven and re-mounts
 * elements it finds missing, which the observer then re-removes — a fight
 * loop that wedged the editor mid-flow. `display:none` leaves the node
 * exactly where React expects it, and React does not observe inline styles.
 *
 * ── Scope: the EDITOR shells (index.html + index-local.html) ───────────
 * index-test.html is deliberately excluded and the lint asserts the
 * negative. It is the REHEARSAL surface — the specs that drive it exist to
 * tell us Decap still behaves the way these shims assume, so it keeps
 * rendering Decap's own stock collection chrome. Same scope argument
 * one-door-publish.js makes for the Status control and the workflow board.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__collectionControlsTrimInstalled) return;
  window.__collectionControlsTrimInstalled = true;

  var CONTAINER = '[class*="CollectionControlsContainer"]';
  var VIEW_STYLE = '[class*="ViewControlsSection"]';
  var CONTROL_BUTTON = '[class*="ControlButton"]';
  var HIDDEN_ATTR = "data-controls-trimmed";

  // ── Pure label matcher (unit-tested) ──────────────────────────────────
  // Decap 3.15.1's en `collection.collectionTop.sortBy` is "Sort by"; its two
  // siblings are "Filter by" and "Group by". Anchored, so a menu item that
  // merely starts with the word ("Sort by date") cannot widen it, and
  // whitespace-tolerant because this reads a DOM textContent.
  function isSortControlLabel(text) {
    return /^sort\s+by$/i.test(String(text == null ? "" : text).trim());
  }

  // The trigger button's visible text for one dropdown wrapper. Prefer the
  // `ControlButton` css label; fall back to the wrapper's first button, so
  // that an emotion label rename degrades to "still matches" rather than
  // "silently matches nothing".
  //
  // The fallback is `[role="button"], button` and the ROLE half is the one
  // that does the work: Decap 3.15.1 renders these dropdown triggers as
  // `<span role="button">`, not `<button>` — confirmed against the live
  // bundle, and the container's own emotion rule targets `span[role='button']`
  // for the same reason. A bare "button" fallback would silently find nothing.
  function controlLabel(el) {
    var btn = null;
    try {
      btn =
        el.querySelector(CONTROL_BUTTON) ||
        el.querySelector('[role="button"], button');
    } catch (e) {
      return "";
    }
    return btn ? btn.textContent : "";
  }

  function isViewStyleControl(el) {
    try {
      return !!(el.matches && el.matches(VIEW_STYLE));
    } catch (e) {
      return false;
    }
  }

  // Write nothing when the element is already in the requested state: an
  // unconditional style write fires an `attributes` mutation inside the
  // subtree this observer itself watches, so the steady state must not touch
  // the DOM. The conditional still re-asserts after emotion re-emits a
  // `style` attribute over the inline display:none.
  function setHidden(el, hidden) {
    if (!el || !el.style) return;
    var isHidden = el.style.getPropertyValue("display") === "none";
    if (isHidden === hidden) return;
    if (hidden) {
      // Out of the layout, the tab order and the a11y tree — without touching
      // the DOM tree React reconciles against.
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("tabindex", "-1");
      el.setAttribute(HIDDEN_ATTR, "1");
    } else {
      // Only ever reached by the CONTAINER, when a route change gives a
      // reused container a filter or group control it did not have before.
      el.style.removeProperty("display");
      el.style.removeProperty("visibility");
      el.style.removeProperty("pointer-events");
      el.removeAttribute("aria-hidden");
      el.removeAttribute("tabindex");
      el.removeAttribute(HIDDEN_ATTR);
    }
  }

  function trim(container) {
    var kids = container.children || [];
    var keptSomething = false;
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (isViewStyleControl(kid) || isSortControlLabel(controlLabel(kid))) {
        setHidden(kid, true);
      } else {
        keptSomething = true;
      }
    }
    // Nothing left to show ⇒ take the row's own margin and its parent's gap
    // back too. Something left (a Filter or Group dropdown) ⇒ the row stays,
    // including after a route change onto a collection that has one.
    setHidden(container, !keptSomething);
  }

  function apply() {
    var containers;
    try {
      containers = document.querySelectorAll(CONTAINER);
    } catch (e) {
      return;
    }
    for (var i = 0; i < containers.length; i++) trim(containers[i]);
  }

  // Coalesce to one pass per frame — Decap re-renders the collection view on
  // every route change, search keystroke and entry load, and an unthrottled
  // observer callback would re-run these queries on each one.
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    var run = function () {
      pending = false;
      apply();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  try {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    /* MutationObserver unavailable — the hashchange hook below still runs */
  }
  window.addEventListener("hashchange", schedule);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }

  // Pure matcher, exported for unit testing (the one-door-publish.js /
  // oauth-app-restriction-detector.js idiom). Nothing here reads DOM state.
  window.__collectionControlsTrim = {
    installed: true,
    isSortControlLabel: isSortControlLabel,
  };
})();
