/*
 * admin/publish-button.js — ONE honest Publish button. PRODUCTION SHELL ONLY.
 *
 * ── What it replaces ───────────────────────────────────────────────────
 * Decap's toolbar Publish control is a split button: clicking it opens a
 * one-item dropdown, and only the item inside it publishes. An editor who
 * clicks it once, sees a menu and clicks away has published nothing and got
 * no error. Worse, Decap renders that control ONLY under `!hasChanged` —
 * type a single character and the button an editor was just told to press
 * silently disappears, with no explanation (docs/PUBLISHING-UX.md §2.5).
 *
 * This shim CSS-hides that control and renders a plain button in its place:
 * one click, one confirmation, one outcome. When it cannot be used it stays
 * on screen, while the state bar says why once; a vanishing control can do
 * neither.
 *
 * ── Why replacing is safer than driving ────────────────────────────────
 * Forwarding a click into Decap's dropdown was implemented and tested
 * against a live instance under #329 (option (a)): activating the single
 * `[role="menuitem"]`, by `.click()` and by a full synthetic pointer
 * sequence, does NOT publish and raises a page error. It is also the branch
 * that risks a double-publish if it ever worked intermittently.
 *
 * Replacing it is possible at all because on this platform PUBLISHING IS
 * ALREADY "ADD A LABEL TO A PR". Decap's synchronous merge always 422s
 * against the branch ruleset; publish-via-auto-merge.js catches that and
 * adds `cms/ready`; cms-editorial-workflow.yml's `auto-merge-when-ready`
 * job arms native auto-merge on exactly that label; the PR merges itself
 * when the six required checks pass. So this button does directly, and
 * visibly, what the shim does by interception — with public GitHub REST on
 * one side and public DOM on the other, and no Decap internals on either.
 *
 * ── Why it adds `cms/ready` and NOT a `decap-cms/*` label ──────────────
 * `auto-merge-when-ready` fires on `cms/ready`, `decap-cms/ready` or
 * `decap-cms/pending_publish` alike. We write `cms/ready` — byte-identical
 * to what publish-via-auto-merge.js already writes on the same PR — and
 * leave the `decap-cms/<status>` label exactly as Decap set it. Two
 * reasons, both load-bearing:
 *
 *   - An entry carrying BOTH `decap-cms/draft` and `decap-cms/pending_publish`
 *     has no defined status in Decap's own derivation, and the
 *     editorial-label audit (scripts/audit-editorial-labels.js) is satisfied
 *     by ANY `decap-cms/*` label, so there is nothing to gain by touching it
 *     and a real ambiguity to create.
 *   - Keeping one arming label across both code paths means the workflow
 *     side has exactly one thing to reason about.
 *
 * ── Why a re-publish REMOVES the label before adding it ────────────────
 * `auto-merge-when-ready` fires on the `labeled` EVENT, and GitHub does not
 * emit one for a label that is already present. So an editor pressing
 * Publish again after a "Needs attention" — the single most likely second
 * click in the product — would POST a 200 that fires nothing at all, and
 * the button would report success over a publish that never restarted.
 * Read the current PR labels without the browser cache, then remove only
 * when present. That avoids an expected HTTP 404 on a first publish. A
 * racing DELETE 404 is also the desired absent state; other read/removal
 * failures stop the attempt rather than promise an event we cannot prove.
 *
 * ── Placement: in the state bar, not in the toolbar ────────────────────
 * publish-step-hint.js's `#cms-publish-state` row is a full-width block in
 * normal flow, directly under the toolbar. Rendering into its actions slot
 * gets three things a toolbar injection cannot:
 *
 *   - It is structurally incapable of painting over a toolbar control. The
 *     first version of that bar WAS an overlay and covered 68% of the
 *     Publish button it pointed at (§2.3); a button that repeats that
 *     mistake would be worse than the notice was.
 *   - The toolbar is `flex-wrap: nowrap` on desktop, and a fifth control
 *     squeezes the other four at 1024 wide (§5, measured).
 *   - The confirmation needs a sentence and two buttons' worth of room,
 *     which the bar has and the toolbar does not.
 *
 * ── The confirmation ───────────────────────────────────────────────────
 * Inline, in the bar, not a modal and not `window.confirm`. It names the
 * URL and the ETA, which is precisely what Decap's own dropdown cannot say.
 * A native `confirm()` would be a shorter implementation and a worse one:
 * confirm-wrap-local-backup.js already wraps `window.confirm` for Decap's
 * misleading backup dialog, and stacking a second meaning onto that wrap is
 * how the wrap stops being auditable. An inline two-step also keeps the
 * whole interaction inside one focus context, with no trap to build.
 *
 * ── The preview surface, and the promise this button must not make (#371) ─
 * A PR-preview deploy serves this same production shell, and
 * scripts/patch-preview-config.sh deliberately rewrites that admin's
 * `backend.branch` to the PR head ref — so an editor on a preview edits a
 * FEATURE BRANCH. cms-editorial-workflow.yml labels the resulting PR
 * `cms/preview-only`. Publishing it merges the edit into that feature
 * branch; nothing removes it again, so it reaches the live site when that
 * branch merges to main (#532 — the label once promised the opposite).
 *
 * The confirmation therefore must not name the live URL there. It used to,
 * unconditionally: "It will appear at https://<apex>/… in about 5–15
 * minutes" — a specific, checkable, false promise, on a surface where
 * nothing reaches the live site now. It now names the destination
 * entry-status-model.js derives, which is the preview's own branch on that
 * surface and the site everywhere else, and says the edit reaches the live
 * site only once that branch's work does (`laterNote`) rather than never.
 *
 * And the button must not DISAPPEAR on a stalled publish. `armed` used to be
 * enough to render nothing at all ("already on its way — a second Publish
 * would be a no-op"), which is right while the merge is actually coming and
 * exactly wrong once it is not: #371's measured instance sat armed, green and
 * unmerged with no control on screen. The armed branch now excludes a stall,
 * so the editor gets a button back alongside the bar's explanation.
 *
 * ── Decap's own "Publish now" is routed here too (2026-10-05) ──────────
 * This button renders only once publish-progress.js has FOUND the entry's
 * open PR, and until then Decap's split button stays on screen (see the
 * `unknown` and `none` branches of plan()). Saving an EXISTING entry fires
 * no `hashchange`, so that window lasts up to one 30 s poll — and inside it
 * an editor sees Decap's Publish, picks "Publish now", and gets Decap's
 * native alert `Please update status to "Ready" before publishing.`
 * Decap's Editor `handlePublishEntry` refuses unless the entry's status is
 * the last workflow status, and one-door-publish.js hides the Status
 * control that would satisfy it, so on this shell that alert is a dead
 * end. Reported on jodidaniel.com's "Expertise" collection; it is not
 * collection-specific, only timing-specific.
 *
 * So a capture-phase listener intercepts a selection inside the dropdown
 * whose trigger is Decap's `PublishButton` ("Publish now", "Publish and
 * create new", "Publish and duplicate") before Decap's React handler sees
 * it, and runs doPublish() instead — the same `cms/ready` route, with the
 * same bounded re-read that finds a PR the poller has not caught up with
 * yet. Choosing a menu item is already the second deliberate step, so no
 * further confirmation is added. "…and create new" / "…and duplicate"
 * publish only; the editor stays on the entry. The published-entry
 * dropdown (`PublishedToolbarButton`: Unpublish, Duplicate) and the
 * rehearsal and local shells, which never load this file, are untouched.
 *
 * ── Failure mode ───────────────────────────────────────────────────────
 * If publish-step-hint.js's bar is absent (a Decap release that renames the
 * toolbar, a route with no editor) there is no actions slot and this shim
 * renders nothing — and, critically, it does NOT hide Decap's control in
 * that case. Hiding a control while failing to provide its replacement is
 * the one outcome worse than either alone, so the hide is conditional on
 * the replacement actually being on screen.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__publishButtonInstalled) return;
  window.__publishButtonInstalled = true;

  var SLOT_ID = "cms-publish-state-actions";
  var BUTTON_ID = "cms-publish-button";
  var DECAP_PUBLISH = '[class*="PublishButton"]';
  var SAVE_BUTTON = 'button[class*="SaveButton"]';
  var HIDDEN_ATTR = "data-one-door-hidden";

  // "confirm" while the two-step confirmation is on screen; "busy" while the
  // REST calls are in flight; "" otherwise. Kept in module scope rather than
  // on the DOM so a React re-render of the bar cannot resurrect a stale
  // confirmation the editor already cancelled.
  var mode = "";
  var lastError = null;
  // The signature of what is currently rendered in the slot. render() runs on
  // an interval, and REBUILDING THE BUTTON UNDER THE EDITOR'S CURSOR IS A LOST
  // CLICK: a node replaced between mousedown and mouseup never fires `click`,
  // so a 2 Hz rebuild would silently drop roughly one Publish press in four.
  // Same discipline as publish-step-hint.js's compare-before-write, for the
  // same reason — the steady state must mutate nothing.
  var renderedSignature = null;
  // The plan() kind currently in the slot, or null with no slot. Read by
  // publish-step-hint.js, which drops the Draft sentence ("…Click Publish to
  // put it on …") while the confirmation asks the same question beside it.
  // What is RENDERED, not `mode`: `mode` can stay "confirm" while plan() shows
  // something else (unsaved edits, an armed PR).
  var renderedKind = null;

  function q(sel, root) {
    try {
      return (root || document).querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  function progress() {
    return window.CMSPublishProgress || null;
  }

  // The public URL this entry will appear at. window.LiveURL knows the
  // routable collections (posts/tags/projects); every other collection —
  // jodidaniel.com's nine per-section ones, every file collection — has no
  // page of its own, so name the SITE instead of inventing a path. Naming
  // the wrong URL would be worse than naming none.
  function targetUrl() {
    try {
      if (window.LiveURL && typeof window.LiveURL.compute === "function") {
        var c = window.LiveURL.compute();
        if (c && c.url) return c.url;
      }
    } catch (e) {
      /* fall through to the site origin */
    }
    var fallback = window.CMS_SITE_ORIGIN || (window.CMS_APEX ? "https://" + window.CMS_APEX : null);
    if (window.CMSHostname && typeof window.CMSHostname.destinationOrigin === "function") {
      return window.CMSHostname.destinationOrigin(fallback);
    }
    return fallback;
  }

  function hasUnsavedChanges() {
    var save = q(SAVE_BUTTON);
    return Boolean(save && !save.disabled);
  }

  // ── Hiding Decap's split button ───────────────────────────────────────
  // CSS-hide, never removeChild — the native-preview-href.js precedent: React
  // re-mounts what it owns, and the resulting fight loop wedged the editor
  // mid-flow at commit 503365a. Conditional on our own button being present,
  // per "Failure mode" above.
  function hideDecapPublish() {
    var nodes;
    try {
      nodes = document.querySelectorAll(DECAP_PUBLISH);
    } catch (e) {
      return;
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.id === BUTTON_ID || (el.closest && el.closest("#" + SLOT_ID))) continue;
      // Re-assert only when it is NOT already hidden. native-preview-href.js
      // re-asserts unconditionally because emotion can re-emit a `style`
      // attribute that clobbers the inline display:none — this keeps that
      // recovery while skipping the write on the steady state, because an
      // unconditional style write here fires an `attributes` mutation inside
      // the subtree publish-step-hint.js's own observer watches, twice a
      // second, forever.
      if (el.style.getPropertyValue("display") === "none") continue;
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("tabindex", "-1");
      el.setAttribute(HIDDEN_ATTR, "1");
    }
  }

  // ── The publish action ────────────────────────────────────────────────
  async function arm(prNumber, token) {
    var repo = window.CMS_REPO;
    var base = "https://api.github.com/repos/" + repo;
    var headers = {
      Authorization: "token " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
    // A PR detail carries the complete label set without label-list
    // pagination. Do not trust the poller's snapshot for a re-arm.
    var status = "unknown";
    try {
      var read = await fetch(base + "/pulls/" + prNumber, {
        headers: headers,
        cache: "no-cache",
      });
      status = Number.isInteger(read.status) && read.status >= 100 && read.status <= 599 ? read.status : "unknown";
      if (!read.ok) throw new Error("Could not read publish labels");
      var pr = await read.json();
      if (!pr || !Array.isArray(pr.labels) || !pr.labels.every(function (label) {
        return label && typeof label === "object" && typeof label.name === "string";
      })) throw new Error("Invalid publish labels");
      if (pr.labels.some(function (label) { return label.name === "cms/ready"; })) {
        status = "unknown";
        var removed = await fetch(base + "/issues/" + prNumber + "/labels/" + encodeURIComponent("cms/ready"), {
          method: "DELETE",
          headers: headers,
        });
        status = Number.isInteger(removed.status) && removed.status >= 100 && removed.status <= 599 ? removed.status : "unknown";
        if (!removed.ok && removed.status !== 404) throw new Error("Could not remove publish label");
      }
    } catch (e) {
      // Neither API bodies nor thrown Error text belong in browser logs.
      console.warn("publish-button: label re-arm failed (HTTP " + status + ")");
      throw new Error("Could not re-arm publishing");
    }
    var res = await fetch(base + "/issues/" + prNumber + "/labels", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ labels: ["cms/ready"] }),
    });
    if (!res.ok && res.status !== 422) {
      throw new Error("GitHub returned " + res.status);
    }
  }

  // ── Why doPublish() re-reads before it gives up (#386) ────────────────
  // publish-progress.js reads the entry's PR every 30 s and on `hashchange`.
  // Saving an EXISTING entry changes no hash, so for up to 30 s after Decap
  // opens the PR the snapshot still says "no PR" — and a Publish pressed in
  // that window used to render "could not be published right now" over a PR
  // that was there all along. A NEW entry never hit this: its first save
  // navigates /new → entries/<slug>, which fires hashchange and a tick. Two
  // consecutive adamdaniel.ai host-loop runs measured exactly that split
  // (CREATE armed, UPDATE sat unarmed). So: with no PR in hand, ask the
  // poller to read again, and keep asking a bounded few times — refresh()
  // returns at once while a tick is already in flight, leaving the snapshot
  // unchanged, so one unchanged read proves nothing. (The other half of
  // #386 is the browser's HTTP cache answering GitHub GETs for 60 s — see
  // publish-progress.js's header; without its `cache: "no-cache"` these
  // re-reads would return the same stale body.)
  var REFRESH_RETRIES = 4;
  var REFRESH_RETRY_MS = 1500;

  function readPrNumber(p) {
    var s = p ? p.get() : null;
    return (s && s.prNumber) || null;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function doPublish() {
    var p = progress();
    var prNumber = readPrNumber(p);
    var token = p && typeof p.getToken === "function" ? p.getToken() : null;
    if (!prNumber && token && p && typeof p.refresh === "function") {
      mode = "busy";
      lastError = null;
      render();
      for (var i = 0; i < REFRESH_RETRIES && !prNumber; i++) {
        try {
          await p.refresh();
        } catch (e) {
          /* the re-read below decides */
        }
        prNumber = readPrNumber(p);
        if (!prNumber) await wait(REFRESH_RETRY_MS);
      }
    }
    if (!prNumber || !token) {
      lastError =
        "This could not be published right now. Try saving again, wait a few " +
        "seconds, and press Publish once more.";
      mode = "";
      render();
      return;
    }
    mode = "busy";
    lastError = null;
    render();
    try {
      await arm(prNumber, token);
      mode = "";
      lastError = null;
      // Flip the bar to "Going live…" immediately rather than up to 30 s
      // later on the next poll.
      if (typeof p.refresh === "function") p.refresh();
    } catch (err) {
      mode = "";
      lastError =
        ((window.CMSHostname && window.CMSHostname.destination()) || "The destination") +
        " did not accept the publish just now (" +
        (err && err.message ? err.message : "unknown error") +
        "). Nothing you typed has been lost — press Publish again in a moment.";
    }
    render();
  }

  // ── Decap's "Publish now", routed through doPublish() ─────────────────
  // See "Decap's own 'Publish now' is routed here too" in the header.
  //
  // react-aria-menubutton, which Decap's toolbar dropdowns are built on,
  // renders each item as `[role="menuitem"]` inside a wrapper whose other
  // child holds the `aria-haspopup` trigger. The nearest ancestor holding a
  // trigger is therefore the item's OWN dropdown, and only the one whose
  // trigger is Decap's `PublishButton` is routed (`PublishedToolbarButton`
  // does not contain that substring, so Unpublish/Duplicate pass through).
  var MENU_TRIGGER = '[aria-haspopup="true"]';
  var MENU_DEPTH = 8;

  function decapPublishMenuItem(target) {
    var item = target && typeof target.closest === "function" ? target.closest('[role="menuitem"]') : null;
    if (!item) return null;
    var el = item.parentElement;
    for (var depth = 0; el && depth < MENU_DEPTH; depth++, el = el.parentElement) {
      var trigger = el.querySelector(MENU_TRIGGER);
      if (!trigger) continue;
      return trigger.matches(DECAP_PUBLISH) && !trigger.closest("#" + SLOT_ID) ? item : null;
    }
    return null;
  }

  // Close the menu the selection would have closed. react-aria-menubutton
  // closes on Escape; best effort, never fatal.
  function closeDecapMenu(item) {
    try {
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch (e) {
      /* the menu stays open; the publish below still runs */
    }
  }

  async function publishFromDecapMenu() {
    if (mode === "busy") return;
    await doPublish();
    // doPublish() reports a failure in the state bar's slot. With no bar on
    // screen (the very window this route exists for can have none — the bar
    // renders nothing for an entry the poller still reads as live), say it
    // the way Decap would have, rather than failing silently.
    if (lastError && !document.getElementById(SLOT_ID) && typeof window.alert === "function") {
      window.alert(lastError);
    }
  }

  function onDecapMenuActivate(ev) {
    // react-aria-menubutton selects on click, and on Enter or Space.
    if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
    var item = decapPublishMenuItem(ev.target);
    if (!item) return;
    // Capture phase on `document` runs before React's listener on its root
    // container, so Decap's status-gated handler never sees this selection.
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
    closeDecapMenu(item);
    publishFromDecapMenu();
  }

  document.addEventListener("click", onDecapMenuActivate, true);
  document.addEventListener("keydown", onDecapMenuActivate, true);

  // Test hook (e2e/publish-button-refresh.test.js drives doPublish() in a vm
  // sandbox; e2e/publish-button-decap-menu.test.js drives the menu route).
  // Same shape as one-door-publish.js's window.__oneDoorPublish.
  window.__publishButton = {
    doPublish: doPublish,
    decapPublishMenuItem: decapPublishMenuItem,
    lastError: function () {
      return lastError;
    },
  };

  // Read by publish-step-hint.js — see `renderedKind`. "busy" counts too:
  // "Click Publish" under "Sending it to …" tells the editor to do what they
  // just did.
  window.CMSPublishButton = {
    isConfirming: function () {
      return renderedKind === "confirm" || renderedKind === "busy";
    },
  };

  // ── Explaining "Unpublish" (#625 item 7) ──────────────────────────────
  // "Published ▾" on a live entry offers Unpublish with no word on what it
  // does. Decap's Unpublish takes the entry off the site and moves it back to
  // Drafts, so say so, as a `title` on that one menu item. Additive only: it
  // touches no other item, never the Publish dropdown, and writes nothing once
  // set. react-aria-menubutton mounts items only while the menu is open, so a
  // slow interval applies it (the 500 ms render tick's own cadence).
  var UNPUBLISHED_TRIGGER_CLASS = "PublishedToolbarButton";
  var UNPUBLISH_HINT =
    "Takes this off the site and moves it back to your drafts. " +
    "Nothing is lost — you can publish it again.";

  function inPublishedDropdown(item) {
    var el = item.parentElement;
    for (var depth = 0; el && depth < MENU_DEPTH; depth++, el = el.parentElement) {
      var trigger = el.querySelector(MENU_TRIGGER);
      if (!trigger) continue;
      return String(trigger.getAttribute("class") || "").indexOf(UNPUBLISHED_TRIGGER_CLASS) !== -1;
    }
    return false;
  }

  function explainUnpublish() {
    var items;
    try {
      items = document.querySelectorAll('[role="menuitem"]');
    } catch (e) {
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var label = String(item.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (label.indexOf("unpublish") !== 0 || !inPublishedDropdown(item)) continue;
      if (item.getAttribute("title") !== UNPUBLISH_HINT) item.setAttribute("title", UNPUBLISH_HINT);
    }
  }
  setInterval(explainUnpublish, 500);

  // ── Rendering ─────────────────────────────────────────────────────────
  function styleButton(b, primary) {
    b.style.cssText =
      [
        "font:600 0.8rem/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
        "padding:0.45rem 0.9rem",
        "border-radius:5px",
        "cursor:pointer",
        "white-space:nowrap",
        primary
          ? "background:#1f7a3d;color:#fff;border:1px solid #1a6733"
          : "background:#fff;color:#3d3115;border:1px solid #c9ae63",
      ].join(";") + ";";
  }

  function disabledNote(slot, text) {
    var note = document.createElement("span");
    note.style.cssText = "font:500 0.75rem/1.35 inherit;color:#6b5a20;";
    note.textContent = text;
    slot.appendChild(note);
  }

  // What SHOULD be in the slot right now, as a small plain object. Deriving
  // it before touching the DOM is what makes the signature comparison below
  // possible at all.
  // entry-status-model.js owns the threshold; this reads its verdict rather
  // than re-deriving one, so the button and the bar can never disagree about
  // whether a publish has stalled. Absent module → false, which keeps the
  // pre-#371 behaviour rather than inventing a failure.
  function isStalled(facts) {
    try {
      var m = window.CMSEntryStatus;
      return Boolean(m && typeof m.isStalled === "function" && m.isStalled(facts, Date.now()));
    } catch (e) {
      return false;
    }
  }

  // Likewise for the destination noun — one derivation, two surfaces.
  function destination(facts) {
    try {
      var m = window.CMSEntryStatus;
      if (m && typeof m.destination === "function") {
        return m.destination(
          facts,
          window.CMSHostname
            ? {
                currentHostname: window.CMSHostname.destination(),
                canonicalHostname: window.CMSHostname.canonical(),
              }
            : {},
        );
      }
    } catch (e) {
      /* fall through */
    }
    return {
      noun: window.CMSHostname ? window.CMSHostname.destination() : "the destination",
      canonical: window.CMSHostname ? window.CMSHostname.canonical() : "the published destination",
      preview: false,
    };
  }

  function siteGated() {
    var model = window.CMSEntryStatus;
    if (model && typeof model.isSiteGated === "function") return model.isSiteGated(document);
    return Boolean(document.getElementById("cms-site-gate-banner"));
  }

  function plan() {
    var p = progress();
    var state = p ? p.get() : null;
    var facts = state && state.ready ? state.facts : null;

    if (mode === "busy") {
      return { kind: "busy", note: "Sending it to " + destination(facts || {}).noun + "…" };
    }

    if (hasUnsavedChanges()) {
      return { kind: "disabled" };
    }

    // NOT YET KNOWN. This is the one branch that must not hide Decap's
    // control: between page load and the poller's first answer we have no
    // replacement to offer, and hiding a control while failing to provide its
    // replacement is the single outcome worse than either alone (see the
    // Failure mode note in the header). So: render nothing, hide nothing, and
    // let the editor keep Decap's own button for the second or two it takes.
    if (!facts) return { kind: "unknown" };

    // Nothing to publish: no open PR means it is already on the website (or
    // deploying). Offering a button that cannot act is worse than no button.
    if (!facts.hasOpenPr) return { kind: "none" };

    // Already on its way — a second Publish would be a no-op the editor would
    // read as a failure. A STALLED publish is not on its way (see the header),
    // so it must not be swallowed here.
    var stalled = isStalled(facts);
    if (
      facts.armed &&
      !facts.checksFailed &&
      !facts.awaitingReviewGate &&
      !facts.mergeConflict &&
      !stalled
    ) {
      return { kind: "none" };
    }

    if (mode === "confirm") {
      var dest = destination(facts);
      // Coming-soon site: do not promise it "appears" in 5 minutes — visitors
      // keep seeing the coming-soon page (#625 item 1). The gate state is
      // site-gate-banner.js's banner, read through the shared model helper.
      if (siteGated()) {
        return {
          kind: "confirm",
          note:
            "Publish this to " + dest.noun + "? It will be saved to the site, but " +
            "visitors keep seeing the coming-soon page until the site is switched on.",
        };
      }
      if (dest.preview) {
        // No URL: window.LiveURL computes the LIVE site's path, and the
        // preview origin is not derivable from anything this shim may read.
        // Naming the branch is the same discipline targetUrl() already
        // applies — naming the wrong URL is worse than naming none.
        // An entry-status-model.js older than laterNote (a cached copy)
        // still says preview: true; say the same thing in its place rather
        // than "undefined".
        return {
          kind: "confirm",
          note:
            "Put this on " + dest.noun + "? It takes about 5 minutes to appear " +
            "there. " +
            (dest.laterNote ||
              "It will not reach " + dest.canonical + " until the work on this branch goes live there."),
        };
      }
      var url = targetUrl();
      return {
        kind: "confirm",
        note: url
          ? "Put this on " + dest.noun + "? It will appear at " + url + " in about 5 minutes."
          : "Put this on " + dest.noun + "? It takes about 5 minutes to appear.",
      };
    }

    return {
      kind: "publish",
      label:
        facts.checksFailed || facts.awaitingReviewGate || stalled
          ? "Try publishing again"
          : "Publish",
    };
  }

  function render() {
    var slot = document.getElementById(SLOT_ID);
    if (!slot) {
      // No bar on this route — see "Failure mode". Nothing rendered means
      // nothing hidden, and the signature resets so the next bar rebuilds.
      renderedSignature = null;
      renderedKind = null;
      return;
    }

    var p = plan();
    renderedKind = p.kind;
    var signature = JSON.stringify([p, lastError]);
    if (signature === renderedSignature && slot.firstChild) {
      // Steady state: mutate nothing. In particular do NOT replace the button
      // — a node swapped between mousedown and mouseup eats the click.
      if (p.kind !== "unknown") hideDecapPublish();
      return;
    }
    renderedSignature = signature;

    while (slot.firstChild) slot.removeChild(slot.firstChild);

    if (lastError) disabledNote(slot, lastError);

    if (p.kind === "unknown") return; // hide nothing — see plan()

    if (p.kind === "busy") {
      if (p.note) disabledNote(slot, p.note);
      hideDecapPublish();
      return;
    }

    // NOTHING TO PUBLISH — and therefore NOTHING TO HIDE.
    //
    // "no open PR" normally means the entry is already on the website, a
    // state in which Decap renders no publish control either, so hiding
    // would be a no-op. But it can also mean the poller failed to MATCH the
    // entry's PR, and that is the one failure this shim must not compound:
    // hiding the only route to production while offering no replacement is
    // the outcome the header calls worse than either alone. So this branch
    // leaves Decap's control exactly as it found it. If Decap is showing one,
    // it is because Decap believes there is something to publish (most often
    // a just-saved PR the poller has not read yet). Decap's own "Publish now"
    // would then stop at its Status gate, whose control one-door-publish.js
    // hides, so onDecapMenuActivate() routes that selection through
    // doPublish() instead.
    if (p.kind === "none") {
      if (p.note) disabledNote(slot, p.note);
      return;
    }

    if (p.kind === "disabled") {
      var disabled = document.createElement("button");
      disabled.id = BUTTON_ID;
      disabled.type = "button";
      disabled.disabled = true;
      disabled.textContent = "Publish";
      styleButton(disabled, true);
      disabled.style.opacity = "0.45";
      disabled.style.cursor = "not-allowed";
      slot.appendChild(disabled);
      hideDecapPublish();
      return;
    }

    if (p.kind === "confirm") {
      disabledNote(slot, p.note);
      var yes = document.createElement("button");
      yes.type = "button";
      yes.textContent = "Yes, publish";
      styleButton(yes, true);
      yes.addEventListener("click", function () {
        doPublish();
      });
      var no = document.createElement("button");
      no.type = "button";
      no.textContent = "Cancel";
      styleButton(no, false);
      no.addEventListener("click", function () {
        mode = "";
        render();
      });
      slot.appendChild(yes);
      slot.appendChild(no);
      hideDecapPublish();
      return;
    }

    var btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.textContent = p.label;
    styleButton(btn, true);
    btn.addEventListener("click", function () {
      mode = "confirm";
      lastError = null;
      render();
    });
    slot.appendChild(btn);
    hideDecapPublish();
  }

  // Re-render on the two things that change what this button should say:
  // the poller's facts, and the toolbar's own saved/unsaved state.
  if (window.CMSPublishProgress && typeof window.CMSPublishProgress.subscribe === "function") {
    window.CMSPublishProgress.subscribe(function () {
      render();
    });
  }

  // A modest interval rather than a MutationObserver: the only DOM fact this
  // reads is the Save button's `disabled` property, and an observer on
  // documentElement would re-run this on every keystroke for a boolean that
  // changes twice per edit session. 500 ms matches publish-step-hint.js's
  // own re-sync cadence.
  setInterval(render, 500);
  window.addEventListener("hashchange", function () {
    mode = "";
    lastError = null;
    renderedSignature = null;
    render();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
})();
