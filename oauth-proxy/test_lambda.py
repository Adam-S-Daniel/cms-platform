"""
Unit tests for the OAuth proxy Lambda handler.

Run locally with:  python -m pytest test_lambda.py -v
No AWS credentials required — all GitHub API calls are mocked.
"""

import importlib
import json
import os
import re
import sys
import unittest
import urllib.parse
from unittest.mock import MagicMock, patch

# Set required env vars before importing the handler
os.environ.setdefault("GITHUB_CLIENT_ID", "test_client_id")
os.environ.setdefault("GITHUB_CLIENT_SECRET", "test_client_secret")
os.environ.setdefault("ALLOWED_ORIGINS", "https://example.com")

# `lambda` is a reserved word, so it can't be a plain `import`; load it
# dynamically after the env vars above and the sys.path shim are in place.
sys.path.insert(0, os.path.dirname(__file__))
handler_module = importlib.import_module("lambda")

STATE_COOKIE = handler_module.STATE_COOKIE
# Obviously fake, low-entropy values (a secrets scanner reads these).
GOOD_STATE = "expected-state"
FAKE_TOKEN = "TEST-TOKEN-VALUE"  # nosec B105  # fixture value, not a secret
CLEARED_COOKIE = f"{STATE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
# The allowlist every test runs against, whatever ALLOWED_ORIGINS the shell has.
TEST_ORIGINS = "https://example.com,https://preview-*.example.com"


def _event(
    path: str,
    params: dict | None = None,
    method: str = "GET",
    cookies: dict[str, str] | None = None,
    origin: str = "https://example.com",
) -> dict:
    """Build a minimal API Gateway HTTP API (payload 2.0) event."""
    event = {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "queryStringParameters": params or {},
        "headers": {"origin": origin},
    }
    if cookies is not None:
        # Payload 2.0 moves the Cookie header into a top-level list.
        event["cookies"] = [f"{name}={value}" for name, value in cookies.items()]
    return event


def _event_v1(
    path: str,
    params: dict | None = None,
    cookie_header: str | None = None,
    origin: str = "https://example.com",
) -> dict:
    """Build a minimal payload 1.0 event: no rawPath/version, Cookie is a header."""
    headers = {"origin": origin}
    if cookie_header is not None:
        headers["Cookie"] = cookie_header
    return {
        "path": path,
        "httpMethod": "GET",
        "queryStringParameters": params or {},
        "headers": headers,
        "requestContext": {},
    }


def _state_of(location: str) -> str:
    return urllib.parse.parse_qs(urllib.parse.urlparse(location).query)["state"][0]


def _set_cookies(resp: dict) -> list[str]:
    """Every Set-Cookie value in a response, from either payload format."""
    cookies = list(resp.get("cookies", []))
    if "Set-Cookie" in resp["headers"]:
        cookies.append(resp["headers"]["Set-Cookie"])
    return cookies


class _Base(unittest.TestCase):
    """Pin the allowlist so no test depends on the ALLOWED_ORIGINS in the shell."""

    def setUp(self):
        patcher = patch.object(
            handler_module,
            "ALLOWED_ORIGIN_PATTERNS",
            handler_module._origin_patterns(TEST_ORIGINS),
        )
        patcher.start()
        self.addCleanup(patcher.stop)


class TestHealthCheck(_Base):
    def test_health(self):
        resp = handler_module.handler(_event("/health"), None)
        self.assertEqual(resp["statusCode"], 200)
        body = json.loads(resp["body"])
        self.assertEqual(body["status"], "ok")

    def test_health_stage_prefixed(self):
        # API Gateway includes the stage in the path (e.g. "/prod/health"),
        # so the health route must match the suffix, not the exact path.
        resp = handler_module.handler(_event("/prod/health"), None)
        self.assertEqual(resp["statusCode"], 200)
        body = json.loads(resp["body"])
        self.assertEqual(body["status"], "ok")

    def test_root(self):
        resp = handler_module.handler(_event("/"), None)
        self.assertEqual(resp["statusCode"], 200)


