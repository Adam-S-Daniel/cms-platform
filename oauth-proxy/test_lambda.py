"""
Unit tests for the OAuth proxy Lambda handler.

Run locally with:  python -m pytest test_lambda.py -v
No AWS credentials required — all GitHub API calls are mocked.
"""

import ast
import hashlib
import importlib
import json
import os
import re
import subprocess  # nosec B404  # runs this file's own interpreter
import sys
import unittest
import urllib.parse
from unittest.mock import MagicMock, patch

import yaml

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
TEST_APEX = "example.com"


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
            handler_module._origin_patterns(TEST_ORIGINS, TEST_APEX),
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

    def test_health_keeps_its_original_fields(self):
        # Additive only: anything that read the old body still finds its keys.
        body = json.loads(handler_module.handler(_event("/prod/health"), None)["body"])
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["service"], "cms-oauth-proxy")

    def test_health_reports_the_digest_of_the_running_handler(self):
        # The digest the build probe compares: sha256 of lambda.py's bytes,
        # computed from the file the handler was loaded from (#518).
        with open(handler_module.__file__, "rb") as source:
            expected = hashlib.sha256(source.read()).hexdigest()
        body = json.loads(handler_module.handler(_event("/prod/health"), None)["body"])
        self.assertEqual(body["handler_sha256"], expected)

    def test_health_reports_the_release_deploy_sh_passed(self):
        with patch.object(handler_module, "PLATFORM_RELEASE", "v9.9.9"):
            body = json.loads(handler_module.handler(_event("/prod/health"), None)["body"])
        self.assertEqual(body["release"], "v9.9.9")

    def test_health_release_is_empty_when_not_deployed_with_one(self):
        with patch.object(handler_module, "PLATFORM_RELEASE", ""):
            body = json.loads(handler_module.handler(_event("/prod/health"), None)["body"])
        self.assertEqual(body["release"], "")


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

    def test_requests_read_user_not_the_profile_write_scope(self):
        # The admin reads GET /user and never writes the profile, so the
        # read/write `user` scope is not requested (#516).
        query = urllib.parse.urlparse(
            handler_module.handler(_event("/auth"), None)["headers"]["Location"]
        ).query
        scopes = urllib.parse.parse_qs(query)["scope"][0].split(",")
        self.assertIn("read:user", scopes)
        self.assertNotIn("user", scopes)

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


class TestGitHubAppTokenResponse(_Base):
    """
    A GitHub App's client id goes through the same web flow, but with token
    expiry on, GitHub's answer also carries a refresh token and expiry fields
    (docs: "Generating a user access token for a GitHub App"). Decap has no
    refresh flow, so the browser gets the access token and nothing else.
    """

    # Low-entropy fixture values; real ones start ghu_ / ghr_.
    ACCESS = "ghu_TEST-ACCESS-VALUE"  # nosec B105  # fixture value, not a secret
    REFRESH = "ghr_TEST-REFRESH-VALUE"  # nosec B105  # fixture value, not a secret

    def _app_response(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(
            {
                "access_token": self.ACCESS,
                "expires_in": 28800,
                "refresh_token": self.REFRESH,
                "refresh_token_expires_in": 15897600,
                "scope": "",
                "token_type": "bearer",  # nosec B105  # OAuth token_type literal
            }
        ).encode("utf-8")
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def _callback(self):
        return _event(
            "/callback", {"code": "code", "state": GOOD_STATE}, cookies={STATE_COOKIE: GOOD_STATE}
        )

    @patch("urllib.request.urlopen")
    def test_page_carries_only_the_access_token(self, mock_urlopen):
        mock_urlopen.return_value = self._app_response()
        with self.assertLogs(level="INFO") as logs:
            resp = handler_module.handler(self._callback(), None)
        self.assertEqual(resp["statusCode"], 200)
        body = resp["body"]
        # The exact payload Decap receives: token and provider, nothing more.
        self.assertIn(
            "var payload  = "
            + handler_module._js_literal({"token": self.ACCESS, "provider": "github"})
            + ";",
            body,
        )
        for leaked in (self.REFRESH, "refresh_token", "expires_in", "28800"):
            self.assertNotIn(leaked, body)
        self.assertNotIn(self.REFRESH, "\n".join(logs.output))


class TestScopeLockstep(unittest.TestCase):
    """
    GITHUB_SCOPE has three homes: the Lambda's fallback, the SAM parameter's
    Default and deploy.sh's default (AGENTS.md). A deploy uses deploy.sh's;
    the others are what an operator reads. They must agree.
    """

    HERE = os.path.dirname(os.path.abspath(__file__))

    def _lambda_default(self) -> str:
        # The second argument of os.environ.get("GITHUB_SCOPE", ...), from the AST.
        with open(os.path.join(self.HERE, "lambda.py"), encoding="utf-8") as f:
            tree = ast.parse(f.read())
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and len(node.args) == 2
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == "GITHUB_SCOPE"
            ):
                return node.args[1].value
        self.fail("lambda.py has no os.environ.get('GITHUB_SCOPE', <default>)")

    def _template_default(self) -> str:
        class _CfnLoader(yaml.SafeLoader):
            pass

        # !Ref / !Sub / !GetAtt: the values are irrelevant here.
        _CfnLoader.add_multi_constructor("!", lambda loader, suffix, node: None)
        with open(os.path.join(self.HERE, "template.yaml"), encoding="utf-8") as f:
            template = yaml.load(f, Loader=_CfnLoader)  # nosec B506  # SafeLoader subclass
        return template["Parameters"]["GitHubScope"]["Default"]

    def _deploy_default(self) -> str:
        # A shell default expansion is one lexical token; bash has no AST here.
        with open(os.path.join(self.HERE, "deploy.sh"), encoding="utf-8") as f:
            found = re.findall(r'^GITHUB_SCOPE="\$\{GITHUB_SCOPE:-([^}]*)\}"$', f.read(), re.M)
        self.assertEqual(len(found), 1, "deploy.sh must set GITHUB_SCOPE's default exactly once")
        return found[0]

    def test_three_defaults_agree(self):
        self.assertEqual(self._lambda_default(), self._template_default())
        self.assertEqual(self._lambda_default(), self._deploy_default())

    def test_default_reads_the_profile_without_writing_it(self):
        scopes = self._deploy_default().split(",")
        self.assertIn("read:user", scopes)
        self.assertNotIn("user", scopes)


