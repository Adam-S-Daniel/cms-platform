/*
 * admin/media-search-nav-link.js — PRODUCTION SHELL ONLY. Puts "Media search"
 * in Decap's top app-bar nav, right after "Reviews" (or after "Contents"
 * when there is no Reviews item), at every width.
 *
 * It is reviews-nav-link.js's twin and follows its rules (read that header):
 * the item is an <li><a> that borrows the Contents link's classes minus
 * `header-link-active`, so its font, spacing, hover and focus ring are its
 * neighbors' with no copied style values; Decap re-creates the header, so a
 * MutationObserver pass re-inserts it when missing; nothing of Decap's is
 * removed or moved; every write is conditional, so the steady state touches
 * nothing; the pass coalesces on a frame, or the next task in a hidden tab
 * (#644). reviews-nav-link.js puts Reviews directly after Contents, so this
 * item anchors after Reviews and the two never fight over a position.
 *
 * The page it links to is /admin/media-search.html. If a Decap release
 * renames the nav list or the Contents route nothing is found and nothing is
 * inserted: the link is simply absent, never a page error.
 *
 * Scope: index.html ONLY (index-test.html keeps Decap's stock header, and
 * index-local.html has no results to show).
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__mediaSearchNavLinkInstalled) return;
  window.__mediaSearchNavLinkInstalled = true;

  var ITEM_ID = "cms-media-search-nav-item";
  var LINK_ID = "cms-media-search-nav";
  var REVIEWS_ITEM_ID = "cms-reviews-nav-item";
  var HREF = "/admin/media-search.html";
  var NAV_LIST = '[class*="AppHeaderNavList"]';
  var ACTIVE_CLASS = "header-link-active";
  // A magnifying glass.
  var ICON_PATH =
    "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z";

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
    a.appendChild(document.createTextNode("Media search"));
    li.appendChild(a);
    return li;
  }

  function apply() {
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

    var reviews = document.getElementById(REVIEWS_ITEM_ID);
    var anchor = reviews && reviews.parentNode === list ? reviews : contentsItem;

    var item = document.getElementById(ITEM_ID);
    if (!item || item.parentNode !== list) {
      if (item && item.parentNode) item.parentNode.removeChild(item);
      item = build(contents);
      list.insertBefore(item, anchor.nextSibling);
    } else if (item.previousElementSibling !== anchor) {
      list.insertBefore(item, anchor.nextSibling);
    }

    var link = item.firstChild;
    var cls = linkClass(contents);
    if (link.className !== cls) link.className = cls;
    if (link.getAttribute("href") !== HREF) link.setAttribute("href", HREF);
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
    // task runs the pass; a tab hidden with a frame pending runs it at once.
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
