"""Tests for the LinkedIn leg: little-text escaping, commentary, token age, post_linkedin."""

import datetime
import json
import urllib.error

import pytest

import cross_post

API = "https://api.linkedin.com"
USERINFO = f"{API}/v2/userinfo"
POSTS = f"{API}/rest/posts"
INIT_UPLOAD = f"{API}/rest/images?action=initializeUpload"
UPLOAD_URL = "https://www.linkedin.com/dms-uploads/abc123"
IMAGE_URL = "https://adamdaniel.ai/assets/img/cover.png"
IMAGE_URN = "urn:li:image:C4E10AQF"
SHARE_URN = "urn:li:share:7000000000000000001"
TOKEN = "li-secret-token"
TODAY = datetime.date(2026, 9, 22)
ROTATE = 'see docs/CROSS-POSTING.md "Rotating the LinkedIn token"'


def make_post(slug="my-post", title="My Post", excerpt="An excerpt.", tags=("ai",), featured_image=""):
    return {
        "path": f"_posts/2026-01-01-{slug}.md",
        "slug": slug,
        "title": title,
        "url": f"https://adamdaniel.ai/blog/{slug}/",
        "date": "2026-01-01",
        "excerpt": excerpt,
        "tags": list(tags),
        "featured_image": featured_image,
    }


def minted_days_ago(days):
    return (TODAY - datetime.timedelta(days=days)).isoformat()