class TestGitHubAppManifest(unittest.TestCase):
    """
    github-app-manifest.json is the #516 spike's sign-in App. Its permissions
    are the minimal set derived in docs/ADMIN-AUTH-SECURITY.md; widening one
    (Workflows, Issues, Administration, any user permission) is a decision
    for that doc first, not a quiet edit here.
    """

    MINIMAL = {
        "metadata": "read",
        "contents": "write",
        "pull_requests": "write",
        "statuses": "read",
        "checks": "read",
        "actions": "read",
        "deployments": "write",
    }

    def setUp(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "github-app-manifest.json")
        with open(path, encoding="utf-8") as f:
            self.manifest = json.load(f)

    def test_requests_exactly_the_minimal_permissions(self):
        self.assertEqual(self.manifest["default_permissions"], self.MINIMAL)

    def test_receives_no_events(self):
        self.assertFalse(self.manifest["hook_attributes"]["active"])
        self.assertEqual(self.manifest["default_events"], [])

    def test_carries_placeholders_not_a_site_identity(self):
        self.assertEqual(self.manifest["callback_urls"], ["<oauth_base_url>/prod/callback"])
        self.assertEqual(self.manifest["url"], "https://<apex>")
        self.assertEqual(self.manifest["redirect_url"], "https://<apex>/")


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
        patterns = handler_module._origin_patterns(raw, TEST_APEX)
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
                    self.assertEqual(handler_module._origin_patterns(entry, TEST_APEX), [])
                self.assertIn(entry.lower(), "\n".join(logs.output))

    def test_valid_entries_survive_next_to_invalid_ones(self):
        patterns = handler_module._origin_patterns(
            "*,https://example.com,https://*.com", TEST_APEX
        )
        self.assertEqual(patterns, [r"https://example\.com"])

    def test_normalizes_trailing_slash_case_and_whitespace(self):
        patterns = handler_module._origin_patterns(
            " HTTPS://Example.COM/ , ,https://example.org", TEST_APEX
        )
        self.assertEqual(patterns, [r"https://example\.com", r"https://example\.org"])

    def test_only_one_trailing_slash_is_stripped(self):
        with self.assertLogs(level="ERROR"):
            self.assertEqual(handler_module._origin_patterns("https://example.com//", TEST_APEX), [])

    def test_empty_input_yields_no_patterns(self):
        self.assertEqual(handler_module._origin_patterns("", TEST_APEX), [])
        self.assertEqual(handler_module._origin_patterns(" , ", TEST_APEX), [])

    def test_sources_use_only_the_shared_alphabet(self):
        # The same source is compiled by Python here and by the browser in the
        # callback page, so it must stay inside the characters both engines
        # read identically.
        for source in handler_module._origin_patterns(TEST_ORIGINS, TEST_APEX):
            self.assertRegex(source, r"^[a-z0-9\\.:/\[\]+-]+$")

    def test_default_patterns_come_from_the_module_allowlist(self):
        with patch.object(handler_module, "ALLOWED_ORIGIN_PATTERNS", [r"https://example\.org"]):
            self.assertTrue(handler_module._origin_allowed("https://example.org"))
            self.assertFalse(handler_module._origin_allowed("https://example.com"))


