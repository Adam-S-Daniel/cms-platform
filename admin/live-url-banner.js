/*
 * admin/live-url-banner.js — renders a "View page on site:" banner at
 * the top of every entry-edit page in the Decap admin.
 *
 * The whole banner row is a single anchor when there's a destination
 * to click through to — `data-testid="cms-live-url-banner-link"` is the
 * stable hook e2e specs use to find it (e2e/cms-banner-clickable.spec.js).
 *
 * URL computation lives in `admin/live-url-derive.js` so the native
 * "View Live" toolbar override (`admin/native-preview-href.js`) can
 * compute the same URL without bundling. This file owns rendering, plus
 * the production-vs-preview ORIGIN decision described next.
 *
 * ── Preview-aware origin ──────────────────────────────────────────
 * `window.LiveURL.compute()` builds the URL from `window.location.origin`
 * — on the production admin (https://adamdaniel.ai/admin/) that is the
 * production host. But a post edited through Decap's editorial workflow
 * lives on a `cms/<collection>/<file-slug>` PR branch and is NOT on the
 * production site until that PR merges, so the banner used to link the
 * whole draft lifecycle at https://adamdaniel.ai/blog/<slug>/ — a hard
 * 404. While the PR is open the post IS live at the per-PR preview
 * environment, so when the open entry has an editorial-workflow PR this
 * script swaps the URL's host for `preview-pr<N>.adamdaniel.ai`, exactly
 * the URL admin/posts-list-enhance.js surfaces in the Posts list. With
 * no open PR the post is genuinely on production and the URL is left at
 * the current origin.
 *
 * The open-PR map is read from admin/posts-list-enhance.js's shared
 * sessionStorage cache when it's warm (an editor who reached the post
 * via the list pays zero extra network); otherwise one `pulls?state=
 * open` REST call (operator's Decap token, same auth pattern as
 * deploy-status-pill.js) is made and cached. With no token / on any API
 * error the banner degrades to the current-origin URL — never worse
 * than the pre-fix behaviour.
 *
 * Stateful sources (read inside `live-url-derive.js`):
 *   - `<input id="title-field-N">` — title text
 *   - `<input id="slug-field-N">` — explicit URL slug (optional)
 *   - `<input id="name-field-N">` — for tags (label is the slug source)
 *   - `<input id="permalink-field-N">` — for pages
 *   - `<button role="switch">` inside the Published field's
 *     ControlContainer — aria-checked = "true" / "false"
 *
 * Robust against Decap class churn: the only emotion-class anchors
 * are `ControlPaneContainer` (insertion point) and `ControlContainer`
 * (Published toggle's wrapper) — both stable component names.
 */
