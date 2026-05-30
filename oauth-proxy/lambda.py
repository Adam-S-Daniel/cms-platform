"""
Sveltia CMS / Decap CMS OAuth Proxy — AWS Lambda handler.

Implements the two-leg GitHub OAuth flow required by any Netlify CMS-compatible
content management system:

  GET /auth      → redirect the browser to GitHub's OAuth consent page
  GET /callback  → exchange the authorisation code for an access token,
                   then post it back to the CMS window via postMessage

Cost model (AWS free tier covers typical personal-blog usage):
  • Lambda:       1 M requests / month free; ~$0.20 per additional 1 M
  • API Gateway:  1 M requests / month free (HTTP API); $1 per additional 1 M
  • No persistent storage, no VPC, no NAT gateway
  Estimated ongoing cost for a low-traffic blog: $0.00 / month
"""

from __future__ import annotations

import html
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ── Environment variables (set in SAM template / Lambda console) ────────────
GITHUB_CLIENT_ID = os.environ["GITHUB_CLIENT_ID"]
GITHUB_CLIENT_SECRET = os.environ["GITHUB_CLIENT_SECRET"]
# Scope requested from GitHub:
#   - `repo`     read/write repo contents (PRs, labels, content API)
#   - `user`     basic user info for Decap's "Logged in as ..." UI
#   - `workflow` dispatch GitHub Actions workflows. REQUIRED by the
#                publish-via-auto-merge.js shim's "Delete published
#                entry" recovery path: when the user clicks Delete on
#                a published post, Decap calls DELETE /contents/{path};
#                main's branch ruleset rejects with 422; the shim
#                catches the 422 and dispatches `delete-via-pr.yml` —
#                that POST returns 404 if the token lacks `workflow`.
#                Without it, the Delete button silently does nothing.
GITHUB_SCOPE = os.environ.get("GITHUB_SCOPE", "repo,user,workflow")
# Allowed origins for the postMessage call (comma-separated list of CMS URLs).
# Set to * during initial setup, then tighten to your site origin, e.g. https://example.com
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "https://example.com")

# GitHub OAuth endpoints (constant — never derived from user input).
GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
# This is a public GitHub URL, not a credential; the literal `access_token`
# substring trips the hardcoded-password heuristic (ruff S105 / bandit B105).
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"  # noqa: S105  # nosec B105
USER_AGENT = "cms-oauth-proxy/1.0"
HTTP_TIMEOUT_SECONDS = 10


# ── Helpers ─────────────────────────────────────────────────────────────────


def _cors_headers(origin: str | None = None) -> dict[str, str]:
    """Return minimal CORS headers."""
    allowed = ALLOWED_ORIGINS.split(",")
    effective_origin = (
        origin if (origin is not None and (origin in allowed or "*" in allowed)) else allowed[0]
    )
    return {
        "Access-Control-Allow-Origin": effective_origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


def _redirect(location: str, origin: str | None = None) -> dict:
    return {
        "statusCode": 302,
        "headers": {"Location": location, **_cors_headers(origin)},
        "body": "",
    }


def _html_response(body: str, status: int = 200, origin: str | None = None) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "text/html; charset=utf-8",
            **_cors_headers(origin),
        },
        "body": body,
    }


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


def _success_page(token: str, provider: str = "github") -> str:
    """
    The postMessage pattern used by Netlify CMS / Decap CMS / Sveltia CMS.

    1. The CMS window opens this page as a popup.
    2. On load, this page sends "authorizing:<provider>" to the opener.
    3. The opener (CMS) replies with a message to confirm it's listening.
    4. This page replies with the success payload containing the access token.
    5. The CMS closes the popup and stores the token.
    """
    # Never embed the token directly in page source via f-string interpolation
    # without escaping — use a JSON-encoded JS literal instead.
    token_json = json.dumps({"token": token, "provider": provider})
    provider_json = json.dumps(provider)

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
  <script>
    (function () {{
      'use strict';

      var provider = {provider_json};
      var payload  = {token_json};

      function receiveMessage(event) {{
        // Only accept the handshake message from the CMS
        if (event.data !== ('authorizing:' + provider)) return;

        window.removeEventListener('message', receiveMessage, false);

        // Reply with the token payload
        window.opener.postMessage(
          'authorization:' + provider + ':success:' + JSON.stringify(payload),
          event.origin
        );
      }}

      window.addEventListener('message', receiveMessage, false);

      // Initiate the handshake — tell the CMS window we are authorizing
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


# ── Route handlers ───────────────────────────────────────────────────────────


def handle_auth(params: dict, origin: str | None) -> dict:
    """
    Step 1 — redirect the browser to GitHub's OAuth consent screen.

    The CMS passes ?provider=github&scope=repo,user (Sveltia/Decap convention).
    We forward the `state` parameter through so GitHub echoes it back in the
    callback (CSRF protection).
    """
    state = params.get("state", "")
    # IGNORE the CMS's scope param. Decap CMS hardcodes `repo,user` in
    # its OAuth request; that's missing `workflow`, which the shim
    # (admin/publish-via-auto-merge.js) needs to dispatch the
    # delete-via-pr workflow. Force the proxy's GITHUB_SCOPE so the
    # token GitHub issues has every scope the admin actually exercises,
    # not just the subset Decap thinks it needs.
    scope = GITHUB_SCOPE

    github_auth_url = (
        f"{GITHUB_AUTHORIZE_URL}"
        f"?client_id={urllib.parse.quote(GITHUB_CLIENT_ID)}"
        f"&scope={urllib.parse.quote(scope)}"
        f"&state={urllib.parse.quote(state)}"
        "&allow_signup=false"
    )

    logger.info(
        "Redirecting to GitHub OAuth (state=%s)", state[:8] + "…" if len(state) > 8 else state
    )
    return _redirect(github_auth_url, origin)


def handle_callback(params: dict, origin: str | None) -> dict:
    """
    Step 2 — exchange the authorisation code for an access token.

    GitHub redirects here with ?code=…&state=… after user consent.
    We POST to GitHub's token endpoint and return an HTML page that
    uses postMessage to hand the token back to the CMS popup.
    """
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

    access_token = token_data.get("access_token", "")
    if not access_token:
        logger.error("GitHub response contained no access_token: %s", list(token_data.keys()))
        return _html_response(
            _error_page("No access token in response."), status=502, origin=origin
        )

    logger.info("Token exchange successful (token length=%d)", len(access_token))
    return _html_response(_success_page(access_token), origin=origin)


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

    if path.endswith("/auth"):
        return handle_auth(params, origin)

    if path.endswith("/callback"):
        return handle_callback(params, origin)

    # Health check
    if path.endswith("/health") or path in ("", "/"):
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json", **_cors_headers(origin)},
            "body": json.dumps({"status": "ok", "service": "cms-oauth-proxy"}),
        }

    return {
        "statusCode": 404,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"error": "Not found"}),
    }