class TestWildcardsStayInsideTheSiteApex(unittest.TestCase):
    """
    #535: "no `*` in the last two labels" is not a registrable-domain boundary.
    `https://*.github.io` and `https://*.co.uk` passed it, and each spans
    sites that other people register. A `*` is now honored only at or beneath
    SITE_APEX, the domain the site declared as its own.
    """

    def _patterns(self, raw, apex=TEST_APEX):
        return handler_module._origin_patterns(raw, apex)

    def _assert_dropped(self, entry, apex=TEST_APEX):
        with self.assertLogs(level="ERROR") as logs:
            self.assertEqual(self._patterns(entry, apex), [], entry)
        self.assertIn(entry.lower(), "\n".join(logs.output))

    def test_the_two_reported_patterns_are_refused(self):
        for entry in ("https://*.pages.example", "https://*.co.example"):
            with self.subTest(entry=entry):
                self._assert_dropped(entry)

    def test_wildcards_over_other_public_and_private_suffixes_are_refused(self):
        for entry in (
            "https://preview-*.pages.example",
            "https://*.example.co.example",
            "https://*.s3.example.net",
            "https://*.execute-api.us-east-1.example.net",
            "https://*.com",
            "https://example.*",
            "https://*.*",
        ):
            with self.subTest(entry=entry):
                self._assert_dropped(entry)

    def test_wildcards_that_only_look_like_the_apex_are_refused(self):
        for entry in (
            # A label that merely ends in the apex's first label.
            "https://*example.com",
            "https://preview-*.notexample.com",
            # The apex followed by more labels is someone else's domain.
            "https://preview-*.example.com.example.net",
            "https://*.example.com.co.example",
            # The wildcard is the last label before a TLD.
            "https://example.*.com",
        ):
            with self.subTest(entry=entry):
                self._assert_dropped(entry)

    def test_no_apex_means_no_wildcard(self):
        for apex in ("", "   ", "com", "*.example.com", "example.com.", "example..com"):
            with self.subTest(apex=apex):
                self._assert_dropped("https://preview-*.example.com", apex)

    def test_a_literal_origin_needs_no_apex(self):
        self.assertEqual(
            self._patterns("https://example.com,https://admin.example.net", ""),
            [r"https://example\.com", r"https://admin\.example\.net"],
        )

    def test_site_owned_wildcards_are_kept(self):
        for entry, origin in (
            ("https://preview-*.example.com", "https://preview-pr12.example.com"),
            ("https://*.example.com", "https://anything.example.com"),
            ("https://pr-*.staging.example.com", "https://pr-3.staging.example.com"),
            ("https://a.*.example.com", "https://a.b.example.com"),
            ("https://preview-*.example.com:8443", "https://preview-x.example.com:8443"),
        ):
            with self.subTest(entry=entry):
                patterns = self._patterns(entry)
                self.assertEqual(len(patterns), 1)
                self.assertTrue(handler_module._origin_allowed(origin, patterns))

    def test_a_kept_wildcard_still_never_leaves_the_apex(self):
        patterns = self._patterns("https://preview-*.example.com")
        for origin in (
            "https://preview-a.example.com.example.net",
            "https://preview-a.b.example.com",
            "https://preview-a.pages.example",
            "https://example.com",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(handler_module._origin_allowed(origin, patterns))

    def test_apex_is_lowercased_like_deploy_sh_does(self):
        self.assertEqual(
            self._patterns("https://preview-*.example.com", "Example.COM"),
            [r"https://preview-[a-z0-9-]+\.example\.com"],
        )

    def test_an_apex_with_whitespace_is_rejected_not_stripped(self):
        # deploy.sh and the template's AllowedPattern refuse it, so the Lambda
        # must not quietly repair it into a working bound.
        for apex in (" example.com", "example.com ", " example.com ", "example.com\n", "exam ple.com"):
            with self.subTest(apex=apex):
                self._assert_dropped("https://preview-*.example.com", apex)

    def test_the_handler_reads_the_apex_from_site_apex(self):
        # A fresh interpreter, so the module-level allowlist is built from
        # this environment rather than patched.
        snippet = (
            "import importlib, json, sys; sys.path.insert(0, sys.argv[1]); "
            "print(json.dumps(importlib.import_module('lambda').ALLOWED_ORIGIN_PATTERNS))"
        )
        base = {
            "PATH": os.environ.get("PATH", ""),
            "GITHUB_CLIENT_ID": "test_client_id",
            "GITHUB_CLIENT_SECRET": "test_client_secret",
            "ALLOWED_ORIGINS": TEST_ORIGINS,
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        here = os.path.dirname(os.path.abspath(__file__))
        for apex, expected in (
            ("example.com", handler_module._origin_patterns(TEST_ORIGINS, "example.com")),
            (None, [r"https://example\.com"]),
        ):
            env = dict(base) if apex is None else {**base, "SITE_APEX": apex}
            with self.subTest(apex=apex):
                out = subprocess.run(  # noqa: S603  # nosec B603  # fixed argv
                    [sys.executable, "-c", snippet, here],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertEqual(json.loads(out.stdout), expected)


class TestConcurrentSignIn(_Base):
    """
    #537: the state lives in ONE `__Host-cms-oauth-state` cookie per browser
    cookie context, so a second /auth overwrites the first one's state. These
    drive /auth and /callback through a minimal cookie jar and never reach
    GitHub except where a sign-in is meant to succeed (mocked).
    """

    VERIFY_FAILED = "This sign-in could not be verified. Close this window and start again."

    def setUp(self):
        super().setUp()
        self.jar: dict[str, str] = {}

    def _store(self, resp):
        # What a browser that accepts the proxy's cookies keeps.
        for cookie in _set_cookies(resp):
            name, _, rest = cookie.partition("=")
            value = rest.split(";", 1)[0]
            if "Max-Age=0" in cookie.split("; "):
                self.jar.pop(name, None)
            else:
                self.jar[name] = value

    def _auth(self, store=True) -> str:
        resp = handler_module.handler(_event("/auth"), None)
        if store:
            self._store(resp)
        return _state_of(resp["headers"]["Location"])

    def _callback(self, state):
        evt = _event("/callback", {"code": "code", "state": state}, cookies=dict(self.jar))
        resp = handler_module.handler(evt, None)
        self._store(resp)
        return resp

    @staticmethod
    def _token_response():
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"access_token": FAKE_TOKEN}).encode("utf-8")
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def _assert_unverified(self, resp):
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn(self.VERIFY_FAILED, resp["body"])
        self.assertNotIn(FAKE_TOKEN, resp["body"])

    @patch("urllib.request.urlopen")
    def test_second_sign_in_overwrites_the_first_ones_state(self, mock_urlopen):
        first = self._auth()
        second = self._auth()
        self.assertNotEqual(first, second)
        self.assertEqual(self.jar, {STATE_COOKIE: second})
        # The first popup returns: its state is gone, and so is the cookie
        # (every callback clears it), which then fails the second popup too.
        self._assert_unverified(self._callback(first))
        self.assertEqual(self.jar, {})
        self._assert_unverified(self._callback(second))
        mock_urlopen.assert_not_called()

    @patch("urllib.request.urlopen")
    def test_newest_sign_in_wins_when_it_returns_first(self, mock_urlopen):
        mock_urlopen.return_value = self._token_response()
        first = self._auth()
        second = self._auth()
        ok = self._callback(second)
        self.assertEqual(ok["statusCode"], 200)
        self.assertIn(FAKE_TOKEN, ok["body"])
        self._assert_unverified(self._callback(first))
        mock_urlopen.assert_called_once()

    @patch("urllib.request.urlopen")
    def test_one_fresh_sign_in_after_a_failure_succeeds(self, mock_urlopen):
        # The retry instruction in docs/ADMIN-AUTH-SECURITY.md: close every
        # sign-in popup, then start exactly one.
        mock_urlopen.return_value = self._token_response()
        first = self._auth()
        self._auth()
        self._assert_unverified(self._callback(first))
        retry = self._auth()
        self.assertEqual(self._callback(retry)["statusCode"], 200)
        mock_urlopen.assert_called_once()

    @patch("urllib.request.urlopen")
    def test_a_browser_that_refuses_the_cookie_cannot_sign_in(self, mock_urlopen):
        # The proxy-host cookie requirement: /auth's state is real, but with
        # no cookie to compare it against the callback is refused before
        # GitHub is contacted, and the log says which half was missing.
        state = self._auth(store=False)
        with self.assertLogs(level="WARNING") as logs:
            resp = self._callback(state)
        self._assert_unverified(resp)
        self.assertIn("state param present=True, cookie present=False", "\n".join(logs.output))
        mock_urlopen.assert_not_called()


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
            self.assertEqual(handler_module._origin_patterns("*", TEST_APEX), [])


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
