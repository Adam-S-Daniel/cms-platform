"""Tests for verify_live and post_mastodon."""

import hashlib
import json
import urllib.error

import pytest

import cross_post


def make_post(slug="my-post", url="https://adamdaniel.ai/blog/my-post/", title="My Post"):
    return {
        "path": f"_posts/2026-01-01-{slug}.md",
        "slug": slug,
        "title": title,
        "url": url,
        "date": "2026-01-01",
        "excerpt": "An excerpt.",
        "tags": ["ai"],
        "featured_image": "",
    }


# --- verify_live -------------------------------------------------


def test_verify_live_success_on_first_attempt():
    calls = []

    def fetch(url):
        calls.append(url)
        return 200

    failed = cross_post.verify_live(["https://adamdaniel.ai/blog/a/"], fetch, attempts=5, sleep=lambda s: None)
    assert failed == []
    assert calls == ["https://adamdaniel.ai/blog/a/"]


def test_verify_live_succeeds_after_a_few_attempts():
    attempt_counts = {"https://adamdaniel.ai/blog/a/": 0}

    def fetch(url):
        attempt_counts[url] += 1
        return 200 if attempt_counts[url] >= 3 else 404

    sleeps = []
    failed = cross_post.verify_live(
        ["https://adamdaniel.ai/blog/a/"], fetch, attempts=5, sleep=lambda s: sleeps.append(s)
    )
    assert failed == []
    assert attempt_counts["https://adamdaniel.ai/blog/a/"] == 3
    assert sleeps == [15, 15]


def test_verify_live_failure_returns_urls_that_never_answered_200():
    def fetch(url):
        return 404

    failed = cross_post.verify_live(
        ["https://adamdaniel.ai/blog/a/", "https://adamdaniel.ai/blog/b/"],
        fetch,
        attempts=3,
        sleep=lambda s: None,
    )
    assert failed == ["https://adamdaniel.ai/blog/a/", "https://adamdaniel.ai/blog/b/"]


def test_verify_live_partial_failure():
    def fetch(url):
        return 200 if url.endswith("/a/") else 500

    failed = cross_post.verify_live(
        ["https://adamdaniel.ai/blog/a/", "https://adamdaniel.ai/blog/b/"],
        fetch,
        attempts=2,
        sleep=lambda s: None,
    )
    assert failed == ["https://adamdaniel.ai/blog/b/"]


# --- urllib_transport -------------------------------------------------


def test_urllib_transport_network_failure_returns_http_zero(monkeypatch):
    def raise_url_error(request, timeout=10):
        raise urllib.error.URLError("boom")

    monkeypatch.setattr(cross_post.urllib.request, "urlopen", raise_url_error)
    assert cross_post.urllib_transport("GET", "https://example.com/x", {}, None) == (0, b"")


# --- post_mastodon -------------------------------------------------


class FakeTransport:
    def __init__(self, responses):
        # responses: dict keyed by (method, url) -> (status, bytes) OR a list consumed in order
        self.responses = responses
        self.calls = []

    def __call__(self, method, url, headers, data):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "data": data})
        key = (method, url)
        value = self.responses[key]
        if isinstance(value, list):
            return value.pop(0)
        return value


def verify_credentials_response(account_id="123"):
    return (200, json.dumps({"id": account_id}).encode("utf-8"))


def statuses_response(statuses):
    return (200, json.dumps(statuses).encode("utf-8"))


def test_post_mastodon_sends_bearer_auth_header():
    post = make_post()
    instance = "https://mastodon.example"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            ("GET", f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true"): statuses_response([]),
            ("POST", f"{instance}/api/v1/statuses"): (
                200,
                json.dumps({"url": "https://mastodon.example/@adam/1", "id": "1"}).encode("utf-8"),
            ),
        }
    )
    cross_post.post_mastodon([post], instance, "secret-token", transport)
    post_call = next(c for c in transport.calls if c["method"] == "POST")
    assert post_call["headers"]["Authorization"] == "Bearer secret-token"
    for call in transport.calls:
        assert call["headers"]["Authorization"] == "Bearer secret-token"


def test_post_mastodon_idempotency_key_is_deterministic_per_url():
    post = make_post()
    instance = "https://mastodon.example"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            ("GET", f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true"): statuses_response([]),
            ("POST", f"{instance}/api/v1/statuses"): (
                200,
                json.dumps({"url": "https://mastodon.example/@adam/1", "id": "1"}).encode("utf-8"),
            ),
        }
    )
    cross_post.post_mastodon([post], instance, "secret-token", transport)
    post_call = next(c for c in transport.calls if c["method"] == "POST")
    expected_key = hashlib.sha256(post["url"].encode("utf-8")).hexdigest()[:32]
    assert post_call["headers"]["Idempotency-Key"] == expected_key
    assert len(expected_key) == 32


