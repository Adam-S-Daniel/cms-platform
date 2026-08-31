/*
 * admin/publish-step-hint.js — the publish-state bar.
 *
 * (Filename kept from its first shipped version — issue #329 item 2 —
 * so the three admin shells, the lint and the gem's file digests don't
 * churn. What it renders is `#cms-publish-state`.)
 *
 * ── What an editor cannot tell from Decap's own toolbar ─────────────────
 * Two facts, both load-bearing, neither stated anywhere on screen:
 *
 *   1. A SAVED entry is not on the website. Under
 *      `publish_mode: editorial_workflow` a Save commits to the entry's
 *      own `cms/<collection>/<slug>` branch and opens a PR; nothing
 *      reaches the public site until it is published. The toolbar says
 *      "Changes saved", which a non-technical owner reads as "done".
 *   2. The one obvious teal "Publish" control is a DROPDOWN TRIGGER, not
 *      a button — clicking it opens a menu ("Publish now" etc.). A user
 *      who clicks it once, sees the menu and clicks away has published
 *      nothing and gets no error. (On the production shell
 *      publish-button.js now hides that control and renders a real
 *      button into this bar's actions slot; this bar is where the
 *      replacement lives.)
 *
 * A third, discovered while fixing the placement below: while the entry
 * has UNSAVED changes there is no Publish control in the toolbar at all
 * (Decap renders it only when `!hasChanged` — measured in
 * decap-cms-core's EditorToolbar `renderWorkflowControls`), and nothing
 * says why it went away. So this bar reports that state too.
 *
 * ── ONE vocabulary, four states (docs/PUBLISHING-UX.md §3.1) ────────────
 * The bar no longer invents its own words. It renders whatever
 * entry-status-model.js derives from the facts publish-progress.js polls:
 * Live / Draft / Going live… / Needs attention, plus the two modifiers
 * (Hidden, Scheduled) that sit ALONGSIDE the badge rather than inside it.
 * posts-list-enhance.js renders the same derivation in the collection
 * list, which is what stops the two surfaces drifting into three
 * vocabularies for three states again (§2.9).
 *
 * When the poller has no facts yet — the first second after load, or a
 * shell that does not load it at all — the bar falls back to the
 * DOM-only draft/unsaved reading it has always had. Degrading to less
 * information is fine; claiming information we do not have is not.
 *
 * ── Why this shim does NOT forward the click for them ───────────────────
 * Tried live: programmatically activating the single `[role="menuitem"]`
 * inside the open dropdown — both via a plain `.click()` and a full
 * synthetic pointer/mouse event sequence — does NOT publish the entry and
 * raises a page error. Auto-invoking the menu item is also the branch
 * that risks a double-publish if it ever did work intermittently. So this
 * shim implements only the safe half: an unmissable state readout, never
 * a forwarded click. publish-button.js does not forward one either — it
 * replaces the control and talks to the GitHub API directly.
 *
 * ── PLACEMENT: in flow, never an overlay (this is the 2026-08-31 fix) ───
 * The first version was a `position: fixed`, top-centre notice. On a real
 * instance it sat ON TOP of the toolbar it was pointing at: measured at
 * 1280×800 against Decap 3.15.1, it covered 68% of the Publish button and
 * 47% of the Status control. It was reported from a live preview session
 * with a screenshot showing exactly that.
 *
 * `pointer-events: none` is why nothing caught it. The repo's occlusion
 * guard (`e2e/ui-visibility.js`'s `expectReachable`) decides "covered" with
 * `document.elementFromPoint` at the control's centre — a HIT test, which
 * a `pointer-events: none` overlay is invisible to. The control stayed
 * clickable and the guard stayed green while the label on it was
 * unreadable. `e2e/admin-no-occlusion.spec.js` now also asserts the
 * geometric case ("nothing this admin injects may OVERLAP a toolbar
 * control"), which is the assertion that can actually see this.
 *
 * So the bar is a full-width block in normal flow, inserted as the
 * toolbar's next sibling inside Decap's `EditorContainer`. Measured on a
 * live 3.15.1 instance, before/after, at both admin resolutions:
 *
 *            overlap with Save / Status / Publish / Delete
 *   before   0 / 2520px² (47%) / 2682px² (68%) / 0     (1280×800)
 *   after    0 / 0 / 0 / 0                             (1280×800 and 393×852)
 *
 * That placement works at both because Decap's own layout does the work:
 * on desktop `ToolbarContainer` is `position: absolute` and
 * `EditorContainer` carries a matching `padding-top`, so an in-flow
 * sibling lands directly beneath the toolbar and pushes the editor pane
 * down; on the phone layout the toolbar is `position: static` and wraps,
 * and the same sibling flows after it. Neither case needs a hard-coded
 * offset, which is what makes it safe across Decap's own responsive
 * breakpoints. Verified to survive a React re-render (leave the entry,
 * come back) and to be removed on the collection-list route.
 *
 * It is ALSO why the Publish button lives here rather than in the toolbar:
 * a fifth toolbar control squeezes the other four at 1024 wide, and this
 * row is structurally incapable of covering anything.
 *
 * ── Copy rules (read before editing a string here) ─────────────────────
 * Same honesty constraint `local-save-indicator.js` documents. The bar
 * may only claim what is true on the shell it is running in:
 *
 *   - The "about 5–15 minutes" clause is PRODUCTION-ONLY. It describes
 *     the real chain (required checks → auto-merge → deploy-production).
 *     On `index-local.html` (decap-server writes your working copy) and
 *     `index-test.html` (an in-browser fake repo) there is no deploy at
 *     all, and a timing promise there would be a worse defect than
 *     silence. The discriminator is the shell's own `deploy-status-pill.js`
 *     script tag — the one shell with a real deploy to report is the one
 *     that loads the pill that reports it.
 *   - It names ONE route to publish. Setting Status → Ready also
 *     publishes on this platform, because Decap applies the
 *     `decap-cms/pending_publish` label and cms-editorial-workflow.yml's
 *     `auto-merge-when-ready` job arms auto-merge on it. Teaching two
 *     doors to a non-technical owner is the confusion, not the cure —
 *     which is why one-door-publish.js now CLOSES the second door on the
 *     production shell instead of the copy tiptoeing around it.
 *
 * ── Why BOTH a MutationObserver AND a setInterval re-sync ───────────────
 * Driven by a MutationObserver on `document.documentElement` for the
 * common case (toolbar re-renders on entry switches, save, field edits).
 * The interval is NOT belt-and-braces — verified live that after a real
 * publish the observer alone did not fire again and the bar stayed on
 * screen (stale, pointing at a state that no longer existed). Both paths
 * call the same idempotent `render()`, so neither path can leave the bar
 * in a state the other wouldn't also produce.
 *
 * `render()` COMPARES BEFORE IT WRITES. Assigning `textContent` replaces
 * the child text node even when the string is identical — a `childList`
 * mutation inside `document.documentElement`, the exact subtree this
 * shim's own observer watches with `subtree: true`. An unconditional
 * write feeds the observer that called it, and because observer callbacks
 * are microtasks the loop never yields; the same mistake in
 * `local-save-indicator.js` killed the page target outright on a live
 * instance while every pure-fs lint stayed green. Do not "simplify" the
 * comparison away. The actions slot is exempt from that rule and MUST
 * stay exempt: publish-button.js owns its children and rebuilds them only
 * on a state change or a click, never on an observer pass.
 *
 * ── Selector strategy / Decap-upgrade safety ────────────────────────────
 * Same substring convention as native-preview-href.js,
 * publish-baseline-refresh.js and deploy-status-pill.js: Emotion's class
 * hash churns between releases but the trailing component-name segment
 * does not, so `[class*="PublishButton"]`, `[class*="SaveButton"]` and
 * `[class*="oolbar"]` (the container's label has been observed as both
 * `EditorToolbar` and `ToolbarContainer`) survive minor-version churn.
 * Public DOM only — no `window.CMS` internals and no Decap Redux store.
 * If a future release removes any of these, `render()` simply never shows
 * the bar: a silent no-op, never a page error.
 */