class TestAuthRedirect(_Base):
    def test_redirects_to_github(self):
        resp = handler_module.handler(_event("/auth"), None)
        self.assertEqual(resp["statusCode"], 302)
        location = resp["headers"]["Location"]
        self.assertIn("github.com/login/oauth/authorize", location)
        self.assertIn("test_client_id", location)

    def test_includes_scope(self):
        resp = handler_module.handler(_event("/auth"), None)
        location = resp["headers"]["Location"]
        self.assertIn("scope=", location)
        # `workflow` is required by the publish-via-auto-merge shim so
        # Decap's "Delete published entry" can dispatch the
        # delete-via-pr.yml workflow. Without it the dispatch endpoint
        # 404s, the shim falls back to the original 422, and the user
        # sees the Delete button silently do nothing. Assert the
        # required scopes survive any future edits.
        self.assertIn("repo", location)
        self.assertIn("workflow", location)

    def test_proxy_forces_scope_ignoring_cms_request(self):
        # Decap CMS hardcodes `repo,user` in its OAuth request. The
        # proxy must override that and always grant `workflow` too,
        # otherwise the shim's delete-via-pr dispatch returns 404. This
        # test pins that the proxy ignores the CMS's narrower scope.
        evt = _event("/auth", {"scope": "repo,user"})
        resp = handler_module.handler(evt, None)
        location = resp["headers"]["Location"]
        self.assertIn("workflow", location)

    def test_response_is_not_cacheable(self):
        # The redirect sets a one-time cookie; no cache may replay it.
        resp = handler_module.handler(_event("/auth"), None)
        self.assertEqual(resp["headers"]["Cache-Control"], "no-store")


class TestAuthState(_Base):
    def test_sets_state_cookie_with_all_attributes(self):
        resp = handler_module.handler(_event("/auth"), None)
        (cookie,) = _set_cookies(resp)
        name_value, *attributes = cookie.split("; ")
        self.assertTrue(name_value.startswith(f"{STATE_COOKIE}="))
        self.assertEqual(
            sorted(attributes),
            sorted(["Path=/", "Max-Age=600", "Secure", "HttpOnly", "SameSite=Lax"]),
        )

    def test_github_state_equals_cookie_value(self):
        resp = handler_module.handler(_event("/auth"), None)
        (cookie,) = _set_cookies(resp)
        cookie_value = cookie.split("; ")[0].split("=", 1)[1]
        state = _state_of(resp["headers"]["Location"])
        self.assertEqual(state, cookie_value)
        self.assertGreaterEqual(len(state), 32)

    def test_client_supplied_state_is_ignored(self):
        resp = handler_module.handler(_event("/auth", {"state": "abc123"}), None)
        location = resp["headers"]["Location"]
        self.assertNotIn("abc123", location)
        self.assertNotEqual(_state_of(location), "abc123")
        self.assertNotIn("abc123", _set_cookies(resp)[0])

    def test_each_call_mints_a_fresh_state(self):
        first = handler_module.handler(_event("/auth"), None)
        second = handler_module.handler(_event("/auth"), None)
        self.assertNotEqual(
            _state_of(first["headers"]["Location"]), _state_of(second["headers"]["Location"])
        )

    def test_payload_2_0_uses_cookies_list(self):
        resp = handler_module.handler(_event("/auth"), None)
        self.assertEqual(len(resp["cookies"]), 1)
        self.assertNotIn("Set-Cookie", resp["headers"])

    def test_payload_1_0_uses_set_cookie_header(self):
        resp = handler_module.handler(_event_v1("/auth"), None)
        self.assertIn(f"{STATE_COOKIE}=", resp["headers"]["Set-Cookie"])
        self.assertNotIn("cookies", resp)

    def test_state_is_not_logged(self):
        with self.assertLogs(level="INFO") as logs:
            resp = handler_module.handler(_event("/auth"), None)
        state = _state_of(resp["headers"]["Location"])
        self.assertNotIn(state[:8], "\n".join(logs.output))