def test_post_mastodon_dedupes_when_status_already_posted():
    post = make_post()
    instance = "https://mastodon.example"
    existing_status_url = "https://mastodon.example/@adam/99"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            ("GET", f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true"): statuses_response(
                [{"url": existing_status_url, "content": f'<p>Check it: <a href="{post["url"]}">link</a></p>'}]
            ),
        }
    )
    results = cross_post.post_mastodon([post], instance, "secret-token", transport)
    assert results == [{"slug": post["slug"], "skipped": "already-posted", "existing_url": existing_status_url}]
    assert all(c["method"] != "POST" for c in transport.calls)


def test_post_mastodon_dedupe_lookup_failure_warns_and_still_posts(capsys):
    post = make_post()
    instance = "https://mastodon.example"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            (
                "GET",
                f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true",
            ): (503, b"Service Unavailable body text with secrets"),
            ("POST", f"{instance}/api/v1/statuses"): (
                201,
                json.dumps({"url": "https://mastodon.example/@adam/1", "id": "1"}).encode("utf-8"),
            ),
        }
    )
    results = cross_post.post_mastodon([post], instance, "secret-token", transport)
    assert any(c["method"] == "POST" for c in transport.calls)
    assert results == [{"slug": post["slug"], "url": "https://mastodon.example/@adam/1", "id": "1"}]

    captured = capsys.readouterr()
    assert "::warning::Mastodon dedupe lookup failed (HTTP 503); posting without a duplicate check" in captured.out
    assert "Service Unavailable body text with secrets" not in captured.out


def test_post_mastodon_dry_run_makes_no_post_request():
    post = make_post()
    instance = "https://mastodon.example"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            ("GET", f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true"): statuses_response([]),
        }
    )
    results = cross_post.post_mastodon([post], instance, "secret-token", transport, dry_run=True)
    assert results == [{"slug": post["slug"], "dry_run": True}]
    assert all(c["method"] != "POST" for c in transport.calls)


def test_post_mastodon_no_token_makes_no_request_and_returns_skipped():
    post = make_post()
    transport = FakeTransport({})
    results = cross_post.post_mastodon([post], "https://mastodon.example", "", transport)
    assert results == [{"slug": post["slug"], "skipped": "no-token"}]
    assert transport.calls == []


def test_post_mastodon_none_token_makes_no_request():
    post = make_post()
    transport = FakeTransport({})
    results = cross_post.post_mastodon([post], "https://mastodon.example", None, transport)
    assert results == [{"slug": post["slug"], "skipped": "no-token"}]
    assert transport.calls == []


def test_post_mastodon_5xx_raises_systemexit_after_attempting_remaining_posts(capsys):
    post1 = make_post(slug="post-one", url="https://adamdaniel.ai/blog/post-one/")
    post2 = make_post(slug="post-two", url="https://adamdaniel.ai/blog/post-two/")
    instance = "https://mastodon.example"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            (
                "GET",
                f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true",
            ): statuses_response([]),
            ("POST", f"{instance}/api/v1/statuses"): [
                (503, b"Service Unavailable body text with secrets"),
                (200, json.dumps({"url": "https://mastodon.example/@adam/2", "id": "2"}).encode("utf-8")),
            ],
        }
    )
    with pytest.raises(SystemExit):
        cross_post.post_mastodon([post1, post2], instance, "secret-token", transport)

    post_calls = [c for c in transport.calls if c["method"] == "POST"]
    assert len(post_calls) == 2  # both posts were attempted despite the first failing

    captured = capsys.readouterr()
    assert "503" in captured.out
    assert "Service Unavailable body text with secrets" not in captured.out
    assert "secret-token" not in captured.out


def test_post_mastodon_error_output_never_contains_response_body(capsys):
    post = make_post()
    instance = "https://mastodon.example"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            (
                "GET",
                f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true",
            ): statuses_response([]),
            ("POST", f"{instance}/api/v1/statuses"): (500, b"top secret internal error details"),
        }
    )
    with pytest.raises(SystemExit):
        cross_post.post_mastodon([post], instance, "secret-token", transport)
    captured = capsys.readouterr()
    assert "top secret internal error details" not in captured.out
    assert "top secret internal error details" not in captured.err


def test_post_mastodon_writes_mastodon_json_when_out_dir_given(tmp_path):
    post = make_post()
    instance = "https://mastodon.example"
    transport = FakeTransport(
        {
            ("GET", f"{instance}/api/v1/accounts/verify_credentials"): verify_credentials_response(),
            ("GET", f"{instance}/api/v1/accounts/123/statuses?limit=40&exclude_replies=true&exclude_reblogs=true"): statuses_response([]),
            ("POST", f"{instance}/api/v1/statuses"): (
                201,
                json.dumps({"url": "https://mastodon.example/@adam/1", "id": "1"}).encode("utf-8"),
            ),
        }
    )
    cross_post.post_mastodon([post], instance, "secret-token", transport, out_dir=tmp_path)
    out_file = tmp_path / f"{post['slug']}.mastodon.json"
    assert out_file.exists()
    data = json.loads(out_file.read_text(encoding="utf-8"))
    assert data["url"] == "https://mastodon.example/@adam/1"
