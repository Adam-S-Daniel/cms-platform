/*
 * admin/one-door-publish.js — PRODUCTION SHELL ONLY. Closes the second,
 * unlabelled door to production.
 *
 * ── The defect ─────────────────────────────────────────────────────────
 * On this platform there are two routes to the live site and only one of
 * them is called "Publish":
 *
 *   1. Publish → "Publish now". Decap's synchronous merge 422s against the
 *      branch ruleset; publish-via-auto-merge.js converts that into a
 *      `cms/ready` label and cms-editorial-workflow.yml's
 *      `auto-merge-when-ready` job lands it.
 *   2. Status → "Ready". Decap's `setPullRequestStatus` replaces the PR's
 *      CMS label with `decap-cms/pending_publish`, and that SAME
 *      `auto-merge-when-ready` job fires on exactly that label name. So
 *      setting a status an editor reasonably reads as a private
 *      note-to-self publishes the entry.
 *
 * Worse, the two surfaces that offer route 2 disagree with each other.
 * The Workflow board hard-gates publishing on Ready
 * (`WorkflowList.requestPublish` alerts "Only items with a 'Ready' status
 * can be published…" and returns), while the entry editor's Publish
 * dropdown has no status gate at all. Same entry, same verb, opposite
 * rules, identical words. See docs/PUBLISHING-UX.md §2.1 and §2.2.
 *
 * This shim hides route 2 on the production shell: the toolbar Status
 * dropdown, the Workflow nav link, and the `#/workflow` route itself.
 * Publish becomes the only way to production, which is what makes the
 * one-sentence instruction in publish-step-hint.js true rather than
 * merely simplified.
 *
 * ── What it COSTS, stated plainly ──────────────────────────────────────
 * `pending_review` becomes unreachable from the production editor. Nothing
 * on this platform consumes it — there is no notification, no queue and no
 * required reviewer, and the two-person teams these sites are built for
 * send each other a preview link instead. The editorial-label audit
 * (scripts/audit-editorial-labels.js) keys on `decap-cms/*` generally, not
 * on which of the three it is, so `decap-cms/draft` keeps satisfying it and
 * the "adding labels…" dialog stays closed.
 *
 * This removes a capability rather than fixing a defect, so it was staged
 * as an explicit operator decision in docs/PUBLISHING-UX.md phase 2. The
 * decision is recorded there.
 *
 * ── Scope: index.html ONLY ─────────────────────────────────────────────
 * Deliberately not loaded by the other two shells, and the lint asserts
 * the negative (e2e/admin-329-shims.test.js):
 *
 *   - index-test.html is the REHEARSAL surface. e2e/cms-editorial-workflow.spec.js
 *     and e2e/cms-workflow-states.spec.js drive Decap's real Status control
 *     and the real board against the in-browser test-repo backend; hiding
 *     them there would delete the coverage that tells us Decap still works
 *     the way this shim assumes it does.
 *   - index-local.html has no editorial workflow at all
 *     (config-local.base.yml sets no `publish_mode`), so there is no Status
 *     control and no board to hide — loading this there would be a no-op
 *     that implied otherwise.
 *
 * ── Why CSS-hide and never removeChild ─────────────────────────────────
 * The native-preview-href.js precedent, and it is a measured one: Decap is
 * React-driven and re-mounts elements it owns when it finds them missing,
 * which the observer then re-removes — a fight loop that wedged the editor
 * mid-flow on the failed prod-mutate and host-loop runs at commit 503365a.
 * `display:none` leaves the node exactly where React expects it, and React
 * does not observe inline styles, so reconciliation is a no-op.
 *
 * ── Why the ROUTE too, not just the nav link ───────────────────────────
 * Hiding the link is not hiding the board: `#/workflow` stays reachable
 * from a bookmark, from browser history, and from Decap's own post-action
 * redirects. A door you can still walk through is not closed, and the board
 * is the surface carrying the contradictory rule. So the hash is rewritten
 * to the site root when it lands on the workflow route.
 *
 * `location.replace` is used rather than an assignment so the skipped route
 * does not become a history entry the Back button drops the editor onto —
 * the same reasoning single-entry-collection-shortcut.js documents.
 *
 * ── Failure mode, and what is actually testable ────────────────────────
 * If a future Decap release renames either control, the selectors simply
 * stop matching and nothing is hidden: the admin degrades to today's
 * two-door behaviour, never to a page error.
 *
 * There is deliberately NO browser spec for this shim, and the reason is
 * worth stating rather than leaving as an apparent gap. A browser spec in
 * this suite drives a SERVED admin shell, and the only served shell that
 * loads this file is production — index-test.html must keep exercising
 * Decap's real Status control and board (that is the coverage this shim
 * relies on), and index-local.html has no editorial workflow at all. A
 * spec that read this file off the platform source tree and injected it
 * into a synthetic page would also break the consumer-context rule the
 * moment it ran on a consumer lane.
 *
 * So the parts most likely to break — the two ROUTE MATCHERS, which are
 * pure string functions and exactly the kind of thing a Decap router
 * change moves — are exported for unit testing on
 * `window.__oneDoorPublish`, the same way oauth-app-restriction-detector.js
 * exports its pure matcher. e2e/admin-publish-routing.test.js exercises
 * them with no browser; e2e/admin-publishing-ux.test.js holds the
 * structural half.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__oneDoorPublishInstalled) return;
  window.__oneDoorPublishInstalled = true;

  // Emotion's class hash churns between Decap releases but the trailing
  // component-name segment does not — the substring convention used by
  // native-preview-href.js, publish-step-hint.js and deploy-status-pill.js.
  var STATUS_TRIGGER = '[class*="StatusButton"]';
  var HIDDEN_ATTR = "data-one-door-hidden";

  // ── Pure route matchers (unit-tested) ─────────────────────────────────
  // Both answer "does this point at Decap's Workflow board?" and both are
  // deliberately narrow: a false positive here would hide an unrelated link
  // or bounce an editor off a route they asked for, which is worse than
  // leaving the board reachable.

  // A location hash. `#/workflow`, `#/workflow/`, `#/workflow/posts/x` —
  // but NOT `#/collections/workflow`, which is a legitimate collection a
  // site could name.
  function isWorkflowHash(hash) {
    return /(^|#)\/workflow(\/|$)/.test(String(hash || ""));
  }

  // An anchor's href ATTRIBUTE. Read the attribute rather than the resolved
  // `.href` property: under Decap's HashRouter the attribute is the bare
  // "#/workflow", while the property resolves against the shell's own URL.
  // Both forms are accepted anyway, plus a router that dropped the "#".
  function isWorkflowHref(href) {
    var s = String(href || "");
    var route = s.indexOf("#") === -1 ? s : s.slice(s.indexOf("#") + 1);
    return route === "/workflow" || route.indexOf("/workflow/") === 0;
  }

  function hideEl(el) {
    if (!el) return;
    // Already hidden — write nothing. An unconditional style write fires an
    // `attributes` mutation inside the subtree publish-step-hint.js's own
    // observer watches, so the steady state must not touch the DOM. The
    // conditional still recovers from emotion re-emitting a `style` attribute
    // that clobbers the inline display:none, which is why
    // native-preview-href.js re-asserts at all.
    if (el.style.getPropertyValue("display") === "none") return;
    // Out of the layout, the tab order and the a11y tree — without touching
    // the DOM tree React reconciles against.
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("tabindex", "-1");
    if (el.getAttribute(HIDDEN_ATTR) !== "1") el.setAttribute(HIDDEN_ATTR, "1");
  }

  // The toolbar Status dropdown trigger. Decap renders it only under
  // `publish_mode: editorial_workflow`, so on any other config this is
  // simply never found.
  function hideStatusControl() {
    var nodes;
    try {
      nodes = document.querySelectorAll(STATUS_TRIGGER);
    } catch (e) {
      return;
    }
    for (var i = 0; i < nodes.length; i++) hideEl(nodes[i]);
  }

  // The Workflow nav link. Read the ATTRIBUTE rather than the resolved
  // `.href` property: under Decap's HashRouter the attribute is the bare
  // "#/workflow", while the property resolves against the shell's own URL.
  function hideWorkflowNavLink() {
    var anchors;
    try {
      anchors = document.querySelectorAll("a[href]");
    } catch (e) {
      return;
    }
    for (var i = 0; i < anchors.length; i++) {
      if (isWorkflowHref(anchors[i].getAttribute("href"))) hideEl(anchors[i]);
    }
  }

  // The route itself — see "Why the ROUTE too" above.
  function leaveWorkflowRoute() {
    if (!isWorkflowHash(location.hash)) return;
    try {
      location.replace(location.pathname + location.search + "#/");
    } catch (e) {
      /* a sandboxed frame can refuse the navigation — degrade, never throw */
    }
  }

  function apply() {
    leaveWorkflowRoute();
    hideStatusControl();
    hideWorkflowNavLink();
  }

  // Coalesce to one pass per frame: Decap re-renders the toolbar on entry
  // switches, saves and field edits, and an unthrottled observer callback
  // would re-run these three queries on every keystroke.
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

  // Pure matchers, exported for unit testing (the oauth-app-restriction-detector.js
  // idiom). Nothing here reads DOM state.
  window.__oneDoorPublish = {
    installed: true,
    isWorkflowHash: isWorkflowHash,
    isWorkflowHref: isWorkflowHref,
  };
})();
