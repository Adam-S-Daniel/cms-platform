/*
 * admin/oauth-app-restriction-detector.js — issue #26.
 *
 * The "can log in but can't save" failure mode on ORG-OWNED consumers:
 * when an organization has GitHub's *OAuth App access restrictions* enabled
 * and the CMS OAuth App hasn't been approved for that org, Decap CMS
 * AUTHENTICATES and READS fine, but every PERSIST (save / publish) fails
 * with an API error whose message is GitHub's verbatim:
 *
 *   "...the `<org>` organization has enabled OAuth App access restrictions,
 *    meaning that data access to third-parties is limited..."
 *
 * (jodidaniel hit this as jodidaniel/jodidaniel.com#27; an org owner
 * approving the app resolved it.) The raw "API_ERROR … OAuth App access
 * restrictions" toast is baffling to a non-technical editor, so this shim
 * turns it into an actionable, DISMISSIBLE banner that tells the ORG OWNER
 * exactly where to approve the app.
 *
 * ── Design constraints (see #26 implementation notes) ─────────────────
 *  - Does NOT block editing. It's a banner; the editor can dismiss it and
 *    keep working (their save just won't land until the app is approved).
 *  - Does NOT clobber/replace window.fetch. publish-via-auto-merge.js
 *    already wraps fetch; a second wrap risks interfering with that and
 *    with Decap's own AbortSignal handling (the Safari loadEntries bug).
 *    Instead we OBSERVE Decap's notification surface: Decap renders persist
 *    failures into a toast/snackbar in the DOM, so a MutationObserver on
 *    document.body that scans freshly-added text for the restriction message
 *    is fetch-agnostic and robust to Decap class churn.
 *  - Reference the OAuth App Client ID GENERICALLY (it lives in the site's
 *    oauth-proxy stack) — we do NOT inject a client_id, to avoid touching
 *    the byte-locked render paths.
 *  - NO-OPs harmlessly anywhere it isn't meaningful: only the real GitHub
 *    backend (prod /admin) can ever produce this error, but the detector is
 *    inert until a matching message actually appears, so loading it in the
 *    local/test shells (or in Node for tests) does nothing.
 *
 * Org is derived from window.CMS_REPO ("owner/repo", injected by the render
 * hook) — split on "/". With no CMS_REPO the banner still explains the
 * failure but omits the deep-link (degrade, never a broken link).
 *
 * The pure helpers are exported on window.OAuthAppRestrictionDetector for
 * unit testing (e2e/oauth-app-restriction-detector.test.js), mirroring how
 * live-url-derive.js exposes window.LiveURL. The DOM/registration code is
 * guarded behind typeof window/document checks so the module is requireable
 * in Node with nothing running but the export assignment.
 */
