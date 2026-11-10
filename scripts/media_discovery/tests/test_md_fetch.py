import io
import urllib.error
from email.message import Message

import pytest

from media_discovery import fetch as fetch_mod
from media_discovery.fetch import MAX_BYTES, USER_AGENT, fetch

PUBLIC = "93.184.215.14"  # a global address; the resolver below is fake anyway


def headers(content_type="text/html; charset=utf-8", **extra):
    msg = Message()
    msg["Content-Type"] = content_type
    for k, v in extra.items():
        msg[k] = v
    return msg


class Resp:
    def __init__(self, body=b"", content_type="text/html; charset=utf-8", status=200):
        self.status = status
        self.headers = headers(content_type)
        self._body = io.BytesIO(body)
        self.read_sizes = []

    def read(self, n=-1):
        self.read_sizes.append(n)
        return self._body.read(n)

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def redirect(url, location, code=302):
    return urllib.error.HTTPError(url, code, "Found", headers("text/html", Location=location),
                                  io.BytesIO(b""))


class Opener:
    """Maps URL -> a Resp, an exception to raise, or a callable(req) returning either."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def open(self, req, timeout=None):
        self.requests.append((req, timeout))
        result = self.routes[req.full_url]
        if callable(result) and not isinstance(result, Resp):
            result = result(req)
        if isinstance(result, BaseException):
            raise result
        return result


def resolver_for(table):
    calls = []

    def resolve(host, port):
        calls.append((host, port))
        value = table.get(host, [PUBLIC])
        if isinstance(value, BaseException):
            raise value
        return value
    resolve.calls = calls
    return resolve


def test_html_page_becomes_text_with_generic_user_agent_and_timeout():
    op = Opener({"https://a.example.com/p": Resp(b"<p>Hello <b>world</b></p><script>x</script>")})
    res = resolver_for({})
    page = fetch("https://a.example.com/p", opener=op, resolver=res)
    assert (page.status, page.text, page.final_url) == (200, "Hello world", "https://a.example.com/p")
    req, timeout = op.requests[0]
    assert req.get_header("User-agent") == USER_AGENT == "cms-platform-media-discovery/1"
    assert "@" not in USER_AGENT and timeout == 20
    assert res.calls == [("a.example.com", 443)]


def test_plain_text_is_kept_and_charset_honored():
    op = Opener({"http://a.example.com/t": Resp("café".encode("latin-1"),
                                                "text/plain; charset=latin-1")})
    page = fetch("http://a.example.com/t", opener=op, resolver=resolver_for({}))
    assert page.text == "café" and page.status == 200


@pytest.mark.parametrize("ctype", ["application/pdf", "image/png", "application/json"])
def test_other_content_types_are_415_with_no_text(ctype):
    op = Opener({"https://a.example.com/f": Resp(b"%PDF-1.7", ctype)})
    page = fetch("https://a.example.com/f", opener=op, resolver=resolver_for({}))
    assert (page.status, page.text, page.unreadable_type) == (415, "", True)


def test_body_read_is_capped_at_3_mb():
    resp = Resp(b"a" * (MAX_BYTES + 10), "text/plain")
    page = fetch("https://a.example.com/big", opener=Opener({"https://a.example.com/big": resp}),
                 resolver=resolver_for({}))
    assert resp.read_sizes == [3 * 1024 * 1024] and len(page.text) == MAX_BYTES


@pytest.mark.parametrize("url", ["ftp://a.example.com/x", "file:///etc/passwd",
                                 "javascript:alert(1)", "https:///nohost"])
def test_non_http_schemes_are_refused_without_a_request(url):
    op = Opener({})
    page = fetch(url, opener=op, resolver=resolver_for({}))
    assert (page.status, page.text) == (0, "") and op.requests == []


@pytest.mark.parametrize("addrs", [
    ["169.254.169.254"], ["127.0.0.1"], ["10.0.0.5"], ["192.168.1.1"], ["::1"],
    ["fe80::1%eth0"], ["fd00::1"], [PUBLIC, "10.0.0.5"], [],
])
def test_any_non_global_address_is_refused(addrs):
    op = Opener({"https://evil.example.net/": Resp(b"secret")})
    page = fetch("https://evil.example.net/", opener=op,
                 resolver=resolver_for({"evil.example.net": addrs}))
    assert page.status == 0 and op.requests == []


def test_ip_literal_host_is_checked_too():
    page = fetch("http://169.254.169.254/latest/meta-data/", opener=Opener({}),
                 resolver=resolver_for({"169.254.169.254": ["169.254.169.254"]}))
    assert page.status == 0


def test_redirects_are_followed_and_every_hop_rechecked():
    op = Opener({
        "https://a.example.com/start": redirect("https://a.example.com/start", "/next", 301),
        "https://a.example.com/next": redirect("https://a.example.com/next",
                                               "https://b.example.org/final"),
        "https://b.example.org/final": Resp(b"<p>done</p>"),
    })
    res = resolver_for({})
    page = fetch("https://a.example.com/start", opener=op, resolver=res)
    assert (page.status, page.text) == (200, "done")
    assert page.url == "https://a.example.com/start"
    assert page.final_url == "https://b.example.org/final"
    assert [h for h, _ in res.calls] == ["a.example.com", "a.example.com", "b.example.org"]


def test_redirect_to_a_private_address_is_refused():
    op = Opener({
        "https://a.example.com/r": redirect("https://a.example.com/r", "http://internal.example.net/"),
    })
    page = fetch("https://a.example.com/r", opener=op,
                 resolver=resolver_for({"internal.example.net": ["10.1.2.3"]}))
    assert page.status == 0 and len(op.requests) == 1


def test_redirect_to_another_scheme_is_refused():
    op = Opener({"https://a.example.com/r": redirect("https://a.example.com/r", "file:///etc/passwd")})
    assert fetch("https://a.example.com/r", opener=op, resolver=resolver_for({})).status == 0


def test_more_than_five_redirects_gives_up():
    routes = {f"https://a.example.com/{i}": redirect(f"https://a.example.com/{i}", f"/{i + 1}")
              for i in range(10)}
    op = Opener(routes)
    page = fetch("https://a.example.com/0", opener=op, resolver=resolver_for({}))
    assert page.status == 0 and len(op.requests) == 6


def test_http_errors_keep_their_status():
    op = Opener({"https://a.example.com/gone": urllib.error.HTTPError(
        "https://a.example.com/gone", 404, "Not Found", headers(), io.BytesIO(b"nope"))})
    page = fetch("https://a.example.com/gone", opener=op, resolver=resolver_for({}))
    assert (page.status, page.text) == (404, "")


@pytest.mark.parametrize("exc", [urllib.error.URLError("boom"), TimeoutError(),
                                 ConnectionResetError(), ValueError("bad")])
def test_network_errors_are_status_0_and_never_raise(exc):
    op = Opener({"https://a.example.com/x": exc})
    page = fetch("https://a.example.com/x", opener=op, resolver=resolver_for({}))
    assert (page.status, page.text) == (0, "")


def test_resolution_failure_is_status_0():
    import socket
    page = fetch("https://nx.example.com/", opener=Opener({}),
                 resolver=resolver_for({"nx.example.com": socket.gaierror("nx")}))
    assert page.status == 0


def test_default_opener_does_not_follow_redirects():
    opener = fetch_mod._default_opener()
    handlers = [type(h).__name__ for h in opener.handlers]
    assert "_NoRedirect" in handlers and "HTTPRedirectHandler" not in handlers
