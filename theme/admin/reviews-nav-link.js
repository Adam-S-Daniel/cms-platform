/*
 * admin/reviews-nav-link.js — PRODUCTION SHELL ONLY. Puts "Reviews" in
 * Decap's top app-bar nav, between "Contents" and "Media", at the widths
 * where the floating Reviews button is hidden.
 *
 * ── Why ────────────────────────────────────────────────────────────────
 * admin-mobile.css rule 9 hides the floating #reviews-link at <= 768px,
 * because there it covered list rows (cms-platform#625.9/.10). That left
 * the Reviews dashboard (/admin/reviews/, which works on a phone) with no
 * way in from the admin on a phone — and the owner approves visual-
 * regression changes from his phone. The header nav has room for one more
 * item and is where Contents and Media already live, so Reviews goes there.
 *
 * ── What it renders ────────────────────────────────────────────────────
 *   <li id="cms-reviews-nav-item">
 *     <a id="cms-reviews-nav" class="<Contents link's classes>" href=…>
 *       <span class="<Contents icon wrapper's classes>"><svg …/></span>
 *       Reviews
 *     </a>
 *   </li>
 * inserted right after the <li> holding the Contents link (`href="#/"`).
 * On the production shell one-door-publish.js hides the Workflow link, so
 * the visible order is Contents, Reviews, Media. The link borrows the
 * Contents link's Emotion classes minus `header-link-active`, so its font,
 * color, spacing, hover and the platform's focus ring (admin-mobile.css
 * rule 0) are exactly its neighbors', with no copied style values to drift.
 *
 * WHEN it shows is CSS, not this file: admin-mobile.css hides
 * #cms-reviews-nav-item above 768px and rule 9 (the rule that hides the
 * floating button, same media query) shows it. So exactly one of the two
 * Reviews links is on screen at any width, and resizing needs no script.
 *
 * ── Where the link goes ────────────────────────────────────────────────
 * It copies the floating #reviews-link's href, which the shell's inline
 * syncReviewsReturn keeps at /admin/reviews/?return=<current hash>. One
 * writer of that value: this file never builds it. The inline listener is
 * registered before this deferred script, so on a hashchange the floating
 * link is current by the time this pass reads it. No #reviews-link (a
 * shell without Reviews) means no header item either.
 *
 * ── Why insert, and why the observer ───────────────────────────────────
 * Decap renders the header only on the list screens (the editor has none)
 * and re-creates it when it comes back, so the item is re-inserted from a
 * MutationObserver pass whenever it is missing. React leaves a foreign
 * node it did not create in place when it reconciles its own siblings, and
 * this file never removes or moves Decap's nodes (the fight loop
 * native-preview-href.js documents comes from removing React's nodes).
 * Every write is conditional, so the steady state touches nothing and
 * cannot feed the observer it runs from.
 *
 * ── Failure mode ───────────────────────────────────────────────────────
 * If a Decap release renames the nav list or the Contents route, nothing
 * is found and nothing is inserted: the phone admin is back to having no
 * Reviews link, never a page error.
 *
 * ── Scope: index.html ONLY ─────────────────────────────────────────────
 * The Reviews link exists only in the production shell. index-test.html
 * keeps Decap's stock header (specs address its nav links by name), and
 * index-local.html has no Reviews dashboard to link to.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__reviewsNavLinkInstalled) return;
  window.__reviewsNavLinkInstalled = true;

  var ITEM_ID = "cms-reviews-nav-item";
  var LINK_ID = "cms-reviews-nav";
  var NAV_LIST = '[class*="AppHeaderNavList"]';
  var ACTIVE_CLASS = "header-link-active";
  // The floating link's own icon, so both Reviews links look like one thing.
  var ICON_PATH =
    "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z";

  function contentsLink(list) {
    var anchors = list.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      if (anchors[i].getAttribute("href") === "#/") return anchors[i];
    }
    return null;
  }

  function linkClass(contents) {
    return String(contents.className || "")
      .split(/\s+/)
      .filter(function (c) {
        return c && c !== ACTIVE_CLASS;
      })
      .join(" ");
  }

  function build(contents) {
    var li = document.createElement("li");
    li.id = ITEM_ID;
    var a = document.createElement("a");
    a.id = LINK_ID;
    var iconSource = contents.querySelector("span");
    if (iconSource) {
      var icon = document.createElement("span");
      icon.className = iconSource.className;
      icon.setAttribute("aria-hidden", "true");
      var svgNS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "currentColor");
      var path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", ICON_PATH);
      svg.appendChild(path);
      icon.appendChild(svg);
      a.appendChild(icon);
    }
    a.appendChild(document.createTextNode("Reviews"));
    li.appendChild(a);
    return li;
  }

  function apply() {
    var source = document.getElementById("reviews-link");
    if (!source) return;
    var list;
    try {
      list = document.querySelector(NAV_LIST);
    } catch (e) {
      return;
    }
    if (!list) return;
    var contents = contentsLink(list);
    if (!contents) return;
    var contentsItem = contents.closest("li");
    if (!contentsItem || contentsItem.parentNode !== list) return;

    var item = document.getElementById(ITEM_ID);
    if (!item || item.parentNode !== list) {
      if (item && item.parentNode) item.parentNode.removeChild(item);
      item = build(contents);
      list.insertBefore(item, contentsItem.nextSibling);
    } else if (item.previousElementSibling !== contentsItem) {
      list.insertBefore(item, contentsItem.nextSibling);
    }

    var link = item.firstChild;
    var cls = linkClass(contents);
    if (link.className !== cls) link.className = cls;
    var href = source.getAttribute("href") || "/admin/reviews/";
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }

  // Coalesce to one pass per frame (the collection-controls-trim.js idiom).
  var pending = false;
  function run() {
    if (!pending) return;
    pending = false;
    apply();
  }
  function schedule() {
    if (pending) return;
    pending = true;
    // A background tab fires no animation frame (#644), so there the next
    // task runs the pass, and a tab hidden with a frame still pending runs it
    // at once (below). The guard in run() keeps it to one pass.
    if (document.hidden) setTimeout(run, 0);
    else if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) run();
  });

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
})();
