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
 * `top: 0` would sit on Decap's editor toolbar (itself `position: fixed;
 * top: 0`) forever — the §2.3 defect, which shipped once already and
 * covered 68% of the Publish button. So this one is a block in normal flow
 * at the top of `<body>`: it pushes the app down instead of covering it,
 * costs a banner's height of scroll, and is structurally incapable of
 * hiding a control.
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
 * One `GET /repos/<repo>/contents/<path>` per admin load, with the editor's
 * own Decap token, cached in sessionStorage for five minutes. The truth
 * lives in the repo, so that is where it is read from: deriving it from the
 * rendered site would mean parsing the public HTML for the ABSENCE of
 * content, which cannot tell "gated" from "empty".
 *
 * The value is matched with a line-anchored regex for a top-level boolean.
 * That is a LEXICAL question about one leaf token, not a claim about
 * document structure, so it does not need a YAML parser (the house AST rule
 * governs code-shape lints, not this) — but it does mean the contract is
 * narrow, and deliberately so: the gate must be a TOP-LEVEL boolean key. A
 * nested or quoted or aliased value does not match, and an unmatched value
 * shows NO banner rather than a guessed one. Claiming the site is gated
 * when it is not would be worse than saying nothing.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__siteGateBannerInstalled) return;
  window.__siteGateBannerInstalled = true;

  var BANNER_ID = "cms-site-gate-banner";
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

  function readCache() {
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if (!c || Date.now() - c.at > CACHE_TTL_MS) return null;
      return c.live;
    } catch (e) {
      return null;
    }
  }

  function writeCache(live) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), live: live }));
    } catch (e) {
      /* private mode / quota — the fetch just repeats next load */
    }
  }

  // true / false / null (could not tell). See "Reading the flag" above for
  // why null must render nothing.
  function parseFlag(text) {
    var re = new RegExp("^[ \\t]*" + gate.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[ \\t]*:[ \\t]*(true|false)[ \\t]*(?:#.*)?$", "mi");
    var m = re.exec(String(text || ""));
    if (!m) return null;
    return m[1].toLowerCase() === "true";
  }

  async function fetchFlag() {
    var token = getToken();
    if (!token) return null;
    try {
      var res = await fetch(
        "https://api.github.com/repos/" + window.CMS_REPO + "/contents/" + gate.path,
        {
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

  function render(live) {
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
    var text = document.createElement("span");
    text.style.cssText = "flex:1 1 20rem;min-width:14rem;font-weight:500;";
    text.textContent =
      "The whole site is in " + label + " — nothing you publish is visible to " +
      "the public yet. Everything you save and publish is kept, and it all " +
      "appears at once when the site is switched on.";
    b.appendChild(text);

    if (gate.entry) {
      var a = document.createElement("a");
      a.href = gate.entry;
      a.textContent = "Change this setting";
      a.style.cssText =
        "color:#fdf3d8;font-weight:700;text-decoration:underline;white-space:nowrap;";
      b.appendChild(a);
    }

    document.body.insertBefore(b, document.body.firstChild);
  }

  async function refresh() {
    var cached = readCache();
    if (cached !== null) {
      render(cached);
      return;
    }
    var live = await fetchFlag();
    if (live === null) return; // could not tell — leave whatever is on screen
    writeCache(live);
    render(live);
  }

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
