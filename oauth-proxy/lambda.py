"""
Sveltia CMS / Decap CMS OAuth Proxy — AWS Lambda handler.

Implements the two-leg GitHub OAuth flow required by any Netlify CMS-compatible
content management system:

  GET /auth      → mint a one-time `state`, remember it in a cookie, and
                   redirect the browser to GitHub's OAuth consent page
  GET /callback  → verify `state` against that cookie, exchange the
                   authorisation code for an access token, then post it back
                   to the CMS window via postMessage (only to an opener whose
                   origin is in ALLOWED_ORIGINS)

Cost model (AWS free tier covers typical personal-blog usage):
  • Lambda:       1 M requests / month free; ~$0.20 per additional 1 M
  • API Gateway:  1 M requests / month free (HTTP API); $1 per additional 1 M
  • No persistent storage, no VPC, no NAT gateway
  Estimated ongoing cost for a low-traffic blog: $0.00 / month
"""

from __future__ import annotations

import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ── Environment variables (set in SAM template / Lambda console) ────────────
GITHUB_CLIENT_ID = os.environ["GITHUB_CLIENT_ID"]
GITHUB_CLIENT_SECRET = os.environ["GITHUB_CLIENT_SECRET"]
# Scope requested from GitHub:
#   - `repo`      read/write repo contents (PRs, labels, content API)
#   - `read:user` GET /user for Decap's "Logged in as ..." UI and the
#                 dashboards. Nothing in the admin writes the profile, so
#                 the read/write `user` scope is not requested (#516).
#   - `workflow`  kept for now. It was added for a delete-via-pr.yml
#                 dispatch that publish-via-auto-merge.js no longer makes;
#                 whether anything still needs it is measured by the
#                 GitHub App spike in docs/ADMIN-AUTH-SECURITY.md.
# A GitHub App's client id ignores `scope`: its token carries the App's
# permissions instead.
GITHUB_SCOPE = os.environ.get("GITHUB_SCOPE", "repo,read:user,workflow")
# Origins of the CMS windows allowed to receive the token: a comma-separated
# list of `https://` origins, e.g. https://example.com. `*` is allowed inside a
# host label so per-PR preview hosts need one entry, e.g.
# https://preview-*.example.com (it matches within ONE label, never across a
# dot), but only beneath SITE_APEX. The callback page releases the token only
# to a matching opener; if no entry is valid, /auth and /callback refuse to
# run (see _origin_patterns).
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "https://example.com")
# The site's own registered domain, e.g. example.com: deploy.sh passes the
# APEX_DOMAIN from site-params.env, the zone the site's bootstrap stack already
# serves. A wildcard entry is honored only for names at or beneath it (#535),
# so `https://*.github.io` or `https://*.co.uk` cannot hand the token to
# sites someone else controls. Empty (the default) means no wildcard entry is
# valid: fail closed.
SITE_APEX = os.environ.get("SITE_APEX", "")

# GitHub OAuth endpoints (constant — never derived from user input).
GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
# This is a public GitHub URL, not a credential; the literal `access_token`
# substring trips the hardcoded-password heuristic (ruff S105 / bandit B105).
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"  # noqa: S105  # nosec B105
USER_AGENT = "cms-oauth-proxy/1.0"
HTTP_TIMEOUT_SECONDS = 10

# One-time `state` binding a /callback to the /auth that started it. The
# `__Host-` prefix makes browsers accept it only as a Secure, Path=/,
# host-only cookie, so a sibling subdomain cannot plant one.
STATE_COOKIE = "__Host-cms-oauth-state"
STATE_MAX_AGE_SECONDS = 600

# Which build is live, for /health (#518). A platform release and the consumer
# bump that follows never redeploy this Lambda, so scripts/probe-oauth-proxy-
# build.js compares HANDLER_SHA256 with the same digest of the lambda.py the
# site is pinned to. The digest is of this file as deployed, computed here
# rather than passed in, so it describes the code that is actually running.
# PLATFORM_RELEASE is the tag (or commit) deploy.sh deployed from; it names
# the build for a human, and the probe never compares it, because most
# releases do not change this file.
PLATFORM_RELEASE = os.environ.get("PLATFORM_RELEASE", "")
with open(__file__, "rb") as _handler_source:
    HANDLER_SHA256 = hashlib.sha256(_handler_source.read()).hexdigest()


# ── Helpers ─────────────────────────────────────────────────────────────────