class TestCallbackSuccess(_Base):
    def _mock_urlopen(self, token: str = FAKE_TOKEN):  # nosec B107  # fake fixture token
        """Return a context manager that yields a fake GitHub token response."""
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(
            {
                "access_token": token,
                "token_type": "bearer",  # nosec B105  # OAuth token_type literal, not a secret
                "scope": "repo,user",
            }
        ).encode("utf-8")
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def _callback(self, params: dict | None = None) -> dict:
        """A /callback whose state matches the cookie (payload 2.0)."""
        merged = {"state": GOOD_STATE, **(params or {})}
        return _event("/callback", merged, cookies={STATE_COOKIE: GOOD_STATE})

    @patch("urllib.request.urlopen")
    def test_success_returns_html(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_urlopen()
        resp = handler_module.handler(self._callback({"code": "auth_code_123"}), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertIn("text/html", resp["headers"]["Content-Type"])
        self.assertIn("postMessage", resp["body"])
        self.assertIn(FAKE_TOKEN, resp["body"])

    @patch("urllib.request.urlopen")
    def test_token_in_postmessage(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_urlopen("my_token_xyz")
        resp = handler_module.handler(self._callback({"code": "code"}), None)
        self.assertIn("my_token_xyz", resp["body"])
        # The postMessage payload is built dynamically in JS to avoid embedding
        # the full string in the HTML (XSS-safe pattern).
        self.assertIn("authorization:", resp["body"])
        self.assertIn(":success:", resp["body"])
        self.assertIn("postMessage", resp["body"])

    def test_missing_code_returns_error(self):
        resp = handler_module.handler(self._callback(), None)
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("No authorisation code", resp["body"])

    def test_github_error_param_returns_error(self):
        resp = handler_module.handler(
            self._callback({"error": "access_denied", "error_description": "User denied access"}),
            None,
        )
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("User denied access", resp["body"])

    @patch("urllib.request.urlopen")
    def test_github_token_error_response(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(
            {
                "error": "bad_verification_code",
                "error_description": "The code passed is incorrect or expired.",
            }
        ).encode("utf-8")
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_resp

        resp = handler_module.handler(self._callback({"code": "expired_code"}), None)
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("expired", resp["body"])

    @patch("urllib.request.urlopen")
    def test_matching_state_via_cookies_list(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_urlopen()
        resp = handler_module.handler(self._callback({"code": "code"}), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertIn(FAKE_TOKEN, resp["body"])
        mock_urlopen.assert_called_once()

    @patch("urllib.request.urlopen")
    def test_matching_state_via_cookie_header(self, mock_urlopen):
        # Payload 1.0 delivers the cookie as a "; "-separated Cookie header.
        mock_urlopen.return_value = self._mock_urlopen()
        evt = _event_v1(
            "/callback",
            {"code": "code", "state": GOOD_STATE},
            cookie_header=f"theme=dark; {STATE_COOKIE}={GOOD_STATE}; other=1",
        )
        resp = handler_module.handler(evt, None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertIn(FAKE_TOKEN, resp["body"])


class TestCallbackStateVerification(_Base):
    """A /callback is honored only if GitHub echoes the state /auth minted."""

    def _assert_rejected(self, resp, mock_urlopen):
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("could not be verified", resp["body"])
        mock_urlopen.assert_not_called()

    @patch("urllib.request.urlopen")
    def test_missing_cookie_is_rejected(self, mock_urlopen):
        evt = _event("/callback", {"code": "code", "state": GOOD_STATE})
        self._assert_rejected(handler_module.handler(evt, None), mock_urlopen)

    @patch("urllib.request.urlopen")
    def test_empty_cookie_is_rejected(self, mock_urlopen):
        evt = _event("/callback", {"code": "code", "state": ""}, cookies={STATE_COOKIE: ""})
        self._assert_rejected(handler_module.handler(evt, None), mock_urlopen)

    @patch("urllib.request.urlopen")
    def test_missing_state_param_is_rejected(self, mock_urlopen):
        evt = _event("/callback", {"code": "code"}, cookies={STATE_COOKIE: GOOD_STATE})
        self._assert_rejected(handler_module.handler(evt, None), mock_urlopen)

    @patch("urllib.request.urlopen")
    def test_mismatched_state_is_rejected(self, mock_urlopen):
        evt = _event(
            "/callback",
            {"code": "code", "state": "other-state"},
            cookies={STATE_COOKIE: GOOD_STATE},
        )
        self._assert_rejected(handler_module.handler(evt, None), mock_urlopen)

    @patch("urllib.request.urlopen")
    def test_state_check_precedes_error_branch(self, mock_urlopen):
        # A forged callback must not get to steer the page text via the
        # error/error_description params, nor reach the code exchange.
        evt = _event(
            "/callback",
            {"error": "access_denied", "error_description": "Attacker words", "state": "wrong"},
            cookies={STATE_COOKIE: GOOD_STATE},
        )
        resp = handler_module.handler(evt, None)
        self._assert_rejected(resp, mock_urlopen)
        self.assertNotIn("Attacker words", resp["body"])

    @patch("urllib.request.urlopen")
    def test_state_cookie_is_not_read_from_a_lookalike_name(self, mock_urlopen):
        evt = _event(
            "/callback", {"code": "code", "state": GOOD_STATE}, cookies={"state": GOOD_STATE}
        )
        self._assert_rejected(handler_module.handler(evt, None), mock_urlopen)

    @patch("urllib.request.urlopen")
    def test_failed_check_logs_no_values(self, mock_urlopen):
        evt = _event(
            "/callback",
            {"code": "code", "state": "param-secret-marker"},
            cookies={STATE_COOKIE: "cookie-secret-marker"},
        )
        with self.assertLogs(level="WARNING") as logs:
            handler_module.handler(evt, None)
        joined = "\n".join(logs.output)
        self.assertNotIn("param-secret-marker", joined)
        self.assertNotIn("cookie-secret-marker", joined)


class TestCallbackClearsCookie(_Base):
    """The state cookie is single use: every /callback response expires it."""

    def _urlopen_returning(self, payload: dict):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(payload).encode("utf-8")
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def _good(self, extra: dict | None = None) -> dict:
        return _event(
            "/callback",
            {"state": GOOD_STATE, **(extra or {})},
            cookies={STATE_COOKIE: GOOD_STATE},
        )

    @patch("urllib.request.urlopen")
    def test_clears_on_success(self, mock_urlopen):
        mock_urlopen.return_value = self._urlopen_returning({"access_token": FAKE_TOKEN})
        resp = handler_module.handler(self._good({"code": "code"}), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(_set_cookies(resp), [CLEARED_COOKIE])

    @patch("urllib.request.urlopen")
    def test_clears_on_state_failure(self, mock_urlopen):
        resp = handler_module.handler(_event("/callback", {"code": "code"}), None)
        self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(_set_cookies(resp), [CLEARED_COOKIE])

    def test_clears_on_github_error_param(self):
        resp = handler_module.handler(self._good({"error": "access_denied"}), None)
        self.assertEqual(_set_cookies(resp), [CLEARED_COOKIE])

    def test_clears_on_missing_code(self):
        resp = handler_module.handler(self._good(), None)
        self.assertEqual(_set_cookies(resp), [CLEARED_COOKIE])

    @patch("urllib.request.urlopen")
    def test_clears_on_token_error(self, mock_urlopen):
        mock_urlopen.return_value = self._urlopen_returning({"error": "bad_verification_code"})
        resp = handler_module.handler(self._good({"code": "code"}), None)
        self.assertEqual(resp["statusCode"], 400)
        self.assertEqual(_set_cookies(resp), [CLEARED_COOKIE])

    @patch("urllib.request.urlopen")
    def test_clears_on_exchange_failure(self, mock_urlopen):
        mock_urlopen.side_effect = OSError("network down")
        resp = handler_module.handler(self._good({"code": "code"}), None)
        self.assertEqual(resp["statusCode"], 502)
        self.assertEqual(_set_cookies(resp), [CLEARED_COOKIE])

    def test_payload_1_0_clears_via_header(self):
        resp = handler_module.handler(_event_v1("/callback", {"code": "code"}), None)
        self.assertEqual(resp["headers"]["Set-Cookie"], CLEARED_COOKIE)
        self.assertNotIn("cookies", resp)


class TestRequestCookies(unittest.TestCase):
    def test_payload_2_0_cookies_list(self):
        event = {"cookies": ["a=1", f"{STATE_COOKIE}={GOOD_STATE}"]}
        self.assertEqual(
            handler_module._request_cookies(event), {"a": "1", STATE_COOKIE: GOOD_STATE}
        )

    def test_payload_1_0_cookie_header_any_case(self):
        for header in ("Cookie", "cookie"):
            event = {"headers": {header: f"a=1; {STATE_COOKIE}={GOOD_STATE}"}}
            self.assertEqual(
                handler_module._request_cookies(event), {"a": "1", STATE_COOKIE: GOOD_STATE}
            )

    def test_value_keeps_embedded_equals_sign(self):
        self.assertEqual(handler_module._request_cookies({"cookies": ["a=b=c"]}), {"a": "b=c"})

    def test_ignores_malformed_pairs_and_missing_fields(self):
        self.assertEqual(handler_module._request_cookies({}), {})
        self.assertEqual(handler_module._request_cookies({"headers": None, "cookies": None}), {})
        self.assertEqual(handler_module._request_cookies({"cookies": ["junk", "=x", " "]}), {})


class TestOriginPatterns(unittest.TestCase):
    def _allowed(self, origin, raw="https://example.com,https://preview-*.example.com"):
        patterns = handler_module._origin_patterns(raw)
        return handler_module._origin_allowed(origin, patterns)

    def test_exact_origin_matches(self):
        self.assertTrue(self._allowed("https://example.com"))

    def test_exact_origin_rejects_lookalikes(self):
        for origin in (
            "https://example.com.example.net",
            "https://xexample.com",
            "http://example.com",
            "https://example.com:8443",
            "https://example.com/",
            "https://example.com\n",
            "null",
            "",
            None,
        ):
            with self.subTest(origin=origin):
                self.assertFalse(self._allowed(origin))

    def test_wildcard_matches_within_one_label(self):
        self.assertTrue(self._allowed("https://preview-pr12.example.com"))
        self.assertTrue(self._allowed("https://preview-cms-some-slug.example.com"))

    def test_wildcard_never_crosses_a_dot_or_matches_empty(self):
        for origin in (
            "https://preview-a.b.example.com",
            "https://preview-.example.com",
            "https://preview-pr1.example.com.example.net",
            "https://preview-pr1.example.com:8443",
            "http://preview-pr1.example.com",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(self._allowed(origin))

    def test_leading_wildcard_label(self):
        raw = "https://*.example.com"
        self.assertTrue(self._allowed("https://a.example.com", raw))
        self.assertFalse(self._allowed("https://example.com", raw))
        self.assertFalse(self._allowed("https://a.b.example.com", raw))

    def test_port_is_part_of_the_origin(self):
        raw = "https://example.com:8443"
        self.assertTrue(self._allowed("https://example.com:8443", raw))
        self.assertFalse(self._allowed("https://example.com", raw))

    def test_invalid_entries_are_dropped(self):
        for entry in (
            "*",
            "https://*.com",
            "https://example.*",
            "https://*.*",
            "http://example.com",
            "https://example.com/path",
            "https://example.com?x=1",
            "https://user@example.com",
            "https://example",
            "javascript:alert(1)",
            "example.com",
        ):
            with self.subTest(entry=entry):
                with self.assertLogs(level="ERROR") as logs:
                    self.assertEqual(handler_module._origin_patterns(entry), [])
                self.assertIn(entry.lower(), "\n".join(logs.output))

    def test_valid_entries_survive_next_to_invalid_ones(self):
        patterns = handler_module._origin_patterns("*,https://example.com,https://*.com")
        self.assertEqual(patterns, [r"https://example\.com"])

    def test_normalizes_trailing_slash_case_and_whitespace(self):
        patterns = handler_module._origin_patterns(" HTTPS://Example.COM/ , ,https://example.org")
        self.assertEqual(patterns, [r"https://example\.com", r"https://example\.org"])

    def test_only_one_trailing_slash_is_stripped(self):
        with self.assertLogs(level="ERROR"):
            self.assertEqual(handler_module._origin_patterns("https://example.com//"), [])

    def test_empty_input_yields_no_patterns(self):
        self.assertEqual(handler_module._origin_patterns(""), [])
        self.assertEqual(handler_module._origin_patterns(" , "), [])

    def test_sources_use_only_the_shared_alphabet(self):
        # The same source is compiled by Python here and by the browser in the
        # callback page, so it must stay inside the characters both engines
        # read identically.
        for source in handler_module._origin_patterns(TEST_ORIGINS):
            self.assertRegex(source, r"^[a-z0-9\\.:/\[\]+-]+$")

    def test_default_patterns_come_from_the_module_allowlist(self):
        with patch.object(handler_module, "ALLOWED_ORIGIN_PATTERNS", [r"https://example\.org"]):
            self.assertTrue(handler_module._origin_allowed("https://example.org"))
            self.assertFalse(handler_module._origin_allowed("https://example.com"))


class TestMisconfiguredAllowlist(_Base):
    """No valid origin: fail closed before any redirect or code exchange."""

    def setUp(self):
        super().setUp()
        patcher = patch.object(handler_module, "ALLOWED_ORIGIN_PATTERNS", [])
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_auth_refuses(self):
        resp = handler_module.handler(_event("/auth"), None)
        self.assertEqual(resp["statusCode"], 500)
        self.assertIn("ALLOWED_ORIGINS has no valid origin", resp["body"])
        self.assertNotIn("Location", resp["headers"])
        self.assertEqual(_set_cookies(resp), [])

    @patch("urllib.request.urlopen")
    def test_callback_refuses_without_calling_github(self, mock_urlopen):
        evt = _event(
            "/callback",
            {"code": "code", "state": GOOD_STATE},
            cookies={STATE_COOKIE: GOOD_STATE},
        )
        resp = handler_module.handler(evt, None)
        self.assertEqual(resp["statusCode"], 500)
        self.assertIn("ALLOWED_ORIGINS has no valid origin", resp["body"])
        mock_urlopen.assert_not_called()

    def test_wildcard_only_configuration_is_unusable(self):
        # `*` is not a valid origin, so a legacy ALLOWED_ORIGINS=* config ends
        # up here rather than silently releasing the token to anyone.
        with self.assertLogs(level="ERROR"):
            self.assertEqual(handler_module._origin_patterns("*"), [])


class TestHtmlResponses(_Base):
    def _success(self, token: str = FAKE_TOKEN) -> dict:
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"access_token": token}).encode("utf-8")
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        evt = _event(
            "/callback",
            {"code": "code", "state": GOOD_STATE},
            cookies={STATE_COOKIE: GOOD_STATE},
        )
        with patch("urllib.request.urlopen", return_value=mock_resp):
            return handler_module.handler(evt, None)

    def _failure(self) -> dict:
        return handler_module.handler(_event("/callback", {"code": "code"}), None)

    def _assert_hardened(self, resp):
        headers = resp["headers"]
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        csp = headers["Content-Security-Policy"]
        for directive in (
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ):
            self.assertIn(directive, csp)
        return re.search(r"script-src 'nonce-([^']+)'", csp).group(1)

    def test_success_page_is_hardened_and_nonce_matches_script(self):
        resp = self._success()
        nonce = self._assert_hardened(resp)
        self.assertIn(f'<script nonce="{nonce}">', resp["body"])
        self.assertEqual(resp["body"].count("<script"), 1)

    def test_error_page_is_hardened_and_has_no_script(self):
        resp = self._failure()
        self._assert_hardened(resp)
        self.assertNotIn("<script", resp["body"])

    def test_nonce_is_fresh_per_response(self):
        self.assertNotEqual(
            self._assert_hardened(self._success()), self._assert_hardened(self._success())
        )

    def test_success_page_carries_origin_allowlist_and_source_check(self):
        body = self._success()["body"]
        for source in handler_module.ALLOWED_ORIGIN_PATTERNS:
            self.assertIn(json.dumps(source), body)
        self.assertIn(json.dumps(r"https://preview-[a-z0-9-]+\.example\.com"), body)
        self.assertIn("event.source !== window.opener", body)
        self.assertIn("originAllowed(event.origin)", body)

    def test_success_page_never_posts_the_token_to_a_wildcard_target(self):
        body = self._success()["body"]
        # The only '*' target is the secret-free handshake announcement.
        self.assertEqual(body.count(", '*')"), 1)
        self.assertIn("window.opener.postMessage('authorizing:' + provider, '*')", body)

    def test_token_cannot_close_the_script_element(self):
        hostile = "x</script><script>alert(1)</script>&<!--"
        body = self._success(hostile)["body"]
        self.assertEqual(body.count("</script>"), 1)
        self.assertEqual(body.count("<script"), 1)
        self.assertNotIn("<!--", body)
        self.assertIn("\\u003c/script\\u003e", body)

    def test_js_literal_escapes_script_breakers(self):
        out = handler_module._js_literal({"v": "<>&\u2028\u2029"})
        for ch in "<>&\u2028\u2029":
            self.assertNotIn(ch, out)
        # Still valid JSON that round-trips to the original value.
        self.assertEqual(json.loads(out), {"v": "<>&\u2028\u2029"})
        self.assertIn("\\u003c", out)
        self.assertIn("\\u003e", out)
        self.assertIn("\\u0026", out)

    def test_misconfigured_error_page_is_hardened(self):
        with patch.object(handler_module, "ALLOWED_ORIGIN_PATTERNS", []):
            resp = handler_module.handler(_event("/auth"), None)
        self.assertEqual(resp["statusCode"], 500)
        self._assert_hardened(resp)


class TestCors(_Base):
    def test_allowed_origin_is_echoed(self):
        resp = handler_module.handler(_event("/auth", origin="https://example.com"), None)
        self.assertEqual(resp["headers"]["Access-Control-Allow-Origin"], "https://example.com")

    def test_allowed_wildcard_origin_is_echoed(self):
        origin = "https://preview-pr12.example.com"
        resp = handler_module.handler(_event("/auth", origin=origin), None)
        self.assertEqual(resp["headers"]["Access-Control-Allow-Origin"], origin)

    def test_disallowed_origin_gets_no_allow_origin_header(self):
        resp = handler_module.handler(_event("/auth", origin="https://attacker.example.net"), None)
        self.assertNotIn("Access-Control-Allow-Origin", resp["headers"])
        self.assertIn("Access-Control-Allow-Methods", resp["headers"])

    def test_no_origin_header_gets_no_allow_origin_header(self):
        evt = _event("/auth")
        evt["headers"] = {}
        resp = handler_module.handler(evt, None)
        self.assertNotIn("Access-Control-Allow-Origin", resp["headers"])

    def test_never_falls_back_to_the_first_configured_origin(self):
        # The old code answered an unknown origin with allowed[0]; a stranger
        # must not be told "https://example.com" is the right origin either.
        resp = handler_module.handler(_event("/health", origin="https://xexample.com"), None)
        self.assertNotIn("Access-Control-Allow-Origin", resp["headers"])


class TestOptionsPreFlight(_Base):
    def test_options_returns_204(self):
        event = _event("/auth", method="OPTIONS")
        resp = handler_module.handler(event, None)
        self.assertEqual(resp["statusCode"], 204)

    def test_options_cors_headers(self):
        event = _event("/callback", method="OPTIONS")
        resp = handler_module.handler(event, None)
        self.assertIn("Access-Control-Allow-Methods", resp["headers"])


class TestNotFound(_Base):
    def test_unknown_path(self):
        resp = handler_module.handler(_event("/unknown"), None)
        self.assertEqual(resp["statusCode"], 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