class FakeTransport:
    """(method, url) -> (status, headers, body), or a list of those consumed in order."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, method, url, headers, data):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "data": data})
        value = self.responses[(method, url)]
        if isinstance(value, list):
            return value.pop(0)
        return value


def userinfo_ok(sub="abc123"):
    return (200, {}, json.dumps({"sub": sub, "name": "Adam"}).encode("utf-8"))


def created(urn=SHARE_URN):
    return (201, {"x-restli-id": urn}, b"")


def init_upload_ok():
    body = {"value": {"uploadUrl": UPLOAD_URL, "image": IMAGE_URN, "uploadUrlExpiresAt": 1}}
    return (200, {}, json.dumps(body).encode("utf-8"))


def write_calls(transport):
    return [c for c in transport.calls if c["method"] in ("POST", "PUT")]


def posts_call(transport):
    calls = [c for c in transport.calls if c["method"] == "POST" and c["url"] == POSTS]
    assert len(calls) == 1
    return calls[0]


# --- little_text_escape ------------------------------------------------------


def test_little_text_escape_escapes_every_reserved_char():
    reserved = "\\|{}@[]()<>#*_~"
    assert cross_post.little_text_escape(reserved) == "".join("\\" + ch for ch in reserved)


def test_little_text_escape_escapes_backslash_exactly_once():
    assert cross_post.little_text_escape("a\\b") == "a\\\\b"
    assert cross_post.little_text_escape("\\#") == "\\\\\\#"


def test_little_text_escape_leaves_plain_text_alone():
    text = "Plain text, with punctuation: yes! 100% done? … \"quotes\" 'too' & more."
    assert cross_post.little_text_escape(text) == text


def test_little_text_escape_realistic_title():
    assert (
        cross_post.little_text_escape("Using @claude (v2) #ai")
        == "Using \\@claude \\(v2\\) \\#ai"
    )


# --- linkedin_hashtag ---------------------------------------------------------


def test_linkedin_hashtag_format():
    assert cross_post.linkedin_hashtag("ai") == "{hashtag|\\#|Ai}"


def test_linkedin_hashtag_camelcases_multiword_tags():
    assert cross_post.linkedin_hashtag("machine learning") == "{hashtag|\\#|MachineLearning}"
    assert cross_post.linkedin_hashtag("open-source") == "{hashtag|\\#|OpenSource}"


def test_linkedin_hashtag_empty_for_tag_without_alphanumerics():
    assert cross_post.linkedin_hashtag("---") == ""
    assert cross_post.linkedin_hashtag("") == ""


def test_linkedin_commentary_dedupes_hashtags():
    # "ai" and "AI" both CamelCase to "Ai"; "---" has no alphanumerics.
    post = make_post(tags=["ai", "AI", "---"], excerpt="")
    assert cross_post.linkedin_commentary(post) == "My Post\n\n{hashtag|\\#|Ai}"


# --- linkedin_commentary ------------------------------------------------------


def test_linkedin_commentary_exact_format():
    post = make_post(title="Hello (World)", excerpt="A #1 excerpt_here.", tags=["ai", "machine learning"])
    assert cross_post.linkedin_commentary(post) == (
        "Hello \\(World\\)\n\nA \\#1 excerpt\\_here.\n\n"
        "{hashtag|\\#|Ai} {hashtag|\\#|MachineLearning}"
    )


def test_linkedin_commentary_carries_no_url():
    post = make_post()
    assert post["url"] not in cross_post.linkedin_commentary(post)
    assert "http" not in cross_post.linkedin_commentary(post)


def test_linkedin_commentary_without_excerpt_or_tags():
    post = make_post(excerpt="", tags=[])
    assert cross_post.linkedin_commentary(post) == "My Post"


def test_linkedin_commentary_truncates_excerpt_at_word_boundary():
    post = make_post(title="T", excerpt="one two three four five", tags=["ai"])
    # "T\n\none two three…\n\n{hashtag|\#|Ai}" = 3 + 14 + 2 + 15 = 34
    commentary = cross_post.linkedin_commentary(post, max_chars=34)
    assert commentary == "T\n\none two three…\n\n{hashtag|\\#|Ai}"
    assert len(commentary) == 34


def test_linkedin_commentary_length_measured_after_escaping():
    post = make_post(title="T", excerpt="a_b c_d e_f", tags=[])
    # Unescaped "T\n\na_b c_d e_f" is 14 chars; escaped it is 17.
    commentary = cross_post.linkedin_commentary(post, max_chars=14)
    assert len(commentary) <= 14
    assert commentary == "T\n\na\\_b c\\_d…"


def test_linkedin_commentary_drops_hashtags_when_still_too_long():
    post = make_post(title="A title", excerpt="word word word word word", tags=["averyveryverylongtag"])
    commentary = cross_post.linkedin_commentary(post, max_chars=10)
    assert "hashtag" not in commentary
    assert commentary == "A title"


def test_linkedin_commentary_default_cap_is_2900():
    post = make_post(excerpt=" ".join(["word"] * 2000), tags=["ai"])
    commentary = cross_post.linkedin_commentary(post)
    assert len(commentary) <= 2900
    assert commentary.endswith("{hashtag|\\#|Ai}")
    assert "…" in commentary


# --- linkedin_token_age / check_linkedin_token ----------------------------------


def test_constants():
    assert cross_post.LINKEDIN_API_VERSION == "202609"
    assert cross_post.LINKEDIN_API == "https://api.linkedin.com"
    assert cross_post.LINKEDIN_TOKEN_WARN_DAYS == 50
    assert cross_post.LINKEDIN_TOKEN_LIFETIME_DAYS == 60


def test_linkedin_token_age_parses_date():
    assert cross_post.linkedin_token_age("2026-09-01", TODAY) == 21
    assert cross_post.linkedin_token_age(TODAY.isoformat(), TODAY) == 0


@pytest.mark.parametrize("minted", ["", None, "garbage", "2026-13-01", "2026/09/01", "20260901"])
def test_linkedin_token_age_unparseable_is_none(minted):
    assert cross_post.linkedin_token_age(minted, TODAY) is None


def test_check_token_missing_is_error(capsys):
    assert cross_post.check_linkedin_token("", TODAY) == 1
    out = capsys.readouterr().out
    assert (
        "::error::LINKEDIN_TOKEN_MINTED is not set (or not YYYY-MM-DD); set it to the date "
        "the LinkedIn token was minted — " + ROTATE
    ) in out


def test_check_token_garbage_is_error(capsys):
    assert cross_post.check_linkedin_token("last tuesday", TODAY) == 1
    assert "::error::LINKEDIN_TOKEN_MINTED is not set" in capsys.readouterr().out


def test_check_token_49_days_is_notice(capsys):
    assert cross_post.check_linkedin_token(minted_days_ago(49), TODAY) == 0
    out = capsys.readouterr().out
    assert "::notice::LinkedIn access token is 49 days old; expires in 11 days" in out
    assert "::error::" not in out


def test_check_token_50_days_is_red(capsys):
    minted = minted_days_ago(50)
    assert cross_post.check_linkedin_token(minted, TODAY) == 1
    out = capsys.readouterr().out
    assert (
        f"::error::LinkedIn access token expires in 10 day(s) (minted {minted}); rotate it — {ROTATE}"
    ) in out


def test_check_token_59_days_is_red(capsys):
    minted = minted_days_ago(59)
    assert cross_post.check_linkedin_token(minted, TODAY) == 1
    assert f"expires in 1 day(s) (minted {minted})" in capsys.readouterr().out


def test_check_token_60_days_is_expired(capsys):
    minted = minted_days_ago(60)
    assert cross_post.check_linkedin_token(minted, TODAY) == 1
    out = capsys.readouterr().out
    assert (
        f"::error::LinkedIn access token expired (minted {minted}, 60 days ago); rotate it — {ROTATE}"
    ) in out


# --- linkedin_transport ------------------------------------------------------


def test_linkedin_transport_network_failure_returns_zero(monkeypatch):
    def raise_url_error(request, timeout=None):
        raise urllib.error.URLError("boom")

    monkeypatch.setattr(cross_post.urllib.request, "urlopen", raise_url_error)
    assert cross_post.linkedin_transport("GET", "https://example.com/x", {}, None) == (0, {}, b"")


def test_linkedin_transport_http_error_returns_code_headers_body(monkeypatch):
    import email.message

    headers = email.message.Message()
    headers["X-Thing"] = "v"

    def raise_http_error(request, timeout=None):
        raise urllib.error.HTTPError("https://example.com/x", 426, "Upgrade", headers, None)

    monkeypatch.setattr(cross_post.urllib.request, "urlopen", raise_http_error)
    status, got_headers, _ = cross_post.linkedin_transport("GET", "https://example.com/x", {}, None)
    assert status == 426
    assert got_headers == {"x-thing": "v"}


def test_linkedin_transport_success_lowercases_headers_and_uses_timeout_20(monkeypatch):
    seen = {}

    class FakeResponse:
        status = 201
        headers = {"X-RestLi-Id": SHARE_URN}

        def read(self):
            return b"ok"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(request, timeout=None):
        seen["timeout"] = timeout
        seen["method"] = request.get_method()
        return FakeResponse()

    monkeypatch.setattr(cross_post.urllib.request, "urlopen", fake_urlopen)
    result = cross_post.linkedin_transport("POST", "https://example.com/x", {}, b"{}")
    assert result == (201, {"x-restli-id": SHARE_URN}, b"ok")
    assert seen == {"timeout": 20, "method": "POST"}


# --- post_linkedin: gating before any request ----------------------------------


def test_no_token_skips_with_zero_requests(capsys):
    transport = FakeTransport({})
    results = cross_post.post_linkedin([make_post()], "", transport)
    assert results == [{"slug": "my-post", "skipped": "no-token"}]
    assert transport.calls == []
    assert "::warning::LinkedIn leg skipped: LINKEDIN_ACCESS_TOKEN is not set" in capsys.readouterr().out


def test_none_token_skips_with_zero_requests():
    transport = FakeTransport({})
    assert cross_post.post_linkedin([make_post()], None, transport) == [
        {"slug": "my-post", "skipped": "no-token"}
    ]
    assert transport.calls == []


def test_expired_by_date_exits_with_zero_requests(capsys):
    transport = FakeTransport({})
    minted = minted_days_ago(60)
    with pytest.raises(SystemExit) as exc:
        cross_post.post_linkedin([make_post()], TOKEN, transport, minted=minted, today=TODAY)
    assert exc.value.code == 1
    assert transport.calls == []
    out = capsys.readouterr().out
    assert f"::error::LinkedIn access token expired (minted {minted}, 60 days ago)" in out


def test_expired_by_date_exits_even_on_dry_run():
    transport = FakeTransport({})
    with pytest.raises(SystemExit):
        cross_post.post_linkedin(
            [make_post()], TOKEN, transport, minted=minted_days_ago(90), today=TODAY, dry_run=True
        )
    assert transport.calls == []


def test_expiring_soon_warns_and_posts(capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    minted = minted_days_ago(55)
    cross_post.post_linkedin([make_post()], TOKEN, transport, minted=minted, today=TODAY)
    out = capsys.readouterr().out
    assert f"::warning::LinkedIn access token expires in 5 day(s) (minted {minted})" in out
    posts_call(transport)


def test_unknown_minted_date_warns_and_posts(capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    cross_post.post_linkedin([make_post()], TOKEN, transport, minted="", today=TODAY)
    out = capsys.readouterr().out
    assert "::warning::LINKEDIN_TOKEN_MINTED is not set; cannot warn before the token expires" in out
    posts_call(transport)


def test_fresh_token_posts_without_age_warning(capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    cross_post.post_linkedin([make_post()], TOKEN, transport, minted=minted_days_ago(3), today=TODAY)
    assert "::warning::" not in capsys.readouterr().out


# --- post_linkedin: author resolution ------------------------------------------


def test_userinfo_sends_bearer_and_author_urn_comes_from_sub():
    transport = FakeTransport({("GET", USERINFO): userinfo_ok("xyz789"), ("POST", POSTS): created()})
    cross_post.post_linkedin([make_post()], TOKEN, transport)
    first = transport.calls[0]
    assert first["method"] == "GET" and first["url"] == USERINFO
    assert first["headers"]["Authorization"] == f"Bearer {TOKEN}"
    body = json.loads(posts_call(transport)["data"].decode("utf-8"))
    assert body["author"] == "urn:li:person:xyz789"


def test_userinfo_401_is_rotation_error(capsys):
    transport = FakeTransport({("GET", USERINFO): (401, {}, b'{"message":"secret-in-body"}')})
    with pytest.raises(SystemExit) as exc:
        cross_post.post_linkedin([make_post()], TOKEN, transport)
    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert (
        "::error::LinkedIn token rejected (HTTP 401): expired or revoked; rotate it — " + ROTATE
    ) in out
    assert "secret-in-body" not in out
    assert write_calls(transport) == []


def test_userinfo_other_failure(capsys):
    transport = FakeTransport({("GET", USERINFO): (503, {}, b"body-with-fake-secret")})
    with pytest.raises(SystemExit):
        cross_post.post_linkedin([make_post()], TOKEN, transport)
    out = capsys.readouterr().out
    assert "::error::LinkedIn userinfo lookup failed: HTTP 503" in out
    assert "body-with-fake-secret" not in out


# --- post_linkedin: the POST ------------------------------------------------------


def test_post_exact_url_headers_and_body():
    post = make_post(title="Hello (World)", excerpt="An excerpt.", tags=["ai"])
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    cross_post.post_linkedin([post], TOKEN, transport)
    call = posts_call(transport)
    assert call["headers"] == {
        "Authorization": f"Bearer {TOKEN}",
        "LinkedIn-Version": "202609",
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
    }
    assert json.loads(call["data"].decode("utf-8")) == {
        "author": "urn:li:person:abc123",
        "commentary": "Hello \\(World\\)\n\nAn excerpt.\n\n{hashtag|\\#|Ai}",
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "content": {
            "article": {
                "source": "https://adamdaniel.ai/blog/my-post/",
                "title": "Hello (World)",
                "description": "An excerpt.",
            }
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }


def test_article_title_and_description_are_truncated():
    post = make_post(title="T" * 500, excerpt="E" * 5000, tags=[])
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    cross_post.post_linkedin([post], TOKEN, transport)
    article = json.loads(posts_call(transport)["data"].decode("utf-8"))["content"]["article"]
    assert len(article["title"]) == 400
    assert len(article["description"]) == 4000


def test_201_urn_url_result_and_linkedin_json(tmp_path, capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    results = cross_post.post_linkedin([make_post()], TOKEN, transport, out_dir=tmp_path)
    url = f"https://www.linkedin.com/feed/update/{SHARE_URN}/"
    assert results == [{"slug": "my-post", "urn": SHARE_URN, "url": url}]
    assert f"Posted: {url}" in capsys.readouterr().out
    out_file = tmp_path / "my-post.linkedin.json"
    assert out_file.read_text(encoding="utf-8") == json.dumps(
        {"urn": SHARE_URN, "url": url}, indent=2
    ) + "\n"


# --- post_linkedin: dry run -------------------------------------------------------


def test_dry_run_makes_no_write_request_and_no_image_fetch(capsys, tmp_path):
    post = make_post(featured_image=IMAGE_URL)
    transport = FakeTransport({("GET", USERINFO): userinfo_ok()})
    results = cross_post.post_linkedin([post], TOKEN, transport, dry_run=True, out_dir=tmp_path)
    assert results == [{"slug": "my-post", "dry_run": True}]
    assert [(c["method"], c["url"]) for c in transport.calls] == [("GET", USERINFO)]
    out = capsys.readouterr().out
    assert "::group::LinkedIn post (dry run) for my-post" in out
    assert cross_post.linkedin_commentary(post) in out
    assert "article: " in out
    assert "::endgroup::" in out
    assert not (tmp_path / "my-post.linkedin.json").exists()


# --- post_linkedin: thumbnail -------------------------------------------------------


def thumbnail_transport(image=None, init=None, put=None):
    return FakeTransport(
        {
            ("GET", USERINFO): userinfo_ok(),
            ("GET", IMAGE_URL): image or (200, {"content-type": "image/png"}, b"\x89PNGbytes"),
            ("POST", INIT_UPLOAD): init or init_upload_ok(),
            ("PUT", UPLOAD_URL): put or (201, {}, b""),
            ("POST", POSTS): created(),
        }
    )


def test_thumbnail_happy_path():
    transport = thumbnail_transport()
    cross_post.post_linkedin([make_post(featured_image=IMAGE_URL)], TOKEN, transport)

    image_get = next(c for c in transport.calls if c["url"] == IMAGE_URL)
    assert "Authorization" not in image_get["headers"]

    init = next(c for c in transport.calls if c["url"] == INIT_UPLOAD)
    assert init["method"] == "POST"
    assert init["headers"]["LinkedIn-Version"] == "202609"
    assert init["headers"]["X-Restli-Protocol-Version"] == "2.0.0"
    assert init["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert json.loads(init["data"].decode("utf-8")) == {
        "initializeUploadRequest": {"owner": "urn:li:person:abc123"}
    }

    put = next(c for c in transport.calls if c["method"] == "PUT")
    assert put["url"] == UPLOAD_URL
    assert put["data"] == b"\x89PNGbytes"
    assert put["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert put["headers"]["Content-Type"] == "application/octet-stream"

    article = json.loads(posts_call(transport)["data"].decode("utf-8"))["content"]["article"]
    assert article["thumbnail"] == IMAGE_URN

    order = [c["url"] for c in transport.calls]
    assert order == [USERINFO, IMAGE_URL, INIT_UPLOAD, UPLOAD_URL, POSTS]


def test_thumbnail_put_200_also_counts():
    transport = thumbnail_transport(put=(200, {}, b""))
    cross_post.post_linkedin([make_post(featured_image=IMAGE_URL)], TOKEN, transport)
    article = json.loads(posts_call(transport)["data"].decode("utf-8"))["content"]["article"]
    assert article["thumbnail"] == IMAGE_URN


def test_no_featured_image_makes_no_image_requests():
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    cross_post.post_linkedin([make_post(featured_image="")], TOKEN, transport)
    assert [c["url"] for c in transport.calls] == [USERINFO, POSTS]


@pytest.mark.parametrize(
    "failing, status",
    [
        ("image", 404),
        ("init", 403),
        ("put", 500),
    ],
)
def test_thumbnail_failure_at_each_step_still_posts_without_thumbnail(failing, status, capsys):
    bad = (status, {}, b"fake-secret-body")
    transport = thumbnail_transport(**{failing: bad})
    results = cross_post.post_linkedin([make_post(featured_image=IMAGE_URL)], TOKEN, transport)
    assert results[0]["urn"] == SHARE_URN
    article = json.loads(posts_call(transport)["data"].decode("utf-8"))["content"]["article"]
    assert "thumbnail" not in article
    out = capsys.readouterr().out
    assert f"::warning::LinkedIn thumbnail upload skipped for my-post: HTTP {status}" in out
    assert "fake-secret-body" not in out


def test_thumbnail_init_response_without_upload_url_skips_thumbnail(capsys):
    transport = thumbnail_transport(init=(200, {}, b'{"value": {}}'))
    cross_post.post_linkedin([make_post(featured_image=IMAGE_URL)], TOKEN, transport)
    article = json.loads(posts_call(transport)["data"].decode("utf-8"))["content"]["article"]
    assert "thumbnail" not in article
    assert "::warning::LinkedIn thumbnail upload skipped for my-post" in capsys.readouterr().out
    assert all(c["method"] != "PUT" for c in transport.calls)


def test_thumbnail_upload_url_off_linkedin_never_receives_the_token(capsys):
    evil = "https://attacker.example/upload"
    body = {"value": {"uploadUrl": evil, "image": IMAGE_URN}}
    transport = thumbnail_transport(init=(200, {}, json.dumps(body).encode("utf-8")))
    cross_post.post_linkedin([make_post(featured_image=IMAGE_URL)], TOKEN, transport)
    assert all(c["url"] != evil for c in transport.calls)
    article = json.loads(posts_call(transport)["data"].decode("utf-8"))["content"]["article"]
    assert "thumbnail" not in article
    assert "::warning::LinkedIn thumbnail upload skipped for my-post" in capsys.readouterr().out


def test_thumbnail_non_http_image_url_is_never_fetched(capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): created()})
    cross_post.post_linkedin([make_post(featured_image="file:///etc/passwd")], TOKEN, transport)
    assert [c["url"] for c in transport.calls] == [USERINFO, POSTS]
    assert "::warning::LinkedIn thumbnail upload skipped for my-post" in capsys.readouterr().out


# --- post_linkedin: POST errors -----------------------------------------------------


def test_post_401_is_rotation_error(capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): (401, {}, b"")})
    with pytest.raises(SystemExit):
        cross_post.post_linkedin([make_post()], TOKEN, transport)
    assert (
        "::error::LinkedIn token rejected (HTTP 401): expired or revoked; rotate it — " + ROTATE
    ) in capsys.readouterr().out


def test_post_426_is_version_sunset_error(capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): (426, {}, b"")})
    with pytest.raises(SystemExit):
        cross_post.post_linkedin([make_post()], TOKEN, transport)
    assert (
        "::error::LinkedIn rejected LinkedIn-Version 202609 (HTTP 426): the API version is "
        "sunset; bump LINKEDIN_API_VERSION in cross_post.py"
    ) in capsys.readouterr().out


@pytest.mark.parametrize("status", [500, 503, 0])
def test_post_5xx_or_network_failure_may_have_posted(status, capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): (status, {}, b"")})
    with pytest.raises(SystemExit):
        cross_post.post_linkedin([make_post()], TOKEN, transport)
    assert (
        f"::error::LinkedIn POST for my-post returned HTTP {status}; it MAY have posted. "
        "Check the profile before re-dispatching with targets=linkedin"
    ) in capsys.readouterr().out
    # Never retried: exactly one POST.
    posts_call(transport)


def test_post_other_error(capsys):
    transport = FakeTransport({("GET", USERINFO): userinfo_ok(), ("POST", POSTS): (422, {}, b"")})
    with pytest.raises(SystemExit):
        cross_post.post_linkedin([make_post()], TOKEN, transport)
    assert "::error::LinkedIn POST failed for my-post: HTTP 422" in capsys.readouterr().out


def test_failure_continues_with_remaining_posts_then_exits_1(tmp_path):
    transport = FakeTransport(
        {
            ("GET", USERINFO): userinfo_ok(),
            ("POST", POSTS): [(500, {}, b""), created("urn:li:share:2")],
        }
    )
    with pytest.raises(SystemExit) as exc:
        cross_post.post_linkedin(
            [make_post(slug="one"), make_post(slug="two")], TOKEN, transport, out_dir=tmp_path
        )
    assert exc.value.code == 1
    assert len([c for c in transport.calls if c["url"] == POSTS]) == 2
    assert not (tmp_path / "one.linkedin.json").exists()
    assert (tmp_path / "two.linkedin.json").exists()


def test_error_body_with_fake_secret_is_never_printed(capsys):
    secret_body = b'{"serviceErrorCode": 1, "message": "FAKE-SECRET-abc123 token=li-secret-token"}'
    transport = FakeTransport(
        {("GET", USERINFO): userinfo_ok(), ("POST", POSTS): (400, {"x-li-uuid": "u"}, secret_body)}
    )
    with pytest.raises(SystemExit):
        cross_post.post_linkedin([make_post()], TOKEN, transport)
    captured = capsys.readouterr()
    for stream in (captured.out, captured.err):
        assert "FAKE-SECRET-abc123" not in stream
        assert TOKEN not in stream
        assert "Bearer" not in stream
