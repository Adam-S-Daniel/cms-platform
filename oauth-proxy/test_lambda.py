"""
Unit tests for the OAuth proxy Lambda handler.

Run locally with:  python -m pytest test_lambda.py -v
No AWS credentials required — all GitHub API calls are mocked.
"""

import importlib
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# Set required env vars before importing the handler
os.environ.setdefault("GITHUB_CLIENT_ID", "test_client_id")
os.environ.setdefault("GITHUB_CLIENT_SECRET", "test_client_secret")
os.environ.setdefault("ALLOWED_ORIGINS", "https://adamdaniel.ai")

# `lambda` is a reserved word, so it can't be a plain `import`; load it
# dynamically after the env vars above and the sys.path shim are in place.
sys.path.insert(0, os.path.dirname(__file__))
handler_module = importlib.import_module("lambda")


def _event(path: str, params: dict | None = None, method: str = "GET") -> dict:
    """Build a minimal API Gateway HTTP API (v2) event."""
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "queryStringParameters": params or {},
        "headers": {"origin": "https://adamdaniel.ai"},
    }


class TestHealthCheck(unittest.TestCase):
    def test_health(self):
        resp = handler_module.handler(_event("/health"), None)
        self.assertEqual(resp["statusCode"], 200)
        body = json.loads(resp["body"])
        self.assertEqual(body["status"], "ok")

    def test_root(self):
        resp = handler_module.handler(_event("/"), None)
        self.assertEqual(resp["statusCode"], 200)


class TestAuthRedirect(unittest.TestCase):
    def test_redirects_to_github(self):
        resp = handler_module.handler(_event("/auth", {"state": "abc123"}), None)
        self.assertEqual(resp["statusCode"], 302)
        location = resp["headers"]["Location"]
        self.assertIn("github.com/login/oauth/authorize", location)
        self.assertIn("test_client_id", location)
        self.assertIn("abc123", location)

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

    def test_cors_header_present(self):
        resp = handler_module.handler(_event("/auth"), None)
        self.assertIn("Access-Control-Allow-Origin", resp["headers"])


class TestCallbackSuccess(unittest.TestCase):
    def _mock_urlopen(self, token: str = "ghp_test_access_token"):  # nosec B107  # fake fixture token
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

    @patch("urllib.request.urlopen")
    def test_success_returns_html(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_urlopen()
        resp = handler_module.handler(_event("/callback", {"code": "auth_code_123"}), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertIn("text/html", resp["headers"]["Content-Type"])
        self.assertIn("postMessage", resp["body"])
        self.assertIn("ghp_test_access_token", resp["body"])

    @patch("urllib.request.urlopen")
    def test_token_in_postmessage(self, mock_urlopen):
        mock_urlopen.return_value = self._mock_urlopen("my_token_xyz")
        resp = handler_module.handler(_event("/callback", {"code": "code"}), None)
        self.assertIn("my_token_xyz", resp["body"])
        # The postMessage payload is built dynamically in JS to avoid embedding
        # the full string in the HTML (XSS-safe pattern).
        self.assertIn("authorization:", resp["body"])
        self.assertIn(":success:", resp["body"])
        self.assertIn("postMessage", resp["body"])

    def test_missing_code_returns_error(self):
        resp = handler_module.handler(_event("/callback", {}), None)
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("No authorisation code", resp["body"])

    def test_github_error_param_returns_error(self):
        resp = handler_module.handler(
            _event(
                "/callback", {"error": "access_denied", "error_description": "User denied access"}
            ),
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

        resp = handler_module.handler(_event("/callback", {"code": "expired_code"}), None)
        self.assertEqual(resp["statusCode"], 400)
        self.assertIn("expired", resp["body"])


class TestOptionsPreFlight(unittest.TestCase):
    def test_options_returns_204(self):
        event = _event("/auth", method="OPTIONS")
        resp = handler_module.handler(event, None)
        self.assertEqual(resp["statusCode"], 204)

    def test_options_cors_headers(self):
        event = _event("/callback", method="OPTIONS")
        resp = handler_module.handler(event, None)
        self.assertIn("Access-Control-Allow-Methods", resp["headers"])


class TestNotFound(unittest.TestCase):
    def test_unknown_path(self):
        resp = handler_module.handler(_event("/unknown"), None)
        self.assertEqual(resp["statusCode"], 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