# One ALLOWED_ORIGINS entry: an https origin with an optional port. `*` may
# stand in for part of a host label.
_ORIGIN_ENTRY = re.compile(r"https://[a-z0-9*-]+(?:\.[a-z0-9*-]+)+(?::[0-9]{1,5})?")
# SITE_APEX: two or more plain labels, no wildcard, no port.
_APEX = re.compile(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+")


def _valid_origin_entry(entry: str, apex: str) -> bool:
    if not _ORIGIN_ENTRY.fullmatch(entry):
        return False
    host = entry.removeprefix("https://").partition(":")[0]
    if "*" not in host:
        return True
    # Which labels end a registrable domain is the Public Suffix List's
    # knowledge (co.uk, github.io), and this file carries none of it. So a
    # wildcard is trusted only beneath the domain the site declared as its
    # own: the labels after the last label holding a `*` must be SITE_APEX or
    # a name under it. No apex, no wildcard.
    if not _APEX.fullmatch(apex):
        return False
    fixed = host.rpartition("*")[2].partition(".")[2]
    return fixed == apex or fixed.endswith("." + apex)


def _origin_patterns(raw: str, apex: str) -> list[str]:
    """
    Turn the ALLOWED_ORIGINS string into regex SOURCE strings, one per valid
    entry. Invalid entries are logged and dropped, never guessed at.

    The grammar is deliberately tiny: lowercase `https://` origins whose host
    labels use only [a-z0-9-] plus `*`, and `*` is accepted only when every
    label after the one holding it is `apex` or beneath it (so neither
    `https://*.com`, `https://*.co.uk` nor `https://*.github.io` can widen the
    list to names other people register). Every entry therefore draws on the
    alphabet [a-z0-9.*:/-], which means the SAME regex source string means the
    same thing to Python's re.fullmatch and to JavaScript's
    new RegExp('^(?:' + src + ')$') — the callback page re-uses these sources
    in the browser, so the two engines must never disagree about which origin
    matches.
    """
    # Not stripped: deploy.sh and the template's AllowedPattern both refuse an
    # apex with whitespace, so a padded SITE_APEX is malformed here too and
    # fails closed (no wildcard) rather than being quietly repaired.
    apex = apex.lower()
    patterns: list[str] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        entry = entry.removesuffix("/").lower()
        if not _valid_origin_entry(entry, apex):
            logger.error(
                "Ignoring invalid ALLOWED_ORIGINS entry: %r (a '*' entry must sit "
                "beneath SITE_APEX %r)",
                entry,
                apex,
            )
            continue
        # `.` is literal; `*` matches within one label and never crosses a dot.
        patterns.append(entry.replace(".", "\\.").replace("*", "[a-z0-9-]+"))
    return patterns


ALLOWED_ORIGIN_PATTERNS = _origin_patterns(ALLOWED_ORIGINS, SITE_APEX)


def _origin_allowed(origin: str | None, patterns: list[str] | None = None) -> bool:
    if not origin:
        return False
    if patterns is None:
        patterns = ALLOWED_ORIGIN_PATTERNS
    return any(re.fullmatch(pattern, origin) for pattern in patterns)


def _cors_headers(origin: str | None = None) -> dict[str, str]:
    """Return minimal CORS headers; the origin is echoed only if allowed."""
    headers = {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    if _origin_allowed(origin):
        headers["Access-Control-Allow-Origin"] = origin
    return headers


def _is_v2_event(event: dict) -> bool:
    """True for an API Gateway HTTP API payload-2.0 event."""
    return event.get("version") == "2.0" or "rawPath" in event


def _request_cookies(event: dict) -> dict[str, str]:
    """
    Cookies sent with the request, across both API Gateway payload formats:
    2.0 delivers `cookies` (a list of "name=value"); 1.0 delivers a
    `Cookie` header ("; "-separated).
    """
    pairs = list(event.get("cookies") or [])
    for name, value in (event.get("headers") or {}).items():
        if name.lower() == "cookie":
            pairs.extend(value.split(";"))
    cookies: dict[str, str] = {}
    for pair in pairs:
        name, sep, value = pair.strip().partition("=")
        if sep and name:
            cookies.setdefault(name, value)
    return cookies


def _state_cookie(value: str, max_age: int) -> str:
    # SameSite=Lax, not Strict: GitHub sends the browser back to /callback as a
    # cross-site top-level GET navigation, and Strict would withhold the cookie
    # on exactly that request.
    return f"{STATE_COOKIE}={value}; Path=/; Max-Age={max_age}; Secure; HttpOnly; SameSite=Lax"


def _with_cookie(response: dict, cookie: str, v2: bool) -> dict:
    """Attach a Set-Cookie value in the shape the payload format expects."""
    if v2:
        response.setdefault("cookies", []).append(cookie)
    else:
        response["headers"]["Set-Cookie"] = cookie
    return response


def _redirect(location: str, origin: str | None = None) -> dict:
    return {
        "statusCode": 302,
        # no-store: the response sets the one-time state cookie.
        "headers": {"Location": location, "Cache-Control": "no-store", **_cors_headers(origin)},
        "body": "",
    }


def _html_response(
    body: str, status: int = 200, origin: str | None = None, nonce: str | None = None
) -> dict:
    # `nonce` must be the one embedded in the body's <script nonce=...>; pages
    # without a script (the error page) just get a fresh, unused one.
    nonce = nonce or secrets.token_urlsafe(16)
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": (
                f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; "
                "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            ),
            **_cors_headers(origin),
        },
        "body": body,
    }


