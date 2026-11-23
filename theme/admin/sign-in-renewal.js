/*
 * sign-in-renewal.js — sign in again WITHOUT reloading, so typed work is not
 * lost when the GitHub sign-in ends mid-edit (#516 spike row 11).
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * A GitHub sign-in can end while an entry is open: a GitHub App user token
 * expires after 8 hours, and any token can be revoked. From then on every
 * save fails ("Failed to persist entry: API_ERROR: Bad credentials"), and so
 * does the automatic save (autosave-on-hide.js only clicks Save). The only
 * way back used to be a reload and a fresh sign-in, and a reload loses the
 * typed work: Decap's own "restore local backup?" offer is suppressed on
 * purpose (confirm-wrap-local-backup.js), because Decap drops the restored
 * work in a race (decaporg/decap-cms#6989, still present in 3.17.3).
 *
 * The typed work is still in the page, in Decap's in-memory draft. So the fix
 * is to never need the reload:
 *
 *   1. notice the dead sign-in (a 401 "Bad credentials" from api.github.com);
 *   2. show a notice with a "Sign in again" button;
 *   3. run the same OAuth-proxy popup handshake the reviews dashboards use;
 *   4. from then on, swap the dead token for the new one on every GitHub API
 *      request, because Decap keeps the old token in memory and offers no
 *      way to replace it. The stored session (`localStorage
 *      ["decap-cms-user"]`) is updated too, so the other shims and the next
 *      page load use the new token.
 *
 * Save then works on the open entry, with nothing retyped.
 *
 * ── No second wrap that rewrites requests ───────────────────────────────
 * publish-via-auto-merge.js owns the ONLY window.fetch wrap that changes
 * what is sent (a second one risks the Safari loadEntries hang, see
 * docs/CONSUMER-COMPATIBILITY.md). media-library-tidy.js wraps fetch too,
 * but sends every request as given and only filters two listings on the
 * way back. This file wraps nothing: it exposes `window.CMSSignInRenewal`, and that
 * wrap calls `prepare()` before and `observe()` after each request. It must
 * therefore load BEFORE publish-via-auto-merge.js, non-deferred
 * (e2e/sign-in-renewal.test.js locks the order). `prepare()` returns null
 * for a request it has no reason to change, so the wrap still passes the
 * caller's original arguments through untouched.
 *
 * ── Once a token is known dead, its requests are answered here ──────────
 * The polling shims and Decap keep sending the dead token, and each request
 * is a red 401 in the console and a wasted round trip. After GitHub has said
 * "Bad credentials" for a token once, `prepare()` answers later requests
 * that carry it with the same 401, locally. Only that exact body marks a
 * token dead; any other 401 is passed through and judged again next time.
 * One answer is not trusted on its own: before the notice appears the token
 * is tried once more against GET /user, for real, and a token that works is
 * put back in use (#1049 follow-up 3).
 *
 * ── A second open tab ───────────────────────────────────────────────────
 * Signing in again in one tab leaves every other open tab holding the dead
 * token in memory, with a stored session that no longer matches it. Such a
 * tab takes the stored session's token instead of asking for another
 * sign-in, but only when another tab wrote it (a `storage` event, which a
 * tab never gets for its own writes), it names the account this tab was
 * using, and GitHub confirms that (#1049 follow-up 1). Otherwise the tab
 * shows the notice and asks.
 *
 * ── Security ────────────────────────────────────────────────────────────
 *  - The `message` listener checks `origin` (the OAuth proxy) AND `source`
 *    (the popup this page opened) before reading anything, and replies only
 *    to that checked origin (docs/ADMIN-AUTH-SECURITY.md).
 *  - A new token, from the popup or from another tab's stored session, is
 *    accepted only if GitHub says it belongs to the SAME account as the
 *    session it replaces. Without a known account name it is refused.
 *  - Tokens are swapped only on https://api.github.com/ requests and are
 *    never logged.
 *
 * ── The notice ──────────────────────────────────────────────────────────
 * In normal flow at the top of <body> with `cms-notice-band`, never a fixed
 * overlay over the toolbar (#329, #412). It is not shown when Decap itself
 * signs the user out (a page load with a dead stored token lands on Decap's
 * own sign-in page, which removes the stored session): the check waits
 * SETTLE_MS and shows nothing if the stored session is gone.
 */
