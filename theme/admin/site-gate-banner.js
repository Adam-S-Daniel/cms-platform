/*
 * admin/site-gate-banner.js — says so, on every screen, when the whole site
 * is gated.
 *
 * ── The defect (docs/PUBLISHING-UX.md §2.6, row 6 of the nine) ──────────
 * A site can be gated: jodidaniel.com ships coming-soon behind a single
 * boolean, `site_live` in `_data/settings.yml`, and `_layouts/home.html`
 * wraps every bio section in `{% if live %}`. While it is false, an editor
 * can write, save, publish, watch the deploy succeed, open the site — and
 * see none of it. Nothing has gone wrong; the gate is doing its job.
 *
 * The problem is entirely one of disclosure. That boolean is discoverable
 * only by opening one particular collection and reading one particular
 * field, and a site can sit gated for months. "Publish" that reliably puts
 * nothing on the public site, with no notice anywhere, is the most
 * expensive lie in the product — it is the one state where every other
 * signal this admin shows is simultaneously true and useless.
 *
 * So: a permanent banner, on every screen, naming the state and linking to
 * the one control that changes it.
 *
 * ── IN FLOW, not fixed — and the contrast is the point ──────────────────
 * oauth-app-restriction-detector.js paints a `position: fixed` top banner,
 * and that is correct FOR IT: it is a transient, dismissible alert about a
 * save that just failed, and covering the toolbar for a moment is a fair
 * price for being unmissable.
 *
 * This banner is permanent while it applies. A permanent fixed overlay at
 * `top: 0` would sit on Decap's editor toolbar (itself `position: absolute;
 * top: 0`, anchored to the viewport) forever — the §2.3 defect, which
 * shipped once already and covered 68% of the Publish button. So this one
 * is a block in normal flow at the top of `<body>`: it pushes the app down
 * instead of covering it, and is structurally incapable of hiding a
 * control.
 *
 * "Pushes the app down" needs one more piece, learned by measurement while
 * #412 was built: on the ENTRY EDITOR route Decap's `EditorContainer` is
 * `position: absolute; top: 0; height: 100%` with no positioned ancestor,
 * so it anchors to the viewport and painted OVER this banner at 1280x800
 * (`elementFromPoint` at the banner's centre returned the split-pane
 * resizer; the screenshot showed no banner). The list and login routes,
 * whose header is sticky, and the phone layout, where admin-mobile.css
 * makes the toolbar static, were fine — which is how v0.1.96 shipped
 * "on every screen" while it was false on the one screen an editor lives
 * in. The banner therefore adds `cms-notice-band` to <body>, and
 * admin-notice-band.css turns body into a flex column with `#nc-root`
 * filling the remaining viewport, so the editor anchors below the notices.
 *
 * When branch-binding-banner.js (#412) has put its own banner at the top of
 * <body> — a preview admin, bound to a PR branch — this one goes directly
 * BELOW it, so the page reads "you are on a branch" before "the public site
 * is gated" whichever of the two async reads resolved first. The ordering is
 * pinned by e2e/branch-binding-banner.test.js.
 *
 * ── True on both surfaces ──────────────────────────────────────────────
 * The same admin is served from production AND from every PR preview, where
 * it is bound to the PR branch (#412), and each surface is built from its own
 * branch: a preview can carry the opposite `site_live` from production. So
 * the flag is read at the branch THIS admin is bound to — `?ref=` the served
 * config's `backend.branch`, via window.CMSHostname.binding() — and the copy
 * names the host that branch is served on: the canonical production host
 * (CMSHostname.canonical()) when the admin is bound to the production branch,
 * and the preview host (CMSHostname.destination(), the served `site_url`) on
 * a preview (#528). Reading the default branch, as this banner once did,
 * showed production's setting above a preview that disagreed with it. The
 * branch banner above this one says where a change made here goes.
 *
 * When the branch cannot be read, the banner says nothing: guessing the
 * default branch would bring back exactly that disagreement.
 *
 * ── Site-agnostic by construction ──────────────────────────────────────
 * The platform must never hardcode one site's identity, and "which boolean
 * gates this site" is identity. The site declares it in `_config.yml`:
 *
 *   cms:
 *     site_gate:
 *       path: _data/settings.yml                          # file holding it
 *       field: site_live                                  # the boolean key
 *       entry: "#/collections/settings/entries/settings"  # where to change it
 *       label: coming-soon mode                           # optional, for copy
 *
 * Both render paths (scripts/render-decap-config.rb and the theme gem's
 * decap_config_hook.rb) inject that as `window.CMS_SITE_GATE`, kept in
 * lockstep by e2e/decap-config-render-parity.test.js. A site with no
 * `site_gate` — adamdaniel.ai, every scaffolded site — injects `null` and
 * this shim is inert. Absence of the key is the normal case, not a gap.
 *
 * ── Reading the flag ───────────────────────────────────────────────────
 * One `GET /repos/<repo>/contents/<path>?ref=<branch>` per admin load, with
 * the editor's own Decap token, cached in sessionStorage for five minutes
 * under a key naming the repository, branch, file and field — so a value
 * read for one branch is never shown for another. The truth
 * lives in the repo, so that is where it is read from: deriving it from the
 * rendered site would mean parsing the public HTML for the ABSENCE of
 * content, which cannot tell "gated" from "empty".
 *
 * The value is read lexically — no YAML parser is loaded in the admin page
 * (Decap bundles one but does not expose it) — so the contract is narrow,
 * and deliberately so: the gate must be a TOP-LEVEL boolean key. Only a line
 * that starts at column 0 with the key spelled exactly as declared counts,
 * and its value must be a YAML boolean (`true`/`True`/`TRUE`, likewise
 * false). An indented line is never the top-level key — it is a nested key
 * or the body of a block scalar — so it is ignored; a differently-cased key
 * is a different key. A quoted or aliased value, or the key appearing at
 * column 0 more than once, reads as unknown, and unknown shows NO banner
 * rather than a guessed one. Claiming the site is gated when it is not would
 * be worse than saying nothing.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__siteGateBannerInstalled) return;
  window.__siteGateBannerInstalled = true;

  var BANNER_ID = "cms-site-gate-banner";
  // Prefix only: the full key is scoped to repo, branch, file and field.
  var CACHE_KEY = "cms-site-gate-state";
  var CACHE_TTL_MS = 5 * 60 * 1000;

  var gate = window.CMS_SITE_GATE || null;
  if (!gate || !gate.path || !gate.field) return; // no gate declared — inert

  function getToken() {
    try {
      var raw = localStorage.getItem("decap-cms-user");
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed.token : null;
    } catch (e) {
      return null;
    }
  }

  function cacheKey(branch) {
    return CACHE_KEY + ":" + JSON.stringify([window.CMS_REPO || "", branch, gate.path, gate.field]);
  }

  function readCache(branch) {
    try {
      var c = JSON.parse(sessionStorage.getItem(cacheKey(branch)) || "null");
      if (!c || Date.now() - c.at > CACHE_TTL_MS) return null;
      return c.live;
    } catch (e) {
      return null;
    }
  }

  function writeCache(branch, live) {
    try {
      sessionStorage.setItem(cacheKey(branch), JSON.stringify({ at: Date.now(), live: live }));
    } catch (e) {
      /* private mode / quota — the fetch just repeats next load */
    }
  }

  // true / false / null (could not tell). See "Reading the flag" above for
  // why null must render nothing.
  function parseFlag(text) {
    var key = gate.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Column 0, exact key case: a top-level key and nothing else.
    var keyLine = new RegExp("^" + key + "[ \\t]*:", "gm");
    var lines = String(text || "").match(keyLine) || [];
    if (lines.length !== 1) return null; // absent, or a duplicate key — unknown
    var m = new RegExp(
      "^" + key + "[ \\t]*:[ \\t]*(true|True|TRUE|false|False|FALSE)[ \\t]*(?:#[^\\n]*)?\\r?$",
      "m",
    ).exec(String(text || ""));
    if (!m) return null;
    return m[1].toLowerCase() === "true";
  }

  // The branch this admin is bound to and the host it is served on, from the
  // served config (site-hostname.js); null when either cannot be read.
  async function readBinding() {
    var names = window.CMSHostname;
    if (!names || typeof names.binding !== "function" || typeof names.destination !== "function") return null;
    try {
      var b = await names.binding();
      return b && b.branch ? b : null;
    } catch (e) {
      return null;
    }
  }

  async function fetchFlag(branch) {
    var token = getToken();
    if (!token) return null;
    try {
      var res = await fetch(
        "https://api.github.com/repos/" + window.CMS_REPO + "/contents/" + gate.path +
          "?ref=" + encodeURIComponent(branch),
        {
          cache: "no-cache",
          headers: {
            Authorization: "token " + token,
            Accept: "application/vnd.github.raw+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!res.ok) return null;
      return parseFlag(await res.text());
    } catch (e) {
      return null;
    }
  }

  // The production branch names the canonical host; any other branch is a
  // preview, served at the served config's site_url. Without an injected
  // production branch, the served site_url is still the right host for both.
  // (Only reached once readBinding() has found window.CMSHostname.)
  function siteName(branch) {
    var production = window.CMS_PRODUCTION_BRANCH;
    if (typeof production === "string" && production && branch === production) {
      return window.CMSHostname.canonical();
    }
    return window.CMSHostname.destination();
  }

  // ── Entry route → entry route needs a full page load (#624, #342) ──────
  // The link points at an ENTRY route and this banner is rendered inside the
  // entry editor, so a plain click is an entry → entry hash change. Decap
  // 3.15.1 mishandles that: it mounts the new editor without loading the
  // entry, so Site Settings shows empty fields under "Changes saved" (F5
  // fixes it; #342 is the same defect, seen there as a failed publish). So
  // from an entry route we pushState the target and reload. From any other route
  // (list, dashboard, new-entry) the native in-app navigation works and is
  // left alone, as is a modified click (open in a new tab).
  //
  // Unsaved work: the only guard is Decap's own `beforeunload` prompt
  // (registered while the editor is dirty), raised by the reload. Known minor
  // edge: if the user cancels it, the URL shows the target while the old
  // entry stays on screen. We deliberately do NOT add a general "any entry ->
  // entry hashchange forces a reload" guard: by the time `hashchange` fires
  // the URL has already changed, so it cannot ask first, and it would race
  // Decap's router Prompt (Back/Forward, bookmarks stay as Decap handles them).
  var ENTRY_ROUTE = /^#\/collections\/[^/]+\/entries\//;

  function onEntryLinkClick(ev) {
    if (ev.defaultPrevented || ev.button > 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
    if (!ENTRY_ROUTE.test(window.location.hash || "")) return;
    ev.preventDefault();
    // pushState fires no hashchange/popstate, so Decap's router never sees
    // the broken entry -> entry navigation; the reload lands on the target
    // and Back still returns to the entry.
    window.history.pushState(null, "", gate.entry);
    window.location.reload();
  }

  function render(live, branch) {
    var existing = document.getElementById(BANNER_ID);
    // live === true → gate is open, nothing to say.
    // live === null → we could not tell; say nothing rather than guess.
    if (live !== false) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return; // permanent while it applies — never re-created
    if (!document.body) return;

    var b = document.createElement("div");
    b.id = BANNER_ID;
    b.setAttribute("role", "status");
    // UI chrome, not page content — excluded from the visual-regression
    // text diff, like every other injected admin surface.
    b.setAttribute("data-visreg-ignore", "");
    b.style.cssText =
      [
        // NO position:fixed — see the placement block in the header. This is
        // permanent chrome, and permanent chrome that overlays is occlusion.
        "box-sizing:border-box",
        "width:100%",
        "padding:0.7rem 1.1rem",
        "background:#3d2f05",
        "color:#fdf3d8",
        "font:600 0.85rem/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
        "display:flex",
        "flex-wrap:wrap",
        "align-items:center",
        "gap:0.5rem 0.9rem",
      ].join(";") + ";";

    var label = gate.label || "coming-soon mode";
    var site = siteName(branch);
    var text = document.createElement("span");
    text.style.cssText = "flex:1 1 20rem;min-width:14rem;font-weight:500;";
    text.textContent =
      site + " is in " + label + " — its visitors see the coming-soon page, " +
      "not what has been published. Everything saved and published is kept, " +
      "and it all appears at once when " + site + " is switched on.";
    b.appendChild(text);

    if (gate.entry) {
      var a = document.createElement("a");
      a.href = gate.entry;
      a.textContent = "Change this setting";
      a.style.cssText =
        "color:#fdf3d8;font-weight:700;text-decoration:underline;white-space:nowrap;";
      a.addEventListener("click", onEntryLinkClick);
      b.appendChild(a);
    }

    // Below the branch banner when there is one (see the placement block in
    // the header); otherwise at the very top.
    var above = document.getElementById("cms-branch-binding-banner");
    if (above && above.parentNode === document.body) {
      document.body.insertBefore(b, above.nextSibling);
    } else {
      document.body.insertBefore(b, document.body.firstChild);
    }
    // Make room: Decap's entry editor is an absolute box anchored to the
    // viewport and would paint over a block in flow at body's top — see
    // "IN FLOW, not fixed" above. The class keys admin-notice-band.css.
    document.body.classList.add("cms-notice-band");
  }

  async function refresh() {
    var bound = await readBinding();
    if (!bound) return; // which branch is unknown — say nothing rather than guess
    var cached = readCache(bound.branch);
    if (cached !== null) {
      render(cached, bound.branch);
      return;
    }
    var live = await fetchFlag(bound.branch);
    if (live === null) return; // could not tell — leave whatever is on screen
    writeCache(bound.branch, live);
    render(live, bound.branch);
  }

  // Exported for e2e/site-gate-banner.test.js (vm sandbox), the seam
  // branch-binding-banner.js exposes as window.CMSBranchBinding.
  window.CMSSiteGate = { refresh: refresh, parseFlag: parseFlag, BANNER_ID: BANNER_ID };

  function start() {
    refresh();
    // Re-check on a slow cadence rather than a fast one: this changes about
    // once in the life of a site, and the cache already answers the common
    // case without a request.
    setInterval(refresh, CACHE_TTL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