# json.dumps already \u-escapes U+2028/U+2029 (ensure_ascii); they are listed
# so the guarantee does not hinge on that default.
_JS_ESCAPES = str.maketrans(
    {
        "<": "\\u003c",
        ">": "\\u003e",
        "&": "\\u0026",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
    }
)


def _js_literal(value) -> str:
    """
    Serialize `value` as a JavaScript literal that is safe inside a <script>
    element: no `</script>`, `<!--` or line-terminator can survive it.
    """
    return json.dumps(value).translate(_JS_ESCAPES)


def _error_page(message: str) -> str:
    safe = html.escape(message)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>OAuth Error</title>
  <style>
    body {{ background:#04060f; color:#c8d4f0; font-family:'Helvetica Neue',Arial,sans-serif;
           display:flex; align-items:center; justify-content:center; min-height:100vh; }}
    .box {{ text-align:center; max-width:480px; padding:2rem; }}
    h1 {{ font-weight:200; font-size:1.6rem; color:#d8e4ff; margin-bottom:1rem; }}
    p  {{ color:#8ab0e8; font-size:0.9rem; }}
    code {{ background:#0a1530; border:1px solid #1a2a5e; border-radius:4px;
            padding:0.2em 0.5em; font-family:'SF Mono','Fira Code',monospace; }}
  </style>
</head>
<body>
  <div class="box">
    <h1>Authentication Error</h1>
    <p>Could not complete GitHub OAuth flow.</p>
    <p><code>{safe}</code></p>
    <p>Close this window and try again.</p>
  </div>
</body>
</html>"""


def _success_page(token: str, nonce: str, provider: str = "github") -> str:
    """
    The postMessage pattern used by Netlify CMS / Decap CMS / Sveltia CMS.

    1. The CMS window opens this page as a popup.
    2. On load, this page sends "authorizing:<provider>" to the opener.
    3. The opener (CMS) replies with a message to confirm it's listening.
    4. This page checks that the reply came from the window that opened it AND
       that the window's origin is in ALLOWED_ORIGINS, then answers with the
       success payload containing the access token, addressed to that origin.
    5. The CMS closes the popup and stores the token.

    `nonce` must match the Content-Security-Policy sent with the page.
    """
    # Never embed a value in the page source without escaping — use a
    # JSON-encoded JS literal that cannot close the <script> element instead.
    token_json = _js_literal({"token": token, "provider": provider})
    provider_json = _js_literal(provider)
    origins_json = _js_literal(ALLOWED_ORIGIN_PATTERNS)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorised</title>
  <style>
    body {{ background:#04060f; color:#c8d4f0;
           font-family:'Helvetica Neue',Arial,sans-serif;
           display:flex; align-items:center; justify-content:center; min-height:100vh; }}
    .box {{ text-align:center; }}
    .dot {{ width:8px; height:8px; background:#285aff; border-radius:50%;
            display:inline-block; animation:pulse 1s infinite; }}
    @keyframes pulse {{ 0%,100%{{opacity:.3}} 50%{{opacity:1}} }}
  </style>
</head>
<body>
  <div class="box">
    <div class="dot"></div>
    <p style="margin-top:1rem;font-size:0.8rem;color:#8ab0e8;">Completing authorisation…</p>
  </div>
  <script nonce="{nonce}">
    (function () {{
      'use strict';

      var provider = {provider_json};
      var payload  = {token_json};
      var allowedOrigins = {origins_json}.map(function (src) {{
        return new RegExp('^(?:' + src + ')$');
      }});

      function originAllowed(origin) {{
        return typeof origin === 'string' &&
          allowedOrigins.some(function (re) {{ return re.test(origin); }});
      }}

      function receiveMessage(event) {{
        // The token goes only to the window that opened this popup, and only
        // when that window is one of the configured CMS origins.
        if (event.source !== window.opener) return;
        if (!originAllowed(event.origin)) return;
        // Only accept the handshake message from the CMS
        if (event.data !== ('authorizing:' + provider)) return;

        window.removeEventListener('message', receiveMessage, false);

        // Reply with the token payload, addressed to the verified origin
        window.opener.postMessage(
          'authorization:' + provider + ':success:' + JSON.stringify(payload),
          event.origin
        );
      }}

      window.addEventListener('message', receiveMessage, false);

      // Initiate the handshake — tell the CMS window we are authorizing.
      // '*' is deliberate: this message carries no secret, and a popup cannot
      // read a cross-origin opener's origin to address it. The CMS's reply is
      // what gets checked, above, before anything sensitive is sent.
      if (window.opener) {{
        window.opener.postMessage('authorizing:' + provider, '*');
      }} else {{
        // If somehow opened without a parent, redirect home
        window.location.href = '/';
      }}
    }})();
  </script>
</body>
</html>"""


def _misconfigured_response(origin: str | None) -> dict:
    # Fail closed and loudly: with no valid origin the callback page could not
    # release the token to anyone, so refuse before any redirect or exchange.
    logger.error("ALLOWED_ORIGINS has no valid origin; refusing the request")
    return _html_response(
        _error_page("OAuth proxy is misconfigured: ALLOWED_ORIGINS has no valid origin."),
        status=500,
        origin=origin,
    )


# ── Route handlers ───────────────────────────────────────────────────────────


def handle_auth(origin: str | None, v2: bool) -> dict:
    """
    Step 1 — redirect the browser to GitHub's OAuth consent screen.

    The CMS passes ?provider=github&scope=repo (Decap 3.15.1's default).
    We generate the `state` ourselves, send it to GitHub, and remember it in a
    short-lived cookie; /callback accepts a code only when GitHub echoes back
    the value in that cookie (CSRF / login-fixation protection). A `state` the
    client supplies is ignored — Decap sends none, and one we did not mint
    could not be checked against anything.
    """
    if not ALLOWED_ORIGIN_PATTERNS:
        return _misconfigured_response(origin)

    state = secrets.token_urlsafe(32)
    # IGNORE the CMS's scope param. Decap 3.15.1 asks for `repo` alone
    # (its `auth_scope`, default `repo`), which lacks the scopes in
    # GITHUB_SCOPE. Force the proxy's GITHUB_SCOPE so the token GitHub
    # issues has every scope the admin exercises, not just Decap's subset.
    scope = GITHUB_SCOPE

    github_auth_url = (
        f"{GITHUB_AUTHORIZE_URL}"
        f"?client_id={urllib.parse.quote(GITHUB_CLIENT_ID)}"
        f"&scope={urllib.parse.quote(scope)}"
        f"&state={urllib.parse.quote(state)}"
        "&allow_signup=false"
    )

    logger.info("Redirecting to GitHub OAuth")
    return _with_cookie(
        _redirect(github_auth_url, origin), _state_cookie(state, STATE_MAX_AGE_SECONDS), v2
    )


def _state_verified(params: dict, cookies: dict[str, str]) -> bool:
    state = params.get("state", "")
    expected = cookies.get(STATE_COOKIE, "")
    if not state or not expected:
        return False
    return hmac.compare_digest(state.encode("utf-8"), expected.encode("utf-8"))


def handle_callback(params: dict, origin: str | None, cookies: dict[str, str], v2: bool) -> dict:
    """
    Step 2 — exchange the authorisation code for an access token.

    GitHub redirects here with ?code=…&state=… after user consent.
    We POST to GitHub's token endpoint and return an HTML page that
    uses postMessage to hand the token back to the CMS popup.

    Every response, success or error, clears the state cookie: it is single use.
    """
    response = _exchange_code(params, origin, cookies)
    return _with_cookie(response, _state_cookie("", 0), v2)


def _exchange_code(params: dict, origin: str | None, cookies: dict[str, str]) -> dict:
    if not ALLOWED_ORIGIN_PATTERNS:
        return _misconfigured_response(origin)

    # Before anything else — and before any call to GitHub — prove this
    # callback belongs to an /auth this browser started.
    if not _state_verified(params, cookies):
        logger.warning(
            "Callback state check failed (state param present=%s, cookie present=%s)",
            bool(params.get("state")),
            bool(cookies.get(STATE_COOKIE)),
        )
        return _html_response(
            _error_page("This sign-in could not be verified. Close this window and start again."),
            status=400,
            origin=origin,
        )

    code = params.get("code", "")
    error = params.get("error", "")

    if error:
        description = params.get("error_description", error)
        logger.warning("GitHub OAuth error: %s", description)
        return _html_response(_error_page(description), status=400, origin=origin)

    if not code:
        logger.warning("Callback reached without code parameter")
        return _html_response(
            _error_page("No authorisation code received."), status=400, origin=origin
        )

    # Exchange code → token
    post_data = urllib.parse.urlencode(
        {
            "client_id": GITHUB_CLIENT_ID,
            "client_secret": GITHUB_CLIENT_SECRET,
            "code": code,
        }
    ).encode("utf-8")

    # URL is the hardcoded GITHUB_TOKEN_URL constant (https scheme), never
    # user-derived, so the file:/custom-scheme risk S310/B310 warns about
    # cannot occur here.
    req = urllib.request.Request(  # noqa: S310
        GITHUB_TOKEN_URL,
        data=post_data,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(  # noqa: S310  # nosec B310
            req, timeout=HTTP_TIMEOUT_SECONDS
        ) as resp:
            token_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        logger.error("GitHub token exchange HTTP error: %s", exc)
        return _html_response(
            _error_page(f"GitHub returned HTTP {exc.code}"), status=502, origin=origin
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("Token exchange failed: %s", exc)
        return _html_response(_error_page("Token exchange failed."), status=502, origin=origin)

    token_error = token_data.get("error")
    if token_error:
        description = token_data.get("error_description", token_error)
        logger.error("Token error from GitHub: %s", description)
        return _html_response(_error_page(description), status=400, origin=origin)

    # Only `access_token` reaches the page. A GitHub App with expiring tokens
    # also returns `refresh_token` (a six-month credential) and `expires_in`;
    # Decap has no refresh flow, so both are dropped here, never sent on.
    access_token = token_data.get("access_token", "")
    if not access_token:
        logger.error("GitHub response contained no access_token: %s", list(token_data.keys()))
        return _html_response(
            _error_page("No access token in response."), status=502, origin=origin
        )

    logger.info("Token exchange successful (token length=%d)", len(access_token))
    nonce = secrets.token_urlsafe(16)
    return _html_response(_success_page(access_token, nonce), origin=origin, nonce=nonce)


# ── Lambda entry point ───────────────────────────────────────────────────────


def handler(event: dict, context) -> dict:  # noqa: ANN001
    """
    AWS Lambda handler — compatible with API Gateway HTTP API (payload 2.0)
    and API Gateway REST API (payload 1.0).
    """
    # Normalise path between HTTP API and REST API payload formats
    raw_path = event.get("rawPath") or event.get("path") or "/"
    path = raw_path.rstrip("/").lower()

    # Query string parameters
    params: dict = event.get("queryStringParameters") or {}

    # Origin header for CORS
    headers = event.get("headers") or {}
    origin = headers.get("origin") or headers.get("Origin")

    # HTTP method (HTTP API payload 2.0 nests it under requestContext.http)
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")

    logger.info("Request: %s %s", method, raw_path)

    # Pre-flight OPTIONS
    if method == "OPTIONS":
        return {
            "statusCode": 204,
            "headers": _cors_headers(origin),
            "body": "",
        }

    v2 = _is_v2_event(event)

    if path.endswith("/auth"):
        return handle_auth(origin, v2)

    if path.endswith("/callback"):
        return handle_callback(params, origin, _request_cookies(event), v2)

    # Health check
    if path.endswith("/health") or path in ("", "/"):
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json", **_cors_headers(origin)},
            "body": json.dumps(
                {
                    "status": "ok",
                    "service": "cms-oauth-proxy",
                    "release": PLATFORM_RELEASE,
                    "handler_sha256": HANDLER_SHA256,
                }
            ),
        }

    return {
        "statusCode": 404,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"error": "Not found"}),
    }
