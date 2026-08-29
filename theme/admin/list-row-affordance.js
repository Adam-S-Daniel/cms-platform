/*
 * admin/list-row-affordance.js — issue #329 item 5.
 *
 * ── The bug ────────────────────────────────────────────────────────────
 * List-widget rows (e.g. About → Bio Paragraphs) start COLLAPSED, and the
 * only way to expand one is a bare 32×26px chevron button — the row's own
 * summary text is not clickable, and the chevron carries no `aria-label`
 * at all (`null`), so a screen-reader user gets no hint what the control
 * does either.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * Two independent, idempotent DOM annotations, both re-applied on every
 * pass so Decap re-rendering a row never leaves it un-annotated:
 *
 *   1. Every list-row top bar's collapse chevron (its first `<button>`
 *      descendant) gets `aria-label="Expand or collapse this item"` when
 *      it doesn't already have one.
 *   2. Every row's summary-text label becomes clickable: a click on it
 *      finds the row's own top-bar chevron and clicks THAT (never
 *      reimplementing the expand/collapse logic itself), so the row
 *      opens exactly as if the chevron had been clicked directly.
 *
 * ── Idempotence guard ─────────────────────────────────────────────────
 * `data-row-affordance="1"` is a real DOM attribute, not an expando
 * property, specifically so a fresh MutationObserver pass over a label
 * Decap re-rendered (a new DOM node, same content) can tell "already
 * wired" from "needs wiring" by reading the node itself — an expando
 * property would vanish the instant Decap swaps in a new element for the
 * same logical row.
 *
 * ── Selector strategy / Decap-upgrade safety ────────────────────────────
 * Same substring convention as elsewhere in this directory (see
 * native-preview-href.js's "Selector strategy"): Emotion's class hash
 * churns between releases, the trailing component-name segment doesn't,
 * so `[class*="StyledListItemTopBar"]` / `[class*="NestedObjectLabel"]` /
 * `[class*="SortableListItem"]` survive minor-version churn. If any of
 * these class names is ever removed outright, the corresponding
 * `querySelectorAll` simply returns nothing and this shim silently stops
 * annotating that surface — never a page error.
 *
 * Verified live: clicking the label expands the row (item height goes
 * from 75px to 258px) and the chevron reports the new aria-label.
 */
(function () {
  "use strict";

  var TOPBAR_SELECTOR = '[class*="StyledListItemTopBar"]';
  var LABEL_SELECTOR = '[class*="NestedObjectLabel"]';
  var SORTABLE_ITEM_SELECTOR = '[class*="SortableListItem"]';
  var CHEVRON_LABEL = "Expand or collapse this item";
  var AFFORDANCE_ATTR = "data-row-affordance";

  function onLabelClick(lab) {
    return function () {
      var item = lab.closest(SORTABLE_ITEM_SELECTOR);
      if (!item) return;
      var chevron = item.querySelector(TOPBAR_SELECTOR + " button");
      if (chevron) chevron.click();
    };
  }

  function labelChevron(topBar) {
    return topBar.querySelector("button");
  }

  function sync() {
    var topBars = document.querySelectorAll(TOPBAR_SELECTOR);
    for (var i = 0; i < topBars.length; i++) {
      var chevron = labelChevron(topBars[i]);
      if (chevron && !chevron.hasAttribute("aria-label")) {
        chevron.setAttribute("aria-label", CHEVRON_LABEL);
      }
    }

    var labels = document.querySelectorAll(LABEL_SELECTOR);
    for (var j = 0; j < labels.length; j++) {
      var lab = labels[j];
      if (lab.hasAttribute(AFFORDANCE_ATTR)) continue;
      lab.setAttribute(AFFORDANCE_ATTR, "1");
      lab.style.cursor = "pointer";
      lab.addEventListener("click", onLabelClick(lab));
    }
  }

  try {
    new MutationObserver(sync).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    /* MutationObserver unavailable — the affordance simply never installs */
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync);
  } else {
    sync();
  }
})();