(function () {
  "use strict";

  if (window.CMSSignInRenewal) return;

  var API_PREFIX = "https://api.github.com/";
  var USER_KEY = "decap-cms-user";
  // Read by confirm-wrap-local-backup.js so its after-reload message does not
  // claim the work was saved when the sign-in had ended first.
  var EXPIRED_FLAG = "cms-sign-in-expired";
  var BANNER_ID = "cms-sign-in-expired-banner";
  var SETTLE_MS = 2000;
  var DONE_MS = 12000;

  var dead = Object.create(null); // token -> true
  var replacement = Object.create(null); // dead token -> its replacement
  var owner = Object.create(null); // token -> the account name its stored session gave
  var need = ""; // the account whose sign-in ended in this tab
  var probing = null; // the dead token being tried for real, once
  var elsewhere = false; // another tab has changed the stored session
  var adopting = Object.create(null); // dead token -> true while its check runs
  var authHandler = null;

  // ── Pure helpers ──────────────────────────────────────────────────────

  function applies(url) {
    return typeof url === "string" && url.indexOf(API_PREFIX) === 0;
  }

  function urlOf(input) {
    return typeof input === "string" ? input : (input && input.url) || "";
  }

  // The headers a request will be sent with: `init.headers` wins over the
  // Request's own, exactly as fetch itself resolves them.
  function headersOf(input, init) {
    if (init && init.headers) return init.headers;
    if (input && typeof input === "object" && input.headers) return input.headers;
    return null;
  }

  function isHeadersObject(h) {
    return !!h && typeof h.get === "function" && typeof h.set === "function";
  }

  function authValue(headers) {
    if (!headers) return null;
    if (isHeadersObject(headers)) return headers.get("Authorization");
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === "authorization") return headers[keys[i]];
    }
    return null;
  }

  // "token abc" / "Bearer abc" -> { scheme, token }; anything else -> null.
  function parseAuth(value) {
    var m = /^(token|bearer)\s+(\S+)$/i.exec(typeof value === "string" ? value : "");
    return m ? { scheme: m[1], token: m[2] } : null;
  }

  function current(token) {
    var seen = 0;
    while (Object.prototype.hasOwnProperty.call(replacement, token) && seen++ < 16) {
      token = replacement[token];
    }
    return token;
  }

  function withAuth(headers, value) {
    if (isHeadersObject(headers)) {
      var copy = new Headers(headers);
      copy.set("Authorization", value);
      return copy;
    }
    var out = {};
    Object.keys(headers).forEach(function (k) {
      if (k.toLowerCase() !== "authorization") out[k] = headers[k];
    });
    out.Authorization = value;
    return out;
  }

  function unauthorized() {
    return new Response(JSON.stringify({ message: "Bad credentials" }), {
      status: 401,
      statusText: "Unauthorized",
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── The two calls the fetch wrap makes ────────────────────────────────

  // null: send the request exactly as the caller gave it.
  // { response }: answer locally (the token is known dead).
  // { input, init }: send these instead (the token was renewed).
  function prepare(input, init) {
    if (!applies(urlOf(input))) return null;
    var auth = parseAuth(authValue(headersOf(input, init)));
    if (!auth) return null;
    var next = current(auth.token);
    if (next === auth.token) {
      if (dead[auth.token]) return probing === auth.token ? null : { response: unauthorized() };
      noteOwner(auth.token);
      return null;
    }
    var value = auth.scheme + " " + next;
    if (init && init.headers) {
      var newInit = Object.assign({}, init);
      newInit.headers = withAuth(init.headers, value);
      return { input: input, init: newInit };
    }
    // A bare Request: rebuild it with only the header changed, and keep the
    // caller's `init` (usually undefined) so nothing else is re-derived.
    return { input: new Request(input, { headers: withAuth(input.headers, value) }), init: init };
  }

  function observe(input, init, res) {
    if (!res || res.status !== 401 || !applies(urlOf(input))) return;
    var auth = parseAuth(authValue(headersOf(input, init)));
    if (!auth || dead[auth.token]) return;
    var clone;
    try {
      clone = res.clone();
    } catch {
      return;
    }
    clone.json().then(
      function (body) {
        if (!body || !/bad credentials/i.test(String(body.message || ""))) return;
        markDead(auth.token);
      },
      function () {
        /* not JSON — not GitHub's "Bad credentials" */
      },
    );
  }

  // ── State ─────────────────────────────────────────────────────────────

  function storedUser() {
    try {
      var user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
      return user && typeof user === "object" ? user : null;
    } catch {
      return null;
    }
  }

  function setFlag(on) {
    try {
      if (on) sessionStorage.setItem(EXPIRED_FLAG, "1");
      else sessionStorage.removeItem(EXPIRED_FLAG);
    } catch {
      /* private mode — the after-reload message just stays generic */
    }
  }

  // Remember which account a token belongs to while the stored session
  // still says so. A second tab needs it later, when the stored session has
  // already moved on to another token.
  function noteOwner(token) {
    if (owner[token]) return;
    var user = storedUser();
    if (user && user.token === token && typeof user.login === "string" && user.login) {
      owner[token] = user.login;
    }
  }

  function sameLogin(a, b) {
    return typeof a === "string" && typeof b === "string" && !!a && a.toLowerCase() === b.toLowerCase();
  }

  // The account GitHub says a token belongs to, or "" when it will not say.
  // `real` sends the request even though the token is marked dead.
  function whoIs(token, real) {
    var sent;
    // prepare() runs inside this call, before it returns.
    if (real) probing = token;
    try {
      sent = window.fetch(API_PREFIX + "user", {
        cache: "no-cache",
        headers: { Authorization: "token " + token, Accept: "application/vnd.github+json" },
      });
    } finally {
      probing = null;
    }
    return sent
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(
        function (who) {
          return who && typeof who.login === "string" ? who.login : "";
        },
        function () {
          return "";
        },
      );
  }

  function ask() {
    setFlag(true);
    showBanner();
  }

  function markDead(token) {
    if (dead[token]) return;
    dead[token] = true;
    need = owner[token] || "";
    // Decap signing the user out (a page load with a dead stored token)
    // removes the stored session right after its own 401. Wait, then speak
    // only if there is still a session in use.
    setTimeout(function () {
      if (!dead[token] || current(token) !== token) return;
      var user = storedUser();
      if (!user || typeof user.token !== "string") return;
      if (user.token !== token) {
        // Only another tab's write counts: this tab's own editor signing in
        // afresh also changes the stored session, and needs nothing from here.
        if (elsewhere) adopt(token, user);
        return;
      }
      // One "Bad credentials" could be a passing fault at GitHub. Ask once
      // more, for real, before telling the owner the sign-in has ended.
      whoIs(token, true).then(function (login) {
        if (login) {
          delete dead[token];
          return;
        }
        if (current(token) === token) ask();
      });
    }, SETTLE_MS);
  }

  // Another tab signed in again: use its token here too, after the same
  // check a sign-in in this tab gets.
  function adopt(token, user) {
    if (adopting[token] || !dead[token] || current(token) !== token) return Promise.resolve(false);
    var next = user.token;
    if (dead[next] || !sameLogin(owner[token], user.login)) {
      ask();
      return Promise.resolve(false);
    }
    adopting[token] = true;
    return whoIs(next).then(function (login) {
      delete adopting[token];
      if (!sameLogin(owner[token], login)) {
        ask();
        return false;
      }
      replacement[token] = next;
      setFlag(false);
      showNote(
        "You signed in again in another tab, and this tab now uses that sign-in. " +
          "If a save failed here, press Save again.",
      );
      return true;
    });
  }

  function onStorage(e) {
    if (!e || e.key !== USER_KEY) return;
    elsewhere = true;
    var user = storedUser();
    if (!user || typeof user.token !== "string") return;
    Object.keys(dead).forEach(function (token) {
      if (token !== user.token) adopt(token, user);
    });
  }

  // ── The notice ────────────────────────────────────────────────────────

  var ASK =
    "Your sign-in has ended, so nothing can be saved right now. What you have typed is still on this page. " +
    "Sign in again to keep it. Do not reload or close this tab first.";

  function showBanner(message) {
    if (!document.body) return;
    var b = document.getElementById(BANNER_ID);
    if (!b) {
      b = document.createElement("div");
      b.id = BANNER_ID;
      b.setAttribute("role", "alert");
      b.setAttribute("data-visreg-ignore", "");
      b.style.cssText =
        "box-sizing:border-box;width:100%;padding:0.7rem 1.1rem;background:#5c1a12;color:#fdeae6;" +
        "font:600 0.85rem/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;" +
        "display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 0.9rem;";
      var text = document.createElement("span");
      text.setAttribute("data-sign-in-renewal-text", "");
      text.style.cssText = "flex:1 1 20rem;min-width:14rem;font-weight:500;";
      b.appendChild(text);
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-sign-in-renewal-button", "");
      button.textContent = "Sign in again";
      button.style.cssText =
        "font:inherit;font-weight:700;color:#5c1a12;background:#fdeae6;border:0;border-radius:6px;" +
        "padding:0.4rem 0.9rem;cursor:pointer;white-space:nowrap;";
      button.addEventListener("click", signIn);
      b.appendChild(button);
      b.__text = text;
      b.__button = button;
      document.body.insertBefore(b, document.body.firstChild);
      // Decap's entry editor is an absolute box anchored to the viewport and
      // would paint over a block at body's top (admin-notice-band.css).
      document.body.classList.add("cms-notice-band");
    }
    b.__text.textContent = message || ASK;
    b.__button.style.display = "";
    return b;
  }

  function showDone() {
    if (document.getElementById(BANNER_ID)) showNote("You are signed in again. Press Save to keep your work.");
  }

  // Good news with nothing to press; it clears itself.
  function showNote(message) {
    var b = showBanner(message);
    if (!b) return;
    b.__button.style.display = "none";
    setTimeout(function () {
      // Only if nothing has gone wrong again in the meantime.
      if (b.__button.style.display === "none") b.remove();
    }, DONE_MS);
  }

  // ── Signing in again ──────────────────────────────────────────────────

  function signIn() {
    var base = window.CMS_OAUTH_BASE_URL;
    if (!base) return;
    var url = base + "/prod/auth";
    var origin = new URL(url, window.location.href).origin;
    var popup = window.open(url, "github-auth", "width=600,height=700");
    if (!popup) {
      showBanner("The sign-in window was blocked. Allow pop-ups for this page, then choose Sign in again.");
      return;
    }
    if (authHandler) window.removeEventListener("message", authHandler);
    authHandler = function handler(e) {
      // Origin and source FIRST: only the proxy's page, in the window this
      // page opened, may speak here.
      if (e.origin !== origin || e.source !== popup) return;
      var data = e.data;
      if (typeof data !== "string") return;
      // The proxy page releases the token only after the opener echoes its
      // "authorizing" message back (oauth-proxy/lambda.py).
      if (data === "authorizing:github") {
        if (!popup.closed) popup.postMessage(data, origin);
        return;
      }
      var m = /^authorization:github:(success|error):([\s\S]*)$/.exec(data);
      if (!m) return;
      window.removeEventListener("message", handler);
      authHandler = null;
      if (!popup.closed) popup.close();
      var token = null;
      if (m[1] === "success") {
        try {
          token = JSON.parse(m[2]).token;
        } catch {
          token = null;
        }
      }
      if (typeof token !== "string" || !token) {
        showBanner(FAILED);
        return;
      }
      accept(token);
    };
    window.addEventListener("message", authHandler);
  }

  var FAILED = "Signing in did not work. Your typed work is still here. Choose Sign in again to retry.";

  // Take the new token only when it is the same GitHub account.
  function accept(token) {
    var user = storedUser();
    if (!user || typeof user.token !== "string") return Promise.resolve(false);
    var storedLogin = typeof user.login === "string" ? user.login : "";
    // The account this tab was using. The stored session can name another
    // one by now, if a different account signed in from another tab.
    var expected = need || storedLogin;
    return whoIs(token).then(function (login) {
      if (!login) {
        showBanner(FAILED);
        return false;
      }
      if (!expected) {
        // Without the original account name the same-account check cannot
        // run, so refuse rather than accept someone else's token.
        showBanner("Signing in did not work: this session does not say which account opened the page. Your typed work is still here.");
        return false;
      }
      if (!sameLogin(expected, login)) {
        showBanner(
          "You signed in as " + login + ", but this page was opened by " + expected + ". " +
            "Choose Sign in again and use the " + expected + " account to keep your work.",
        );
        return false;
      }
      Object.keys(dead).forEach(function (t) {
        if (t !== token) replacement[t] = token;
      });
      // Leave a stored session alone when it belongs to another account.
      if (sameLogin(storedLogin, login)) {
        if (user.token !== token) replacement[user.token] = token;
        user.token = token;
        try {
          localStorage.setItem(USER_KEY, JSON.stringify(user));
        } catch {
          /* the in-page swap still works; only the next page load asks again */
        }
      }
      setFlag(false);
      showDone();
      return true;
    });
  }

  window.addEventListener("storage", onStorage);

  window.CMSSignInRenewal = {
    prepare: prepare,
    observe: observe,
    signIn: signIn,
    accept: accept,
    parseAuth: parseAuth,
    expiredFlag: EXPIRED_FLAG,
    bannerId: BANNER_ID,
  };
})();