(function () {
  "use strict";

  var BAR_ID = "cms-publish-state";
  var BADGE_ID = "cms-publish-state-badge";
  var TEXT_ID = "cms-publish-state-text";
  var MODIFIERS_ID = "cms-publish-state-modifiers";
  var ACTIONS_ID = "cms-publish-state-actions";
  var PUBLISH_TRIGGER = '[role="button"][aria-haspopup="true"][class*="PublishButton"]';
  var SAVE_BUTTON = 'button[class*="SaveButton"]';
  var TOOLBAR = '[class*="oolbar"]';
  var SYNC_INTERVAL_MS = 500;

  // PRODUCTION-ONLY timing clause — see the copy rules above.
  var HAS_REAL_DEPLOY = !!document.querySelector('script[src*="deploy-status-pill"]');

  // The DOM-only fallback copy, used before the poller has any facts and on
  // every shell that does not load it.
  var FALLBACK = {
    unsaved: {
      label: "Unsaved changes",
      detail:
        "Click Save first — the Publish button only appears once your changes " +
        "are saved.",
    },
    draft: {
      label: "Draft — only you can see this",
      detail: HAS_REAL_DEPLOY
        ? "This is a draft — it is not on the website yet. To put it on the " +
          "website: click Publish. It then takes about 5–15 minutes to appear."
        : "This is a draft — it is not published yet. To publish it, click Publish.",
    },
  };

  // Badge → the bar's colours. One palette, four states, so a glance at the
  // colour is the same information as a read of the words.
  var TONE = {
    live: { bg: "#e6f4ea", fg: "#14532d", rule: "#8fcfa4" },
    draft: { bg: "#fdf3d8", fg: "#5c4813", rule: "#e8c766" },
    "going-live": { bg: "#e7f0fb", fg: "#10345f", rule: "#8fb8e8" },
    "needs-attention": { bg: "#fdecea", fg: "#7a1c12", rule: "#e8a49b" },
    unsaved: { bg: "#fdf3d8", fg: "#5c4813", rule: "#e8c766" },
  };

  function q(selector) {
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  // The DOM half of the state. An enabled Save button means Decap's
  // `hasChanged` is true, which is also exactly why the Publish control is
  // absent — so "unsaved" is checked first and takes precedence over
  // anything the poller says, because it is the fact the editor is
  // currently acting on.
  function domState() {
    var save = q(SAVE_BUTTON);
    if (save && !save.disabled) return "unsaved";
    if (q(PUBLISH_TRIGGER)) return "draft";
    return null;
  }

  // Merge the DOM half with the polled half into one view-model:
  // { state, label, detail, modifiers: [string] }.
  function currentView() {
    var dom = domState();
    if (dom === "unsaved") {
      return {
        state: "unsaved",
        label: FALLBACK.unsaved.label,
        detail: FALLBACK.unsaved.detail,
        modifiers: [],
      };
    }

    var progress = window.CMSPublishProgress;
    var model = window.CMSEntryStatus;
    var snapshot = progress && typeof progress.get === "function" ? progress.get() : null;
    if (model && snapshot && snapshot.ready && snapshot.facts) {
      var derived = model.derive(snapshot.facts, {
        now: Date.now(),
        contact: window.CMS_SUPPORT_CONTACT || null,
      });
      // "Live" with no toolbar publish control and no open PR is the steady
      // state of an entry nobody is publishing. Showing a green bar on every
      // such entry is noise, not information — the bar earns its row only
      // when there is something to say.
      if (derived.badge === "live" && !derived.modifiers.length) return null;
      return {
        state: derived.badge,
        label: derived.label,
        detail: derived.detail,
        modifiers: derived.modifiers.map(function (m) {
          return m.label;
        }),
      };
    }

    if (dom === "draft") {
      return {
        state: "draft",
        label: FALLBACK.draft.label,
        detail: FALLBACK.draft.detail,
        modifiers: [],
      };
    }
    return null;
  }

  function span(id, css) {
    var el = document.createElement("span");
    if (id) el.id = id;
    el.style.cssText = css;
    return el;
  }

  function createBar() {
    var el = document.createElement("div");
    el.id = BAR_ID;
    el.setAttribute("role", "status");
    // Deployment/UI chrome, not content: the visual-regression text check
    // strips [data-visreg-ignore] nodes before diffing, and this bar's
    // presence depends on the entry's workflow state rather than on
    // anything a page render should be compared on.
    el.setAttribute("data-visreg-ignore", "");
    el.style.cssText =
      [
        // NO position:fixed. This bar is in normal flow so it can never
        // paint over the controls it describes — see the PLACEMENT block
        // above, and the lint in e2e/admin-329-shims.test.js.
        "box-sizing:border-box",
        "width:100%",
        "display:flex",
        "flex-wrap:wrap",
        "align-items:center",
        "gap:0.5rem 0.75rem",
        "padding:0.5rem 1rem",
        "font:600 0.8rem/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
      ].join(";") + ";";

    el.appendChild(
      span(
        BADGE_ID,
        "display:inline-block;padding:0.1rem 0.5rem;border-radius:999px;" +
          "background:rgba(255,255,255,0.7);font-weight:700;white-space:nowrap;",
      ),
    );
    el.appendChild(span(TEXT_ID, "font-weight:500;flex:1 1 16rem;min-width:12rem;"));
    el.appendChild(span(MODIFIERS_ID, "font-weight:600;opacity:0.85;white-space:nowrap;"));
    // publish-button.js owns everything inside this slot.
    el.appendChild(
      span(ACTIONS_ID, "display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;"),
    );
    return el;
  }

  // Compare before writing — an unconditional textContent assignment feeds
  // this shim's own MutationObserver. See the header.
  function setText(el, text) {
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
  }

  function setStyle(el, prop, value) {
    if (!el) return;
    if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
  }

  function render() {
    if (!document.body) return;
    var view = currentView();
    var existing = document.getElementById(BAR_ID);

    if (!view) {
      if (existing) existing.remove();
      return;
    }

    var toolbar = q(TOOLBAR);
    if (!toolbar || !toolbar.parentElement) {
      // No editor toolbar on this route (collection list, login, the
      // workflow board). Nothing to annotate.
      if (existing) existing.remove();
      return;
    }

    var el = existing;
    if (!el || !el.isConnected || el.parentElement !== toolbar.parentElement) {
      // React rebuilt the editor and dropped (or re-parented) the bar.
      if (el) el.remove();
      el = createBar();
      toolbar.parentElement.insertBefore(el, toolbar.nextSibling);
    }

    var tone = TONE[view.state] || TONE.draft;
    setStyle(el, "background", tone.bg);
    setStyle(el, "color", tone.fg);
    setStyle(el, "border-bottom", "1px solid " + tone.rule);

    setText(document.getElementById(BADGE_ID), view.label);
    setText(document.getElementById(TEXT_ID), view.detail);
    setText(document.getElementById(MODIFIERS_ID), view.modifiers.join(" · "));

    if (el.getAttribute("data-state") !== view.state) el.setAttribute("data-state", view.state);
  }

  try {
    new MutationObserver(render).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  } catch (e) {
    /* MutationObserver unavailable — the interval re-sync below still runs */
  }

  // REQUIRED re-sync, not belt-and-braces — see the block comment above.
  setInterval(render, SYNC_INTERVAL_MS);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
