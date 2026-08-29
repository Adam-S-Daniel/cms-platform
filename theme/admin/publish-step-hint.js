/*
 * admin/publish-step-hint.js — issue #329 item 2.
 *
 * ── The problem ────────────────────────────────────────────────────────
 * The one obvious teal "Publish" control in the toolbar is a DROPDOWN
 * TRIGGER, not a button — clicking it opens a menu ("Publish now" etc.)
 * rather than publishing directly. A user who clicks it once, sees the
 * menu, and walks away (or clicks elsewhere to dismiss it) has saved
 * nothing and gets no error telling them the entry is still unpublished.
 *
 * ── Why this shim does NOT forward the click for them ───────────────────
 * Tried live: programmatically activating the single `[role="menuitem"]`
 * inside the open dropdown — both via a plain `.click()` and a full
 * synthetic pointer/mouse event sequence — does NOT publish the entry and
 * raises a page error. Auto-invoking the menu item is also the branch
 * that risks a double-publish if it ever did work intermittently. So this
 * shim implements only the safe half (option (b) in the issue): an
 * unmissable "not published yet" notice, never a forwarded click.
 *
 * ── Behaviour ─────────────────────────────────────────────────────────
 * A single `#cms-publish-step-hint` element is kept in sync with whether
 * Decap's Publish dropdown trigger is currently on screen — present when
 * the trigger is present, removed the instant it isn't (i.e. once the
 * entry is actually published, or the toolbar re-renders without it).
 * It's a small, fixed, horizontally-centred, high-z-index, pale-amber
 * notice near the top of the viewport, with `pointer-events:none` so it
 * never intercepts clicks meant for the toolbar underneath it.
 *
 * ── Why BOTH a MutationObserver AND a setInterval re-sync ───────────────
 * Driven by a MutationObserver on `document.documentElement` for the
 * common case (toolbar re-renders on entry switches, save, field edits).
 * The interval is NOT belt-and-braces — verified live that after a real
 * publish the observer alone did not fire again and the hint stayed on
 * screen (stale, pointing at a state that no longer existed). Both paths
 * call the same idempotent `sync()`, so neither path can leave the hint
 * in a state the other wouldn't also produce.
 *
 * ── Selector strategy / Decap-upgrade safety ────────────────────────────
 * Same substring convention as native-preview-href.js and
 * publish-baseline-refresh.js: Emotion's class hash churns between
 * releases but the trailing component-name segment
 * (`...-PublishButton`) does not, so `[class*="PublishButton"]` survives
 * minor-version churn. If the class name is ever removed outright, `sync`
 * simply never shows the hint — a silent no-op, never a page error.
 */
(function () {
  "use strict";

  var HINT_ID = "cms-publish-step-hint";
  var TRIGGER_SELECTOR = '[role="button"][aria-haspopup="true"][class*="PublishButton"]';
  var SYNC_INTERVAL_MS = 500;
  var HINT_TEXT = "Not published yet — click Publish, then choose “Publish now”.";

  function triggerPresent() {
    try {
      return !!document.querySelector(TRIGGER_SELECTOR);
    } catch (e) {
      return false;
    }
  }

  function createHint() {
    var el = document.createElement("div");
    el.id = HINT_ID;
    el.setAttribute("role", "status");
    el.textContent = HINT_TEXT;
    el.style.cssText =
      [
        "position:fixed",
        "top:0.5rem",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:2147483000",
        "max-width:90vw",
        "padding:0.4rem 0.9rem",
        "background:#fdf3d8",
        "color:#5c4813",
        "border:1px solid #e8c766",
        "border-radius:4px",
        "font:600 0.8rem/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
        "text-align:center",
        "box-shadow:0 1px 4px rgba(0,0,0,0.12)",
        "pointer-events:none",
      ].join(";") + ";";
    return el;
  }

  function sync() {
    if (!document.body) return;
    var present = triggerPresent();
    var existing = document.getElementById(HINT_ID);
    if (present && !existing) {
      document.body.appendChild(createHint());
    } else if (!present && existing) {
      existing.remove();
    }
  }

  try {
    new MutationObserver(sync).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  } catch (e) {
    /* MutationObserver unavailable — the interval re-sync below still runs */
  }

  // REQUIRED re-sync, not belt-and-braces — see the block comment above.
  setInterval(sync, SYNC_INTERVAL_MS);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sync);
  } else {
    sync();
  }
})();
