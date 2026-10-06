/*
 * admin/list-row-affordance.js — issue #329 item 5, plus the unnamed-control
 * names found in the session-19 keyboard and screen-reader UX round.
 *
 * ── The bug (#329.5) ──────────────────────────────────────────────────
 * List-widget rows (e.g. About → Bio Paragraphs) start COLLAPSED, and the
 * only way to expand one is a bare 32×26px chevron button — the row's own
 * summary text is not clickable, and the chevron carries no `aria-label`
 * at all (`null`), so a screen-reader user gets no hint what the control
 * does either.
 *
 * ── The fix ───────────────────────────────────────────────────────────
 * Independent, idempotent DOM annotations, all re-applied on every pass so
 * Decap re-rendering a row never leaves it un-annotated:
 *
 *   1. Every row's summary-text label becomes clickable: a click on it
 *      finds the row's own top-bar chevron and clicks THAT (never
 *      reimplementing the expand/collapse logic itself), so the row
 *      opens exactly as if the chevron had been clicked directly.
 *   2. Every list-row top bar's three icon-only controls get a name that
 *      says WHICH row, because with two rows a screen reader otherwise
 *      hears the same names twice, and the remove "x" and the drag handle
 *      had no name at all (so Enter on an unnamed control deleted a row):
 *        chevron  "Expand or collapse item 2 (Beta)"
 *        handle   "Move item 2 (Beta)"
 *        "x"      "Delete item 2 (Beta)"
 *      The number is the row's 1-based position among its siblings and the
 *      summary is the one Decap shows for it (shortened, so a bio paragraph
 *      does not read out whole three times); a blank summary leaves just
 *      "item 2". Same idea as rowName() in validation-feedback.js.
 *   3. The entry editor's Back link has the arrow glyph and the "Unsaved
 *      Changes" badge inside it, so its name read "← Writing in Posts
 *      collection Changes saved". Both are now aria-hidden, and the name is
 *      Decap's own localized "Writing in Posts collection" with BACK_PREFIX
 *      in front, because that phrase never says the link goes back and Decap
 *      has no localized string that does. BACK_PREFIX is the one piece of
 *      copy this file invents: set it to "" and the link keeps Decap's own
 *      words alone. (The badge text is still on screen; it is no longer part
 *      of the link's name.)
 *   4. The Rich Text / Markdown switch and the body editor's textbox carry
 *      no name at all in Decap; they take one from their field's label
 *      ("Content": switch "Edit Content as Markdown", textbox "Content").
 *
 * A name Decap (or a later release) puts on a control itself is never
 * overwritten: only a control with no `aria-label`, or one this shim wrote
 * (marked `data-control-named`), is renamed.
 *
 * ── Idempotence guard ─────────────────────────────────────────────────
 * `data-row-affordance="1"` is a real DOM attribute, not an expando
 * property, specifically so a fresh MutationObserver pass over a label
 * Decap re-rendered (a new DOM node, same content) can tell "already
 * wired" from "needs wiring" by reading the node itself — an expando
 * property would vanish the instant Decap swaps in a new element for the
 * same logical row. Names are recomputed on every pass (a row's position
 * and summary change as the editor types and reorders) and written only
 * when they differ; the observer watches childList and text (a summary is
 * rewritten in place), never attributes, so writing a name cannot
 * re-trigger it.
 *
 * ── Selector strategy / Decap-upgrade safety ────────────────────────────
 * Same substring convention as elsewhere in this directory (see
 * native-preview-href.js's "Selector strategy"): Emotion's class hash
 * churns between releases, the trailing component-name segment doesn't,
 * so `[class*="StyledListItemTopBar"]` / `[class*="NestedObjectLabel"]` /
 * `[class*="SortableListItem"]` / `[class*="ToolbarSectionBackLink"]` /
 * `[class*="ControlContainer"]` survive minor-version churn. If any of
 * these class names is ever removed outright, the corresponding
 * `querySelectorAll` simply returns nothing and this shim silently stops
 * annotating that surface — never a page error.
 *
 * Verified against Decap 3.15.1 (the pinned bundle) in a real browser: the
 * top bar's children are button (chevron), `div[role=button]
 * [aria-roledescription=sortable]` (the dnd-kit handle, NOT a <button>) and
 * button (remove); a row's summary label stays in the DOM after the row is
 * opened, and a nested list's label sits inside the outer row, so the
 * summary is the first label whose nearest row is this one.
 */