(function () {
  "use strict";

  // ── Pure helpers (unit-tested) ───────────────────────────────────────

  // True when `text` is GitHub's OAuth-App-access-restriction persist error.
  // Matches the real verbatim message AND Decap's "API_ERROR: OAuth App
  // access restrictions" wrap; rejects every benign error (rule violations,
  // bad credentials, expired token, branch-protection restrictions, …).
  // The anchor is the specific phrase "OAuth App access restrictions" — a
  // token-expiry message that merely says "OAuth" must NOT match.
  function isOAuthAppRestrictionError(text) {
    if (text == null) return false;
    return /oauth app access restrictions/i.test(String(text));
  }

  // "owner/repo" → "owner" (the org/user that owns the repo). Tolerates
  // surrounding whitespace and a stray leading slash; returns null on
  // anything that isn't a non-empty owner before a "/".
  function orgFromRepo(repo) {
    if (typeof repo !== "string") return null;
    var trimmed = repo.trim().replace(/^\/+/, "");
    var slash = trimmed.indexOf("/");
    if (slash <= 0) return null;
    var owner = trimmed.slice(0, slash).trim();
    return owner || null;
  }

  // org → the GitHub settings deep-link where an org owner approves OAuth
  // Apps (Settings → Third-party access → OAuth App policy). null when org
  // is missing, so callers render no link rather than a broken one.
  function orgOAuthPolicyUrl(org) {
    if (!org) return null;
    return "https://github.com/organizations/" + org + "/settings/oauth_application_policy";
  }

  var api = {
    isOAuthAppRestrictionError: isOAuthAppRestrictionError,
    orgFromRepo: orgFromRepo,
    orgOAuthPolicyUrl: orgOAuthPolicyUrl,
  };

  // Export for unit tests (Node vm sandbox / browser). Always do this — it's
  // the only thing that runs when the module is loaded outside a real DOM.
  if (typeof window !== "undefined") {
    window.OAuthAppRestrictionDetector = api;
  }

  // ── Runtime banner wiring (browser only) ─────────────────────────────
  // Guard: a real document is required. In the Node test sandbox `document`
  // is undefined, so everything below is skipped and only the export above
  // ran — keeping the module side-effect-free for unit tests.
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) {
    return;
  }
  if (window.__oauthAppRestrictionDetectorInstalled) return;
  window.__oauthAppRestrictionDetectorInstalled = true;

  var BANNER_ID = "cms-oauth-app-restriction-banner";

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function org() {
    return orgFromRepo(typeof window.CMS_REPO === "string" ? window.CMS_REPO : null);
  }

  // Render (or re-render) the banner. Re-shows on every fresh failure: a
  // dismissed banner is removed from the DOM, so the next matching toast
  // rebuilds it. Returns the banner element (or null if the body is gone).
  function showBanner() {
    if (!document.body) return null;
    // If a banner is already visible, leave it (don't stack duplicates).
    var existing = document.getElementById(BANNER_ID);
    if (existing) return existing;

    var o = org();
    var policyUrl = orgOAuthPolicyUrl(o);

    var b = document.createElement("div");
    b.id = BANNER_ID;
    b.setAttribute("role", "alert");
    b.setAttribute("data-testid", "cms-oauth-app-restriction-banner");
    b.style.cssText =
      [
        "position:fixed",
        "top:0",
        "left:0",
        "right:0",
        "z-index:2147483647",
        "padding:0.9rem 1.1rem",
        "background:#7f1d1d",
        "color:#fff",
        "font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
        "box-shadow:0 2px 12px rgba(0,0,0,.35)",
        "display:flex",
        "align-items:flex-start",
        "gap:0.75rem",
      ].join(";") + ";";

    // Org-specific deep link when we can derive the org; otherwise a generic
    // pointer to the same Settings page (degrade, never a broken link).
    var linkHTML = policyUrl
      ? '<a href="' +
        escapeHTML(policyUrl) +
        '" target="_blank" rel="noopener" ' +
        'style="color:#fecaca;font-weight:600;text-decoration:underline;">' +
        "Settings → Third-party access → OAuth App policy</a>"
      : "<span style=\"font-weight:600;\">your organization's Settings → " +
        "Third-party access → OAuth App policy</span>";

    var orgLabel = o ? "The <strong>" + escapeHTML(o) + "</strong> organization" : "Your organization";

    var msgHTML =
      '<div style="flex:1;min-width:0;">' +
      '<div style="font-weight:700;margin-bottom:0.2rem;">Saving is blocked — the CMS OAuth App needs org approval</div>' +
      "<div>" +
      orgLabel +
      " has <strong>OAuth App access restrictions</strong> enabled, and this site's " +
      "CMS OAuth App hasn't been approved. You can sign in and browse, but " +
      "<strong>saves and publishes will fail</strong> until an <strong>org owner</strong> " +
      "approves the app's Client ID (it's in the site's oauth-proxy stack) at " +
      linkHTML +
      "." +
      "</div>" +
      "</div>";

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.setAttribute("data-testid", "cms-oauth-app-restriction-dismiss");
    dismiss.textContent = "✕";
    dismiss.style.cssText =
      [
        "flex:0 0 auto",
        "background:transparent",
        "border:0",
        "color:#fff",
        "font-size:1.1rem",
        "line-height:1",
        "cursor:pointer",
        "padding:0.15rem 0.35rem",
        "opacity:0.85",
      ].join(";") + ";";
    dismiss.onclick = function () {
      try {
        b.remove();
      } catch {
        /* already detached */
      }
    };

    // eslint-disable-next-line no-unsanitized/property -- the only dynamic values (org, policyUrl) are HTML-entity-escaped via escapeHTML; the rest is static markup.
    b.innerHTML = msgHTML;
    b.appendChild(dismiss);
    document.body.appendChild(b);
    return b;
  }

  // Scan a freshly-mutated subtree's text for the restriction message. We
  // read textContent of added nodes (Decap renders the error into a toast),
  // and also re-scan on character-data changes (the toast text can be set
  // after the node is inserted).
  function scan(text) {
    if (isOAuthAppRestrictionError(text)) {
      showBanner();
      return true;
    }
    return false;
  }

  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "characterData") {
        if (scan(r.target && r.target.textContent)) return;
        continue;
      }
      var added = r.addedNodes || [];
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        // Element or text node — read whatever text it carries.
        var t = n && (n.textContent != null ? n.textContent : n.nodeValue);
        if (t && scan(t)) return;
      }
    }
  }

  try {
    new MutationObserver(onMutations).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch {
    /* MutationObserver unavailable — detector inert, editing unaffected */
  }

  // Tiny debug surface (mirrors publish-via-auto-merge.js): lets a spec
  // confirm the detector installed and trigger the banner directly.
  window.__oauthAppRestrictionDetector = {
    installed: true,
    showBanner: showBanner,
    isOAuthAppRestrictionError: isOAuthAppRestrictionError,
  };
})();