(function () {
  "use strict";

  var BANNER_ID = "cms-live-url";
  var REPO = window.CMS_REPO;
  var REST = "https://api.github.com/repos/" + REPO;
  // admin/posts-list-enhance.js writes { at, data:{ prBySlug, … } }
  // under this key whenever the operator visits the Posts list. Sharing
  // it means an editor who opened a post from the list incurs zero
  // extra network here.
  var PLE_CACHE_KEY = "cms-ple-remote-cache-v1";
  // Our own fallback cache for the deep-linked-straight-to-an-entry
  // case where the shared cache is cold.
  var PR_CACHE_KEY = "cms-live-url-pr-cache-v1";
  var CACHE_TTL_MS = 5 * 60 * 1000;

  // window.LiveURL is provided by admin/live-url-derive.js, which MUST be
  // loaded before this script (see admin/index*.html ordering).
  function compute() {
    return window.LiveURL ? window.LiveURL.compute() : null;
  }

  // ── open-PR lookup (preview-vs-prod origin) ──────────────────────
  function getToken() {
    try {
      var raw = localStorage.getItem("decap-cms-user");
      if (!raw) return null;
      var p = JSON.parse(raw);
      return p && p.token ? p.token : null;
    } catch {
      return null;
    }
  }

  function freshCache(key) {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || Date.now() - c.at > CACHE_TTL_MS) return null;
      return c;
    } catch {
      return null;
    }
  }

  // file-slug of the entry currently open in the editor, from Decap's
  // hash route `#/collections/<col>/entries/<slug>`. null on the
  // "new entry" route (no PR can exist yet) and the list route.
  function currentEntrySlug() {
    var m = /#\/collections\/[^/]+\/entries\/([^?#]+)/.exec(window.location.hash || "");
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }

  function stripDate(slug) {
    return String(slug || "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  }

  // slug → open-PR number. null until a lookup resolves.
  var prBySlug = null;
  var fetchInFlight = false;

  function adoptCache() {
    if (prBySlug) return true;
    var ple = freshCache(PLE_CACHE_KEY);
    if (ple && ple.data && ple.data.prBySlug) {
      // posts-list-enhance stores { number, url }; we only need number.
      var m = {};
      Object.keys(ple.data.prBySlug).forEach(function (k) {
        var v = ple.data.prBySlug[k];
        m[k] = v && typeof v === "object" ? v.number : v;
      });
      prBySlug = m;
      return true;
    }
    var own = freshCache(PR_CACHE_KEY);
    if (own && own.data) {
      prBySlug = own.data;
      return true;
    }
    return false;
  }

  function fetchOpenPrs() {
    if (fetchInFlight || prBySlug) return;
    var token = getToken();
    if (!token) return; // not signed in → degrade to current origin
    fetchInFlight = true;
    fetch(REST + "/pulls?state=open&per_page=100", {
      headers: {
        Authorization: "token " + token,
        Accept: "application/vnd.github+json",
      },
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (prs) {
        var map = {};
        if (Array.isArray(prs)) {
          prs.forEach(function (pr) {
            var ref = (pr.head && pr.head.ref) || "";
            // Decap editorial-workflow branches: cms/<col>/<file-slug>.
            // Key by the trailing slug (with optional date prefix), the
            // same shape posts-list-enhance.js's fetchOpenPrBySlug uses.
            var mm = /(?:^|\/)((?:\d{4}-\d{2}-\d{2}-)?[a-z0-9-]+)$/i.exec(ref);
            if (/^cms\//i.test(ref) && mm) {
              map[mm[1]] = pr.number;
            }
          });
        }
        prBySlug = map;
        try {
          sessionStorage.setItem(PR_CACHE_KEY, JSON.stringify({ at: Date.now(), data: map }));
        } catch {
          /* sessionStorage full/disabled — in-memory only */
        }
      })
      .catch(function () {
        /* network / API error — leave prBySlug null, current origin */
      })
      .then(function () {
        fetchInFlight = false;
        scheduleRender();
      });
  }

  // Swap the production URL's host for the per-PR preview host when the
  // open entry has an editorial-workflow PR; otherwise return the URL
  // unchanged (the post is genuinely on the current origin).
  function previewAwareURL(prodUrl) {
    if (!prodUrl) return prodUrl;
    var slug = currentEntrySlug();
    if (!slug) return prodUrl; // new / unsaved entry → no PR yet
    adoptCache();
    if (!prBySlug) {
      fetchOpenPrs(); // one-shot; scheduleRender() fires on resolve
      return prodUrl;
    }
    var n = prBySlug[slug];
    if (n == null) n = prBySlug[stripDate(slug)];
    if (n == null) return prodUrl; // no open PR → genuinely live on prod
    try {
      var u = new URL(prodUrl);
      u.protocol = "https:";
      u.hostname = "preview-pr" + n + "." + window.CMS_APEX;
      return u.toString();
    } catch {
      return prodUrl;
    }
  }

  function ensureBanner() {
    var existing = document.getElementById(BANNER_ID);
    if (existing) return existing;
    // Inner ControlPaneContainer = the form area; outer is the split-pane
    // parent that contains both form + preview panes. We want the inner.
    var panes = document.querySelectorAll('[class*="ControlPaneContainer"]');
    var pane = null;
    for (var i = 0; i < panes.length; i++) {
      if (panes[i].className.indexOf("PreviewPaneContainer") === -1) {
        pane = panes[i];
        break;
      }
    }
    if (!pane) return null;

    var b = document.createElement("div");
    b.id = BANNER_ID;
    b.style.cssText =
      [
        "padding:0.55rem 0.85rem",
        "margin:0.75rem 5rem 1rem",
        "border:1px solid #1a2a5e",
        "border-radius:6px",
        "background:#060d1f",
        "font-family:'Helvetica Neue',Arial,sans-serif",
        "font-size:0.78rem",
        "color:#a8b3c8",
        "display:flex",
        "align-items:baseline",
        "gap:0.5em",
        "flex-wrap:wrap",
      ].join(";") + ";";
    pane.insertBefore(b, pane.firstChild);
    return b;
  }

  // Cache the last-rendered markup so unchanged re-renders are no-ops.
  // Without this, the MutationObserver on document.body would observe
  // every `banner.innerHTML = …` write and schedule another render,
  // detaching the anchor mid-click and producing a "click → element
  // detached" flake against the very thing this banner is for.
  var lastHTML = null;

  function render() {
    var banner = ensureBanner();
    if (!banner) return;
    var data = compute();
    if (!data) {
      if (banner.style.display !== "none") banner.style.display = "none";
      return;
    }
    if (banner.style.display === "none") banner.style.display = "";

    // Label span — same styling whether or not the row is wrapped in an
    // anchor. Color stays even on the anchor case (the outer anchor uses
    // `color:inherit` so children render their own colors).
    var labelHTML =
      "<span style=\"font-weight:600;color:#8ab0e8;text-transform:uppercase;letter-spacing:0.08em;font-size:0.7rem;font-family:'SF Mono','Fira Code',monospace;\">View page on site:</span>";

    var nextHTML;
    if (data.published === false) {
      // No destination → render plain spans, no anchor. An anchor with
      // no href would be misleading; the row is informational here.
      nextHTML = labelHTML + ' <span style="font-style:italic;">Not yet published.</span>';
    } else if (!data.url) {
      nextHTML =
        labelHTML + ' <span style="font-style:italic;">Set a title or slug to see the URL.</span>';
    } else {
      // Live URL state: wrap the *entire row* in a single anchor so any
      // click in the banner opens the live URL. The URL span keeps the
      // accent color + underline so it still LOOKS like a link, but the
      // label and any whitespace between them are part of the same
      // clickable surface. data-testid is the contract e2e tests assert
      // on. When the entry is an unmerged editorial-workflow draft the
      // host is the per-PR preview env (it 404s on prod until merge).
      var liveURL = previewAwareURL(data.url);
      var safeURL = String(liveURL).replace(/[<>"']/g, function (c) {
        return { "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
      var urlSpanHTML =
        '<span style="color:#7bb3ff;text-decoration:underline;word-break:break-all;">' +
        safeURL +
        "</span>";
      nextHTML =
        '<a id="cms-live-url-banner-link" data-testid="cms-live-url-banner-link" ' +
        'target="_blank" rel="noopener" href="' +
        safeURL +
        '" ' +
        'style="display:flex;align-items:baseline;gap:0.5em;flex-wrap:wrap;color:inherit;text-decoration:none;width:100%;">' +
        labelHTML +
        urlSpanHTML +
        "</a>";
    }

    if (nextHTML !== lastHTML) {
      // eslint-disable-next-line no-unsanitized/property -- the only dynamic value (the live URL) is HTML-entity-escaped into `safeURL` above; the rest of `nextHTML` is static markup.
      banner.innerHTML = nextHTML;
      lastHTML = nextHTML;
    }
  }

  var pending = false;
  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      render();
    });
  }

  // Mutations re-render the banner when the form mounts / fields update.
  new MutationObserver(scheduleRender).observe(document.body, {
    childList: true,
    subtree: true,
  });
  // Input / change events catch toggle flips and typed values immediately.
  document.addEventListener("input", scheduleRender, true);
  document.addEventListener("change", scheduleRender, true);
  // Hash changes navigate between entries — refresh the banner.
  window.addEventListener("hashchange", scheduleRender);
  scheduleRender();
})();