(function () {
  "use strict";

  var TOPBAR_SELECTOR = '[class*="StyledListItemTopBar"]';
  var LABEL_SELECTOR = '[class*="NestedObjectLabel"]';
  var SORTABLE_ITEM_SELECTOR = '[class*="SortableListItem"]';
  var DRAG_ICON_SELECTOR = '[class*="DragIconContainer"]';
  var BACK_LINK_SELECTOR = '[class*="ToolbarSectionBackLink"]';
  var BACK_ARROW_SELECTOR = '[class*="BackArrow"]';
  var BACK_STATUS_SELECTOR = '[class*="BackStatus"]';
  var BACK_COLLECTION_SELECTOR = '[class*="BackCollection"]';
  var MODE_SWITCH_SELECTOR = '[class*="ToolbarToggle"][role="switch"]';
  var BODY_TEXTBOX_SELECTOR = '[role="textbox"][data-slate-editor]';
  var CONTROL_SELECTOR = '[class*="ControlContainer"]';
  var FIELD_LABEL_SELECTOR = '[class*="FieldLabel"]';
  var AFFORDANCE_ATTR = "data-row-affordance";
  var NAMED_ATTR = "data-control-named";
  var MAX_SUMMARY = 60;
  // The one invented word: Decap's "Writing in X collection" does not say the
  // link goes back. "" leaves the link with Decap's own words alone.
  var BACK_PREFIX = "Back to ";

  function onLabelClick(lab) {
    return function () {
      var item = lab.closest(SORTABLE_ITEM_SELECTOR);
      if (!item) return;
      var chevron = item.querySelector(TOPBAR_SELECTOR + " button");
      if (chevron) chevron.click();
    };
  }

  function clean(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Name `el` unless it already carries a name that is not ours. Writes only
  // on a change, so a pass over an up-to-date row touches nothing.
  function setName(el, name) {
    if (!el || !name) return;
    var cur = el.getAttribute("aria-label");
    if (cur !== null && !el.hasAttribute(NAMED_ATTR)) return;
    if (cur !== name) el.setAttribute("aria-label", name);
    if (!el.hasAttribute(NAMED_ATTR)) el.setAttribute(NAMED_ATTR, "1");
  }

  // The summary Decap shows for the row. A nested list's label sits inside
  // its outer row too, so take the first label whose nearest row is this one.
  function summaryOf(row) {
    var labels = row.querySelectorAll(LABEL_SELECTOR);
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].closest(SORTABLE_ITEM_SELECTOR) !== row) continue;
      var text = clean(labels[i].textContent);
      return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY - 1).trim() + "…" : text;
    }
    return "";
  }

  // "item 2 (Beta)": the row's 1-based position among its sibling rows, then
  // the summary when there is one.
  function rowName(row) {
    var sibs = row.parentElement ? row.parentElement.children : [];
    var pos = 0;
    for (var i = 0; i < sibs.length; i++) {
      if (sibs[i].matches && sibs[i].matches(SORTABLE_ITEM_SELECTOR)) {
        pos++;
        if (sibs[i] === row) break;
      }
    }
    var summary = summaryOf(row);
    return "item " + (pos || "?") + (summary ? " (" + summary + ")" : "");
  }

  function isButton(el) {
    return String(el.tagName).toLowerCase() === "button";
  }

  // The top bar's own controls, in Decap's order: chevron <button>, the drag
  // handle (a div[role=button] from dnd-kit, not a <button>), remove <button>.
  // Only the bar's direct children are looked at, so a nested list's bar is
  // never mistaken for this one's.
  function nameTopBar(topBar) {
    var row = topBar.closest(SORTABLE_ITEM_SELECTOR);
    if (!row) return;
    var kids = topBar.children;
    var chevron = null;
    var remove = null;
    var handle = null;
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (isButton(kid)) {
        if (!chevron) chevron = kid;
        else remove = kid;
      } else if (
        kid.getAttribute("aria-roledescription") === "sortable" ||
        kid.querySelector(DRAG_ICON_SELECTOR)
      ) {
        handle = kid;
      }
    }
    var name = rowName(row);
    setName(chevron, "Expand or collapse " + name);
    setName(handle, "Move " + name);
    setName(remove, "Delete " + name);
  }

  // The label of the field a control belongs to ("Content"), or "".
  function fieldLabelOf(el) {
    var field = el.closest(CONTROL_SELECTOR);
    if (!field) return "";
    var labels = field.querySelectorAll(FIELD_LABEL_SELECTOR);
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].closest(CONTROL_SELECTOR) === field) return clean(labels[i].textContent);
    }
    return "";
  }

  function nameBackLink(link) {
    var arrow = link.querySelector(BACK_ARROW_SELECTOR);
    var status = link.querySelector(BACK_STATUS_SELECTOR);
    if (arrow) arrow.setAttribute("aria-hidden", "true");
    if (status) status.setAttribute("aria-hidden", "true");
    var where = link.querySelector(BACK_COLLECTION_SELECTOR);
    var text = where ? clean(where.textContent) : "";
    if (BACK_PREFIX && text) setName(link, BACK_PREFIX + text);
  }

  function sync() {
    var topBars = document.querySelectorAll(TOPBAR_SELECTOR);
    for (var i = 0; i < topBars.length; i++) nameTopBar(topBars[i]);

    var labels = document.querySelectorAll(LABEL_SELECTOR);
    for (var j = 0; j < labels.length; j++) {
      var lab = labels[j];
      if (lab.hasAttribute(AFFORDANCE_ATTR)) continue;
      lab.setAttribute(AFFORDANCE_ATTR, "1");
      lab.style.cursor = "pointer";
      lab.addEventListener("click", onLabelClick(lab));
    }

    var links = document.querySelectorAll(BACK_LINK_SELECTOR);
    for (var k = 0; k < links.length; k++) nameBackLink(links[k]);

    var switches = document.querySelectorAll(MODE_SWITCH_SELECTOR);
    for (var m = 0; m < switches.length; m++) {
      var swLabel = fieldLabelOf(switches[m]);
      if (swLabel) setName(switches[m], "Edit " + swLabel + " as Markdown");
    }

    var boxes = document.querySelectorAll(BODY_TEXTBOX_SELECTOR);
    for (var n = 0; n < boxes.length; n++) {
      if (boxes[n].hasAttribute("aria-labelledby")) continue;
      setName(boxes[n], fieldLabelOf(boxes[n]));
    }
  }

  try {
    // characterData too: React updates a row's summary by rewriting its text
    // node in place, which is not a childList mutation, and the names carry it.
    new MutationObserver(sync).observe(document.documentElement, {
      childList: true,
      characterData: true,
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
