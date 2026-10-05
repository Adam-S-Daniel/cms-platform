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
    } else if (e.key === " " && /,\s*$/.test(value)) {
      e.preventDefault();
    }
  }

  document.addEventListener("keydown", onKeyDown, true);
})();
